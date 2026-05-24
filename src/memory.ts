/**
 * Clino memory-quality layer.
 *
 * Pure, side-effect-free functions that turn raw transcript text into clean,
 * human-readable project memories. Everything here runs BEFORE a memory is
 * written to disk and BEFORE it is emitted by `clino inject`, so the same
 * repair / quality / dedupe rules apply on both paths.
 *
 * Pipeline: split -> classify -> repair -> quality filter -> dedupe.
 */

export type MemoryType = 'decisions' | 'todos' | 'bugs' | 'errors';

export interface ExtractedSignals {
  decisions: string[];
  todos: string[];
  bugs: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Normalization (used for dedupe comparisons only — never stored)
// ---------------------------------------------------------------------------

export function normalizeMemoryText(text: string): string {
  let normalized = text.toLowerCase().trim();
  normalized = normalized.replace(/\s+/g, ' ');
  normalized = normalized.replace(/([!?.]){2,}/g, '$1');
  normalized = normalized.replace(/^[-*]\s+/, '');
  normalized = normalized.replace(/['"«»„“”]/g, "'");
  normalized = normalized.replace(/[.!?]+$/, '');
  return normalized.trim();
}

// ---------------------------------------------------------------------------
// Code / command detection
// ---------------------------------------------------------------------------

const COMMANDS = new Set([
  'npm', 'npx', 'node', 'pnpm', 'yarn', 'git', 'docker', 'cd', 'ls', 'cat',
  'make', 'python', 'python3', 'pip', 'cargo', 'go', 'tsc', 'jest', 'sudo',
  'curl', 'wget', 'bash', 'sh',
]);

/** A single token that looks like code: a path, file:line, env var, or command. */
function tokenIsCode(tok: string): boolean {
  if (!tok) return false;
  if (/^[`$]/.test(tok)) return true;
  if (/[/\\]/.test(tok) && /\w/.test(tok)) return true; // path-ish
  if (/:\d+/.test(tok)) return true; // file:line / line:col
  if (/\w+\.\w{1,5}$/.test(tok) && /\.[a-z]{1,5}$/i.test(tok)) return true; // file.ext
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(tok)) return true; // CONSTANT / ENV_VAR / acronym
  if (COMMANDS.has(tok.toLowerCase())) return true;
  return false;
}

/**
 * Whether the whole string reads like a shell command or code literal.
 * Deliberately stricter than `tokenIsCode` (no bare-acronym match) so a single
 * keyword such as "JWT" is never accepted as a "command".
 */
function isCommandLike(text: string): boolean {
  const t = text.trim();
  if (/^[`$]/.test(t)) return true;
  const firstWord = (t.split(/\s+/)[0] || '').toLowerCase();
  if (COMMANDS.has(firstWord)) return true;
  if (/[/\\][\w.\-/\\]+/.test(t)) return true; // contains a path
  if (/\.\w{1,5}:\d+/.test(t)) return true; // file.ext:line
  return false;
}

// ---------------------------------------------------------------------------
// Repair: raw fragment -> clean human-readable note
// ---------------------------------------------------------------------------

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bwe'll\b/gi, 'we will'],
  [/\bi'll\b/gi, 'I will'],
  [/\bit's\b/gi, 'it is'],
  [/\bthat's\b/gi, 'that is'],
  [/\bwe're\b/gi, 'we are'],
  [/\bthey're\b/gi, 'they are'],
  [/\bdon't\b/gi, 'do not'],
  [/\bdoesn't\b/gi, 'does not'],
  [/\bdidn't\b/gi, 'did not'],
  [/\bcan't\b/gi, 'cannot'],
  [/\bwon't\b/gi, 'will not'],
  [/\bisn't\b/gi, 'is not'],
  [/\baren't\b/gi, 'are not'],
];

// Lead-in phrases stripped from the FRONT of a fragment. These are the
// conversational scaffolding ("we decided to", "need to", "to ", labels) — never
// the action verb itself (use / fix / add / implement stay put).
const LEAD_INS: RegExp[] = [
  /^[-*+]\s+/,
  // label prefixes: "decision:", "todo:", "remaining:", "bug:", "error:" ...
  /^(decisions?|todos?|fixme|bugs?|issues?|problems?|errors?|exception|remaining|notes?|plans?)\s*:\s*/i,
  // decision lead-ins: "we decided to", "decided to", "chose to", "we agreed to"
  /^(we\s+|i\s+|they\s+)?(have\s+|had\s+)?(decided|decide|chose|choose|agreed|opted|settled)\s+(on\s+|to\s+)?/i,
  // future lead-ins: "we will", "going to"
  /^(we\s+|i\s+|they\s+)?(are\s+|is\s+)?(going\s+to|will)\s+/i,
  // obligation lead-ins: "we need to", "still need to", "have to", "want to"
  /^(we\s+|i\s+|they\s+)?(still\s+|also\s+|now\s+|just\s+)?(need|want|have|plan|ought)\s+to\s+/i,
  // bare subject before a known action verb: "we use" -> "use", "they fix" -> "fix"
  /^(we|i|they)\s+(?=(use|using|fix|fixing|add|adding|implement|implementing|update|updating|remove|removing|refactor|switch|migrate)\b)/i,
  // bare infinitive: "to use X" -> "use X"
  /^to\s+(?=\w)/i,
  // leftover filler
  /^(still|also|now|just)\s+/i,
];

/**
 * Repair a raw extracted fragment into a clean, capitalized, period-terminated
 * note. Handles all the cases in the acceptance criteria:
 *   "to use JWT auth"                 -> "Use JWT auth."
 *   "we decided to use JWT auth"      -> "Use JWT auth."
 *   "...because it's stateless"       -> "...because it is stateless."
 *   "need to fix Redis blacklist bug" -> "Fix Redis blacklist bug."
 *   "remaining: add unit tests ..."   -> "Add unit tests ..."
 */
export function repairMemoryText(raw: string): string {
  if (!raw) return '';
  let t = raw.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[-*+]\s+/, '');
  t = t.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();

  // Expand contractions ("it's" -> "it is", etc.) before anything else.
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);

  // Drop trailing terminal punctuation / spam ("bug!!!" -> "bug"); re-added below.
  t = t.replace(/\s*[.!?]+$/, '').trim();

  // Strip lead-in scaffolding repeatedly until the fragment is stable.
  let prev = '';
  let guard = 0;
  while (t !== prev && guard < 8) {
    prev = t;
    for (const re of LEAD_INS) {
      const next = t.replace(re, '');
      if (next !== t) t = next.trim();
    }
    guard++;
  }
  t = t.trim();
  if (!t) return '';

  // Capitalize the first character unless it opens with a code/command token.
  const firstTok = t.split(/\s+/)[0] || '';
  if (!tokenIsCode(firstTok)) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Terminate with a period unless it already ends in punctuation or a code token.
  const lastTok = t.split(/\s+/).pop() || '';
  if (!/[.!?]$/.test(t) && !tokenIsCode(lastTok)) {
    t += '.';
  }
  return t;
}

// ---------------------------------------------------------------------------
// Quality filter
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'is',
  'it', 'we', 'i', 'that', 'this', 'because', 'but', 'so', 'as', 'be', 'are',
  'was', 'were', 'with', 'by', 'from', 'our', 'their', 'its', 'will',
]);

function countMeaningfulWords(text: string): number {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w)).length;
}

/**
 * Reject low-quality memories. A memory is rejected when it:
 *   - opens with "to use" / "decided to use" / "we decided to use" / bare "to "
 *   - opens with a subordinating/coordinating conjunction (a dependent fragment,
 *     e.g. "because it is stateless")
 *   - starts lowercase and is not a command/code literal
 *   - has fewer than 3 meaningful words (keyword-only like "jwt"/"auth"/"to use JWT"),
 *     unless it is an explicit error or a command/code literal
 *
 * Note on the word threshold: the canonical accepted memory "Use JWT auth." has
 * three meaningful words, so the keyword/fragment cutoff sits at "< 3 meaningful
 * words". Genuine fragments ("to use JWT" -> 2, "because it is stateless" -> 1,
 * "jwt" -> 1) all fall below it while valid imperatives survive.
 */
export function isQualityMemory(text: string, type: MemoryType): boolean {
  if (!text) return false;
  const core = text.trim().replace(/^[-*+]\s+/, '').replace(/[.!?]+$/, '').trim();
  if (!core) return false;

  // Forbidden starts (defense in depth — repair should already remove these).
  if (/^(to\s+use|decided\s+to\s+use|we\s+decided\s+to\s+use|to\s+)/i.test(core)) {
    return false;
  }
  // Dependent-clause fragments.
  if (/^(because|which|that|so|since|although|though|whereas|but|and|or|nor|yet|if|when|while)\b/i.test(core)) {
    return false;
  }

  const cmd = isCommandLike(core);
  const isErr = type === 'errors';
  const firstChar = core[0];
  const firstTok = core.split(/\s+/)[0] || '';

  // Lowercase start is only allowed for command/code literals.
  if (/[a-z]/.test(firstChar) && !cmd && !tokenIsCode(firstTok)) return false;

  // Keyword-only / fragment guard.
  if (!isErr && !cmd && countMeaningfulWords(core) < 3) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Dedupe (with richer-memory preference)
// ---------------------------------------------------------------------------

function getBigrams(str: string): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < str.length - 1; i++) bigrams.push(str.substring(i, i + 2));
  return bigrams;
}

function diceCoefficient(a: string, b: string): number {
  const x = getBigrams(a);
  const y = getBigrams(b);
  if (x.length === 0 && y.length === 0) return 1.0;
  if (x.length === 0 || y.length === 0) return 0.0;
  const yCopy = [...y];
  let intersection = 0;
  for (const bg of x) {
    const idx = yCopy.indexOf(bg);
    if (idx !== -1) {
      intersection++;
      yCopy.splice(idx, 1);
    }
  }
  return (2.0 * intersection) / (x.length + y.length);
}

/** Drop a memory when its normalized form is contained in a longer one. */
function subsumeMemories(memories: string[]): string[] {
  if (memories.length <= 1) return memories;
  const norm = memories.map(normalizeMemoryText);
  const keep = new Array(memories.length).fill(true);

  for (let i = 0; i < memories.length; i++) {
    if (!keep[i]) continue;
    for (let j = i + 1; j < memories.length; j++) {
      if (!keep[j]) continue;
      if (norm[i].length < norm[j].length && norm[j].includes(norm[i])) {
        keep[i] = false;
        break;
      }
      if (norm[j].length < norm[i].length && norm[i].includes(norm[j])) {
        keep[j] = false;
      }
    }
  }
  return memories.filter((_, idx) => keep[idx]);
}

/** Collapse near-duplicates by Dice similarity, keeping the richer (longer) one. */
function fuzzyDedupe(items: string[], threshold = 0.85): string[] {
  if (items.length <= 1) return items;
  const norm = items.map(normalizeMemoryText);
  const keep = new Array(items.length).fill(true);

  for (let i = 0; i < items.length; i++) {
    if (!keep[i]) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (!keep[j]) continue;
      if (diceCoefficient(norm[i], norm[j]) >= threshold) {
        if (items[j].length > items[i].length) keep[i] = false;
        else keep[j] = false;
        if (!keep[i]) break;
      }
    }
  }
  return items.filter((_, idx) => keep[idx]);
}

/**
 * Full dedupe: exact (normalized) -> subsume -> fuzzy. At every stage the richer
 * (longer) memory wins, so given both "Use JWT auth." and "Use JWT auth because
 * it is stateless." only the latter survives.
 */
export function dedupeMemories(items: string[]): string[] {
  const exact = new Map<string, string>();
  for (const it of items) {
    const n = normalizeMemoryText(it);
    const existing = exact.get(n);
    if (!existing || it.length > existing.length) exact.set(n, it);
  }
  return fuzzyDedupe(subsumeMemories([...exact.values()]));
}

// ---------------------------------------------------------------------------
// Sentence splitting & classification
// ---------------------------------------------------------------------------

/** Split into candidate units: per line, then per sentence within a line. */
export function splitIntoSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Split compound statements ("X and need to Y") into separate signals. */
export function splitCompoundSentences(sentences: string[]): string[] {
  const conjunctions = [
    ' and need to ',
    ' but need to ',
    ' and still need to ',
    ' but still need to ',
    ' and we need to ',
    ' but we need to ',
    ' and then ',
  ];
  const result: string[] = [];
  for (const sentence of sentences) {
    let splitIndex = -1;
    let matched = '';
    for (const conj of conjunctions) {
      const idx = sentence.toLowerCase().indexOf(conj);
      if (idx !== -1) {
        splitIndex = idx;
        matched = conj;
        break;
      }
    }
    if (splitIndex !== -1) {
      const first = sentence.substring(0, splitIndex).trim();
      const second = sentence.substring(splitIndex + matched.length).trim();
      if (first) result.push(first);
      if (second) result.push(second);
    } else {
      result.push(sentence);
    }
  }
  return result;
}

/** Route a sentence to exactly one memory bucket (or null to drop it). */
export function classifySentence(sentence: string): MemoryType | null {
  const t = sentence.toLowerCase();

  if (
    /\b(error|exception)\b\s*:/.test(t) ||
    /^error\b/.test(t) ||
    /\bexception\b/.test(t) ||
    /\bfailed\b/.test(t) ||
    /\bat\s+\S+:\d+:\d+/.test(sentence)
  ) {
    return 'errors';
  }

  if (
    /\bbug\b/.test(t) ||
    /^(bug|issue|problem)\s*:/.test(t) ||
    /\b(issue|problem)\b/.test(t) ||
    /\bfix\b/.test(t)
  ) {
    return 'bugs';
  }

  if (
    /\b(decided|decision|chose|choose|opted|agreed|settled)\b/.test(t) ||
    /\bgo(ing)?\s+with\b/.test(t) ||
    /^(to\s+)?use\b/.test(t) ||
    /\bwe\s+(will\s+)?use\b/.test(t)
  ) {
    return 'decisions';
  }

  if (
    /\b(todo|fixme)\b/.test(t) ||
    /^(todo|fixme|remaining)\s*:/.test(t) ||
    /\b(need|want|plan|ought)\s+to\b/.test(t) ||
    /\bremaining\b/.test(t) ||
    /^(add|implement|update|refactor|remove)\b/.test(t)
  ) {
    return 'todos';
  }

  return null;
}

/**
 * Extract clean, classified, deduped memories from raw transcript content.
 * Repair and the quality filter are applied per-signal before dedupe so nothing
 * low-quality ever reaches storage or injection.
 */
export function extractSignals(content: string): ExtractedSignals {
  const sentences = splitCompoundSentences(splitIntoSentences(content));
  const buckets: ExtractedSignals = { decisions: [], todos: [], bugs: [], errors: [] };

  for (const sentence of sentences) {
    const category = classifySentence(sentence);
    if (!category) continue;
    const repaired = repairMemoryText(sentence);
    if (!isQualityMemory(repaired, category)) continue;
    buckets[category].push(repaired);
  }

  buckets.decisions = dedupeMemories(buckets.decisions);
  buckets.todos = dedupeMemories(buckets.todos);
  buckets.bugs = dedupeMemories(buckets.bugs);
  buckets.errors = dedupeMemories(buckets.errors);
  return buckets;
}

// ---------------------------------------------------------------------------
// Synthesized summary (context, not raw bullets)
// ---------------------------------------------------------------------------

const TOPIC_STOP = new Set([
  ...STOPWORDS,
  'use', 'using', 'used', 'fix', 'fixing', 'fixed', 'add', 'adding', 'added',
  'implement', 'implementing', 'handle', 'handling', 'update', 'updating',
  'remove', 'removing', 'refactor', 'need', 'still', 'also', 'after', 'when',
  'while', 'unable', 'not', 'bug', 'bugs', 'error', 'errors', 'issue', 'issues',
  'problem', 'todo', 'fixme', 'specified', 'type', 'users', 'user', 'unable',
  'thing', 'things', 'stuff',
]);

function extractTopics(texts: string[], limit = 6): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const text of texts) {
    const words = text.replace(/[^A-Za-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      const lw = w.toLowerCase();
      if (lw.length < 3 || TOPIC_STOP.has(lw) || seen.has(lw)) continue;
      seen.add(lw);
      topics.push(w);
      if (topics.length >= limit) return topics;
    }
  }
  return topics;
}

/**
 * Build a synthesized summary that describes the session at a glance. It reports
 * signal counts and focus topics — it must NOT repeat the raw decision/bug/todo
 * bullets verbatim (acceptance criteria #6).
 */
export function synthesizeSummary(signals: ExtractedSignals): string {
  const all = [
    ...signals.decisions,
    ...signals.bugs,
    ...signals.todos,
    ...signals.errors,
  ];
  if (all.length === 0) return '';

  const counts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (signals.decisions.length) counts.push(plural(signals.decisions.length, 'decision'));
  if (signals.bugs.length) counts.push(plural(signals.bugs.length, 'bug'));
  if (signals.todos.length) counts.push(plural(signals.todos.length, 'TODO'));
  if (signals.errors.length) counts.push(plural(signals.errors.length, 'error'));

  const countsText =
    counts.length === 1
      ? counts[0]
      : `${counts.slice(0, -1).join(', ')} and ${counts[counts.length - 1]}`;

  const topics = extractTopics(all);
  const focus = topics.length ? ` Focus areas: ${topics.join(', ')}.` : '';
  return `This session captured ${countsText}.${focus}`;
}

// ---------------------------------------------------------------------------
// Memory-file parsing helpers (pure)
// ---------------------------------------------------------------------------

/** Remove every YAML frontmatter fence (`--- ... ---`) from file content. */
export function stripFrontmatter(content: string): string {
  return content.replace(/---\r?\n[\s\S]*?\r?\n---\r?\n?/g, '\n');
}

/** Read stored bullet items from a memory file (frontmatter & headings ignored). */
export function parseMemoryItems(content: string): string[] {
  return stripFrontmatter(content)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}
