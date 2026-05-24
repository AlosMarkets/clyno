# Clino Guardrails

Clino is a local-first memory layer for terminal-based AI coding agents.

Its purpose is to help users preserve, search, and rehydrate their own project context without repeatedly re-explaining the same work to AI coding tools.

Clino must remain a user-controlled terminal memory tool, not an automation layer, proxy, credential handler, subscription bypass, or hosted model-access product.

---

## Core Positioning

Clino should be described as:

> Local memory for your terminal coding agents.

Approved positioning:

- Local-first project memory
- Terminal session memory
- Searchable AI coding session history
- Context rehydration for coding agents
- Persistent memory for user-operated CLI tools
- Markdown-native memory for AI-assisted development

Avoid positioning Clino as:

- Infinite context
- A Claude Code wrapper that extends usage
- A subscription workaround
- A model proxy
- A cheaper API replacement
- A way to automate Claude, Codex, or other coding agents at scale

---

## Product Boundary

Clino may:

- Launch user-installed terminal tools locally.
- Record terminal output that is visible to the user.
- Save local transcripts.
- Extract useful memories from local transcripts.
- Store memories in local Markdown files.
- Build a local search index over user-owned memory.
- Generate compact context blocks from relevant memories.
- Let users manually copy, paste, or inject context into their own terminal sessions.
- Let users inspect, edit, delete, export, or disable memory.
- Support multiple terminal agents through local adapters.

Clino must not:

- Provide access to Claude, OpenAI, or any model provider.
- Sell access to third-party AI subscriptions.
- Route user prompts through Clino-owned accounts.
- Proxy Claude Code, Codex, Aider, Goose, or other agents through Clino servers.
- Extract, store, reuse, or forward provider credentials.
- Read hidden authentication files from model providers.
- Share one user’s subscription with other users.
- Bypass rate limits, usage limits, session limits, or access controls.
- Run background prompt loops designed to maximize subscription usage.
- Hide from users what context is being captured or injected.

---

## Claude Code / Codex / Agent Compatibility

Clino should treat every coding agent as an external user-installed tool.

The safest integration model is:

```txt
User installs agent normally
User authenticates with provider normally
User runs agent locally through Clino
Clino observes local terminal I/O
Clino saves local memory
User remains responsible for provider terms
