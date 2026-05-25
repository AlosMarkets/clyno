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
// Transcript cleaning / metadata stripping
// ---------------------------------------------------------------------------

// Terminal transcripts captured from real TUIs contain redraw/control bytes that
// are not project content. Keep the raw saved transcript intact, but remove this
// noise before classification.
function stripTerminalControlSequences(text: string): string {
  let cleaned = text;

  // OSC / DCS / APC / PM / SOS strings, including title and color queries.
  cleaned = cleaned.replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '');
  cleaned = cleaned.replace(/\x1B[P_^X][\s\S]*?(?:\x07|\x1B\\)/g, '');
  // CSI cursor movement, erase, color, bracketed paste, alternate screen, etc.
  cleaned = cleaned.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  // Charset selection and any remaining one-byte ESC controls.
  cleaned = cleaned.replace(/\x1B[()#%*+\-.\/][0-~]/g, '');
  cleaned = cleaned.replace(/\x1B[@-Z\\-_]/g, '');
  // Fragments left behind by terminal RGB color responses when escape framing is
  // partial or interleaved with redraw output.
  cleaned = cleaned.replace(
    /(?:\d{1,2};)?rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}/gi,
    '',
  );
  cleaned = cleaned.replace(/\]\d{1,2};\?/g, '');

  return cleaned
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

