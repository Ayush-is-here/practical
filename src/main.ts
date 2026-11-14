import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";
import { resolveLlmConfig, missingKeyMessage } from "./utils/env.js";

export function createCLI() {
  const program = new Command();

  program
    .name("coder")
    .description("A simplified Coding assistant - AI coding assistant in your terminal")
    .version("1.0.0")
    .option(
      "-m, --model <model>",
      "Model to use via LLM gateway (default: auto-detect; see LLM_MODEL in .env)",
      undefined
    )
    .action((options) => {
      const config = resolveLlmConfig(options.model);

      if (!config.apiKey) {
        console.error(missingKeyMessage());
        process.exit(1);
      }

      render(
        React.createElement(App, {
          apiKey: config.apiKey,
          model: config.model,
          baseUrl: config.baseUrl,
        })
      );
    });

  return program;
}

export default createCLI;
