# SillyTavern — Subscriptions (Claude Max · Codex · Gemini)

Use the AI subscriptions you already pay for in SillyTavern — **Claude
Pro/Max**, **ChatGPT Plus/Pro (Codex)** and **Google Antigravity (Gemini)** —
through one server plugin and one panel, instead of per-token API keys. Each
provider also has a pay-per-token "API" backend (your own key, or a LinkAPI
relay key) for overflow when a subscription window is used up.

This is the successor of the three separate plugins
(SillyTavern-ClaudeSubscription, SillyTavern-CodexSubscription,
SillyTavern-GeminiSubscription). One listener, one model list, one panel;
pick the provider by picking the model.

## What you get

- **One endpoint, every subscription** — `claude-*`, `gpt-*` and `gemini-*`
  models in one dropdown, each routed to its own backend. Or connect to a
  single provider from the panel if you want a shorter list.
- **Claude** — Fable 5.1/5, Opus 5/4.8/4.7/4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5,
  explicit **(1M context)** variants, reasoning effort `low…max`, thinking
  modes, real multi-turn context via session resume (prompt caching works),
  roleplay isolation (no coding preamble, no host settings/MCP/tools), live
  5-hour / 7-day quota meter, OAuth auto-refresh.
- **Codex** — the live model list from your ChatGPT account (GPT-6 Astra,
  GPT-5.6 family, GPT-5.5 …) with per-model reasoning efforts (`low…ultra`),
  the Fast/priority service tier, streamed replies **and** reasoning summaries
  through the Codex app-server, your character card as the *real* system
  prompt, no MCP servers/plugins/tools touched, nothing written to disk.
- **Gemini** — Antigravity's model list (Gemini 3.8/3.7/3.6 Flash, 3.1 Pro,
  each with High/Medium/Low effort), long chats piped safely to the CLI.
- **Overflow** — per provider: *Auto* (subscription first, API key when the
  window is exhausted), *Subscription only*, or *API key only*. Works with the
  LinkAPI relay keys and toggles you may already have.
- **Stop sequences enforced server-side** (`\n{{user}}:` guards work on every
  backend), thinking displayed in SillyTavern's native reasoning box, clear
  error messages (e.g. "Codex not logged in — run `codex login`"), a status
  panel that shows exactly what each provider sees.
- **Windows, Linux, macOS and Termux (Android)**.

## Prerequisites

On the machine that runs SillyTavern (same OS user as `server.js`):

| Provider | Install | Sign in |
| --- | --- | --- |
| Claude | nothing extra — the Claude Code CLI ships inside the plugin's Agent SDK | `npm i -g @anthropic-ai/claude-code` then `claude login` (headless: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`) |
| Codex | `npm i -g @openai/codex` (or the native installer) | `codex login` |
| Gemini | Antigravity CLI from https://antigravity.google/cli | run `agy` once and complete the browser sign-in |

You only need the providers you want. SillyTavern `config.yaml` must have
`enableServerPlugins: true`.

## Install

From your SillyTavern directory (the one containing `server.js`):

```bash
node plugins.js install https://github.com/LukaTheHero/SillyTavern-Subscriptions
cd plugins/SillyTavern-Subscriptions
npm install
```

(Linux/macOS/Termux: `bash plugins/SillyTavern-Subscriptions/install.sh` does
the `npm install` and prints a doctor report.)

**Migrating from the old plugins:** remove `plugins/SillyTavern-ClaudeSubscription`
(it uses the same port 8901), and delete the old UI extensions from
`public/scripts/extensions/third-party/` — `SillyTavern-ClaudeMax`,
`SillyTavern-CodexMax`, `SillyTavern-GeminiAntigravity` and any
`SillyTavern-*Subscription` clones installed through the extension dialog. The
new panel imports your old effort/thinking settings on first load.

Restart SillyTavern. The log should show:

