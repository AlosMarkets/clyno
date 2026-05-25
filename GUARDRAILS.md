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
```

Clino should not depend on unofficial credential access, private APIs, reverse engineering, or hidden provider internals.

Preferred integration methods:

- PTY wrapper
- Local terminal logging
- User-approved context injection
- User-visible temporary context files
- Documented CLI flags or config options
- Documented hooks, if officially supported by the agent

Avoid:

- Token extraction
- OAuth/session reuse
- Provider account scraping
- Automated login handling
- Private endpoint calls
- Simulated hidden API clients
- Multi-user account multiplexing

---

## Privacy Principles

Clino is local-first by default.

Default behavior:

- No transcripts leave the user’s machine.
- No memory leaves the user’s machine.
- No telemetry is enabled by default.
- No provider credentials are collected.
- No automatic cloud sync.
- No team sharing without explicit opt-in.

If cloud features are added later, they must be:

- Optional
- Explicitly enabled by the user
- Clearly explained before activation
- Easy to disable
- Designed with encryption and deletion controls
- Auditable by the user

Sensitive data handling:

- Users must be able to delete any session, memory, or index.
- Memory files should be stored in a clear, user-controlled folder.
- Clino should keep `.clino/` ignored by Git by default.
- Clino should warn before any future export/share/commit workflow.
- Clino should avoid storing API keys, tokens, passwords, or private credentials.
- Secret detection should be added before any Git integration.

---

## Memory Capture Rules

Clino should capture only what is necessary to create useful project memory.

Prefer storing:

- Architectural decisions
- Implementation plans
- Bug fixes
- Known issues
- Failed attempts
- Environment setup notes
- Commands that changed the project
- TODOs
- Constraints
- Important file references
- Summaries of completed work

Avoid storing unnecessary noise:

- Spinners
- Progress bars
- Repeated logs
- Token counters
- Large raw stack traces unless relevant
- Duplicate assistant messages
- Full generated files unless explicitly useful
- Secrets or credentials
- Temporary terminal clutter
- Terminal UI control codes
- Agent narration that does not contain project memory

Raw transcripts may be stored locally, but memory extraction should aggressively reduce noise.

---

## Context Injection Rules

Context injection must be selective, compact, and user-visible.

Clino should:

- Inject only relevant memories.
- Respect a default character/token budget.
- Show the generated context before or during injection.
- Deduplicate repeated memories.
- Prefer current, high-confidence memories.
- Separate decisions, TODOs, bugs, summaries, and constraints.
- Include source references when useful.
- Avoid dumping the entire memory folder into an agent.

Clino should not:

- Automatically inject huge histories.
- Hide injected context from the user.
- Inject memories from unrelated projects.
- Inject stale or superseded decisions without marking them.
- Repeatedly inject the same memory in one context block.

Recommended defaults:

```txt
Default max chars: 6000
Default max items: 8
Prefer exact query matches
Prefer decisions and active TODOs
Prefer recent memories
Deduplicate before output
```

---

## Automation Guardrails

Clino should remain a memory assistant, not an autonomous usage amplifier.

Allowed automation:

- Saving transcripts
- Extracting memory after a session
- Updating local Markdown files
- Searching local memory
- Generating context blocks
- Optional user-triggered injection

Restricted automation:

- Background prompt loops
- Fully autonomous coding sessions without user supervision
- Queueing large numbers of prompts
- Running multiple provider sessions from one account
- Any feature designed to bypass rate limits or usage limits
- Any feature that turns a subscription CLI into a hosted API

If Clino later supports workflows or agents, they must require clear user intent and must respect provider terms.

---

## Legal / Terms-of-Service Posture

Clino is not a legal advisor and should not claim that all third-party usage is allowed.

Documentation should include language like:

```txt
Clino does not provide access to any AI model or coding agent. Users are responsible for complying with the terms of the tools they run through Clino.
```

Recommended public disclaimer:

```txt
Clino is a local terminal memory tool. It records and organizes terminal output visible to the user. It does not bypass rate limits, automate account sharing, extract credentials, proxy requests, or provide model access.
```

Do not market Clino as a way to:

- Increase Claude Code limits
- Avoid API pricing
- Share one account across a team
- Replace official APIs
- Run provider tools as backend infrastructure

---

## Integration Guardrails

Before adding a new agent integration, answer:

1. Does this integration use only documented behavior?
2. Does the user authenticate with the provider directly?
3. Does Clino avoid touching credentials?
4. Is all captured context visible to the user?
5. Can the user disable capture?
6. Can the user delete memory?
7. Does this avoid bypassing provider limits?
8. Does this avoid turning the user’s subscription into a shared service?

If any answer is “no,” do not ship the integration until redesigned.

---

## Memory Quality Guardrails

Clino memory should be useful, compact, and accurate.

Extraction should:

- Strip terminal control codes before extraction.
- Remove terminal UI chrome and agent interface noise.
- Split compound statements into separate memories.
- Classify decisions, bugs, TODOs, errors, plans, and summaries correctly.
- Remove duplicates.
- Track source session.
- Track timestamp.
- Track confidence where possible.
- Mark superseded memories where possible.
- Avoid treating speculation as fact.
- Avoid storing low-value repeated messages.
- Avoid storing agent process narration as memory.

Example:

Bad memory:

```txt
We decided to use JWT auth and need to fix Redis blacklist bug.
```

Better memory:

```txt
Decision: Use JWT authentication.

