# Clyno

Clyno is a local-first memory layer for terminal-based AI coding agents.

It helps developers preserve, search, and rehydrate useful project context from coding-agent sessions so they do not have to repeatedly explain the same project, decisions, bugs, and constraints every time they start a new session.

> Never explain your project to an AI coding agent twice.

---

## Install & Develop

Clyno is a Node.js CLI. It requires **Node 18+** and is not yet published to npm,
so install it from source:

```bash
npm install      # install dependencies (also builds via the prepare script)
npm run build    # compile TypeScript to dist/
npm link         # symlink the `clyno` binary onto your PATH
clyno --version  # verify the install
```

`npm link` makes the `clyno` command available globally from your shell. To
remove it later, run `npm unlink -g clyno`.

### Usage

```bash
clyno run claude       # run a coding agent through Clyno and capture the session
clyno run --review codex
clyno status           # show where memory is stored and a quick health summary
clyno find "auth"      # search stored memory
clyno inject "auth"    # print compact, relevant context for a new session
```

> **Privacy:** `.clyno/` is project-local and ignored by Git by default.
> Transcripts and memory stay on your machine unless you explicitly export them.

---

## What Clyno Is

Clyno is a local terminal memory tool.

It can run a user-installed coding agent inside a local terminal wrapper, capture the session output, extract useful project memories, store them locally, and later generate compact context blocks that can be searched or injected into a new session.

Clyno is designed for tools like:

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

## What Clyno Is Not

Clyno is not an AI model provider.

Clyno does not give users access to Claude, OpenAI, or any other model provider.

Clyno is not a proxy, subscription bypass, automation farm, hosted agent platform, or replacement for official APIs.

Clyno does not:

* provide model access
* sell access to third-party subscriptions
* bypass rate limits
* bypass usage limits
* share one user account across multiple users
* extract provider credentials
* store OAuth/session tokens
* call private provider APIs
* run Claude Code, Codex, or other agents on Clyno-owned servers
* turn subscription CLI tools into hosted API backends

Users must install and authenticate with their own coding tools normally.

---

## Why Clyno Exists

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

Clyno solves this by turning coding sessions into structured, searchable, local project memory.

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

## The Clyno Approach

Clyno separates long-term memory from active context.

The agent context window should be treated like working memory.

Clyno’s local memory store acts like project memory on disk.

Instead of injecting an entire transcript, Clyno retrieves only the relevant memories for the current task.

Example:

