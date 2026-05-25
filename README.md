# Clino

Clino is a local-first memory layer for terminal-based AI coding agents.

It helps developers preserve, search, and rehydrate useful project context from coding-agent sessions so they do not have to repeatedly explain the same project, decisions, bugs, and constraints every time they start a new session.

> Never explain your project to an AI coding agent twice.

---

## What Clino Is

Clino is a local terminal memory tool.

It can run a user-installed coding agent inside a local terminal wrapper, capture the session output, extract useful project memories, store them locally, and later generate compact context blocks that can be searched or injected into a new session.

Clino is designed for tools like:

- Codex CLI
- Claude Code
- Aider
- Goose
- other terminal-based AI coding agents

The core loop is:

```txt
capture → summarize → store → search → inject
```

---

## What Clino Is Not

Clino is not an AI model provider.

Clino does not give users access to Claude, OpenAI, or any other model provider.

Clino is not a proxy, subscription bypass, automation farm, hosted agent platform, or replacement for official APIs.

Clino does not:

* provide model access
* sell access to third-party subscriptions
* bypass rate limits
* bypass usage limits
* share one user account across multiple users
* extract provider credentials
* store OAuth/session tokens
* call private provider APIs
* run Claude Code, Codex, or other agents on Clino-owned servers
* turn subscription CLI tools into hosted API backends

Users must install and authenticate with their own coding tools normally.

---

## Why Clino Exists

AI coding agents are powerful, but their sessions are often temporary.

A developer may spend hours with an agent explaining:

* architecture decisions
* current bugs
* implementation plans
* project constraints
* environment setup
* failed attempts
* TODOs
* file structure
* why something was built a certain way

Then the next session starts, and much of that context is gone.

Existing approaches usually involve:

* pasting huge summaries manually
* replaying old terminal history
* copying notes into markdown files
* relying on agent-specific memory
* wasting tokens on irrelevant context

Clino solves this by turning coding sessions into structured, searchable, local project memory.

---

## The Problem

Terminal coding-agent sessions are usually ephemeral.

Important context gets lost inside:

* terminal scrollback
* chat history
* raw transcripts
* repeated prompts
* long logs
* noisy tool output
* forgotten decisions

When a developer resumes work later, the agent often lacks the context needed to continue safely.

This causes:

* repeated explanations
* duplicated work
* inconsistent decisions
* wasted tokens
* forgotten bugs
* stale plans
* context window bloat

---

## The Clino Approach

Clino separates long-term memory from active context.

The agent context window should be treated like working memory.

Clino’s local memory store acts like project memory on disk.

Instead of injecting an entire transcript, Clino retrieves only the relevant memories for the current task.

Example:

```bash
clino inject auth
```

Might return:

```md
# Project Context: auth

## Decisions
- Use JWT authentication because it is stateless.
  Source: 2026-05-24-20-30-00.md
  Date: 2026-05-24

## Open Bugs / TODOs
- Fix Redis blacklist bug.
  Source: 2026-05-24-20-30-00.md
  Date: 2026-05-24

## Summary
Auth work currently centers on JWT authentication, Redis blacklist handling, and auth unit test coverage.
```

The result is compact, relevant context instead of a giant history dump.

---

## Core Features

Current MVP goals:

* Run a terminal coding agent through Clino
* Capture session transcripts locally
* Extract useful memories from sessions
* Store memories as markdown files
* Search memories by query
* Generate compact context blocks
* Deduplicate repeated memories
* Classify decisions, TODOs, bugs, errors, plans, and summaries
* Keep all data local by default

---

## Example Commands

Run an agent through Clino:

```bash
clino run claude
```

Run another command through Clino:

```bash
clino run codex
```

Search memory:

```bash
clino find "redis auth bug"
```

Inject relevant context:

```bash
clino inject "auth"
```

Summarize a saved session:

```bash
clino summarize .clino/sessions/2026-05-24-20-30-00.md
```

Check where memory is stored and a quick health summary:

```bash
clino status
```

Example output:

```txt
Clino status

Home: /home/you/project/.clino
Storage mode: project-local
CLINO_HOME override: not set
Git repo: yes
Git ignored: yes

Sessions: 1
Memory files: 3
- decisions: 1
- todos: 1
- bugs: 0
- errors: 0
- summaries: 1

Try:
- clino find "auth"
- clino inject "storage"
- clino run claude
```

`clino status` is read-only — it never creates `.clino/` or any memory file, so
you can run it in a fresh project to see the resolved path and zero counts.

---

## Local Storage

Clino stores project memory locally.

Example structure:

```txt
.clino/
  sessions/
    2026-05-24-20-30-00.md
  memory/
    decisions.md
    todos.md
    bugs.md
    errors.md
    summaries.md
  index.db
  cache/
```

Raw transcripts live in `.clino/sessions`.

Extracted project memory lives in `.clino/memory`.

Search indexes and cache files live locally.

`.clino/` is **ignored by Git by default** for privacy — transcripts, memory,
indexes, and cache stay on your machine and are never committed. You can choose
to export or curate-and-commit selected memory later (e.g. `git add -f` on a
specific file), but that is an explicit, manual choice and not the MVP default.

Storage is **project-local by default** so memory never leaks between unrelated
projects. The Clino home directory is resolved in this order:

1. `CLINO_HOME`, if set — used exactly as given.
2. `<git-root>/.clino`, when run inside a Git repository (found by walking up for `.git`).
3. `<cwd>/.clino` otherwise.

