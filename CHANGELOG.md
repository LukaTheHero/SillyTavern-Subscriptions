# Changelog

## 3.1.0

Update: restart SillyTavern (it pulls the code), then run `npm install` inside
`plugins/SillyTavern-Subscriptions` once and restart again. The panel updates
through Extensions → Manage extensions.

**New**
- Claude Opus 5.5, Sonnet 5.5 and Sonnet 5 (bundled Claude Code CLI 2.1.285).
- Fable, Opus 4.7+ and Sonnet 5+ use their full 1M context without a separate "(1M context)" entry; old saved `[1m]` ids keep working.
- Codex verbosity setting (default medium).
- Status panel shows the Claude CLI version, readiness per selected backend, per-model weekly caps and Extra Usage in real currency.

**Fixed**
- Stop / swipe / regenerate now really cancels the generation on all three providers (it used to run to the end and use quota).
- Impersonate, quiet prompts (Summarize, captions, /gen), group nudges and Author's Note depth no longer turn into "continue the last message".
- Continue shows the model its own message instead of a fake "No response requested." turn.
- Claude replies stop at SillyTavern's max response length (finish reason "length") instead of the CLI quietly generating up to four times as much.
- Claude no longer sees your account email, the plugin folder path or git status; `@file` text in a chat is never read from disk.
- Codex roleplay turns no longer get a shell, web search or patch tools, and your AGENTS.md, skills and environment details stay out of the prompt.
- Gemini turns run a tool-less plugin agent: your GEMINI.md, skills, rules, hooks and MCP servers no longer reach the model.
- A refused or rerouted reply is always an error — no silent retry and no answer from another model (Claude, Codex and Gemini).
- "Subscription only" never bills a key: Codex refuses an API-key login, Gemini refuses an agy set up for API-key billing, and Claude Auto no longer switches to the key just because one exists.
- Connect no longer overwrites your saved Custom API key.
- Panel settings survive JSON or list-style Include Body text.
- Prefill echo stripping works for `*action*` and `"dialogue"` prefills and no longer eats words after short prefills.
- Error classifiers no longer mistake numbers in messages for HTTP 429/401.
- The listener rejects DNS-rebinding requests, and needs a token if bound beyond localhost.
- SillyTavern shutdown no longer waits for running generations.

**Known issues**
- The Claude CLI still adds a short note with the platform, model name and date; it cannot be removed without breaking subscription login.
- Claude does not run natively on Termux (no Android build of Claude Code); use proot-distro.
- Codex refuses to run while its home contains a non-empty AGENTS.md (see Troubleshooting).
- agy still titles each conversation with a second small model call and starts your MCP servers (the model cannot reach them).