```bash
clyno inject auth
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

* Run a terminal coding agent through Clyno
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

Run an agent through Clyno:

```bash
clyno run claude
```

Run another command through Clyno:

```bash
clyno run codex
```

Memory write modes:

- Default: save the transcript, extract memories, and write memory automatically.
- `--review`: save the transcript and show reviewable candidates before writing memory.
- `--no-memory`: save the transcript only and skip automatic extraction.

Recommended dogfood flow:

```bash
clyno run --review codex
clyno review latest
clyno review latest --accept all
```

Show CLI help or version:

```bash
clyno help
clyno --version
```

Search memory:

```bash
clyno find "redis auth bug"
```

Inject relevant context:

```bash
clyno inject "auth"
```

Summarize a saved session:

```bash
clyno summarize .clyno/sessions/2026-05-24-20-30-00.md
```

Debug extraction quality without writing memory:

```bash
clyno inspect latest
clyno summarize --dry-run .clyno/sessions/2026-05-24-20-30-00.md
clyno summarize --show-cleaned .clyno/sessions/2026-05-24-20-30-00.md
```

`clyno inspect` shows the raw transcript path, file metadata, a cleaned-text
preview, and extraction counts. `clyno summarize --dry-run` shows the candidate
memories and final memory files that would be written without modifying
`.clyno/memory`. Add `--show-cleaned` to print the cleaned transcript text used
for extraction; use `--max-chars <n>` to limit large transcripts.

Review before writing memory:

```bash
clyno review latest
clyno review latest --accept all
clyno review latest --skip
clyno review .clyno/sessions/<file>.md --accept decision-1,todo-1
clyno review .clyno/sessions/<file>.md --skip
```

`clyno review` runs the same extraction pipeline as `summarize`, shows
deterministic candidate IDs, and is read-only unless `--accept` or `--skip` is
provided. Use `--accept all` to write every candidate or pass a comma-separated ID
list to write only selected memories. Add `--no-summary` with `--accept all` to
skip the synthesized summary.

`clyno review latest` selects the newest **pending** session (one without a marker
in `.clyno/reviews/`), not simply the newest transcript file. If every session is
already reviewed or skipped, it prints `No pending review sessions.` and exits 0.

Zero-candidate sessions can still be closed out: `clyno review latest --accept all`
creates a reviewed marker, writes no memory, and prints `Marked session as reviewed.`
Use `--skip` to mark a session reviewed without writing memory when you do not want
to accept any candidates.

Explicit `clyno review <session-file>` still works for any transcript path, even if
that session already has a reviewed or skipped marker.

Review tracking:

- `clyno review pending` lists sessions without a marker in `.clyno/reviews/`.
- Reviewed or skipped sessions get a local marker under `.clyno/reviews/`.
- Raw sessions remain untouched.

Manage stored memory:

```bash
clyno memory list
clyno memory show <id>
clyno memory delete <id>
clyno memory delete <id> --dry-run
```

Memory IDs are human-readable display IDs like `decision-1`, `todo-1`, and
`bug-1`. Memory IDs are display IDs generated from the current list; run
`clyno memory list` before resolving or deleting to see current IDs. Memory
management is local and private: listing and showing memories does not create
`.clyno/`, and deletion only edits the selected markdown memory item, not raw
session transcripts.

Memory rebuild:

```bash
clyno memory rebuild --dry-run
clyno memory rebuild
```

Use rebuild after Clyno's extraction filters improve and older `.clyno/memory`
files contain stale noisy memories. The dry run reads all raw transcripts in
`.clyno/sessions`, shows the memory that would be produced, and does not modify
files. A real rebuild leaves raw sessions untouched, backs up the old memory to
`.clyno/backups/memory-YYYY-MM-DDTHH-mm-ss/`, then replaces `.clyno/memory`
using the current extraction logic.

Check where memory is stored and a quick health summary:

```bash
clyno status
```

Diagnose local setup, storage, and runtime checks:

```bash
clyno doctor
```

Example output:

```txt
Clyno doctor

Version: clyno 0.1.0
Node: v22.x.x
Platform: linux x64
CWD: /home/you/project

Storage:
- Home: /home/you/project/.clyno
- Mode: project-local Git root
- Git repo: yes
- Git ignored: yes
- Sessions dir: exists
- Memory dir: exists

Runtime:
- node-pty: ok
- CLI bin: ok (./dist/index.js)
- Build output: exists (dist/index.js)

Warnings:
- none
```

Example output:

```txt
Clyno status

Home: /home/you/project/.clyno
Storage mode: project-local
CLYNO_HOME override: not set
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
- clyno find "auth"
- clyno inject "storage"
- clyno run claude
```

`clyno status` is read-only — it never creates `.clyno/` or any memory file, so
you can run it in a fresh project to see the resolved path and zero counts.

### Resolving stale memory

```bash
clyno resolve todo-1
clyno resolve bug-1
clyno resolve "clyno status command"
```

Mark an open TODO or bug as completed. When you `clyno resolve <id>`, Clyno:
- Creates a resolved memory entry preserving the original text
- Suppresses the open item from `clyno inject` output (shows it under Recently Resolved instead)
- Keeps the original TODO/bug in place — nothing is deleted

Resolved items are also matched by text. The command `clyno resolve "status command"` creates a resolved marker that suppresses any open TODO containing those keywords.

Example:
```txt
$ clyno resolve todo-1
Resolved todo-1:
  Add clyno status command.

Created resolved memory:
  Resolved: Add clyno status command.
```

---

## Local Storage

Clyno stores project memory locally.

Example structure:

```txt
.clyno/
  sessions/
    2026-05-24-20-30-00.md
  memory/
    decisions.md
    todos.md
    bugs.md
    errors.md
    resolved.md
    summaries.md
