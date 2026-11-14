import type {
  ChatCompletionChunk,
  ChatMessage,
  ToolCall,
  ToolCallDelta,
} from "../api/types.js";
import { LLMClient } from "../api/client.js";
import { getToolDefinitions } from "../tools/index.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import {
  executeToolCalls,
  type ToolExecutionResult,
} from "./toolExecutor.js";

function fallbackCandidates(primary: string): string[] {
  const env =
    typeof process !== "undefined"
      ? process.env.LLM_FALLBACK_MODELS
      : undefined;
  const fallbacks = env
    ? env.split(",").map((s) => s.trim()).filter(Boolean)
    : ["openrouter/free"];
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

export interface MessageLoopCallbacks {
  onToken: (token: string) => void;
  onToolStart: (toolCalls: ToolCall[]) => void;
  onToolResult: (results: ToolExecutionResult[]) => void;
  onComplete: (text: string) => void;
  onError: (error: Error) => void;
}

export async function runMessageLoop(
  client: LLMClient,
  messages: ChatMessage[],
  model: string,
  callbacks: MessageLoopCallbacks
): Promise<ChatMessage[]> {
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(),
  };

  const tools = getToolDefinitions();
  let continueLoop = true;

  while (continueLoop) {
    const models = fallbackCandidates(model);
    let roundError: Error | null = null;
    let roundFailedModels: string[] = [];

    for (let attempt = 0; attempt < models.length; attempt++) {
      const modelToTry = models[attempt];
      let assistantText = "";
      const toolCallDeltas: Map<number, { id: string; name: string; arguments: string }> = new Map();

      let stream: AsyncGenerator<ChatCompletionChunk>;
      try {
        stream = client.streamChatCompletion({
          model: modelToTry,
          messages: [systemMessage, ...messages],
          tools: tools.length > 0 ? tools : undefined,
        });
      } catch (err) {
        roundError = err instanceof Error ? err : new Error(String(err));
        roundFailedModels.push(modelToTry);
        continue;
      }

      let finishReason: string | null = null;
      let streamThrew = false;

      try {
        for await (const chunk of stream) {
          if (!chunk.choices || chunk.choices.length === 0) continue;
          const choice = chunk.choices[0];
          if (!choice?.delta) continue;

          // Handle text content
          if (choice.delta.content) {
            assistantText += choice.delta.content;
            callbacks.onToken(choice.delta.content);
          }

          // Handle tool call deltas
          if (choice.delta.tool_calls) {
            for (const delta of choice.delta.tool_calls) {
              accumulateToolCallDelta(toolCallDeltas, delta);
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      } catch (err) {
        roundError = err instanceof Error ? err : new Error(String(err));
        streamThrew = true;
      }

      const toolCalls: ToolCall[] = Array.from(toolCallDeltas.values()).map(
        (tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        })
      );

      // The gateway sometimes returns an upstream error as a chunk with no
      // choices (empty response). Treat "silent + no output" as a failed
      // round and fall back to the next model.
      const silentRound =
        !streamThrew &&
        !finishReason &&
        !assistantText &&
        toolCalls.length === 0;

      if (silentRound) {
        roundError = roundError ?? new Error(`Model ${modelToTry} returned no output`);
        roundFailedModels.push(modelToTry);
        continue;
      }

      if (
        finishReason === "tool_calls" ||
        (toolCalls.length > 0 && finishReason !== "stop")
      ) {
        // Add assistant message with tool calls
        const assistantMessage: ChatMessage = {
          role: "assistant",
          content: assistantText || null,
          tool_calls: toolCalls,
        };
        messages.push(assistantMessage);

        callbacks.onToolStart(toolCalls);

        // Execute tools
        const { messages: toolMessages, results } =
          await executeToolCalls(toolCalls);

        messages.push(...toolMessages);
        callbacks.onToolResult(results);

        // Continue the loop for another round
      } else {
        // finish_reason is "stop" or no tool calls - we're done
        if (assistantText) {
          messages.push({
            role: "assistant",
            content: assistantText,
          });
        }
        callbacks.onComplete(assistantText);
        continueLoop = false;
      }
      break; // success: leave the attempt loop
    }

    if (continueLoop && roundError) {
      // All model attempts failed this round.
      callbacks.onError(
        new Error(
          `All models failed (${roundFailedModels.join(", ")}): ${roundError.message}`
        )
      );
      continueLoop = false;
    }
  }

  return messages;
}

function accumulateToolCallDelta(
  accumulator: Map<number, { id: string; name: string; arguments: string }>,
  delta: ToolCallDelta
) {
  const existing = accumulator.get(delta.index);

  if (!existing) {
    accumulator.set(delta.index, {
      id: delta.id || "",
      name: delta.function?.name || "",
      arguments: delta.function?.arguments || "",
    });
  } else {
    if (delta.id) existing.id = delta.id;
    if (delta.function?.name) existing.name = delta.function.name;
    if (delta.function?.arguments)
      existing.arguments += delta.function.arguments;
  }
}
