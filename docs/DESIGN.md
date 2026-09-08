# SillyTavern-Subscriptions — design notes

This plugin fuses three earlier plugins (SillyTavern-ClaudeSubscription,
SillyTavern-CodexSubscription, SillyTavern-GeminiSubscription) into one server
plugin + one UI panel. This file records the decisions that are not obvious
from the code.

## Why one plugin

Three plugins meant three listeners (8901/8902/8903), three panels each
injecting its own `custom_include_body` block, three copies of the same SSE /
stop-sequence / folding code, and — the actual failure the user hit — two of
the server plugins were never installed while their panels were, so "Connect"
pointed at ports nobody listened on.

Now: **one listener (8901), one model list, one panel**. The provider is
inferred from the model id (`claude-*`, `gpt-*`/`o*`, `gemini-*`); the panel's
"Connect to" scope only decides which prefix the endpoint uses (`/v1`,
`/claude/v1`, `/codex/v1`, `/gemini/v1`) and therefore which models the list
shows.

## Request settings channel

SillyTavern forwards `custom_include_body` (YAML) unconditionally for Custom
sources, so the panel injects:

```yaml
subscriptions:
  show_reasoning: true
  claude: { backend, effort, thinking, identity_mode, use_resume, fast_mode }
  codex:  { backend, effort, service_tier, reasoning_summary }
  gemini: { backend, effort }
```

The three legacy namespaces (`claude_subscription`, `codex_subscription`,
`gemini_subscription`) are still parsed so an old panel keeps working during
migration. Precedence: unified namespace > legacy namespace > OpenAI
`reasoning_effort`.

## Backends per provider

| Provider | `subscription` | `api` | `auto` |
| --- | --- | --- | --- |
| Claude | Agent SDK with the OAuth login (`claude login`) | SDK with `ANTHROPIC_BASE_URL` + key/token and `CLAUDE_CONFIG_DIR` pointed at an empty plugin dir so the OAuth login is invisible (no credential stashing) | subscription; a quota-exhausted reply retries the same request on the API key when one exists |
| Codex | app-server, `modelProvider: "openai"` | direct OpenAI-compatible HTTP when a key exists (clean `messages[]`), else app-server with the overflow provider from `config.toml` | app-server exactly as the CLI is configured (so the LinkAPI toggle is honoured); direct HTTP when no CLI but a key |
| Gemini | `agy` print mode | direct HTTP to `GOOGLE_GEMINI_BASE_URL` (default LinkAPI) | agy when installed, else key |

## Claude specifics (carried over + fixed)

* Synthetic session resume (`resume` + one-shot `SessionStore`) gives real
  multi-turn context and prompt caching; fold fallback for first turns.
* **Agent SDK ≥ 0.3.263.** 0.2.141 bundles Claude Code 2.1.141, and Anthropic
  now rejects Fable on anything below 2.1.251 ("does not support this model").
* The CLI reports locally generated errors as an assistant message with
  `model: "<synthetic>"`. The old served-model guard tripped on that and hid the
  real text ("Model substitution refused … resolved to <synthetic>"). Now the
  synthetic text *is* the error, classified like any other.
* `rate_limit_event` stream messages feed the quota meter for free (the OAuth
  usage endpoint remains the on-demand source).
* The subprocess env scrubs `CLAUDECODE`/`CLAUDE_CODE_*` so SillyTavern started
  from inside a Claude Code terminal still works.
* Subprocess `cwd` must be a real path: spawning from inside the Claude desktop
  app's virtualised AppData fails with `ENOTCONN` — the plugin uses
  `<plugin>/.runtime/`.

## Codex specifics

* `codex exec --json` gives no token streaming; `codex app-server` (JSON-RPC
  over stdio) streams `item/agentMessage/delta`, reasoning summaries, token
  usage and rate limits, accepts `baseInstructions` (replacing the coding
  system prompt), `ephemeral: true` threads, and `turn/interrupt` (used for
  stop sequences and client disconnects). One process is kept alive.
* `--ignore-user-config` is not available on app-server and would drop the
  auth/provider setup anyway; isolation is per-name `-c
  mcp_servers.X.enabled=false`, `plugins."X".enabled=false`, `notify=[]`,
  `project_doc_max_bytes=0`, read-only sandbox, approval policy `never`, and
  every server→client approval request is refused.
* The CLI may use `~/.codex-cli` (desktop-app machines) or `~/.codex`; the
  `initialize` response reports the real home and the isolation flags are
  recomputed against it if the guess was wrong.
* Model catalog is live (`model/list`), then `models_cache.json`, then a static
  snapshot. Efforts are clamped to what the model supports.

## Gemini specifics

* Prompt on **stdin** with `--input-format text` (no `-p`): avoids the
  command-line length limit on long chats.
* agy never streams thoughts in stream-json mode; reasoning display only
  works on the `api` backend. Tools cannot be disabled by flag, so the prompt
  carries a text-only instruction and cwd is the plugin scratch dir.

## Platform

* Executable resolution (`lib/common/exec.js`) never spawns Windows `.cmd`
  shims or npm's POSIX shell shims: it prefers `.exe`, then the package's JS
  launcher under the global `node_modules` (run with the current Node), then
  native-installer paths, then PATH. Termux adds `$PREFIX/bin` and
  `$PREFIX/lib/node_modules`.
* On Android the Agent SDK cannot find its platform package (keyed on
  `process.platform`); the plugin passes the musl build or a global `claude`
  via `pathToClaudeCodeExecutable`.