```

Raw transcripts live in `.clyno/sessions`.

Extracted project memory lives in `.clyno/memory`.

Search is currently keyword-based over these markdown files — there is no
database or index on disk in the MVP. (A future SQLite/FTS index is on the
roadmap; see ROADMAP.md.)

`.clyno/` is **ignored by Git by default** for privacy — transcripts and memory
stay on your machine and are never committed. You can choose
to export or curate-and-commit selected memory later (e.g. `git add -f` on a
specific file), but that is an explicit, manual choice and not the MVP default.

Storage is **project-local by default** so memory never leaks between unrelated
projects. The Clyno home directory is resolved in this order:

1. `CLYNO_HOME`, if set — used exactly as given.
2. `<git-root>/.clyno`, when run inside a Git repository (found by walking up for `.git`).
3. `<cwd>/.clyno` otherwise.

All commands (`run`, `inspect`, `review`, `summarize`, `memory`, `find`, `inject`, `status`, `doctor`) share this resolved home.
`~/.clyno` is no longer used for project memory; it may be reserved for global
config later.

---

## Memory Types

Clyno extracts and stores useful signals such as:

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

Clyno memory should be compact, useful, and deduplicated.

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

Clyno should split compound statements into separate memories when they contain different signals.

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

Clyno should not dump the full memory folder into an agent session.

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

Clyno is local-first.

By default:

* project memory is stored locally under the project `.clyno/`
* the entire `.clyno/` directory is ignored by Git by default for privacy
* transcripts stay on the user’s machine
* memories stay on the user’s machine
* indexes stay on the user’s machine
* no provider credentials are collected
* no cloud sync is enabled
* no telemetry is required

### Secret redaction

Clyno redacts obvious secrets before they can be stored or shown. Detection is
rule-based and covers common high-risk strings — API keys (`sk-…`, `ghp_…`,
`github_pat_…`, `xox…`), JWTs, PEM private-key blocks, credentialed URLs
(`postgres://user:pass@…`), OAuth query params, and secret-y env assignments
(`OPENAI_API_KEY=…`, `DATABASE_URL=…`). Detected values are replaced with
`[REDACTED_SECRET]`, keeping the surrounding context readable.

Redaction applies to everything that leaves the raw transcript: cleaned
extraction output, memory files, `clyno find` / `clyno inject` output, review
candidates, and synthesized summaries. A candidate that is *only* a secret line
is dropped entirely; a useful memory that merely mentions a secret is kept with
the value redacted.

Raw transcripts on disk are local and intentionally left unchanged. This is an
MVP guardrail, not a guarantee — it does not yet scan or rewrite already-stored
memory, and it is not a substitute for keeping secrets out of your terminal.

Users should be able to inspect, edit, delete, and export their own memory.

Sharing memory is opt-in: a project can manually export or commit curated
memory files later, but committing memory is not the MVP default. (A convenience
command such as `clyno init --track-memory` may be added in the future; it does
not exist today.)

Cloud features, team sync, or sharing features should only exist as explicit opt-in features in the future.

---

## Provider Compatibility

Clyno treats coding agents as external user-installed tools.

The safe integration model is:

```txt
User installs the coding agent
User authenticates with the provider normally
User runs the agent locally through Clyno
Clyno observes local terminal I/O
Clyno stores local memory
User remains responsible for provider terms
```

Clyno should use documented integration methods where available.

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

Clyno does not provide access to any AI model, coding agent, or subscription service.

Users are responsible for complying with the terms of the tools they run through Clyno.

Clyno is intended to record and organize terminal output visible to the user. It is not intended to bypass limits, automate account sharing, extract credentials, proxy requests, or provide model access.

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
4. Improve `clyno inject` formatting
5. Add injection limits
6. Add tests for extraction and injection quality
7. Replace placeholder process spawning with proper PTY support
8. Keep the project local-first and CLI-focused

---

## Non-Goals

Clyno is not trying to be:

* a general AI chatbot
* a model router
* a Claude/OpenAI API alternative
* a hosted coding-agent service
* a team account-sharing product
* an autonomous coding swarm
* a project management suite
* a replacement for Git
* a replacement for official provider tools

Clyno’s job is narrower:

> preserve useful project memory from terminal coding-agent sessions and make it easy to reuse later.

---

## Success Criteria

Clyno is working if this loop feels reliable:

```txt
A developer runs a coding agent through Clyno.
Clyno captures the session without breaking the terminal.
Clyno extracts useful project memory.
The developer closes the session.
The developer comes back later.
The developer searches for relevant memory.
Clyno returns the right decisions, bugs, TODOs, and summaries.
The developer injects compact context into a new agent session.
The agent continues with enough context to be useful.
```

If this loop is not excellent, do not add more features.

---

## North Star

Clyno exists to help developers avoid repeating themselves.

The product promise is:

> Never explain your project to an AI coding agent twice.

Every feature should support that promise while preserving user control, local-first privacy, and respect for third-party provider terms.
