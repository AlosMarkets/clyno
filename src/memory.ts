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

export type MemoryType = 'decisions' | 'todos' | 'bugs' | 'errors' | 'resolved';

export interface ExtractedSignals {
  decisions: string[];
  todos: string[];
  bugs: string[];
  errors: string[];
  resolved: string[];
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

// ---------------------------------------------------------------------------
// Codex intro / login / auth blob rejection
//
// The Codex intro/login screen is NOT clean line-based output. It arrives as one
// giant compacted blob: ASCII/TUI art, missing whitespace, and login/auth text
// glued together. Line-oriented cleaning misses it, so it must be matched on a
// whitespace/punctuation-free "compact" form and dropped wholesale.
// ---------------------------------------------------------------------------

/**
 * Normalize text for matching compacted UI/login blobs: lowercase, drop all
 * whitespace and punctuation/separators, keep only letters and digits.
 *
 *   "Welcome to Codex, OpenAI's command-line coding agent"
 *     -> "welcometocodexopenaiscommandlinecodingagent"
 *   "ProvideyourownAPIkey" -> "provideyourownapikey"
 */
export function compactForUiMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Compact patterns that mark a Codex intro / login / auth / menu blob. If a
// chunk's compact form contains any of these, the whole chunk is dropped.
const CODEX_INTRO_COMPACT_PATTERNS = [
  'welcometocodex',
  'openaiscommandlinecodingagent',
  'signinwithchatgpt',
  'signinwithdevicecode',
  'provideyourownapikey',
  'usagebasedbilling',
  'pressentertocontinue',
  'finishsigninginviayourbrowser',
  'ifthelinkdoesntopenautomatically',
  'openthefollowinglinktoauthenticate',
  'authopenai',
  'oauthauthorize',
  'codechallenge',
  'redirecturi',
  'idtoken',
  'accesstoken',
  'refreshtoken',
  'codexclisimplifiedflow',
];

// Codex command-menu / session-chrome signatures. These are the same TUI strings
// isTerminalUiLine already recognizes line-by-line (booting MCP server, esc to
// interrupt, the /model menu, …). The root-cause bug is that they survive when
// compacted into one blob, so they are matched here on the compact form too.
const CODEX_MENU_COMPACT_PATTERNS = [
  'reasoningefforttouse',
  'remaptuishortcuts',
  'togglevimmode',
  'summarizeconversationtoprevent',
  'bootingmcpserver',
  'esctointerrupt',
  'codexresume',
  'selectmodelandeffort',
  'accesslegacymodels',
  'waitingforbackgroundterminal',
];

// Hard candidate-rejection patterns (defense in depth — a candidate whose compact
// form contains any of these is never stored as a memory). "state" from the spec
// is deliberately omitted: it is a substring of ordinary words ("stateless",
// "statement", "estate") and would reject valid memories such as the canonical
// "Use JWT auth because it is stateless." The OAuth `state=` parameter is handled
// instead by auth-URL/marker redaction below.
const CODEX_AUTH_REJECT_COMPACT_PATTERNS = [
  'welcometocodex',
  'signinwithchatgpt',
  'signinwithdevicecode',
  'provideyourownapikey',
  'usagebasedbilling',
  'pressentertocontinue',
  'finishsigningin',
  'authopenai',
  'oauthauthorize',
  'codechallenge',
  'redirecturi',
  'clientid',
  'codexclisimplifiedflow',
];

// Substrings that mark a URL (or URL-like token) as OAuth/auth chrome.
const AUTH_URL_MARKERS = [
  'auth.openai.com',
  'oauth',
  'authorize',
  'callback',
  'code_challenge',
  'access_token',
  'refresh_token',
  'id_token',
  'client_id',
  'redirect_uri',
  'state=',
];

// OAuth-specific query tokens that are never legitimate project prose. Stripped
// as a final safety pass so they cannot survive even when a URL is glued into a
// larger blob without surrounding whitespace.
const AUTH_RESIDUE_RE =
  /(?:auth\.openai\.com|oauth|code_challenge|code_verifier|access_token|refresh_token|id_token|client_id|redirect_uri|response_type|grant_type)\S*/gi;
const AUTH_STATE_PARAM_RE = /[?&]state=[^\s&]*/gi;

/**
 * Remove full URLs (and URL-like runs) carrying an OAuth/auth marker, even when
 * embedded in a larger line/blob. The `https?://` scheme is distinctive enough to
 * match without a word boundary, so a URL glued onto preceding text is still
 * removed in full.
 */
function redactAuthUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, (url) => {
    const lower = url.toLowerCase();
    return AUTH_URL_MARKERS.some((m) => lower.includes(m)) ? '' : url;
  });
}

