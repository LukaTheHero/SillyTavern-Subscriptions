# Changelog

## 3.1.0

Update: restart SillyTavern (it pulls the code), then run `npm install` inside
`plugins/SillyTavern-Subscriptions` once and restart again. The panel updates
through Extensions → Manage extensions. Gemini now needs agy 1.2.11+
(`agy update`); keep the Codex CLI current (`npm i -g @openai/codex@latest`).

**New**
- Claude Opus 5.5, Sonnet 5.5 and Sonnet 5 (bundled Claude Code CLI 2.1.285).
- Fable, Opus 4.7+ and Sonnet 5+ use their full 1M context without a separate "(1M context)" entry; old saved `[1m]` ids keep working.
- Codex verbosity setting (default medium). Codex effort "Auto" now sends the model's own default instead of inheriting the coding effort from your Codex config (which could be xhigh/ultra).
- Status panel shows the Claude CLI version, readiness per selected backend, per-model weekly caps and Extra Usage in real currency.

**Fixed**
- Stop / swipe / regenerate now really cancels the generation on all three providers (it used to run to the end and use quota).
- Impersonate, quiet prompts (Summarize, captions, /gen), group nudges and Author's Note depth no longer turn into "continue the last message".
- Continue shows the model its own message instead of a fake "No response requested." turn.
- Claude replies stop at SillyTavern's max response length (finish reason "length") instead of the CLI quietly generating up to four times as much.
- Claude no longer sees your account email or git status, runs from a plugin-owned folder, and never reads `@file` text in a chat from disk.
- Codex roleplay turns no longer get a shell or web search, and your AGENTS.md, skills and environment details stay out of the prompt.
- Gemini turns run a tool-less plugin agent: your GEMINI.md, skills, rules, hooks and MCP servers no longer reach the model.
- A refused or rerouted reply is always an error — no silent retry and no answer from another model (Claude, Codex and Gemini).
- "Subscription only" never bills a key: Claude checks the CLI's credential before every request (a stored Console key or another provider is refused), Codex refuses an API-key login or a relay base URL, Gemini refuses an agy set up for API-key billing, and Claude Auto no longer switches to the key just because one exists.
- The shared Custom API key field is never sent to the wrong vendor (an `sk-ant-` key never reaches OpenAI, and so on).
- Non-streaming errors now show the plugin's message in SillyTavern instead of just "Bad Request".
- Connect no longer overwrites your saved Custom API key.
- Panel settings survive JSON or list-style Include Body text.
- Prefill echo stripping works for `*action*` and `"dialogue"` prefills and no longer eats words after short prefills.
- Error classifiers no longer mistake numbers in messages for HTTP 429/401.
- The listener rejects DNS-rebinding requests, and needs a token if bound beyond localhost.
- SillyTavern shutdown no longer waits for running generations.

**Known issues**
- The Claude CLI still adds a short note (working directory inside the plugin, platform, shell, OS, model name, date); it cannot be removed without breaking subscription login.
- Claude on macOS: the plugin cannot refresh a Keychain login, so an expired one asks you to run `claude` once — or use `claude setup-token` for a long-lived token.
- Max response length is not enforced on the Codex app-server and agy paths (no output cap there).
- Claude does not run natively on Termux (no Android build of Claude Code); use proot-distro.
- Codex refuses to run while its home contains a non-empty AGENTS.md (see Troubleshooting).
- agy still titles each conversation with a second small model call, starts your MCP servers (the model cannot reach them), adds your local time, and re-asks a safety-blocked prompt once internally before the plugin stops it (the reply is discarded as a refusal).
- Codex still declares its patch and ask-user tools to the model; the read-only sandbox and the plugin's guards neutralise them.