```
[subscriptions] installed UI extension v3.0.0 at public/scripts/extensions/third-party/SillyTavern-Subscriptions-UI
[subscriptions] standalone listener: http://127.0.0.1:8901/v1 (per-provider: /claude/v1, /codex/v1, /gemini/v1)
[subscriptions] initialised — endpoint http://127.0.0.1:8901/v1
```

Hard-refresh the browser (Ctrl+F5) after the first install.

> The repo doubles as a regular UI extension (`manifest.json` at the root), so
> the panel can also be installed from **Extensions → Install extension** with
> the same URL. That installs only the panel — the server plugin above is what
> actually talks to the subscriptions.

## Connect

1. Extensions drawer → **Subscriptions**.
2. "Connect to": *All subscriptions* (one list) or a single provider.
3. **Connect**. The Custom (OpenAI-compatible) source is configured and
   connected for you.
4. Pick a model from SillyTavern's normal model dropdown. Chat.

Settings in the panel apply from the next message — no reconnect needed.

### Panel reference

| Section | Setting | Notes |
| --- | --- | --- |
| Global | Show reasoning | Display only. Streams thinking summaries into ST's "thoughts" box (enable "Show model thoughts" in ST too). Claude and Codex stream summaries; Antigravity's CLI never exposes Gemini thoughts. |
| Claude | Backend | Auto / Subscription / API key. API keys come from ST's Custom API key field, `ST_SUBSCRIPTIONS_CLAUDE_API_KEY`, `LINKAPI_CLAUDE_API_KEY`, or `~/.claude/settings.json`'s env block (the LinkAPI toggle). Your OAuth login is never modified. |
| | Reasoning effort | `low … max`. Auto = model default. |
| | Thinking mode | Adaptive / Always on / Off. Fable and Opus 4.7+ always think. |
| | Session resume | On (recommended): real multi-turn session + prompt caching. |
| | Identity mode | Prepends the Claude Code preamble (self-identification) — off for roleplay. |
| | Fast mode | Requests `/fast`; the CLI decides, the server log shows the state. |
| Codex | Backend | Auto follows the Codex CLI config (your LinkAPI toggle included); Subscription forces the ChatGPT login; API uses `LINKAPI_CODEX_API_KEY` / `OPENAI_API_KEY` directly. |
| | Reasoning effort | Clamped to the model's supported levels. |
| | Service tier | Standard / Fast (priority) / Ultrafast where offered. |
| | Reasoning summary | auto / concise / detailed / none. |
| Gemini | Backend | Auto / Antigravity CLI / API key (`LINKAPI_ANTIGRAVITY_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`). |
| | Reasoning effort | Overrides the `-high/-medium/-low` suffix of the model id. |
| Status & quota | Refresh | Per-provider: CLI found, login state, routing (subscription vs relay), key availability, Claude 5h/7d windows, Codex rate limits. |

Leave SillyTavern's native **Reasoning Effort** dropdown on *Auto*; the panel
replaces it. Temperature/Top-P only apply on the API backends (the CLIs expose
no sampling controls).

## Endpoints

| Method | URL | Purpose |
| --- | --- | --- |
| GET | `http://127.0.0.1:8901/status` (`?deep=1`) | Health of all providers |
| GET | `http://127.0.0.1:8901/v1/models` | Unified model list (usable providers) |
| GET | `http://127.0.0.1:8901/{claude,codex,gemini}/v1/models` | One provider's list |
| GET | `http://127.0.0.1:8901/v1/usage/quota` | Claude windows + Codex rate limits |
| POST | `http://127.0.0.1:8901/v1/chat/completions` | Chat (SSE + JSON), routed by model id |
| POST | `…/{provider}/v1/chat/completions` | Same, provider forced for unknown ids |
| POST | `…/v1/embeddings` | Always `501` |
| GET | `http://<sillytavern>/api/plugins/subscriptions/status` | Same-origin health for the panel |