/** Strip any residual OAuth/auth query tokens left behind after URL removal. */
function redactAuthMarkers(text: string): string {
  return text.replace(AUTH_RESIDUE_RE, '').replace(AUTH_STATE_PARAM_RE, '');
}

/** Conservative symbol-noise heuristic (used only alongside a Codex/auth signal). */
function isHighSymbolNoise(text: string): boolean {
  const dense = text.replace(/\s/g, '');
  if (dense.length < 24) return false;
  const symbols = (dense.match(/[^a-z0-9]/gi) || []).length;
  return symbols / dense.length > 0.45;
}

/**
 * Whether a chunk is a Codex intro/login/auth/menu blob that must be dropped
 * wholesale. Matches on the compact form so single compacted blobs are caught.
 * Symbol-noise alone never drops a chunk — it must be tied to a Codex/auth signal.
 */
function isCodexIntroChunk(line: string): boolean {
  const compact = compactForUiMatch(line);
  if (!compact) return false;
  if (CODEX_INTRO_COMPACT_PATTERNS.some((p) => compact.includes(p))) return true;
  if (CODEX_MENU_COMPACT_PATTERNS.some((p) => compact.includes(p))) return true;
  if (isHighSymbolNoise(line) && /(codex|signin|apikey|oauth)/.test(compact)) return true;
  return false;
}

/**
 * Hard rejection for memory candidates: true when a candidate's compact form is
 * recognizable Codex intro/login/auth text. Used as defense in depth so that even
 * if block-level cleaning misses a blob, no fake memory is ever stored.
 */
export function isCodexAuthNoise(text: string): boolean {
  const compact = compactForUiMatch(text);
  if (!compact) return false;
  return CODEX_AUTH_REJECT_COMPACT_PATTERNS.some((p) => compact.includes(p));
}

export function cleanTranscriptForExtraction(raw: string): string {
  // Redact auth URLs before splitting so an embedded/compacted URL is removed in
  // full, then drop terminal-UI lines and whole Codex intro/login/auth blobs.
  // Drop diff/code-noise, Clino-output, and session/status lines BEFORE unwrapping
  // so a patch line (which often ends in ";" or ",") can never be soft-joined onto
  // the prose line below it, and so spec headings reach the block pass intact.
  const lines = redactAuthUrls(stripTerminalControlSequences(raw))
    .split('\n')
    .map(normalizeTranscriptLine)
    .filter(
      (line) =>
        !isTerminalUiLine(line) &&
        !isCodexIntroChunk(line) &&
        !isDiffOrCodeNoise(line) &&
        !isClinoOutputNoise(line) &&
        !isPromptSpecDirective(line) &&
        !isSessionStatusNoise(line),
    );

  // Block-level pass: strip pasted prompt/spec instruction blocks (headings plus
  // the requirement bullets beneath them) that survive line-level filtering.
  const despecced = dropPromptSpecBlocks(lines);
  const unwrapped = unwrapSoftWrappedLines(despecced).filter(
    (line) =>
      !isTerminalUiLine(line) &&
      !isCodexIntroChunk(line) &&
      !isDiffOrCodeNoise(line) &&
      !isClinoOutputNoise(line) &&
      !isPromptSpecDirective(line) &&
      !isSessionStatusNoise(line),
  );

  // Final safety pass: scrub any residual OAuth/auth query tokens.
  return redactAuthMarkers(unwrapped.join('\n'));
}

