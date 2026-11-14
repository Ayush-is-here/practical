#!/usr/bin/env node
/**
 * One-shot setup for this coding agent.
 *
 * What it does, in order:
 *   1. Checks Node/npm are available.
 *   2. Installs project dependencies (npm ci / npm install).
 *   3. Ensures the OmniRoute gateway is installed and running on :20128
 *      (installs it globally if missing, starts it if not up).
 *   4. Asks for the OmniRoute API key shown in the dashboard.
 *   5. Probes a list of model candidates against the gateway and picks the
 *      first one that answers a real tool-call request.
 *   6. Writes .env (git-ignored) with LLM_API_KEY / LLM_BASE_URL / LLM_MODEL.
 *
 * After it finishes:  npm run dev
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY_HEALTH = "http://localhost:20128/api/health";
const GATEWAY_BASE = "http://localhost:20128";
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

// Candidate models tried in order. "auto" lets OmniRoute pick a provider.
// If you add a favorite, put it first (or set LLM_MODEL in .env later).
const MODEL_CANDIDATES = ["auto", "static-coding", "openrouter/free"];

// ---------------------------------------------------------------- helpers

function log(step: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${step} ${msg}`);
}

function run(cmd: string, args: string[], opts?: { quiet?: boolean }) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf-8",
      stdio: opts?.quiet ? "pipe" : "inherit",
      cwd: PROJECT_ROOT,
    });
    return { ok: true, out: (out ?? "").toString() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      out: ((e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "")).toString(),
    };
  }
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function httpGet(url: string, timeoutMs = 4000): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.on("error", () => resolve({ status: 0, body: "unreachable" }));
  });
}

function httpPostJson(url: string, payload: unknown, timeoutMs = 45000, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c.toString()));
        res.on("end", () => {
          let parsed: any = body;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* keep raw string */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.on("error", () => resolve({ status: 0, body: "unreachable" }));
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------- steps

async function stepNode() {
  log("1/6", "Checking Node.js ...");
  const { ok, out } = run("node", ["--version"], { quiet: true });
  if (!ok) {
    console.error(
      "Node.js is required. Install it from https://nodejs.org (LTS) and re-run."
    );
    process.exit(1);
  }
  console.log(`       node ${out.trim()}`);
}

async function stepDeps() {
  if (fs.existsSync(path.join(PROJECT_ROOT, "node_modules"))) {
    log("2/6", "Dependencies already installed — skipping npm install.");
    return;
  }
  log("2/6", "Installing project dependencies ...");
  const lock = fs.existsSync(path.join(PROJECT_ROOT, "package-lock.json"));
  const res = lock
    ? run("npm", ["ci", "--no-audit", "--no-fund"])
    : run("npm", ["install", "--no-audit", "--no-fund"]);
  if (!res.ok) {
    console.error("npm install failed:\n" + res.out);
    process.exit(1);
  }
  console.log("       dependencies installed");
}