Open Bug/TODO: Fix Redis blacklist bug.
```

---

## Git Guardrails

Memory files may contain sensitive project information.

For MVP, Clino should keep all `.clino/` state ignored by Git by default.

Before enabling any future Git integration, Clino must:

- Warn users that memory may contain private information.
- Provide `.gitignore` recommendations.
- Detect common secrets before commit.
- Let users approve exactly what is committed.
- Support private memory folders outside the repository.
- Avoid auto-committing raw transcripts by default.

Default `.gitignore`:

```gitignore
.clino/
```

Only export or commit memory files if the user explicitly wants project memory in version control.

---

## Security Guardrails

Clino should never intentionally collect or store:

- API keys
- OAuth tokens
- Session cookies
- Passwords
- SSH keys
- Provider auth files
- Billing information
- Private account tokens

If detected in terminal output or memory, Clino should:

- Redact the secret where possible.
- Warn the user.
- Avoid indexing it.
- Avoid injecting it later.
- Avoid committing it to Git.

Future security features should include:

- Secret scanning
- Local encryption at rest
- Per-project memory deletion
- Memory export/import controls
- Audit log for sync or sharing features

---

## MVP Scope Guardrails

The MVP should stay focused on the smallest useful loop:

```txt
capture → summarize → store → search → inject
```

Build now:

- CLI
- PTY wrapper
- Local transcript saving
- Rule-based extraction
- Markdown memory files
- Simple search
- Compact context injection
- Deduplication
- Transcript cleaning
- Basic tests

Do not build yet:

- Desktop GUI
- Team sync
- Cloud accounts
- Marketplace
- Graph memory
- Contextual bandits
- Voice memory
- Cross-project analytics
- Hosted agent execution
- Provider API proxying
- Background autonomous workers

Only add advanced features after the local CLI is reliable.

---

## Product Test

Clino is on-track if this works:

```txt
A user runs a coding agent through Clino for one real session.
Clino captures the session without breaking the terminal.
Clino extracts useful memory.
The user closes the session.
The user returns later.
The user searches memory and finds the right decision.
The user injects a compact context block.
The next agent understands the project without a full history replay.
```

If that loop is not excellent, do not add more features.

---

## North Star

Clino should help users avoid repeating themselves.

The product promise is:

> Never explain your project to an AI coding agent twice.

Everything Clino builds should support that promise without compromising user privacy, provider terms, or user control.
