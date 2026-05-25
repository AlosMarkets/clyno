Dogfood revealed the next extraction bug: real Codex/Claude terminal transcripts contain ANSI/control-code noise and agent UI narration. Clino is extracting polluted memories.

Observed bad memory:

summaries.md:
"This session captured 1 decision, 1 bug and 1 TODO. Focus areas: 49m, 1mTip, 22m, 3mNew, 23m, Fast."

todos.md:
"- • I’ve got the main content; I’m doing one quick pass on the remaining lines to."

bugs.md:
"- Net: strong alignment and mostly clear docs, with one concrete quality issue."

These are not valid memories.

Root issue:
The raw transcript from real terminal agents includes:
- ANSI escape sequences
- RGB color control fragments
- TUI chrome
- model selector text
- tips
- timing fragments like 49m, 1m, 22m
- agent narration like "I’ll read..." / "I’ve got..."
- partial/incomplete lines from redraws

Goal:
Keep raw transcript unchanged, but clean/sanitize text before extraction.

Requirements:

1. Add a transcript-cleaning function before extraction.

Do not alter raw saved transcripts. Only use cleaned text for memory extraction.

Function idea:
cleanTranscriptForExtraction(raw: string): string

It should remove:
- ANSI escape codes
- OSC sequences like terminal color/title sequences
- control characters
- cursor movement sequences
- alternate screen buffer sequences
- box drawing UI chrome where practical
- terminal RGB fragments like:
  "10;rgb:ffff/ffff/ffff11;rgb:3c95/3c95/3c95"
- Codex/Claude UI lines like:
  "Tip: New Use /fast..."
  "Select Model and Effort"
  "Access legacy models..."
  "Model changed to..."
  "OpenAI Codex"
  "directory:"
  "model:"
  "╭──"
  "╰──"

2. Add narration filters.

Reject memory candidates that are just agent process narration, such as:
- "I’ll read README..."
- "I’ve got the main content..."
- "I’m doing one quick pass..."
- "I’ll inspect..."
- "Let me check..."
- "I can see..."
- "Now I’ll..."

These are not project memories unless they contain a concrete decision/TODO/bug.

3. Improve bug classification.

Do not classify review feedback as a bug just because it says "issue".

Example:
"Net: strong alignment and mostly clear docs, with one concrete quality issue."
should not become a bug.

Bug memories should usually involve concrete broken behavior, error, failing command, regression, or explicit "bug: fix X".

4. Improve focus area extraction.

Reject numeric/time/control-code tokens:
- 49m
- 1mTip
- 22m
- 3mNew
- 23m
- Fast if it comes from UI tip text

Focus areas should come only from cleaned meaningful content.

5. Add regression tests using this exact bad content.

Inputs should include:
- "10;rgb:ffff/ffff/ffff11;rgb:3c95/3c95/3c95"
- "Tip: New Use /fast to enable our fastest inference..."
- "Select Model and Effort"
- "• I’ve got the main content; I’m doing one quick pass on the remaining lines to."
- "Net: strong alignment and mostly clear docs, with one concrete quality issue."

Expected:
- none of these become decisions/todos/bugs/errors
- none of these appear as focus areas

6. Re-run extraction on the latest real session transcript if possible.

Expected:
- no 49m/1mTip/22m focus areas
- no agent narration as TODO
- no generic "quality issue" feedback as bug
- if the session reviewed README/GUARDRAILS, extracted memory should mention README, GUARDRAILS, documentation, docs, or guardrails if present in cleaned text

7. Show proof:
- cleaning function
- filters added
- tests added
- npm test
- npm run build
- before/after memory output from the real transcript

Do not add embeddings, SQLite, GUI, cloud sync, or unrelated features.