async function stepGateway(): Promise<boolean> {
  log("3/6", "Checking OmniRoute gateway ...");

  // Already up?
  const health = await httpGet(GATEWAY_HEALTH);
  if (health.status === 200 && health.body.includes('"status"')) {
    console.log("       gateway already running at http://localhost:20128");
    return true;
  }

  // Installed?
  const which = run("omniroute", ["--version"], { quiet: true });
  if (!which.ok) {
    console.log("       OmniRoute not found — installing globally (npm -g omniroute) ...");
    const inst = run("npm", ["install", "-g", "omniroute"]);
    if (!inst.ok) {
      console.error(
        "Could not install OmniRoute automatically.\n" +
          "Install it manually:  npm install -g omniroute\n" +
          "then run: omniroute serve\n" +
          "and re-run this script."
      );
      return false;
    }
    console.log("       OmniRoute installed");
  } else {
    console.log(`       OmniRoute ${which.out.trim()} found`);
  }

  // Start it in the background and wait for health.
  console.log("       starting gateway (background daemon) ...");
  const child = spawn("omniroute", ["serve", "--daemon", "--no-open"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const h = await httpGet(GATEWAY_HEALTH);
    if (h.status === 200 && h.body.includes('"status"')) {
      console.log("       gateway is up at http://localhost:20128");
      return true;
    }
    process.stdout.write(".");
  }
  console.error(
    "\n       Gateway did not become healthy. Try starting it manually:\n" +
      "         omniroute serve\n" +
      "       then re-run this script."
  );
  return false;
}

async function stepKey(): Promise<string> {
  log("4/6", "Getting your OmniRoute API key ...");
  console.log(
    "       Open the OmniRoute dashboard in your browser:\n" +
      "         " + GATEWAY_BASE + "\n" +
      "       (On this machine it may already be open.)\n" +
      "       Find / create an API key, paste it below."
  );
  const key = await ask("       OmniRoute API key (or press Enter to skip): ");
  return key;
}

interface ProbeResult {
  model: string;
  ok: boolean;
  detail: string;
}

async function probeModel(model: string, apiKey: string): Promise<ProbeResult> {
  const payload = {
    model,
    messages: [{ role: "user", content: "Call the setup_probe tool now." }],
    // A forced tool call proves the model can drive the agent's tools, not
    // just chat. No max_tokens cap: reasoning models can burn a small budget
    // on thinking before ever emitting the call.
    tools: [
      {
        type: "function",
        function: {
          name: "setup_probe",
          description: "Probe tool",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: "required",
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await httpPostJson(`${GATEWAY_BASE}/v1/chat/completions`, payload);

  if (res.status >= 200 && res.status < 300) {
    const msg = res.body?.choices?.[0]?.message;
    if (msg && (msg.content || msg.tool_calls)) {
      return { model, ok: true, detail: "answered" };
    }
    return { model, ok: false, detail: "empty response" };
  }
  const msg =
    typeof res.body === "string"
      ? res.body.slice(0, 200)
      : res.body?.error?.message ?? JSON.stringify(res.body)?.slice(0, 200) ?? "unknown error";
  return { model, ok: false, detail: `${res.status} ${msg}` };
}

async function stepModel(apiKey: string): Promise<string | null> {
  log("5/6", "Probing models through the gateway (this can take a minute) ...");
  for (const candidate of MODEL_CANDIDATES) {
    const res = await probeModel(candidate, apiKey);
    if (res.ok) {
      console.log(`       ✓ ${candidate} — ${res.detail}`);
      return candidate;
    }
    console.log(`       ✗ ${candidate} — ${res.detail}`);
  }
  return null;
}

function writeEnv(apiKey: string, model: string) {
  const lines = [
    "# Auto-generated by npm run setup — edit freely.",
    "# LLM_BASE_URL is the OmniRoute gateway on this machine.",
    `LLM_API_KEY=${apiKey}`,
    `LLM_BASE_URL=${GATEWAY_BASE}/v1`,
    `LLM_MODEL=${model}`,
    "",
  ];
  fs.writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
  console.log(`       wrote ${path.basename(ENV_PATH)} (git-ignored)`);
}

// ---------------------------------------------------------------- main

async function main() {
  console.log("=== Coding agent setup ===\n");

  await stepNode();
  await stepDeps();
  const gatewayOk = await stepGateway();
  if (!gatewayOk) process.exit(1);

  const apiKey = await stepKey();
  const model = await stepModel(apiKey);

  if (!model) {
    console.error(
      "\nNo candidate model answered with tools support. Things to try:"
    );
    console.error("  • Open the OmniRoute dashboard, add a provider API key, then re-run.");
    console.error("  • Check 'omniroute providers list' shows at least one active provider.");
    console.error("  • Set LLM_MODEL in .env manually to a model you know works.");
    process.exit(1);
  }

  writeEnv(apiKey, model);

  console.log("\n=== Setup complete ===");
  console.log(`   Model selected : ${model}`);
  console.log(`   Gateway        : ${GATEWAY_BASE}`);
  console.log("\nRun the agent with:  npm run dev\n");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