Direct API users can send the `subscriptions` object shown in
`docs/DESIGN.md`, the legacy `claude_subscription` / `codex_subscription` /
`gemini_subscription` objects, or plain OpenAI `reasoning_effort`.

## Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `ST_SUBSCRIPTIONS_PORT` / `_HOST` | `8901` / `127.0.0.1` | Listener |
| `ST_SUBSCRIPTIONS_NO_UI_INSTALL` | – | `1` skips the UI auto-install |
| `ST_SUBSCRIPTIONS_LIST_ALL_MODELS` | – | `1` lists every provider even when unusable here |
| `ST_SUBSCRIPTIONS_CLAUDE_PATH` | – | Explicit `claude` executable (Termux) |
| `ST_SUBSCRIPTIONS_CLAUDE_USE_RESUME` | `1` | `0` forces the fold path |
| `ST_SUBSCRIPTIONS_CLAUDE_MAX_TURNS` | `1` | SDK maxTurns |
| `ST_SUBSCRIPTIONS_CLAUDE_API_KEY` / `_BASE_URL` | – | Claude API backend |
| `ST_SUBSCRIPTIONS_CODEX_PATH` | – | Explicit `codex` executable |
| `ST_SUBSCRIPTIONS_CODEX_HOME` | CLI default | Codex home (e.g. `~/.codex` to reuse a desktop-app login) |
| `ST_SUBSCRIPTIONS_CODEX_API_KEY` / `_BASE_URL` | – | Codex API backend |
| `ST_SUBSCRIPTIONS_AGY_PATH` | – | Explicit `agy` executable |
| `ST_SUBSCRIPTIONS_GEMINI_API_KEY` / `_BASE_URL` | – | Gemini API backend |

The LinkAPI overflow variables (`LINKAPI_CLAUDE_API_KEY`,
`LINKAPI_CODEX_API_KEY`, `LINKAPI_ANTIGRAVITY_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_GEMINI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`) are picked up
automatically. Changing the port? Update **Listener base URL** in the panel.

## Linux & Termux

- Linux/macOS: install Node 18+, then the steps above. CLIs are found on PATH,
  in `~/.local/bin`, `~/.codex/bin`, `~/.agy/bin`, `/usr/local/bin`,
  `/opt/homebrew/bin` and the global npm `node_modules`.
- Termux: `pkg install nodejs-lts git`, install SillyTavern as usual, then the
  steps above. Node reports Termux as `android`, so the plugin looks for a
  `claude` on PATH (or the SDK's linux-arm64-musl build) and passes it to the
  Agent SDK. Codex from npm also runs its musl build on Termux. Run
  `npm run doctor` inside the plugin folder to see what was detected.

## Troubleshooting

- **`npm run doctor`** (inside the plugin folder) prints what the plugin sees:
  CLIs, logins, keys, catalogs. Add `--deep` for Codex account/rate limits.
- **"does not support this model; version … or newer is required"** — the
  Claude CLI inside the Agent SDK is too old: `npm install` in the plugin
  folder, restart SillyTavern.
- **Codex "not logged in"** — the CLI's home (shown in the status panel, often
  `~/.codex-cli` next to a desktop-app install at `~/.codex`) has no
  `auth.json`: run `codex login`, or set `ST_SUBSCRIPTIONS_CODEX_HOME`.
- **Port 8901 in use** — the old SillyTavern-ClaudeSubscription plugin is still
  installed; remove it.
- **Model list empty for a provider** — that provider is not usable on this
  host (no CLI and no key). Check the status panel / doctor.
- **Auth errors mid-chat (Claude)** — the plugin refreshes the OAuth token
  once per request; if it keeps failing, `claude login` as the SillyTavern
  user.

## Development

```bash
npm test                     # unit tests
node test/integration.js     # standalone listener on :8911, status + model lists
LIVE=1 node test/integration.js   # + one tiny chat per usable provider (spends quota)
```

## License

[GNU AGPL v3.0 or later](LICENSE).
