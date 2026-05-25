## Where Clyno actually is now

Current reality:

```txt
Built:
- TypeScript CLI
- real node-pty `clyno run`
- project-local `.clyno/`
- private-by-default Git behavior
- transcript capture
- transcript cleaning
- memory extraction
- phrase repair
- dedupe
- resolved memory tracking
- `find`
- `inject`
- `status`
- docs/guardrails
- 45 passing tests
```

So the new trajectory should be:

```txt
Turn the working prototype into a reliable daily-use CLI.
```

# New strategic direction

The next version of the roadmap should be centered around **MVP readiness**, not intelligence.

The product is now:

> A local-first CLI memory layer for terminal AI coding agents.

The next question is:

> Can a developer install this, run Claude/Codex through it for a week, and trust the memory it produces?

That means the next roadmap should focus on:

1. CLI polish
2. memory trust
3. manual control
4. real-session dogfooding
5. installability
6. documentation
7. safety/privacy
8. only then smarter search

## The new roadmap should probably be this

### Phase 1 — MVP hardening

Goal: make Clyno reliable enough for your own daily use.

Build next:

```txt
clyno --version
clyno help
clyno doctor
clyno clean
clyno memory list
clyno memory show
clyno memory delete
```

Why? Because right now Clyno can create memories, but user control is still thin. A memory tool must let the user inspect and delete what it learned.

I would prioritize:

```txt
1. clyno memory list
2. clyno memory show <type>
3. clyno memory delete <id or query>
4. clyno doctor
```

Not embeddings. Not GUI.

### Phase 2 — Trust and correction loop

This is the real missing piece.

Right now Clyno can extract and resolve, but the user needs a way to correct it.

Needed commands:

```bash
clyno memory list
clyno memory edit
clyno memory delete
clyno resolve "GUARDRAILS code fence"
clyno ignore "bad extracted memory"
```

This matters more than semantic search because bad memory is worse than no memory.

The product principle should be:

> Clyno never traps users with stale or wrong memory.

### Phase 3 — Better real-session extraction

You already hit ANSI/TUI noise. More will appear.

Add:

```txt
- raw transcript stays unchanged
- cleaned transcript preview
- extraction debug mode
- per-session extraction report
```

Useful commands:

```bash
clyno inspect latest
clyno inspect <session>
clyno summarize --dry-run <session>
clyno summarize --show-cleaned <session>
```

This lets you debug extraction without guessing.

### Phase 4 — Installation and packaging

Before any desktop app:

```txt
- npm package polish
- bin command
- npm link docs
- --version
- install instructions
- release checklist
- GitHub Actions CI
```

A CLI people can install beats a half-built Electron app.

### Phase 5 — Retrieval improvements

Only after the above:

```txt
- better scoring
- tag boost
- phrase boost
- recency boost
- resolved suppression improvements
- optional SQLite index
```

Still avoid embeddings until keyword/rules are maxed out.

### Phase 6 — Optional intelligence

Later:

```txt
- local embeddings
- semantic search
- component-level memory
- architecture summaries
- changelog generation
```

The old roadmap puts this too early. Your dogfood showed the bottleneck is not semantic search yet — it is memory quality and control.

# The new `ROADMAP.md` structure

I’d replace the stale roadmap with something like this:

````md
# Clyno Roadmap

## Current Status

Clyno is no longer pre-prototype.

The current CLI can:

- Run terminal agents through a real PTY.
- Capture raw transcripts.
- Store project-local `.clyno/` memory.
- Keep `.clyno/` private by default in Git.
- Clean terminal/TUI noise before extraction.
- Extract decisions, TODOs, bugs, errors, summaries, and resolved items.
- Repair low-quality memory fragments.
- Deduplicate repeated memories.
- Search memory with `clyno find`.
- Generate context with `clyno inject`.
- Show storage health with `clyno status`.
- Suppress resolved bugs during injection.

The next goal is not to add a GUI or embeddings.

The next goal is to make Clyno reliable enough for daily use.

---

## Product North Star

Never explain your project to an AI coding agent twice.

Clyno should preserve useful project context from terminal AI sessions and make it easy to reuse later without bloating the agent context window.

---

## Current MVP Loop