// ---------------------------------------------------------------------------
// Diff / code / test-output noise rejection
//
// A transcript of a coding session is full of git diffs, patch hunks, test
// assertions and test-runner output. Those fragments are not project memories,
// but they classify (a patch line mentioning "bug"/"decision" looks like one),
// so they must be rejected as candidates before extraction. The detection is
// deliberately conservative: it keeps natural-language prose that merely
// mentions code (e.g. "Fixed GUARDRAILS.md unclosed code fence.") and only drops
// fragments that are structurally code/diff/test output.
// ---------------------------------------------------------------------------

/** Statement-shaped code: declarations, closing braces, punctuation-only lines. */
function looksLikeCodeStatement(t: string): boolean {
  if (
    /^(import|export|const|let|var|function|class|interface|enum|public|private|protected|static)\b.*[=({;]/.test(
      t,
    )
  ) {
    return true;
  }
  if (/^type\s+\w+\s*[=:<]/.test(t)) return true; // type X = ... / type X: ...
  if (/^(return|await|async|throw|new)\b.*[=({;'"`]/.test(t)) return true;
  if (/^[)}\]][;,)}\]\s]*$/.test(t)) return true; // closing-bracket lines: ");", "});"
  if (/^[{}()[\];,.<>=|&]+$/.test(t)) return true; // punctuation-only
  return false;
}