function normalizeTranscriptLine(line: string): string {
  return line
    .replace(/[╭╮╰╯┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬]/g, ' ')
    .replace(/[│║]/g, ' ')
    .replace(/[─━═]{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTerminalUiLine(line: string): boolean {
  const t = normalizeTranscriptLine(line)
    .replace(/^[-*+•]\s*/, '')
    .replace(/^›\s*/, '')
    .trim();
  if (!t) return true;
  if (/^[\s╭╮╰╯│║─━═┌┐└┘├┤┬┴┼]+$/.test(line)) return true;

  return [
    /^openai codex\b/i,
    /^model\s*:/i,
    /^directory\s*:/i,
    /^tip:\s*new\s+use\s+\/fast\b/i,
    /^select model and effort\b/i,
    /^access legacy models\b/i,
    /^model changed to\b/i,
    /^booting mcp server\b/i,
    /^\(\d+s\s*•\s*esc to interrupt\)$/i,
    /^implement\s+\{feature\}$/i,
    /^explored$/i,
    /^short assessment:$/i,
    /^read\s+[\w./-]+(?:,\s*[\w./-]+)*$/i,
    /^list\s+[\w./-]+$/i,
    /^ran\s+\S+/i,
    /^\/(?:model|fast|ide|permissions|keymap|vim|experimental|approve|memories|mention|mcp)\b/i,
    /^gpt-[\w.-]+\s+\w+\s*(?:·\s*~?\/?.*)?$/i,
  ].some((re) => re.test(t));
}

function shouldJoinWrappedLine(previous: string, line: string): boolean {
  if (!previous || !line) return false;
  if (/^```/.test(previous) || /^```/.test(line)) return false;
  if (/^[-*+•]\s+/.test(line)) return false;
  if (/^[#]{1,6}\s+/.test(line)) return false;
  if (/[.!?]$/.test(previous)) return false;
  if (/^(agent|command|arguments|args|started|ended|exit code)\s*:/i.test(line)) return false;

  return /[,;:]$/.test(previous) || /^(and|but|or|so|because|which|that|in|on|of|to|for|with|the|it|fence|makes|guidance)\b/i.test(line);
}

function unwrapSoftWrappedLines(lines: string[]): string[] {
  const unwrapped: string[] = [];
  for (const line of lines) {
    if (!line) {
      unwrapped.push(line);
      continue;
    }

    const last = unwrapped[unwrapped.length - 1];
    if (shouldJoinWrappedLine(last, line)) {
      unwrapped[unwrapped.length - 1] = `${last} ${line}`.replace(/\s+/g, ' ').trim();
    } else {
      unwrapped.push(line);
    }
  }
  return unwrapped;
}

export function cleanTranscriptForExtraction(raw: string): string {
  const lines = stripTerminalControlSequences(raw)
    .split('\n')
    .map(normalizeTranscriptLine)
    .filter((line) => !isTerminalUiLine(line));

  return unwrapSoftWrappedLines(lines).join('\n');
}

// Header labels Clino writes into every session transcript (see finalizeSession
// in index.ts) plus their plain-text equivalents. They are scaffolding, never
// project content, so they are removed before classification and repair.
const METADATA_LABELS = [
  'agent', 'command', 'arguments', 'args', 'exit code', 'started', 'ended',
];

// Matches a leading label in either the markdown-bold form `**Arguments:**` or
// the bare form `Arguments:` (case-insensitive).
const METADATA_PREFIX_RE = new RegExp(
  '^\\s*\\*{0,2}\\s*(?:' + METADATA_LABELS.join('|') + ')\\s*:\\s*\\*{0,2}\\s*',
  'i',
);

/**
 * Strip a leading transcript-metadata label from a single line. Returns the
 * useful remainder when the line is "label: <content>", or the line unchanged
 * when no metadata label is present.
 *
 *   "**Arguments:** We decided to use X" -> "We decided to use X"
 *   "Command: git status"                -> "git status"
 *   "We decided to use X"                -> "We decided to use X" (unchanged)
 */
export function stripMetadataPrefix(line: string): string {
  const stripped = line.replace(METADATA_PREFIX_RE, '');
  return stripped === line ? line : stripped.trim();
}

/** Pure metadata values that carry no meaning once the label is gone. */
function isBareMetadataValue(s: string): boolean {
  if (!s) return true;
  if (/^\d+(\s*\(signal\s+\d+\))?$/i.test(s)) return true; // exit code, e.g. "0" / "130 (signal 2)"
  if (/^\d{4}-\d{2}-\d{2}t[\d:.\-z]+$/i.test(s)) return true; // ISO timestamp
  return false;
}

/**
 * Remove transcript-metadata header lines before extraction. A line that is only
 * metadata (label with no content, a timestamp, or an exit code) is dropped; a
 * line that is "label: <useful content>" keeps just the content so real prose
 * (e.g. the agent's arguments) still flows into classification.
 */
export function stripTranscriptMetadata(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const remainder = stripMetadataPrefix(line);
      if (remainder === line) return line; // no metadata label present
      return isBareMetadataValue(remainder) ? '' : remainder;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Repair: raw fragment -> clean human-readable note
// ---------------------------------------------------------------------------

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bwe['’]ll\b/gi, 'we will'],
  [/\bi['’]ll\b/gi, 'I will'],
  [/\bi['’]ve\b/gi, 'I have'],
  [/\bi['’]m\b/gi, 'I am'],
  [/\bit['’]s\b/gi, 'it is'],
  [/\bthat['’]s\b/gi, 'that is'],
  [/\bwe['’]re\b/gi, 'we are'],
  [/\bthey['’]re\b/gi, 'they are'],
  [/\bdon['’]t\b/gi, 'do not'],
  [/\bdoesn['’]t\b/gi, 'does not'],
  [/\bdidn['’]t\b/gi, 'did not'],
  [/\bcan['’]t\b/gi, 'cannot'],
  [/\bwon['’]t\b/gi, 'will not'],
  [/\bisn['’]t\b/gi, 'is not'],
  [/\baren['’]t\b/gi, 'are not'],
];

// Lead-in phrases stripped from the FRONT of a fragment. These are the
// conversational scaffolding ("we decided to", "need to", "to ", labels) — never
// the action verb itself (use / fix / add / implement stay put).
const LEAD_INS: RegExp[] = [
  /^[-*+•]\s+/,
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
  let t = cleanTranscriptForExtraction(raw).replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  if (!t || isTerminalUiLine(t)) return '';
  // Drop a transcript-metadata label ("**Arguments:**", "Command:", …) if the
  // fragment slipped through with one attached, then keep repairing the content.
  t = stripMetadataPrefix(t);
  t = t.replace(/^[-*+•]\s+/, '');
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
  const core = text.trim().replace(/^[-*+•]\s+/, '').replace(/[.!?]+$/, '').trim();
  if (!core) return false;
  if (isTerminalUiLine(core) || isAgentProcessNarration(core)) return false;
  if (type === 'bugs' && !hasConcreteBugSignal(core.toLowerCase())) return false;

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

function plainCandidateText(sentence: string): string {
  return normalizeTranscriptLine(stripTerminalControlSequences(sentence))
    .replace(/^[-*+•]\s*/, '')
    .trim();
}

function isAgentProcessNarration(sentence: string): boolean {
  const t = plainCandidateText(sentence).toLowerCase();
  if (!t) return false;

  return [
    /^(i['’]?ll|i will)\s+(read|inspect|check|look|review|scan|open|run|do|give)\b/,
    /^now\s+(i['’]?ll|i will)\s+(read|inspect|check|look|review|scan|open|run|do|give)\b/,
    /^(i['’]?ve|i have)\s+got\b/,
    /^(i['’]?m|i am)\s+(doing|checking|reading|inspecting|looking|running|making|going)\b/,
    /^let me\s+(check|inspect|look|read|open|run)\b/,
    /^i can see\b/,
    /^i found\b/,
  ].some((re) => re.test(t));
}

function hasConcreteBugSignal(t: string): boolean {
  if (/\bbugs?\b/.test(t) || /^(bugs?)\s*:/.test(t)) return true;
  if (
    /\b(regression|broken|breakage|crash(?:es|ed|ing)?|hang(?:s|ed|ing)?|failing|failure|fails?\b|throws?|leak|corrupt|invalid|unclosed|truncated|incomplete|not working)\b/.test(t)
  ) {
    return true;
  }
  if (/\bdoes not\b.*\b(work|load|run|compile|build|pass|save|write|read|render)\b/.test(t)) {
    return true;
  }
  if (/\bfix(?:e[sd])?\b.*\b(bug|error|regression|failure|crash|broken|failing|unclosed|truncated|incomplete)\b/.test(t)) {
    return true;
  }
  if (/^(issue|problem)\s*:\s*.*\b(fails?|failed|broken|error|exception|bug|regression|crash|truncated|unclosed|incomplete)\b/.test(t)) {
    return true;
  }
  return false;
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

  if (hasConcreteBugSignal(t)) {
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
    /^(add|implement|update|refactor|remove|fix)\b/.test(t)
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
  const cleaned = stripTranscriptMetadata(cleanTranscriptForExtraction(content));
  const sentences = splitCompoundSentences(splitIntoSentences(cleaned));
  const buckets: ExtractedSignals = { decisions: [], todos: [], bugs: [], errors: [] };

  for (const sentence of sentences) {
    if (isAgentProcessNarration(sentence)) continue;
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
  // Generic review adjectives/nouns are weak focus areas; prefer concrete
  // files, domains, and phrases instead.
  'directionally', 'strong', 'aligned', 'same', 'boundaries', 'clear', 'mostly',
  'concrete', 'quality', 'useful', 'good', 'bad', 'important', 'relevant',
  'appears', 'appear', 'line', 'lines', 'closing', 'sections', 'section',
  'clarity', 'truth', 'unfinished',
  // Transcript-metadata words and generic extraction verbs must never surface as
  // focus areas (e.g. "Arguments", "decided", "project", "local").
  'agent', 'command', 'arguments', 'args', 'exit', 'started', 'ended',
  'decided', 'decide', 'chose', 'choose', 'agreed', 'opted', 'project', 'local',
  'want', 'plan', 'ought',
  // TUI/menu words from Codex/Claude chrome.
  'tip', 'new', 'fast', 'select', 'model', 'effort', 'openai', 'codex',
  'directory', 'legacy', 'models',
]);

function isJunkTopicToken(word: string): boolean {
  return /^\d/.test(word) || /^\d+[smhd](?:[a-z]+)?$/i.test(word) || /^rgb$/i.test(word);
}

function topicKey(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function addTopic(topic: string, seen: Set<string>, topics: string[], limit: number): boolean {
  const clean = topic.replace(/\s+/g, ' ').trim();
  if (!clean) return topics.length >= limit;

  const key = topicKey(clean);
  if (!key || seen.has(key)) return topics.length >= limit;

  seen.add(key);
  for (const part of key.split(/\s+/)) seen.add(part);
  topics.push(clean);
  return topics.length >= limit;
}

function hasDocsSignal(text: string): boolean {
  return /\b(?:README|GUARDRAILS)\.md\b/i.test(text) ||
    /\b(?:docs?|documentation|markdown|code\s+fence|fenced\s+block)\b/i.test(text);
}

function extractTopics(texts: string[], limit = 6): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];

  for (const text of texts) {
    for (const match of text.matchAll(/\b[A-Za-z0-9_-]+\.md\b/g)) {
      if (addTopic(match[0], seen, topics, limit)) return topics;
    }

    if (/\bproject guardrails\b/i.test(text) && addTopic('project guardrails', seen, topics, limit)) {
      return topics;
    }
    if (/\b(?:unclosed\s+)?code\s+fence\b/i.test(text) && addTopic('code fence', seen, topics, limit)) {
      return topics;
    }
    if (/\bmemory extraction\b/i.test(text) && addTopic('memory extraction', seen, topics, limit)) {
      return topics;
    }
    if (/\bmarkdown\b/i.test(text) && addTopic('markdown', seen, topics, limit)) {
      return topics;
    }
    if (/\bpty\b/i.test(text) && addTopic('PTY', seen, topics, limit)) {
      return topics;
    }
    if (/\bstorage\b/i.test(text) && addTopic('storage', seen, topics, limit)) {
      return topics;
    }
    if (hasDocsSignal(text) && addTopic('documentation', seen, topics, limit)) {
      return topics;
    }
  }

  if (topics.length >= 3) return topics;

  for (const text of texts) {
    const words = text.replace(/[^A-Za-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      const lw = w.toLowerCase();
      if (isJunkTopicToken(w)) continue;
      if (lw.length < 3 || TOPIC_STOP.has(lw) || seen.has(lw)) continue;
      seen.add(lw);
      // Capitalize for readability ("clino" -> "Clino"); already-uppercase
      // acronyms like "JWT" are preserved.
      topics.push(w.charAt(0).toUpperCase() + w.slice(1));
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