```txt
clyno run <agent>
→ capture transcript
→ clean transcript for extraction
→ extract useful memory
→ store local project memory
→ search with clyno find
→ inject with clyno inject
→ resolve stale memories
````

---

## Phase 1: MVP Reliability

Goal: make the CLI predictable, inspectable, and safe.

### Priorities

* Improve CLI help output.
* Add `clyno --version`.
* Add `clyno doctor`.
* Add `clyno memory list`.
* Add `clyno memory show`.
* Add `clyno memory delete`.
* Add `clyno inspect latest`.
* Improve README install/use instructions.
* Add release checklist.
* Add CI.

### Acceptance Criteria

* A fresh user can install Clyno and run one agent session.
* `clyno status` explains where memory is stored.
* `clyno doctor` detects common setup problems.
* Users can inspect and delete stored memories.
* Tests pass on every commit.

---

## Phase 2: Memory Trust and Correction

Goal: make memory safe to rely on.

### Priorities

* Add stable memory IDs.
* Show source session for each memory.
* Mark open/resolved status clearly.
* Add `clyno resolve <query>`.
* Add `clyno memory delete <query-or-id>`.
* Add `clyno summarize --dry-run`.
* Add extraction confidence labels if useful.
* Improve stale-memory suppression.

### Acceptance Criteria

* Users can correct bad memory.
* Resolved bugs do not appear as open bugs in injected context.
* Search may show historical memory, but inject prioritizes current state.
* Every injected item can be traced back to a session.

---

## Phase 3: Real Agent Dogfooding

Goal: prove Clyno works with real Codex/Claude sessions.

### Test Matrix

* `clyno run claude`
* `clyno run codex`
* `clyno run aider`
* `clyno run bash`
* Ctrl+C behavior
* Resize behavior
* Long session transcripts
* Full-screen TUI output
* Agent session with code edits
* Agent session with documentation review
* Agent session with bug fix and resolution

### Acceptance Criteria

* Clyno captures sessions without breaking terminal behavior.
* Extracted memory is useful after real sessions.
* No ANSI/TUI noise appears in memory.
* `clyno inject` gives compact, relevant context.
* Dogfood sessions produce actionable memories.

---

## Phase 4: Packaging and Distribution

Goal: make Clyno easy to install and update.

### Priorities

* Finalize package metadata.
* Add `bin` command verification.
* Add npm publish readiness.
* Add GitHub Actions CI.
* Add changelog.
* Add release tags.
* Add install docs.
* Add uninstall/cleanup docs.

### Acceptance Criteria

* `npm install -g clyno` or equivalent works.
* `clyno --version` works.
* CI runs tests and build.
* A user can follow README and succeed.

---

## Phase 5: Retrieval Quality

Goal: improve relevance without jumping to heavy ML too early.

### Priorities

* Improve query scoring.
* Add exact phrase boost.
* Add tag boost.
* Add recency boost.
* Add status boost: open > resolved for inject.
* Add type boost: decisions/TODOs/bugs > summaries.
* Add lightweight aliases.
* Add optional `--type` filter.

### Example Commands

```bash
clyno find "auth" --type decision
clyno find "GUARDRAILS" --include-resolved
clyno inject "storage" --max-items 5
```

### Acceptance Criteria

* Search results are ranked sensibly.
* Inject never dumps irrelevant memory.
* Resolved memories are labeled clearly.
* Users can narrow searches by type.

---

## Phase 6: Optional Local Intelligence

Goal: add smarter retrieval only after the CLI is trustworthy.

### Possible Features

* SQLite index.
* FTS search.
* Local embeddings.
* Semantic search.
* Component-level summaries.
* Architecture summaries.
* Changelog generation.
* Drift detection.

### Non-Goals for Now

* Desktop GUI.
* Cloud sync.
* Team sharing.
* Marketplace.
* Hosted agent execution.
* Provider API proxying.
* Autonomous background workers.

---

## Immediate Next Tasks

1. Commit current resolved-memory milestone.
2. Add `clyno --version`.
3. Improve `clyno help`.
4. Add `clyno doctor`.
5. Add `clyno memory list`.
6. Add `clyno memory show`.
7. Add `clyno memory delete`.
8. Run a full dogfood session using `clyno run claude`.
9. Inspect resulting memory.
10. Fix only the issues revealed by dogfooding.


## My recommendation

Do **not** let the project drift into:

```txt
embeddings
Electron
team sync
marketplace
architecture drift
```

yet.

The strongest next trajectory is:

```txt
Daily-use CLI → memory control → dogfood reliability → packaging
```

The next actual task I’d give the agent is:

```txt
Add `clyno --version`, clean help output, and `clyno doctor`.
```

Then after that:

```txt
Add `clyno memory list/show/delete`.
```

That gives users control, which is the missing layer now.