/** Bracket/operator density typical of code rather than prose. */
function looksPunctuationHeavyCode(t: string): boolean {
  const brackets = (t.match(/[(){}[\]]/g) || []).length;
  const semis = (t.match(/;/g) || []).length;
  if (brackets + semis === 0) return false;
  if (/^\s*[{([]/.test(t)) return true; // opens with a bracket
  if (brackets + semis >= 5) return true; // very dense
  if (semis >= 2) return true; // multiple statements on one line
  if (/[\w$]\([^)]*['"`][^)]*\)/.test(t)) return true; // call("...") / call(`...`)
  if (/[\w$]\([^)]*,[^)]*\)/.test(t)) return true; // call(a, b)
  if (
    /\b(assert|expect|deepEqual|doesNotMatch|writeFileSync|readFileSync|existsSync|require|console)\b/.test(t) &&
    brackets >= 1
  ) {
    return true;
  }
  if (/(=>|===|!==)/.test(t) && brackets >= 1) return true;
  return false;
}

/**
 * Whether a candidate line/chunk is diff, code, or test-runner output rather than
 * a natural-language project memory. Covers git diff headers, line-numbered patch
 * hunks, code statements, punctuation-heavy code, progress-spinner glyph runs, and
 * TAP/node:test runner output.
 */
export function isDiffOrCodeNoise(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // Git diff structure.
  if (/^diff --git /.test(t)) return true;
  if (/^index [0-9a-f]{4,}\.\.[0-9a-f]{4,}/i.test(t)) return true;
  if (/^(---|\+\+\+)\s+["']?[ab]?[/\\]?\S/.test(t)) return true; // --- a/file  +++ b/file
  if (/@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(t)) return true; // hunk header (anywhere)

  // Line-numbered patch lines: "347 + assert...", "653 +type ...", "379 - assert...".
  if (/^\d+\s*[+-]\s*\S/.test(t)) return true;
  // Two or more "<line-number> +/-" markers ⇒ a glued multi-line patch blob.
  const markers = t.match(/(?:^|[\s;,)])\d+\s*[+-]\s/g);
  if (markers && markers.length >= 2) return true;
  // A single multi-digit line-number marker next to code punctuation ⇒ a patch
  // fragment (e.g. "... memory'); 460 +" / "456 + } finally {"). The multi-digit
  // guard keeps ordinary prose such as "3 + 4" from matching.
  if (/(?:^|[\s;,)('"])\d{2,}\s*[+-]/.test(t) && /[(){}[\];]/.test(t)) return true;

  // Test-runner output (node:test / TAP).
  if (/^#\s*(tests?|pass(?:ed)?|fail(?:ed|ures)?|suites?|skipped|todo|cancelled|duration_ms|subtest)\b/i.test(t)) {
    return true;
  }
  if (/^(?:ok|not ok)\s+\d+\b/i.test(t)) return true;
  if (/^1\.\.\d+\s*$/.test(t)) return true; // TAP plan line

  // Progress-spinner / glyph noise glued onto a line.
  if ((t.match(/[•·]/g) || []).length >= 4) return true;
  if (/^`{3,}\w*$/.test(t)) return true; // markdown code fence

  // Bare paths/file names from diffs, file lists, or memory file output.
  if (/^(?:\.{1,2}[/\\])?[\w.-]+(?:[/\\][\w.-]+)+$/.test(t)) return true;
  if (/^[\w.-]+\.[a-z0-9]{1,5}$/i.test(t)) return true;

  // Code-shaped content. Strip a single leading diff marker first so that
  // "+ assert.equal(x)" is treated as code while "+ Fixed ..." prose is kept.
  const body = t.replace(/^[+-]\s+/, '').trim();
  if (looksLikeCodeStatement(body)) return true;
  if (looksPunctuationHeavyCode(body)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Prompt/spec echo, Clino-output echo, and session/status metadata rejection
//
// A real transcript is dominated by three kinds of non-memory text:
//   1. The user PASTES a large task spec into the agent (headings, requirement
//      bullets, "Do not ...", command examples). Those are instructions to the
//      coding agent, not project memories.
//   2. Clino's OWN command output gets pasted back into the conversation
//      (memory-list rows, dry-run "Would delete ..." lines, extraction counts).
//   3. Agent/session chrome (account, session id, rate limits, /status, the
//      usage URL) surrounds everything.
// All three classify (a requirement bullet "Add clino doctor" looks like a TODO,
// a memory-list row "decision-1 decision Use ..." looks like a decision), so they
// must be removed before extraction. Detection stays line/format-anchored so that
// the SAME sentence written as ordinary prose (e.g. "Need to add clino status
// command.") still becomes a memory.
// ---------------------------------------------------------------------------

// Agent/session/account/rate-limit chrome printed by Codex's /status and header.
const SESSION_STATUS_PATTERNS: RegExp[] = [
  /^>?_?\s*openai codex\b/i,            // ">_ OpenAI Codex (v0.133.0)" / "OpenAI Codex ..."
  /^\/status\b/i,                       // the /status slash-command echo
  /\bsettings\/usage\b/i,               // "Visit https://.../settings/usage ..."
  /\brate limits and credits\b/i,
  /^permissions\s*:/i,                  // "Permissions: Workspace (on-request)"
  /^agents?\.md\s*:/i,                  // "Agents.md: <none>"
  /^account\s*:/i,                      // "Account: user@example.com"
  /^collaboration mode\s*:/i,           // "Collaboration mode: Default"
  /^session\s*:\s*[0-9a-f-]{8,}/i,      // "Session: <uuid>"
  /^\d+\s*h\s*limit\s*:/i,              // "5h limit: 37% left"
  /^weekly limit\s*:/i,                 // "Weekly limit: 59% left"
  /^limits\s*:/i,                       // "Limits: refresh requested; ..."
  /^token usage\s*:/i,                  // "Token usage: total=..."
  /^tip\s*:/i,                          // "Tip: Use /status to see ..."
  /^codex$/i,
];

/** Whether a line is Codex/agent session/status/privacy chrome (never a memory). */
export function isSessionStatusNoise(text: string): boolean {
  const t = stripPromptListPrefix(text);
  if (!t) return false;
  return SESSION_STATUS_PATTERNS.some((re) => re.test(t));
}

// Clino's own command output, recognizable by its fixed formats.
const CLINO_OUTPUT_PATTERNS: RegExp[] = [
  // Memory-list / candidate rows: "decision-1 decision Use ...", "Summary-1 summary ...".
  /^(decision|todo|bug|error|resolved|summary)-\d+\s+(decision|todo|bug|error|resolved|summary)\b/i,
  // Count headers from inspect/summarize: "decisions (9)", "summary (1)".
  /^(decisions|todos|bugs|errors|resolved|summary|summaries)\s*\(\d+\)\s*$/i,
  // Count rows (after a leading bullet is stripped): "decisions: 9".
  /^(decisions|todos|bugs|errors|resolved|summary|summaries)\s*:\s*\d+\s*$/i,
  // Synthesized-summary text echoed back as a candidate.
  /^this session captured\b/i,
  // Section headers Clino prints during summarize/inspect.
  /^clino\s+(run|find|inject|summarize|inspect|review|status|doctor|memory|--version|-v|help)\b/i,
  /^memory\s+(list|show|delete)\s+invalid\b/i,
  /^candidate memories\b/i,
  /^extraction counts\b/i,
  /^final stored memories\b/i,
  /^current memory\s*:?\s*$/i,
  /^rebuilt memory\s*:?\s*$/i,
  /^new memory\s*:?\s*$/i,
  /^memory to write\s*:?\s*$/i,
  /^no memory files were written\b/i,
  /^no files were changed\b/i,
  /^no memories found\b/i,
  /^backup:\s+/i,
  /^memory$/i,
  /^memory item$/i,
  /^does not write to `?\.clino\/memory/i,
  /^searching memory for\s*:/i,
  /^found \d+ relevant memory\b/i,
  /^version:\s+clino\b/i,
  /^node:\s+v?\d/i,
  /^platform:\s+\w+/i,
  /^cwd:\s+\//i,
  /^clino\s+\W+\s+local memory\b/i,
  /^uses project-local \.clino\b/i,
  /^clino_home can override\b/i,
  /^\.clino\/ is ignored by git\b/i,
  /^diagnose common setup\b/i,
  // memory delete / dry-run output.
  /^would delete\s+(decision|todo|bug|error|resolved|summary)-\d+/i,
  /^deleted\s+(decision|todo|bug|error|resolved|summary)-\d+/i,
  // memory show output rows.
  /^(id|type|text|status|source session|source|file path|file)\s*:/i,
  // inject context headers.
  /^project context\b/i,
  /^recently resolved\b/i,
  /^open bugs\b/i,
  /\b(?:decisions|todos|bugs|errors|resolved|summaries?)(?:\/(?:decisions|todos|bugs|errors|resolved|summaries?|todos?)){1,}\b/i,
  /\bmanual proof memory\b/i,
  /\bmanual proof delete test\b/i,
  /^the manual proof succeeded\b/i,
];

/**
 * Whether a line is Clino's own command output (a memory-list row, dry-run line,
 * extraction count, or a `clino ...` command invocation) rather than a project
 * memory. A leading list bullet is stripped first so bulleted rows still match.
 */
export function isClinoOutputNoise(text: string): boolean {
  const t = stripPromptListPrefix(text);
  if (!t) return false;
  return CLINO_OUTPUT_PATTERNS.some((re) => re.test(t));
}

function stripPromptListPrefix(text: string): string {
  return text
    .trim()
    .replace(/^[-*+•]\s+/, '')
    .replace(/^›\s*/, '')
    .replace(/^\$\s+/, '')
    .trim();
}

// Known section labels of a pasted prompt/spec. "remaining" is deliberately
// excluded: it is a legitimate TODO lead-in ("remaining: add unit tests ...").
const SPEC_LABEL_RE =
  /^(goal|tasks?|requirements?|acceptance criteria|verification|verify|before editing|already implemented|important docs?|current project state|context|behaviou?r|safety|constraints?|scope|deliverables?|steps?|output should show|optional flags?|examples?|example output|suggested help shape|show|run|expected|manual proof|storage|privacy|changed files|command outputs?|known limitations?|approach|root cause)\s*:/i;

const BARE_SPEC_HEADING_RE =
  /^(changed files|verification|manual proof|known limitations|command outputs?|examples rejected|examples preserved|tests added|root cause)$/i;

/**
 * A line that OPENS (or continues) a pasted prompt/spec block: a markdown
 * heading, any "Label:" line, a known spec section label, a "Do not ..."
 * prohibition, or the "We are working on ..." preamble. These are document
 * structure / instructions and are never memories on their own.
 */
function isPromptSpecHeading(text: string): boolean {
  const t = stripPromptListPrefix(text);
  if (!t) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true;       // markdown heading: "## 1. Add ..."
  if (/:$/.test(t)) return true;                 // any "Label:" line introducing a list
  if (SPEC_LABEL_RE.test(t)) return true;        // "Goal: ...", "Run: ...", "Verification: ..."
  if (BARE_SPEC_HEADING_RE.test(t)) return true; // final-report/spec headings without colons
  if (/^do\s+not\b/i.test(t)) return true;       // "Do not add embeddings, SQLite, ..."
  if (/^we are working on\b/i.test(t)) return true;
  return false;
}

function isPastedPromptEnvelopeStart(text: string): boolean {
  const t = stripPromptListPrefix(text);
  return /\[pasted content \d+ chars\]/i.test(t) || /^we are working on\b/i.test(t);
}

function isPastedPromptEnvelopeEnd(text: string): boolean {
  const t = text.trim();
  return /^•\s+/.test(t) || /^(search|list|read|edited|ran|waited|updated plan)\b/i.test(t);
}

// Standalone prompt/spec directives that survive block-shredding. Terminal redraw
// frequently orphans a directive from its heading, so these process/style
// instructions and goal restatements need a line-level matcher too. Kept narrow so
// concrete project imperatives ("Use project-local .clino storage.", "Add unit
// tests for auth module.") are untouched.
const PROMPT_SPEC_DIRECTIVE_PATTERNS: RegExp[] = [
  // "Use the existing test style.", "Use existing style." — process/style direction.
  /\buse\s+(the\s+)?existing\b[^.]*\b(styles?|patterns?|conventions?|approach)\b/i,
  // "Implement Phase 1A ...", "Implement Phase 1B: ..." — pasted roadmap goal.
  /^implement\s+phase\b/i,
  // Prompt task bullets that are too generic to be durable project memory.
  /^add\s+`?clino\s+(--version|doctor)\b/i,
  /^add\/update\s+tests?\b/i,
  /^add\s+tests\.?$/i,
  /^update\s+(the\s+)?readme(?:\.md)?\b.*\b(include|section|memory-management|memory management)\b/i,
  /^add\s+(stable display ids?|a short section|a short debugging section)\b/i,
  /^keep refactor minimal\b/i,
  /^prefer minimal disruption\b/i,
  /^do the simplest reliable version\b/i,
  /^no new dependencies\b/i,
  /^emphasize user control and privacy\b/i,
];

/** Whether a line is a pasted prompt/spec process directive or goal restatement. */
export function isPromptSpecDirective(text: string): boolean {
  const t = stripPromptListPrefix(text);
  if (!t) return false;
  return PROMPT_SPEC_DIRECTIVE_PATTERNS.some((re) => re.test(t));
}

/** A line that continues an open spec block: a bullet, a numbered item, or blank. */
function isSpecBlockContinuation(text: string, previousWasBullet = false): boolean {
  const t = text.trim();
  if (!t) return true;                           // blank line keeps the block open
  if (/^[-*+•]\s+/.test(t)) return true;         // bullet item
  if (/^\d+[.)]\s+/.test(t)) return true;        // numbered / lettered list item
  if (previousWasBullet && /^[a-z0-9`.-]/.test(t)) return true; // soft-wrapped bullet continuation
  return false;
}

/**
 * Remove pasted prompt/spec instruction blocks. A block opens at a spec heading
 * (markdown heading, "Label:", "Do not ...", preamble) and swallows the bullets,
 * numbered items, and blank lines beneath it. The first line that is ordinary
 * prose ends the block and is kept — so a real memory written as a sentence right
 * after a spec block (e.g. "We decided to use project-local .clino storage.")
 * still survives, while the requirement bullets above it do not.
 */
export function dropPromptSpecBlocks(lines: string[]): string[] {
  const kept: string[] = [];
  let inBlock = false;
  let inPromptEnvelope = false;
  let previousWasBullet = false;
  for (const line of lines) {
    if (inPromptEnvelope) {
      if (!isPastedPromptEnvelopeEnd(line)) continue;
      inPromptEnvelope = false;
    }
    if (isPastedPromptEnvelopeStart(line)) {
      inPromptEnvelope = true;
      continue;
    }
    if (isPromptSpecHeading(line)) {
      inBlock = true;
      previousWasBullet = false;
      continue; // drop the heading / label / directive itself
    }
    if (inBlock) {
      if (isSpecBlockContinuation(line, previousWasBullet)) {
        const t = line.trim();
        previousWasBullet = previousWasBullet || /^[-*+•]\s+/.test(t);
        continue; // drop bullets / numbered / blank / wrapped bullet tails
      }
      inBlock = false; // ordinary prose ends the block; fall through to keep it
      previousWasBullet = false;
    }
    kept.push(line);
  }
  return kept;
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
  if (/^codex$/i.test(s)) return true;
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
  if (isCodexAuthNoise(core) || isDiffOrCodeNoise(core)) return false;
  if (isClinoOutputNoise(core) || isPromptSpecDirective(core) || isSessionStatusNoise(core)) return false;
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
    /^i\s+(also\s+)?made\b/,
    /^let me\s+(check|inspect|look|read|open|run)\b/,
    /^i can see\b/,
    /^i found\b/,
    /^the test run\b/,
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

function hasResolutionSignal(t: string): boolean {
  return [
    /^(fixed|resolved|completed|closed|addressed|repaired)\b/,
    /^(we|i|they)\s+(fixed|resolved|completed|closed|addressed|repaired)\b/,
    /\b(has been|have been|was|were|is now|are now)\s+(fixed|resolved|completed|closed|addressed|repaired)\b/,
    /\bclosed\s+the\s+.*\b(bug|todo|issue|problem)\b/,
  ].some((re) => re.test(t));
}

/** Route a sentence to exactly one memory bucket (or null to drop it). */
export function classifySentence(sentence: string): MemoryType | null {
  const plain = plainCandidateText(sentence);
  const t = plain.toLowerCase();

  if (hasResolutionSignal(t)) {
    return 'resolved';
  }

  if (
    /\b(error|exception)\b\s*:/.test(t) ||
    /^error\b/.test(t) ||
    /\bexception\b/.test(t) ||
    /\bfailed\b/.test(t) ||
    /\bat\s+\S+:\d+:\d+/.test(plain)
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
  const buckets: ExtractedSignals = { decisions: [], todos: [], bugs: [], errors: [], resolved: [] };

  for (const sentence of sentences) {
    if (isAgentProcessNarration(sentence)) continue;
    if (isCodexAuthNoise(sentence) || isDiffOrCodeNoise(sentence)) continue;
    if (isClinoOutputNoise(sentence) || isPromptSpecDirective(sentence) || isSessionStatusNoise(sentence)) continue;
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
  buckets.resolved = dedupeMemories(buckets.resolved);
  return buckets;
}

// ---------------------------------------------------------------------------
// Resolution matching
// ---------------------------------------------------------------------------

const RESOLUTION_MATCH_STOP = new Set([
  ...STOPWORDS,
  'fix', 'fixed', 'fixing', 'resolve', 'resolved', 'resolving',
  'complete', 'completed', 'completing', 'close', 'closed', 'closing',
  'address', 'addressed', 'addressing', 'repair', 'repaired', 'repairing',
  'done', 'bug', 'bugs', 'todo', 'todos', 'issue', 'issues', 'problem',
  'problems', 'file', 'files', 'about',
]);

function canonicalMatchToken(token: string): string {
  if (/^truncat/.test(token)) return 'truncat';
  if (/^fenc/.test(token)) return 'fence';
  if (/^doc/.test(token)) return 'document';
  return token.replace(/(?:ing|ed|s)$/i, '');
}

function matchTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const raw = normalizeMemoryText(text)
    .replace(/[^a-z0-9_.\s-]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/^[.-]+|[.-]+$/g, '').trim())
    .filter(Boolean);

  for (const token of raw) {
    const variants = [token];
    const fileMatch = token.match(/^([a-z0-9_-]+)\.[a-z0-9]+$/i);
    if (fileMatch) variants.push(fileMatch[1]);

    for (const variant of variants) {
      const canonical = canonicalMatchToken(variant);
      if (canonical.length < 3 || RESOLUTION_MATCH_STOP.has(canonical)) continue;
      tokens.add(canonical);
    }
  }

  return tokens;
}

function referenceAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/\b([a-z0-9_-]+)\.[a-z0-9]+\b/g)) {
    anchors.add(match[0]);
    anchors.add(match[1]);
  }
  if (/\bguardrails\b/i.test(text)) anchors.add('guardrails');
  if (/\breadme\b/i.test(text)) anchors.add('readme');
  return anchors;
}

function hasDocumentationSignalForResolution(text: string): boolean {
  return /\b(?:README|GUARDRAILS)\.md\b/i.test(text) ||
    /\b(?:readme|guardrails|docs?|documentation|document|markdown|code\s+fence|fenced\s+block)\b/i.test(text);
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

/**
 * Whether a resolved memory is close enough to suppress an older open bug/TODO.
 * The matcher is intentionally conservative: it needs shared concrete tokens,
 * a shared file/reference anchor, or a broad documentation completion signal.
 */
export function memoryResolvesItem(openItem: string, resolvedItem: string): boolean {
  if (!hasResolutionSignal(resolvedItem.toLowerCase())) return false;

  const openTokens = matchTokens(openItem);
  const resolvedTokens = matchTokens(resolvedItem);
  const shared = [...openTokens].filter((token) => resolvedTokens.has(token));
  const sharedAnchors = intersects(referenceAnchors(openItem), referenceAnchors(resolvedItem));
  const sharedCodeFence = shared.includes('code') && shared.includes('fence');

  if (sharedAnchors && shared.length >= 2) return true;
  if (shared.length >= 3) return true;
  if (sharedCodeFence) return true;

  return sharedAnchors &&
    hasDocumentationSignalForResolution(openItem) &&
    hasDocumentationSignalForResolution(resolvedItem);
}

// ---------------------------------------------------------------------------
// Synthesized summary (context, not raw bullets)
// ---------------------------------------------------------------------------

const TOPIC_STOP = new Set([
  ...STOPWORDS,
  'use', 'using', 'used', 'fix', 'fixing', 'fixed', 'add', 'adding', 'added',
  'resolve', 'resolving', 'resolved', 'complete', 'completing', 'completed',
  'close', 'closing', 'closed', 'address', 'addressing', 'addressed',
  'repair', 'repairing', 'repaired', 'implement', 'implementing', 'handle', 'handling',
  'update', 'updating', 'remove', 'removing', 'refactor', 'need', 'still', 'also', 'after', 'when',
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
    ...signals.resolved,
  ];
  if (all.length === 0) return '';

  const counts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (signals.decisions.length) counts.push(plural(signals.decisions.length, 'decision'));
  if (signals.bugs.length) counts.push(plural(signals.bugs.length, 'bug'));
  if (signals.todos.length) counts.push(plural(signals.todos.length, 'TODO'));
  if (signals.errors.length) counts.push(plural(signals.errors.length, 'error'));
  if (signals.resolved.length) counts.push(plural(signals.resolved.length, 'resolved item'));

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