All commands (`run`, `summarize`, `find`, `inject`) share this resolved home.
`~/.clino` is no longer used for project memory; it may be reserved for global
config later.

---

## Memory Types

Clino extracts and stores useful signals such as:

### Decisions

Architecture choices, technology choices, and important implementation decisions.

Example:

```txt
Use JWT authentication because it is stateless.
```

### TODOs

Pending tasks or unfinished work.

Example:

```txt
Add unit tests for auth module.
```

### Bugs

Known issues, regressions, and things that need fixing.

Example:

```txt
Fix Redis blacklist bug.
```

### Errors

Important errors that affected development.

Example:

```txt
Module type not specified in package.json.
```

### Plans

Implementation strategies or near-term direction.

Example:

```txt
Replace placeholder spawn with node-pty for proper terminal handling.
```

### Summaries

Compact descriptions of what happened in a session or component.

Example:

```txt
Auth work currently centers on JWT authentication, Redis blacklist handling, and auth test coverage.
```

---

## Memory Quality Rules

Clino memory should be compact, useful, and deduplicated.

It should avoid storing repeated raw sentences.

Bad memory:

```txt
We decided to use JWT auth and need to fix Redis blacklist bug.
```

Better memory:

```txt
Decision: Use JWT auth.

Open Bug / TODO: Fix Redis blacklist bug.
```

Clino should split compound statements into separate memories when they contain different signals.

The same memory should not appear repeatedly in one memory file or one injected context block.

---

## Context Injection Rules

Injected context should be:

* relevant
* compact
* deduplicated
* grouped by type
* source-aware
* date-aware when possible
* small enough to avoid wasting tokens

Clino should not dump the full memory folder into an agent session.

Default limits:

```txt
max items: 8
max chars: 6000
```

Ranking should prefer:

1. exact query matches
2. decisions
3. open bugs / TODOs
4. recent summaries
5. older general notes

---

## Privacy Model

Clino is local-first.

By default:

* project memory is stored locally under the project `.clino/`
* the entire `.clino/` directory is ignored by Git by default for privacy
* transcripts stay on the user’s machine
* memories stay on the user’s machine
* indexes stay on the user’s machine
* no provider credentials are collected
* no cloud sync is enabled
* no telemetry is required

Users should be able to inspect, edit, delete, and export their own memory.

Sharing memory is opt-in: a project can manually export or commit curated
memory files later, but committing memory is not the MVP default. (A convenience
command such as `clino init --track-memory` may be added in the future; it does
not exist today.)

Cloud features, team sync, or sharing features should only exist as explicit opt-in features in the future.

---

## Provider Compatibility

Clino treats coding agents as external user-installed tools.

The safe integration model is:

```txt
User installs the coding agent
User authenticates with the provider normally
User runs the agent locally through Clino
Clino observes local terminal I/O
Clino stores local memory
User remains responsible for provider terms
```

Clino should use documented integration methods where available.

Preferred methods:

* local PTY wrapper
* local terminal logging
* user-visible context files
* documented CLI flags
* documented hooks
* user-approved context injection

Avoid:

* token extraction
* hidden API calls
* private endpoint usage
* account scraping
* automated login handling
* multi-user account sharing

---

## Legal / Terms Note

Clino does not provide access to any AI model, coding agent, or subscription service.

Users are responsible for complying with the terms of the tools they run through Clino.

Clino is intended to record and organize terminal output visible to the user. It is not intended to bypass limits, automate account sharing, extract credentials, proxy requests, or provide model access.

---

## MVP Scope

The MVP should stay focused on the smallest useful loop:

```txt
capture → summarize → store → search → inject
```

Build now:

* CLI
* PTY wrapper
* local transcript saving
* rule-based extraction
* markdown memory files
* simple search
* compact context injection
* deduplication
* basic tests

Do not build yet:

* desktop GUI
* team sync
* cloud accounts
* marketplace
* graph memory
* contextual bandits
* voice memory
* hosted agent execution
* provider API proxying
* background autonomous workers

The CLI should become reliable before advanced features are added.

---

## Current Development Priorities

Near-term priorities:

1. Improve memory deduplication
2. Improve classification
3. Split compound memories into clean signals
4. Improve `clino inject` formatting
5. Add injection limits
6. Add tests for extraction and injection quality
7. Replace placeholder process spawning with proper PTY support
8. Keep the project local-first and CLI-focused

---

## Non-Goals

Clino is not trying to be:

* a general AI chatbot
* a model router
* a Claude/OpenAI API alternative
* a hosted coding-agent service
* a team account-sharing product
* an autonomous coding swarm
* a project management suite
* a replacement for Git
* a replacement for official provider tools

Clino’s job is narrower:

> preserve useful project memory from terminal coding-agent sessions and make it easy to reuse later.

---

## Success Criteria

Clino is working if this loop feels reliable:

```txt
A developer runs a coding agent through Clino.
Clino captures the session without breaking the terminal.
Clino extracts useful project memory.
The developer closes the session.
The developer comes back later.
The developer searches for relevant memory.
Clino returns the right decisions, bugs, TODOs, and summaries.
The developer injects compact context into a new agent session.
The agent continues with enough context to be useful.
```

If this loop is not excellent, do not add more features.

---

## North Star

Clino exists to help developers avoid repeating themselves.

The product promise is:

> Never explain your project to an AI coding agent twice.

Every feature should support that promise while preserving user control, local-first privacy, and respect for third-party provider terms.

