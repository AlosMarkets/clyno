Good. The inject command works, but the output shows memory duplication and weak classification.

Fix the memory quality layer before adding any new features.

Important: do not add GUI, embeddings, SQLite FTS, team sync, or Electron yet. This task is only about memory quality.

## Goal

Make injected context clean, deduplicated, correctly classified, and compact.

The current bad output repeats the same memory multiple times:

"We decided to use JWT auth and need to fix Redis blacklist bug"

This should not happen.

---

## 1. Add deduplication in three places

Deduplicate at:

1. extraction time
2. memory write time
3. inject output time

Do not rely only on final-output dedupe.

### Text normalization

Create a reusable function:

normalizeMemoryText(text: string): string

It should:

- lowercase
- trim whitespace
- collapse repeated spaces
- remove repeated punctuation
- remove markdown bullet prefixes
- normalize quotes
- remove trailing periods for comparison
- preserve the original display text separately

Example:

Input:
"- We decided to use JWT auth and need to fix Redis blacklist bug!!!"

Normalized:
"we decided to use jwt auth and need to fix redis blacklist bug"

### Exact dedupe

First dedupe by normalized text.

### Fuzzy dedupe

Then add simple fuzzy dedupe.

Use a similarity threshold of 0.85.

Acceptable simple options:

- Dice coefficient
- Jaccard similarity over words
- Levenshtein ratio

Do not add a heavy dependency unless already present.

### Required behavior

The same memory sentence must not appear multiple times in:

- decisions.md
- summaries.md
- todos.md
- bugs.md
- `clino inject` output

---

## 2. Improve classification and signal splitting

The sentence:

"We decided to use JWT auth and need to fix Redis blacklist bug"

must split into separate memories:

- decision: "Use JWT auth."
- bug/todo: "Fix Redis blacklist bug."

Do not store compound sentences as one memory if they contain multiple signals.

### Required extraction behavior

Detect conjunctions like:

- "and need to"
- "but need to"
- "and still need to"
- "but still need to"
- "and we need to"
- "but we need to"

Then split the sentence into meaningful signals.

### Classification rules

Examples:

"We decided to use JWT auth"
→ decision: "Use JWT auth."

"because it's stateless"
→ reason attached to the decision if present.

"need to fix Redis blacklist bug"
→ bug/todo: "Fix Redis blacklist bug."

"remaining: add unit tests for auth module"
→ todo: "Add unit tests for auth module."

"error: module type not specified"
→ error: "Module type not specified."

---

## 3. Improve memory formatting

Each stored memory item should include metadata.

Minimum metadata:

- type
- date
- source session filename
- confidence
- tags if available

Example memory item:

```md
---
type: decision
date: 2026-05-24
source: 2026-05-24-20-30-00.md
confidence: 0.92
tags:
  - auth
  - jwt
---

Use JWT auth because it is stateless.
