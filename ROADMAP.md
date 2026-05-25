## Where Clino actually is now

Current reality:

```txt
Built:
- TypeScript CLI
- real node-pty `clino run`
- project-local `.clino/`
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

Goal: make Clino reliable enough for your own daily use.

Build next:

```txt
clino --version
clino help
clino doctor
clino clean
clino memory list
clino memory show
clino memory delete
```

Why? Because right now Clino can create memories, but user control is still thin. A memory tool must let the user inspect and delete what it learned.

I would prioritize:

```txt
1. clino memory list
2. clino memory show <type>
3. clino memory delete <id or query>
4. clino doctor
```

Not embeddings. Not GUI.

### Phase 2 — Trust and correction loop

This is the real missing piece.

Right now Clino can extract and resolve, but the user needs a way to correct it.

Needed commands:

```bash
clino memory list
clino memory edit
clino memory delete
clino resolve "GUARDRAILS code fence"
clino ignore "bad extracted memory"
```

This matters more than semantic search because bad memory is worse than no memory.

The product principle should be:

> Clino never traps users with stale or wrong memory.

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
clino inspect latest
clino inspect <session>
clino summarize --dry-run <session>
clino summarize --show-cleaned <session>
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
# Clino Roadmap

## Current Status

Clino is no longer pre-prototype.

The current CLI can:

- Run terminal agents through a real PTY.
- Capture raw transcripts.
- Store project-local `.clino/` memory.
- Keep `.clino/` private by default in Git.
- Clean terminal/TUI noise before extraction.
- Extract decisions, TODOs, bugs, errors, summaries, and resolved items.
- Repair low-quality memory fragments.
- Deduplicate repeated memories.
- Search memory with `clino find`.
- Generate context with `clino inject`.
- Show storage health with `clino status`.
- Suppress resolved bugs during injection.

The next goal is not to add a GUI or embeddings.

The next goal is to make Clino reliable enough for daily use.

---

## Product North Star

Never explain your project to an AI coding agent twice.

Clino should preserve useful project context from terminal AI sessions and make it easy to reuse later without bloating the agent context window.

---

## Current MVP Loop

```txt
clino run <agent>
→ capture transcript
→ clean transcript for extraction
→ extract useful memory
→ store local project memory
→ search with clino find
→ inject with clino inject
→ resolve stale memories
````

---

## Phase 1: MVP Reliability

Goal: make the CLI predictable, inspectable, and safe.

### Priorities

* Improve CLI help output.
* Add `clino --version`.
* Add `clino doctor`.
* Add `clino memory list`.
* Add `clino memory show`.
* Add `clino memory delete`.
* Add `clino inspect latest`.
* Improve README install/use instructions.
* Add release checklist.
* Add CI.

### Acceptance Criteria

* A fresh user can install Clino and run one agent session.
* `clino status` explains where memory is stored.
* `clino doctor` detects common setup problems.
* Users can inspect and delete stored memories.
* Tests pass on every commit.

---

## Phase 2: Memory Trust and Correction

Goal: make memory safe to rely on.

### Priorities

* Add stable memory IDs.
* Show source session for each memory.
* Mark open/resolved status clearly.
* Add `clino resolve <query>`.
* Add `clino memory delete <query-or-id>`.
* Add `clino summarize --dry-run`.
* Add extraction confidence labels if useful.
* Improve stale-memory suppression.

### Acceptance Criteria

* Users can correct bad memory.
* Resolved bugs do not appear as open bugs in injected context.
* Search may show historical memory, but inject prioritizes current state.
* Every injected item can be traced back to a session.

---

## Phase 3: Real Agent Dogfooding

Goal: prove Clino works with real Codex/Claude sessions.

### Test Matrix

* `clino run claude`
* `clino run codex`
* `clino run aider`
* `clino run bash`
* Ctrl+C behavior
* Resize behavior
* Long session transcripts
* Full-screen TUI output
* Agent session with code edits
* Agent session with documentation review
* Agent session with bug fix and resolution

### Acceptance Criteria

* Clino captures sessions without breaking terminal behavior.
* Extracted memory is useful after real sessions.
* No ANSI/TUI noise appears in memory.
* `clino inject` gives compact, relevant context.
* Dogfood sessions produce actionable memories.

---

## Phase 4: Packaging and Distribution

Goal: make Clino easy to install and update.

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

* `npm install -g clino` or equivalent works.
* `clino --version` works.
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
clino find "auth" --type decision
clino find "GUARDRAILS" --include-resolved
clino inject "storage" --max-items 5
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
2. Add `clino --version`.
3. Improve `clino help`.
4. Add `clino doctor`.
5. Add `clino memory list`.
6. Add `clino memory show`.
7. Add `clino memory delete`.
8. Run a full dogfood session using `clino run claude`.
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
Add `clino --version`, clean help output, and `clino doctor`.
```

Then after that:

```txt
Add `clino memory list/show/delete`.
```

That gives users control, which is the missing layer now.

