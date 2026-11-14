import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader. Applies only as a fallback for variables that are not
 * already set in the environment, so real env vars always win.
 */
export function loadDotEnv(filePath?: string): void {
  const resolved = filePath ?? path.join(process.cwd(), ".env");
  let contents: string;
  try {
    contents = fs.readFileSync(resolved, "utf-8");
  } catch {
    return; // No .env file — nothing to load.
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip matching quotes so LLM_API_KEY="..." works.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Resolve LLM connection settings: env vars first, then .env, then defaults. */
export function resolveLlmConfig(cliModel?: string): LlmConfig {
  loadDotEnv();

  const apiKey = process.env.LLM_API_KEY ?? "";
  const baseUrl =
    process.env.LLM_BASE_URL || "http://localhost:20128/v1";
  const model =
    cliModel ??
    process.env.LLM_MODEL ??
    "auto";

  return { apiKey, baseUrl, model };
}

export function missingKeyMessage(): string {
  return (
    "Error: LLM_API_KEY is not set.\n" +
    "\n" +
    "This app talks to an OpenAI-compatible gateway (OmniRoute by default).\n" +
    "Create a .env file in this folder with:\n" +
    "\n" +
    "  LLM_API_KEY=your-omni-route-api-key\n" +
    "  LLM_BASE_URL=http://localhost:20128/v1\n" +
    "  LLM_MODEL=auto\n" +
    "\n" +
    "Or run the installer first: npm run setup"
  );
}
