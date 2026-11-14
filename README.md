# Base-code — terminal coding agent

A small Ink-based terminal coding agent that talks to any **OpenAI-compatible**
LLM gateway. By default it expects **OmniRoute** running locally on port
`20128` and uses whatever model/provider that gateway has available.

## Quick start (friend edition)

```bash
git clone <repo-url>
cd <repo>
npm run setup     # installs deps, starts OmniRoute, asks for key, picks a model
npm run dev       # run the agent
```

`npm run setup` does everything:

1. Checks Node.js is installed (get it from https://nodejs.org if not).
2. Runs `npm ci` / `npm install`.
3. Installs OmniRoute (`npm i -g omniroute`) if missing and starts it as a
   background daemon, then waits for `http://localhost:20128/api/health`.
4. Asks you to paste your **OmniRoute API key** (from the dashboard it opens —
   keys are per person, everyone configures their own).
5. Probes candidate models with a real tool-call request and picks the first
   one that answers.
6. Writes `.env` (git-ignored) with `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`.

After that, `npm run dev` just works.

## Manual configuration

Create a `.env` file in the project root (or export the variables):

```env
LLM_API_KEY=sk-your-omni-route-key
LLM_BASE_URL=http://localhost:20128/v1
LLM_MODEL=auto
```

`LLM_MODEL` is optional — default is `auto`, which lets OmniRoute choose.
Set `-m <model>` on the command line to override per-run.

To start the gateway manually (if it is not already running):

```bash
omniroute serve            # foreground, opens dashboard
omniroute serve --daemon   # background
```

## How it works

- `src/api/client.ts` — generic OpenAI-compatible SSE streaming client.
- `src/core/messageLoop.ts` — agent loop: stream → tool calls → execute →
  feed results back → stream again.
- `src/tools/` — bash / read / write / edit / glob / grep tools.
- `src/main.ts` — CLI entry; `src/setup.ts` — the auto-setup script.
- `src/utils/env.ts` — loads `.env` with env-var fallback priority.

## Notes for Windows users

- The `bash` and `grep` tools run commands through **Git Bash**
  (`C:\Program Files\Git\bin\bash.exe`) when present, so POSIX commands
  (`pwd`, `ls`, `find`, `grep -rn`) work. Install Git for Windows if you
  don't have it; otherwise the tools fall back to `cmd.exe`, where POSIX
  commands will fail.

## Privacy / logging

OmniRoute logs full request/response bodies (your prompts, file contents,
tool output) by default under `~/.omniroute/call_logs/`. Review and delete
that folder if you don't want transcripts kept. Check
`omniroute --help` / dashboard settings for retention options.

## Troubleshooting

- `Error: LLM API error (401)` → wrong/missing `LLM_API_KEY`, or the key
  has no active provider in OmniRoute. Open the dashboard (`http://localhost:20128`)
  and confirm at least one provider has a working key.
- `No active credentials for provider: kiro` (or similar) → the chosen model
  routes to a provider with no key. Re-run `npm run setup` to pick a working
  model, or set `LLM_MODEL` to one you know works.
- Agent answers but tool calls fail → the selected model rejects function
  tools; re-run `npm run setup` to probe another model.
