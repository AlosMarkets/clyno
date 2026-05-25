#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractSignals,
  synthesizeSummary,
  dedupeMemories,
  parseMemoryItems,
  cleanTranscriptForExtraction,
  stripTranscriptMetadata,
  stripFrontmatter,
  repairMemoryText,
  isQualityMemory,
  isSuspiciousCandidate,
  memoryResolvesItem,
  type MemoryType,
} from './memory.js';

type NodePtyModule = typeof import('node-pty');

const requireFromHere = createRequire(import.meta.url);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = join(PACKAGE_ROOT, 'package.json');

function isGitMarker(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').startsWith('gitdir:');
  } catch {
    return existsSync(join(path, 'HEAD'));
  }
}

/**
 * Walk up from `start` looking for a `.git` entry (a directory for a normal
 * checkout, a file for a worktree/submodule). Returns the repository root, or
 * null if none is found. This is a pure filesystem walk so it works even when
 * the `git` binary is not installed.
 */
function findGitRoot(start: string): string | null {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isGitMarker(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Resolve the directory that holds all Clino state (sessions + memory).
 *
 * Resolution order:
 *   1. CLINO_HOME env var, if set — used exactly as given.
 *   2. <git-root>/.clino, when run inside a Git working tree.
 *   3. <cwd>/.clino otherwise.
 *
 * Storage is project-local by default so memory never leaks between unrelated
 * projects. ~/.clino (os.homedir) is intentionally no longer used for project
 * memory; it may be reserved for global config in the future.
 */
interface ClinoStorage {
  home: string;
  sessionsDir: string;
  memoryDir: string;
  reviewsDir: string;
  processedSessionsFile: string;
  gitRoot: string | null;
  overrideActive: boolean;
  mode: 'CLINO_HOME override' | 'project-local Git root' | 'cwd fallback';
}

function resolveClinoStorage(): ClinoStorage {
  const overrideActive = Boolean(process.env.CLINO_HOME);
  const gitRoot = findGitRoot(process.cwd());
  const home = overrideActive ? process.env.CLINO_HOME! : join(gitRoot ?? process.cwd(), '.clino');
  const mode = overrideActive
    ? 'CLINO_HOME override'
    : gitRoot
      ? 'project-local Git root'
      : 'cwd fallback';

  return {
    home,
    sessionsDir: join(home, 'sessions'),
    memoryDir: join(home, 'memory'),
    reviewsDir: join(home, 'reviews'),
    processedSessionsFile: join(home, 'processed.sessions'),
    gitRoot,
    overrideActive,
    mode,
  };
}

// Configuration. All commands read and write through this single resolved home.
const STORAGE = resolveClinoStorage();
const CLINO_DIR = STORAGE.home;
const SESSIONS_DIR = STORAGE.sessionsDir;
const MEMORY_DIR = STORAGE.memoryDir;
const REVIEWS_DIR = STORAGE.reviewsDir;
const PROCESSED_SESSIONS_FILE = STORAGE.processedSessionsFile;

interface PackageInfo {
  name?: string;
  version?: string;
  main?: string;
  bin?: string | Record<string, string>;
}

function readPackageInfo(): PackageInfo | null {
  try {
    return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as PackageInfo;
  } catch {
    return null;
  }
}

function clinoVersion(): string {
  return readPackageInfo()?.version ?? '0.0.0';
}

function printVersion(): void {
  console.log(`clino ${clinoVersion()}`);
}

function loadNodePty(): NodePtyModule {
  return requireFromHere('node-pty') as NodePtyModule;
}

function nodePtyStatus(): { ok: boolean; message?: string } {
  try {
    const mod = loadNodePty();
    return typeof mod.spawn === 'function'
      ? { ok: true }
      : { ok: false, message: 'node-pty did not expose spawn' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

const HELP_TEXT = `Clino — local memory for terminal coding agents

Usage:
  clino run [--review|--no-memory] <command> [args...]
  clino inspect latest [--show-cleaned] [--max-chars <n>]
  clino inspect <session-file> [--show-cleaned] [--max-chars <n>]
  clino review pending
  clino review latest [--accept all|<ids>] [--no-summary] [--include-suspicious] [--skip]
  clino review <session-file> [--accept all|<ids>] [--no-summary] [--include-suspicious] [--skip]
  clino summarize [--dry-run] [--show-cleaned] [--max-chars <n>] <session-file>
  clino memory list [--type <type>] [--include-resolved]
  clino memory show <id>
  clino memory delete <id> [--dry-run]
  clino memory rebuild [--dry-run]
  clino find <query>
  clino inject <query>
  clino resolve <id>
  clino resolve <query>
  clino status
  clino doctor
  clino --version
  clino help

Flags:
  -h, --help       Show help
  -v, --version    Show version

Run memory modes:
  default        Save transcript, extract memories, write memory automatically
  --review      Save transcript and show candidates without writing memory
  --no-memory   Save transcript only, skipping extraction

Examples:
  clino run claude
  clino run --review claude
  clino run --no-memory codex
  clino inspect latest
  clino review pending
  clino review latest
  clino review latest --accept all
  clino review latest --skip
  clino summarize --dry-run .clino/sessions/2026-05-24-20-30-00.md
  clino memory list
  clino memory show decision-1
  clino memory rebuild --dry-run
  clino find "auth bug"
  clino inject "storage"
  clino resolve todo-1
  clino resolve "clino status command"
  clino status

Storage:
  Uses project-local .clino/ by default.
  CLINO_HOME can override storage location.

Privacy:
  .clino/ is ignored by Git by default.`;

function printHelp(): void {
  console.log(HELP_TEXT);
}

/**
 * Create the Clino state directories on demand. Only the writing commands
 * (`run`, `summarize`) call this; read-only commands (`status`, `doctor`,
 * `find`, `inject`) never create `.clino/` just to inspect or report on it.
 */
function ensureClinoDirs(): void {
  [CLINO_DIR, SESSIONS_DIR, MEMORY_DIR].forEach((dir) => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  });
}

// Load processed sessions
const processedSessions: Set<string> = new Set();
if (existsSync(PROCESSED_SESSIONS_FILE)) {
  readFileSync(PROCESSED_SESSIONS_FILE, 'utf8')
    .split('\n')
    .forEach((line) => {
      if (line.trim()) processedSessions.add(line.trim());
    });
}

// Human-friendly section titles for each memory file.
const FILE_TITLES: Record<string, string> = {
  decisions: 'Decisions',
  todos: 'Open TODOs',
  bugs: 'Open Bugs',
  errors: 'Errors',
  resolved: 'Recently Resolved',
  summaries: 'Summary',
};

interface InsightCounts {
  decisions: number;
  todos: number;
  bugs: number;
  errors: number;
  resolved: number;
}

type RunMemoryMode = 'auto' | 'review' | 'none';

interface ParsedRunArgs {
  mode: RunMemoryMode;
  command: string;
  args: string[];
}

const RUN_USAGE = 'Usage: clino run [--review|--no-memory] <command> [args...]';

function insightCountsFromReport(report: ExtractionReport): InsightCounts {
  return {
    decisions: report.counts.decisions,
    todos: report.counts.todos,
    bugs: report.counts.bugs,
    errors: report.counts.errors,
    resolved: report.counts.resolved,
  };
}

function formatInsightCountsInline(counts: InsightCounts): string {
  return `${counts.decisions} decisions, ${counts.todos} todos, ` +
    `${counts.bugs} bugs, ${counts.errors} errors, ${counts.resolved} resolved`;
}

function parseRunArgs(args: string[]): ParsedRunArgs | null {
  let review = false;
  let noMemory = false;
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--review' || arg === '--review-memory') {
      review = true;
      continue;
    }
    if (arg === '--no-memory' || arg === '--no-extract') {
      noMemory = true;
      continue;
    }
    if (arg.startsWith('--')) {
      console.error(`Unknown run option: ${arg}`);
      console.error(RUN_USAGE);
      return null;
    }
    break;
  }

  if (review && noMemory) {
    console.error('Cannot combine --review and --no-memory.');
    console.error(RUN_USAGE);
    return null;
  }

  const command = args[i];
  if (!command) {
    console.error(RUN_USAGE);
    return null;
  }

  return {
    mode: review ? 'review' : noMemory ? 'none' : 'auto',
    command,
    args: args.slice(i + 1),
  };
}

/**
 * Run a command through a real PTY, wiring it to the parent terminal so the
 * child behaves exactly as if launched directly: colors, prompts, raw keystrokes
 * (arrows, Ctrl+C), and window resizes all pass through. The full byte stream is
 * captured for the session transcript. No Clino output is written while the child
 * is running — a single summary line is printed only after it exits.
 *
 * Resolves with the child's exit code so the caller can mirror it.
 */
function runCommand(
  agentCmd: string,
  agentArgs: string[],
  memoryMode: RunMemoryMode = 'auto',
): Promise<number> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const interactive = Boolean(stdin.isTTY && stdout.isTTY);
    const startedAt = new Date();
    const ptyStatus = nodePtyStatus();

    if (!ptyStatus.ok) {
      process.stderr.write(
        `clino: node-pty could not be loaded${ptyStatus.message ? `: ${ptyStatus.message}` : ''}\n`,
      );
      resolve(1);
      return;
    }

    let ptyProcess;
    try {
      ptyProcess = loadNodePty().spawn(agentCmd, agentArgs, {
        name: process.env.TERM || 'xterm-256color',
        cols: stdout.columns || 80,
        rows: stdout.rows || 30,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (err) {
      // Typically ENOENT: the command isn't on PATH. Mirror the shell's 127.
      process.stderr.write(`clino: cannot run '${agentCmd}': ${(err as Error).message}\n`);
      resolve(127);
      return;
    }

    let transcript = '';
    let exited = false;

    // Put our stdin into raw mode so keystrokes (including Ctrl+C, arrow keys,
    // and pasted input) are delivered verbatim to the child's PTY rather than
    // being line-buffered or interpreted by our own terminal.
    const setRaw = (on: boolean) => {
      if (interactive && typeof stdin.setRawMode === 'function') {
        try {
          stdin.setRawMode(on);
        } catch {
          /* not all TTYs support raw mode; degrade gracefully */
        }
      }
    };

    const restoreTerminal = () => {
      setRaw(false);
      stdin.removeListener('data', onStdinData);
      stdout.removeListener('resize', onResize);
      stdin.pause();
    };

    const onStdinData = (data: Buffer) => {
      if (!exited) ptyProcess!.write(data.toString('utf8'));
    };

    // Keep the child's PTY the same size as our terminal so full-screen TUIs
    // (claude, codex, vim, …) redraw correctly when the window changes.
    const onResize = () => {
      if (exited) return;
      try {
        ptyProcess!.resize(stdout.columns || 80, stdout.rows || 30);
      } catch {
        /* child may be mid-exit */
      }
    };

    // Forward the child's output to our terminal and record it raw.
    const dataDisposable = ptyProcess.onData((data: string) => {
      transcript += data;
      stdout.write(data);
    });

    setRaw(true);
    stdin.resume();
    stdin.on('data', onStdinData);
    stdout.on('resize', onResize);

    // Forward termination signals to the child. In raw mode Ctrl+C reaches the
    // child as a byte (so these rarely fire), but this covers the non-TTY case
    // and an outer SIGTERM/SIGHUP, e.g. the terminal window being closed.
    const forwardSignal = (signal: string) => () => {
      try {
        if (!exited) ptyProcess!.kill(signal);
      } catch {
        /* already gone */
      }
    };
    const sigint = forwardSignal('SIGINT');
    const sigterm = forwardSignal('SIGTERM');
    const sighup = forwardSignal('SIGHUP');
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
    process.on('SIGHUP', sighup);

    ptyProcess.onExit(({ exitCode, signal }) => {
      exited = true;
      dataDisposable.dispose();
      restoreTerminal();
      process.removeListener('SIGINT', sigint);
      process.removeListener('SIGTERM', sigterm);
      process.removeListener('SIGHUP', sighup);

      // node-pty reports exitCode 0 with a non-zero `signal` for signal-killed
      // children, so a signal takes precedence and maps to the shell's 128+N
      // (e.g. Ctrl+C → SIGINT → 130).
      const code = signal ? 128 + signal : exitCode ?? 0;
      finalizeSession(agentCmd, agentArgs, startedAt, transcript, code, signal, memoryMode);
      resolve(code);
    });
  });
}

/**
 * Persist the raw transcript and run insight extraction. Called only after the
 * child has exited and the terminal has been restored, so its output is safe.
 */
function finalizeSession(
  agentCmd: string,
  agentArgs: string[],
  startedAt: Date,
  transcript: string,
  exitCode: number,
  signal?: number,
  memoryMode: RunMemoryMode = 'auto',
): void {
  ensureClinoDirs();
  const endedAt = new Date();
  const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const sessionFile = join(SESSIONS_DIR, `${timestamp}.md`);

  const sessionContent =
    `# Coding Agent Session\n\n` +
    `**Agent:** ${agentCmd}\n` +
    `**Arguments:** ${agentArgs.join(' ')}\n` +
    `**Started:** ${startedAt.toISOString()}\n` +
    `**Ended:** ${endedAt.toISOString()}\n` +
    `**Exit code:** ${exitCode}${signal ? ` (signal ${signal})` : ''}\n\n` +
    `## Transcript\n\n\`\`\`\n${transcript}\`\`\`\n`;

  writeFileSync(sessionFile, sessionContent, 'utf8');

  if (memoryMode === 'none') {
    process.stdout.write(
      `\n[clino] session saved → ${sessionFile}\n` +
        '[clino] memory extraction skipped (--no-memory)\n',
    );
    return;
  }

  if (memoryMode === 'review') {
    const report = buildExtractionReport(sessionFile);
    const counts = insightCountsFromReport(report);
    process.stdout.write(
      `\n[clino] session saved → ${sessionFile}\n` +
        '[clino] review mode: memory was not written\n' +
        `[clino] candidates: ${formatInsightCountsInline(counts)}\n` +
        '[clino] review with:\n' +
        '  clino review latest\n' +
        `  clino review ${sessionFile}\n`,
    );
    return;
  }

  let counts: InsightCounts = { decisions: 0, todos: 0, bugs: 0, errors: 0, resolved: 0 };
  if (!processedSessions.has(sessionFile)) {
    counts = extractInsights(sessionFile, { quiet: true });
    processedSessions.add(sessionFile);
    writeFileSync(PROCESSED_SESSIONS_FILE, Array.from(processedSessions).join('\n'), 'utf8');
  }

  // The single, simple post-session message (requirement: nothing during run).
  process.stdout.write(
    `\n[clino] session saved → ${sessionFile}\n` +
      `[clino] learned ${formatInsightCountsInline(counts)}\n`,
  );
}

/**
 * Extract insights from a session file and persist them as clean memories.
 * Returns the per-category counts. Pass `quiet` to suppress progress logging
 * (used by `clino run`, which prints its own single post-session summary).
 */
function extractInsights(
  sessionFilePath: string,
  opts: { quiet?: boolean } = {},
): InsightCounts {
  if (!opts.quiet) console.log('🔍 Extracting insights from session...');

  ensureClinoDirs();
  const report = buildExtractionReport(sessionFilePath);
  const signals = report.signals;

  writeMemoryFile('decisions.md', signals.decisions, sessionFilePath);
  writeMemoryFile('todos.md', signals.todos, sessionFilePath);
  writeMemoryFile('bugs.md', signals.bugs, sessionFilePath);
  writeMemoryFile('errors.md', signals.errors, sessionFilePath);
  writeMemoryFile('resolved.md', signals.resolved, sessionFilePath);
  writeSummaryFile('summaries.md', report.summary, sessionFilePath);

  const counts = {
    decisions: signals.decisions.length,
    todos: signals.todos.length,
    bugs: signals.bugs.length,
    errors: signals.errors.length,
    resolved: signals.resolved.length,
  };

  if (!opts.quiet) {
    console.log(
      `✅ Extracted: ${counts.decisions} decisions, ${counts.todos} TODOs, ` +
        `${counts.bugs} bugs, ${counts.errors} errors, ${counts.resolved} resolved`,
    );
  }

  return counts;
}

interface ExtractionReport {
  sessionFilePath: string;
  fileSizeBytes: number;
  metadata: {
    started?: string;
    ended?: string;
    exitCode?: string;
  };
  cleanedText: string;
  signals: ReturnType<typeof extractSignals>;
  summary: string;
  counts: InsightCounts & { summary: number };
}

interface ParsedDebugArgs {
  positionals: string[];
  dryRun: boolean;
  showCleaned: boolean;
  maxChars: number;
}

const DEFAULT_CLEANED_MAX_CHARS = 4000;
const CLEANED_PREVIEW_CHARS = 800;

const MEMORY_WRITE_PREVIEW: Array<{ type: MemoryType; filename: string; label: string }> = [
  { type: 'decisions', filename: 'decisions.md', label: 'decisions' },
  { type: 'todos', filename: 'todos.md', label: 'todos' },
  { type: 'bugs', filename: 'bugs.md', label: 'bugs' },
  { type: 'errors', filename: 'errors.md', label: 'errors' },
  { type: 'resolved', filename: 'resolved.md', label: 'resolved' },
];

function parseDebugArgs(args: string[], usage: string, allowDryRun: boolean): ParsedDebugArgs | null {
  const parsed: ParsedDebugArgs = {
    positionals: [],
    dryRun: false,
    showCleaned: false,
    maxChars: DEFAULT_CLEANED_MAX_CHARS,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' && allowDryRun) {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--show-cleaned') {
      parsed.showCleaned = true;
      continue;
    }
    if (arg === '--max-chars') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(usage);
        return null;
      }
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error('Invalid value for --max-chars');
        return null;
      }
      parsed.maxChars = n;
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      console.error(usage);
      return null;
    }
    parsed.positionals.push(arg);
  }

  return parsed;
}

function sessionMetadata(content: string): ExtractionReport['metadata'] {
  const findLabel = (label: string): string | undefined => {
    const re = new RegExp(`^\\s*\\*{0,2}${label}\\s*:\\s*\\*{0,2}\\s*(.+?)\\s*$`, 'im');
    return content.match(re)?.[1]?.trim();
  };

  return {
    started: findLabel('Started'),
    ended: findLabel('Ended'),
    exitCode: findLabel('Exit code'),
  };
}

function buildExtractionReport(sessionFilePath: string): ExtractionReport {
  const content = readFileSync(sessionFilePath, 'utf8');
  const signals = extractSignals(content);
  const summary = synthesizeSummary(signals);
  return {
    sessionFilePath,
    fileSizeBytes: statSync(sessionFilePath).size,
    metadata: sessionMetadata(content),
    cleanedText: stripTranscriptMetadata(cleanTranscriptForExtraction(content)).trim(),
    signals,
    summary,
    counts: {
      decisions: signals.decisions.length,
      todos: signals.todos.length,
      bugs: signals.bugs.length,
      errors: signals.errors.length,
      resolved: signals.resolved.length,
      summary: summary ? 1 : 0,
    },
  };
}

function sessionTranscriptPathsNewestFirst(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files = readdirSync(SESSIONS_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => join(SESSIONS_DIR, file))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });

  files.sort((a, b) => {
    const diff = statSync(b).mtimeMs - statSync(a).mtimeMs;
    return diff === 0 ? b.localeCompare(a) : diff;
  });
  return files;
}

function newestSessionFile(): string | null {
  const files = sessionTranscriptPathsNewestFirst();
  return files.length === 0 ? null : files[0];
}

function pendingSessionPathsNewestFirst(): string[] {
  return sessionTranscriptPathsNewestFirst().filter((file) => !isSessionReviewed(file));
}

function newestPendingSessionFile(): string | null {
  const pending = pendingSessionPathsNewestFirst();
  return pending.length === 0 ? null : pending[0];
}

function printNoPendingReviewSessions(): number {
  console.log('No pending review sessions.');
  console.log('');
  console.log('Suggest:');
  console.log('  clino review pending');
  return 0;
}

function reviewMarkerFilename(sessionBasename: string): string {
  const safe = sessionBasename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const stem = safe.endsWith('.md') ? safe.slice(0, -3) : safe;
  return `${stem}.reviewed.json`;
}

function reviewMarkerPathForSession(sessionPath: string): string {
  return join(REVIEWS_DIR, reviewMarkerFilename(basename(sessionPath)));
}

function isSessionReviewed(sessionPath: string): boolean {
  return existsSync(reviewMarkerPathForSession(sessionPath));
}

function countReviewedSessions(): number {
  if (!existsSync(REVIEWS_DIR)) return 0;
  return readdirSync(REVIEWS_DIR).filter((file) => file.endsWith('.reviewed.json')).length;
}

function countSkippedReviewSessions(): number {
  if (!existsSync(REVIEWS_DIR)) return 0;
  let skipped = 0;
  for (const file of readdirSync(REVIEWS_DIR)) {
    if (!file.endsWith('.reviewed.json')) continue;
    try {
      const marker = JSON.parse(readFileSync(join(REVIEWS_DIR, file), 'utf8')) as { status?: string };
      if (marker.status === 'skipped') skipped++;
    } catch {
      /* ignore malformed markers */
    }
  }
  return skipped;
}

function countPendingReviewSessions(): number {
  return pendingSessionPathsNewestFirst().length;
}

interface ReviewMarkerAccepted {
  decisions: number;
  todos: number;
  bugs: number;
  errors: number;
  resolved: number;
  summaries: number;
}

function shouldWriteReviewMarker(
  accept: string,
  candidates: ReviewCandidate[],
  selected: ReviewCandidate[],
): boolean {
  if (accept.toLowerCase() === 'all' && candidates.length === 0) return true;
  return selected.length > 0;
}

type ReviewMarkerStatus = 'reviewed' | 'skipped';

function writeReviewMarker(
  sessionPath: string,
  written: MemoryCounts,
  status: ReviewMarkerStatus = 'reviewed',
): void {
  mkdirSync(REVIEWS_DIR, { recursive: true });
  const marker = {
    session: basename(sessionPath),
    status,
    reviewedAt: new Date().toISOString(),
    accepted: {
      decisions: written.decisions,
      todos: written.todos,
      bugs: written.bugs,
      errors: written.errors,
      resolved: written.resolved,
      summaries: written.summaries,
    } satisfies ReviewMarkerAccepted,
  };
  writeFileSync(
    reviewMarkerPathForSession(sessionPath),
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf8',
  );
}

function formatPendingCandidateCounts(report: ExtractionReport): string {
  const total =
    report.counts.decisions +
    report.counts.todos +
    report.counts.bugs +
    report.counts.errors +
    report.counts.resolved +
    report.counts.summary;
  if (total === 0) return 'no candidates';
  return (
    `decisions:${report.counts.decisions} todos:${report.counts.todos} ` +
    `bugs:${report.counts.bugs} errors:${report.counts.errors} ` +
    `resolved:${report.counts.resolved}`
  );
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars).replace(/\s+$/g, ''),
    truncated: true,
  };
}

function formatCleanedBlock(label: string, cleanedText: string, maxChars: number): string[] {
  const { text, truncated } = truncateText(cleanedText || '(empty)', maxChars);
  const lines = [`${label}:`, text];
  if (truncated) {
    lines.push(`[truncated to ${maxChars} of ${cleanedText.length} chars]`);
  }
  return lines;
}

function printCounts(counts: ExtractionReport['counts']): string[] {
  return [
    `- decisions: ${counts.decisions}`,
    `- todos: ${counts.todos}`,
    `- bugs: ${counts.bugs}`,
    `- errors: ${counts.errors}`,
    `- resolved: ${counts.resolved}`,
    `- summary: ${counts.summary}`,
  ];
}

function printCategory(label: string, items: string[]): string[] {
  if (items.length === 0) return [`${label} (0)`, '(none)'];
  return [`${label} (${items.length})`, ...items.map((item) => `- ${item}`)];
}

function printSummaryCategory(summary: string): string[] {
  if (!summary) return ['summary (0)', '(none)'];
  return ['summary (1)', summary];
}

function dryRunMergedItems(type: MemoryType, filename: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return dedupeMemories([...items, ...readStoredMemoryItems(filename, type)]);
}

function printCandidateMemories(report: ExtractionReport): string[] {
  return [
    'Candidate memories:',
    ...printCategory('decisions', report.signals.decisions),
    ...printCategory('todos', report.signals.todos),
    ...printCategory('bugs', report.signals.bugs),
    ...printCategory('errors', report.signals.errors),
    ...printCategory('resolved', report.signals.resolved),
    ...printSummaryCategory(report.summary),
  ];
}

function printDryRunMemories(report: ExtractionReport): string[] {
  const lines = ['Final stored memories if written:'];
  for (const bucket of MEMORY_WRITE_PREVIEW) {
    lines.push(
      ...printCategory(
        bucket.label,
        dryRunMergedItems(bucket.type, bucket.filename, report.signals[bucket.type]),
      ),
    );
  }
  lines.push(...printSummaryCategory(report.summary));
  return lines;
}

function resolveSessionArg(sessionArg: string): string {
  return resolve(process.cwd(), sessionArg);
}

function printInspect(args: string[]): number {
  const usage = 'Usage: clino inspect <latest|session-file> [--show-cleaned] [--max-chars <n>]';
  const parsed = parseDebugArgs(args, usage, false);
  if (!parsed) return 1;
  if (parsed.positionals.length !== 1) {
    console.error(usage);
    return 1;
  }

  const target = parsed.positionals[0] === 'latest'
    ? newestSessionFile()
    : resolveSessionArg(parsed.positionals[0]);

  if (!target) {
    console.error(`No session transcripts found in ${SESSIONS_DIR}`);
    return 1;
  }
  if (!existsSync(target)) {
    console.error(`Session file not found: ${target}`);
    return 1;
  }

  let report: ExtractionReport;
  try {
    report = buildExtractionReport(target);
  } catch (err) {
    console.error(`Could not inspect session: ${(err as Error).message}`);
    return 1;
  }

  const preview = truncateText(report.cleanedText || '(empty)', CLEANED_PREVIEW_CHARS);
  const lines = [
    'Clino inspect',
    '',
    `File: ${report.sessionFilePath}`,
    `Size: ${report.fileSizeBytes} bytes`,
    `Started: ${report.metadata.started ?? 'n/a'}`,
    `Ended: ${report.metadata.ended ?? 'n/a'}`,
    `Exit code: ${report.metadata.exitCode ?? 'n/a'}`,
    '',
    'Cleaned preview:',
    preview.text,
  ];
  if (preview.truncated) {
    lines.push(`[truncated to ${CLEANED_PREVIEW_CHARS} of ${report.cleanedText.length} chars]`);
  }
  lines.push('', 'Extraction counts:', ...printCounts(report.counts));
  if (parsed.showCleaned) {
    lines.push('', ...formatCleanedBlock('Cleaned transcript', report.cleanedText, parsed.maxChars));
  }

  console.log(lines.join('\n'));
  return 0;
}

function printSummarize(args: string[]): number {
  const usage = 'Usage: clino summarize [--dry-run] [--show-cleaned] [--max-chars <n>] <session-file>';
  const parsed = parseDebugArgs(args, usage, true);
  if (!parsed) return 1;
  if (parsed.positionals.length !== 1) {
    console.error(usage);
    return 1;
  }

  const sessionFile = resolveSessionArg(parsed.positionals[0]);
  if (!existsSync(sessionFile)) {
    console.error(`Session file not found: ${sessionFile}`);
    return 1;
  }

  if (!parsed.dryRun) {
    if (parsed.showCleaned) {
      const report = buildExtractionReport(sessionFile);
      console.log(formatCleanedBlock('Cleaned transcript', report.cleanedText, parsed.maxChars).join('\n'));
    }
    extractInsights(sessionFile);
    return 0;
  }

  let report: ExtractionReport;
  try {
    report = buildExtractionReport(sessionFile);
  } catch (err) {
    console.error(`Could not summarize session: ${(err as Error).message}`);
    return 1;
  }

  const lines = [
    'Clino summarize dry run',
    '',
    `File: ${report.sessionFilePath}`,
    'No memory files were written.',
    '',
    'Extraction counts:',
    ...printCounts(report.counts),
  ];
  if (parsed.showCleaned) {
    lines.push('', ...formatCleanedBlock('Cleaned transcript', report.cleanedText, parsed.maxChars));
  }
  lines.push('', ...printCandidateMemories(report), '', ...printDryRunMemories(report));

  console.log(lines.join('\n'));
  return 0;
}

/**
 * Merge freshly extracted items with what is already stored, re-running repair
 * and the quality filter over existing content (so legacy junk is cleaned too),
 * then dedupe with richer-memory preference and rewrite the file. Returns the
 * number of new stored bullet memories added by this write.
 */
function writeMemoryFile(filename: string, items: string[], source: string): number {
  const type = filename.replace('.md', '') as MemoryType;
  const filePath = join(MEMORY_DIR, filename);
  if (items.length === 0) return 0;

  const existing = readStoredMemoryItems(filename, type);

  const merged = dedupeMemories([...items, ...existing]);
  if (merged.length === 0) return 0;
  if (sameStringArray(merged, existing)) return 0;

  const body = merged.map((m) => `- ${m}`).join('\n');
  writeFileSync(filePath, frontmatter(type, source) + body + '\n', 'utf8');
  return Math.max(0, merged.length - existing.length);
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function readStoredMemoryItems(filename: string, type: MemoryType): string[] {
  const filePath = join(MEMORY_DIR, filename);
  if (!existsSync(filePath)) return [];
  return dedupeMemories(
    parseMemoryItems(readFileSync(filePath, 'utf8'))
      .map(repairMemoryText)
      .filter((m) => isQualityMemory(m, type)),
  );
}

/**
 * Write the synthesized summary. Summaries are regenerated fresh each run and
 * must not duplicate the raw decision/bug/todo bullets.
 */
function writeSummaryFile(filename: string, summary: string, source: string): number {
  if (!summary) return 0;
  const filePath = join(MEMORY_DIR, filename);
  if (existsSync(filePath)) {
    const parsed = parseFrontmatter(readFileSync(filePath, 'utf8'));
    const existingSummaries = summaryTextItems(parsed.body).map((item) => item.text.trim());
    if (existingSummaries.includes(summary.trim())) return 0;
  }
  writeFileSync(filePath, frontmatter('summaries', source) + summary + '\n', 'utf8');
  return 1;
}

function frontmatter(type: string, source: string): string {
  const date = new Date().toISOString().split('T')[0];
  return `---\ntype: ${type}\ndate: ${date}\nsource: ${source}\n---\n\n`;
}

const QUERY_ALIASES: Record<string, string[]> = {
  documentation: [
    'documentation',
    'docs',
    'README',
    'README.md',
    'GUARDRAILS',
    'GUARDRAILS.md',
    'markdown',
  ],
  docs: [
    'documentation',
    'docs',
    'README',
    'README.md',
    'GUARDRAILS',
    'GUARDRAILS.md',
    'markdown',
  ],
  guardrails: [
    'guardrails',
    'GUARDRAILS.md',
    'documentation',
    'project guardrails',
  ],
  readme: [
    'readme',
    'README.md',
    'documentation',
    'docs',
  ],
  'code fence': [
    'code fence',
    'unclosed code fence',
    'markdown',
    'fenced block',
  ],
};

function normalizeSearchTerm(term: string): string {
  return term.toLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms.map(normalizeSearchTerm).filter(Boolean)) {
    if (seen.has(term)) continue;
    seen.add(term);
    unique.push(term);
  }
  return unique;
}

function expandSearchQuery(query: string): { directTerms: string[]; allTerms: string[] } {
  const normalized = normalizeSearchTerm(query);
  const aliases = QUERY_ALIASES[normalized] ?? [];
  return {
    directTerms: uniqueTerms([query]),
    allTerms: uniqueTerms([query, ...aliases]),
  };
}

/**
 * Search memory files. Frontmatter and headings are ignored so keyword tags and
 * metadata never surface as results.
 */
function searchMemory(query: string): Array<{ file: string; matches: string[] }> {
  console.log(`🔍 Searching memory for: "${query}"`);

  const { directTerms, allTerms } = expandSearchQuery(query);
  const normalizedQuery = normalizeSearchTerm(query);
  const preferDirectMatches = normalizedQuery === 'readme' || normalizedQuery === 'readme.md';
  const results: Array<{ file: string; matches: string[] }> = [];
  const aliasResults: Array<{ file: string; matches: string[]; directMatches: string[] }> = [];

  if (!existsSync(MEMORY_DIR)) return results; // nothing captured yet

  readdirSync(MEMORY_DIR).forEach((file) => {
    if (!file.endsWith('.md')) return;
    const body = stripFrontmatter(readFileSync(join(MEMORY_DIR, file), 'utf8'));
    const lines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const matches = lines.filter((l) => {
      const lower = l.toLowerCase();
      return allTerms.some((term) => lower.includes(term));
    });
    const directMatches = matches.filter((l) => {
      const lower = l.toLowerCase();
      return directTerms.some((term) => lower.includes(term));
    });

    if (matches.length > 0) {
      aliasResults.push({ file, matches, directMatches });
    }
  });

  const hasDirectMatches = aliasResults.some((result) => result.directMatches.length > 0);
  for (const result of aliasResults) {
    const matches = preferDirectMatches && hasDirectMatches ? result.directMatches : result.matches;
    if (matches.length > 0) results.push({ file: result.file, matches: matches.slice(0, 8) });
  }

  return results;
}

/**
 * Generate a compact, grouped, deduped context block for injection.
 */
function generateContext(query: string, maxChars = 3000): string {
  console.log(`💡 Generating context for: "${query}"`);

  const results = searchMemory(query);
  let context = `# Project Context: ${query}\n\n`;

  if (results.length === 0) {
    return context + `No relevant memories found for "${query}".\n`;
  }

  const allResolvedItems = readStoredMemoryItems('resolved.md', 'resolved');
  const matchedResolvedItems: string[] = [];
  const suppressedByResolved: string[] = [];

  for (const result of results) {
    const key = result.file.replace('.md', '');
    if (key === 'resolved') {
      matchedResolvedItems.push(
        ...result.matches
          .map((m) => m.replace(/^[-*]\s+/, '').trim())
          .map(repairMemoryText)
          .filter((m) => isQualityMemory(m, 'resolved')),
      );
      continue;
    }

    const title = FILE_TITLES[key] || key;

    // Re-apply the quality/dedupe layer at inject time (defense in depth).
    // Summaries are already synthesized text and intentionally match the Clino
    // output-noise guard used by extraction, so they must not be repaired again.
    let items = key === 'summaries'
      ? dedupeMemories(result.matches.map((m) => m.replace(/^[-*]\s+/, '').trim()).filter(Boolean))
      : dedupeMemories(
          result.matches
            .map((m) => m.replace(/^[-*]\s+/, '').trim())
            .map(repairMemoryText)
            .filter((m) => isQualityMemory(m, key as MemoryType)),
        );
    if (key === 'bugs' || key === 'todos') {
      items = items.filter((item) => {
        const resolver = allResolvedItems.find((resolved) => memoryResolvesItem(item, resolved));
        if (resolver) {
          suppressedByResolved.push(resolver);
          return false;
        }
        return true;
      });
    }
    if (items.length === 0) continue;

    context += `## ${title}\n`;
    context += items.map((i) => `- ${i}`).join('\n');
    context += '\n\n';
  }

  const resolvedToShow = dedupeMemories([...matchedResolvedItems, ...suppressedByResolved]);
  if (resolvedToShow.length > 0) {
    context += `## ${FILE_TITLES.resolved}\n`;
    context += resolvedToShow.map((i) => `- ${i}`).join('\n');
    context += '\n\n';
  }

  if (context.length > maxChars) {
    context = context.slice(0, maxChars) + '\n\n*[Context truncated for token efficiency]*\n';
  }

  return context;
}

// ---------------------------------------------------------------------------
// Memory management
// ---------------------------------------------------------------------------

type MemoryCategory = MemoryType | 'summaries';
type MemoryDisplayType = 'decision' | 'todo' | 'bug' | 'error' | 'resolved' | 'summary';

interface MemoryFileDescriptor {
  category: MemoryCategory;
  displayType: MemoryDisplayType;
  filename: string;
}

interface ParsedMemoryFile extends MemoryFileDescriptor {
  filePath: string;
  frontmatter: string;
  metadata: Record<string, string>;
  body: string;
}

interface ListedMemoryItem {
  id: string;
  type: MemoryDisplayType;
  category: MemoryCategory;
  text: string;
  filePath: string;
  date?: string;
  source?: string;
  bodyLineIndex?: number;
  resolved?: boolean;
}

const MEMORY_FILES: MemoryFileDescriptor[] = [
  { category: 'decisions', displayType: 'decision', filename: 'decisions.md' },
  { category: 'todos', displayType: 'todo', filename: 'todos.md' },
  { category: 'bugs', displayType: 'bug', filename: 'bugs.md' },
  { category: 'errors', displayType: 'error', filename: 'errors.md' },
  { category: 'resolved', displayType: 'resolved', filename: 'resolved.md' },
  { category: 'summaries', displayType: 'summary', filename: 'summaries.md' },
];

const MEMORY_TYPE_ALIASES: Record<string, MemoryDisplayType> = {
  decision: 'decision',
  decisions: 'decision',
  todo: 'todo',
  todos: 'todo',
  bug: 'bug',
  bugs: 'bug',
  error: 'error',
  errors: 'error',
  resolved: 'resolved',
  summary: 'summary',
  summaries: 'summary',
};

function parseFrontmatter(content: string): {
  frontmatter: string;
  metadata: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: '', metadata: {}, body: content };

  const metadata: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) metadata[key] = value;
  }

  return {
    frontmatter: match[0],
    metadata,
    body: content.slice(match[0].length),
  };
}

function readMemoryFile(descriptor: MemoryFileDescriptor): ParsedMemoryFile | null {
  const filePath = join(MEMORY_DIR, descriptor.filename);
  if (!existsSync(filePath)) return null;
  const parsed = parseFrontmatter(readFileSync(filePath, 'utf8'));
  return { ...descriptor, filePath, ...parsed };
}

function bulletText(line: string): string | null {
  const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
  return match ? match[1].trim() : null;
}

function summaryTextItems(body: string): Array<{ text: string; bodyLineIndex?: number }> {
  const lines = body.split(/\r?\n/);
  const bullets: Array<{ text: string; bodyLineIndex: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const text = bulletText(lines[i]);
    if (text) bullets.push({ text, bodyLineIndex: i });
  }
  if (bullets.length > 0) return bullets;

  const text = body.trim();
  return text ? [{ text }] : [];
}

function nextMemoryId(type: MemoryDisplayType, counts: Map<MemoryDisplayType, number>): string {
  const count = (counts.get(type) ?? 0) + 1;
  counts.set(type, count);
  return `${type}-${count}`;
}

function shortMemoryText(text: string, maxLength = 92): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).replace(/\s+$/g, '')}...`;
}

function rightPad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - text.length));
}

function readAllMemoryItems(): ListedMemoryItem[] {
  if (!existsSync(MEMORY_DIR)) return [];

  const items: ListedMemoryItem[] = [];
  const idCounts = new Map<MemoryDisplayType, number>();

  for (const descriptor of MEMORY_FILES) {
    const parsed = readMemoryFile(descriptor);
    if (!parsed) continue;

    if (descriptor.category === 'summaries') {
      for (const summary of summaryTextItems(parsed.body)) {
        items.push({
          id: nextMemoryId(descriptor.displayType, idCounts),
          type: descriptor.displayType,
          category: descriptor.category,
          text: summary.text,
          filePath: parsed.filePath,
          date: parsed.metadata.date,
          source: parsed.metadata.source,
          bodyLineIndex: summary.bodyLineIndex,
        });
      }
      continue;
    }

    const bodyLines = parsed.body.split(/\r?\n/);
    for (let i = 0; i < bodyLines.length; i++) {
      const text = bulletText(bodyLines[i]);
      if (!text) continue;
      items.push({
        id: nextMemoryId(descriptor.displayType, idCounts),
        type: descriptor.displayType,
        category: descriptor.category,
        text,
        filePath: parsed.filePath,
        date: parsed.metadata.date,
        source: parsed.metadata.source,
        bodyLineIndex: i,
      });
    }
  }

  const resolvedItems = items.filter((item) => item.type === 'resolved');
  for (const item of items) {
    if (item.type !== 'bug' && item.type !== 'todo') continue;
    item.resolved = resolvedItems.some((resolved) => memoryResolvesItem(item.text, resolved.text));
  }

  return items;
}

interface MemoryCounts {
  decisions: number;
  todos: number;
  bugs: number;
  errors: number;
  resolved: number;
  summaries: number;
}

interface RebuildPlan {
  sessionFiles: string[];
  signals: ReturnType<typeof extractSignals>;
  summaries: string[];
  counts: MemoryCounts;
}

const REBUILD_SOURCE = 'sessions/*';

function sessionTranscriptFiles(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => join(SESSIONS_DIR, file))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

function memoryCountsFromBuckets(
  signals: ReturnType<typeof extractSignals>,
  summaries: string[],
): MemoryCounts {
  return {
    decisions: signals.decisions.length,
    todos: signals.todos.length,
    bugs: signals.bugs.length,
    errors: signals.errors.length,
    resolved: signals.resolved.length,
    summaries: summaries.length,
  };
}

function currentMemoryCounts(): MemoryCounts {
  return {
    decisions: countMemoryItems('decisions.md'),
    todos: countMemoryItems('todos.md'),
    bugs: countMemoryItems('bugs.md'),
    errors: countMemoryItems('errors.md'),
    resolved: countMemoryItems('resolved.md'),
    summaries: countSummaries('summaries.md'),
  };
}

function formatMemoryCounts(counts: MemoryCounts): string[] {
  return [
    `- decisions: ${counts.decisions}`,
    `- todos: ${counts.todos}`,
    `- bugs: ${counts.bugs}`,
    `- errors: ${counts.errors}`,
    `- resolved: ${counts.resolved}`,
    `- summaries: ${counts.summaries}`,
  ];
}

interface ParsedReviewArgs {
  targetArg: string;
  accept?: string;
  noSummary: boolean;
  includeSuspicious: boolean;
  skip: boolean;
}

interface ReviewCandidate {
  id: string;
  type: MemoryDisplayType;
  category: MemoryCategory;
  text: string;
  suspicious: boolean;
}

const REVIEW_USAGE =
  'Usage: clino review <latest|session-file> [--accept all|<ids>] [--no-summary] [--include-suspicious] [--skip]';

const REVIEW_BUCKETS: Array<{ category: MemoryType; displayType: MemoryDisplayType }> = [
  { category: 'decisions', displayType: 'decision' },
  { category: 'todos', displayType: 'todo' },
  { category: 'bugs', displayType: 'bug' },
  { category: 'errors', displayType: 'error' },
  { category: 'resolved', displayType: 'resolved' },
];

function parseReviewArgs(args: string[]): ParsedReviewArgs | null {
  const positionals: string[] = [];
  let accept: string | undefined;
  let noSummary = false;
  let includeSuspicious = false;
  let skip = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--accept') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(REVIEW_USAGE);
        return null;
      }
      accept = value;
      i++;
      continue;
    }
    if (arg === '--no-summary') {
      noSummary = true;
      continue;
    }
    if (arg === '--include-suspicious') {
      includeSuspicious = true;
      continue;
    }
    if (arg === '--skip') {
      skip = true;
      continue;
    }
    if (arg.startsWith('--')) {
      console.error(`Unknown review option: ${arg}`);
      console.error(REVIEW_USAGE);
      return null;
    }
    positionals.push(arg);
  }

  if (positionals.length !== 1) {
    console.error(REVIEW_USAGE);
    return null;
  }

  if (skip && accept) {
    console.error('Cannot combine --skip and --accept.');
    console.error(REVIEW_USAGE);
    return null;
  }

  return { targetArg: positionals[0], accept, noSummary, includeSuspicious, skip };
}

function reviewCandidateSuspicious(
  type: MemoryDisplayType,
  category: MemoryCategory,
  text: string,
): boolean {
  if (category === 'summaries') return isSuspiciousCandidate(text, 'summaries');
  return isSuspiciousCandidate(text, category);
}

function buildReviewCandidates(report: ExtractionReport): ReviewCandidate[] {
  const candidates: ReviewCandidate[] = [];
  const idCounts = new Map<MemoryDisplayType, number>();

  for (const bucket of REVIEW_BUCKETS) {
    for (const text of report.signals[bucket.category]) {
      candidates.push({
        id: nextMemoryId(bucket.displayType, idCounts),
        type: bucket.displayType,
        category: bucket.category,
        text,
        suspicious: reviewCandidateSuspicious(bucket.displayType, bucket.category, text),
      });
    }
  }

  if (report.summary) {
    candidates.push({
      id: nextMemoryId('summary', idCounts),
      type: 'summary',
      category: 'summaries',
      text: report.summary,
      suspicious: reviewCandidateSuspicious('summary', 'summaries', report.summary),
    });
  }

  return candidates;
}

function formatReviewCandidates(candidates: ReviewCandidate[]): string[] {
  if (candidates.length === 0) {
    return ['Candidate memories:', '', 'No candidate memories found.'];
  }

  const idWidth = Math.max(...candidates.map((candidate) => candidate.id.length)) + 2;
  const typeWidth = Math.max(...candidates.map((candidate) => candidate.type.length)) + 2;
  return [
    'Candidate memories:',
    '',
    ...candidates.map((candidate) => {
      const suffix = candidate.suspicious ? '  [suspicious]' : '';
      return `${rightPad(candidate.id, idWidth)}${rightPad(candidate.type, typeWidth)}${candidate.text}${suffix}`;
    }),
  ];
}

function formatReviewPreview(
  report: ExtractionReport,
  candidates: ReviewCandidate[],
  targetArg: string,
): string[] {
  const lines = [
    'Clino review',
    '',
    `Session: ${report.sessionFilePath}`,
    '',
    ...formatReviewCandidates(candidates),
    '',
    'No files were changed.',
  ];

  if (candidates.length > 0) {
    const selectedExample = candidates.slice(0, 2).map((candidate) => candidate.id).join(',');
    const suspiciousCount = candidates.filter((c) => c.suspicious).length;
    lines.push(
      '',
      'To write all candidates:',
      `  clino review ${targetArg} --accept all`,
    );
    if (suspiciousCount > 0) {
      lines.push(
        '',
        `${suspiciousCount} candidate${suspiciousCount === 1 ? '' : 's'} marked [suspicious] — skipped by --accept all unless you pass --include-suspicious.`,
        `  clino review ${targetArg} --accept all --include-suspicious`,
      );
    }
    lines.push(
      '',
      'To write selected candidates:',
      `  clino review ${targetArg} --accept ${selectedExample}`,
    );
  }

  return lines;
}

function selectReviewCandidates(
  candidates: ReviewCandidate[],
  accept: string,
  noSummary: boolean,
  includeSuspicious: boolean,
): { selected: ReviewCandidate[]; error?: string } {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  let selected: ReviewCandidate[];

  if (accept.toLowerCase() === 'all') {
    selected = includeSuspicious
      ? candidates
      : candidates.filter((candidate) => !candidate.suspicious);
  } else {
    const ids = accept
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean);
    if (ids.length === 0) return { selected: [], error: 'No accept IDs provided.' };

    const invalid = ids.filter((id) => !candidateById.has(id));
    if (invalid.length > 0) {
      return { selected: [], error: `Invalid accept ID${invalid.length === 1 ? '' : 's'}: ${invalid.join(',')}` };
    }

    const seen = new Set<string>();
    selected = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      selected.push(candidateById.get(id)!);
    }
  }

  if (noSummary) {
    selected = selected.filter((candidate) => candidate.type !== 'summary');
  }

  return { selected };
}

function emptyMemoryCounts(): MemoryCounts {
  return { decisions: 0, todos: 0, bugs: 0, errors: 0, resolved: 0, summaries: 0 };
}

function writeReviewCandidates(candidates: ReviewCandidate[], source: string): MemoryCounts {
  if (candidates.length === 0) return emptyMemoryCounts();

  const signals: ReturnType<typeof extractSignals> = {
    decisions: [],
    todos: [],
    bugs: [],
    errors: [],
    resolved: [],
  };
  let summary = '';

  for (const candidate of candidates) {
    if (candidate.category === 'summaries') {
      summary = candidate.text;
    } else {
      signals[candidate.category].push(candidate.text);
    }
  }

  ensureClinoDirs();
  return {
    decisions: writeMemoryFile('decisions.md', signals.decisions, source),
    todos: writeMemoryFile('todos.md', signals.todos, source),
    bugs: writeMemoryFile('bugs.md', signals.bugs, source),
    errors: writeMemoryFile('errors.md', signals.errors, source),
    resolved: writeMemoryFile('resolved.md', signals.resolved, source),
    summaries: writeSummaryFile('summaries.md', summary, source),
  };
}

function formatAcceptedReview(
  report: ExtractionReport,
  selected: ReviewCandidate[],
  written: MemoryCounts,
  opts: { accept?: string; candidates?: ReviewCandidate[] } = {},
): string[] {
  if (
    selected.length === 0 &&
    opts.accept?.toLowerCase() === 'all' &&
    (opts.candidates?.length ?? 0) === 0
  ) {
    return [
      'Clino review',
      '',
      `Session: ${report.sessionFilePath}`,
      '',
      'No candidate memories found.',
      'Marked session as reviewed.',
      'No memory was written.',
    ];
  }

  if (selected.length === 0) {
    return [
      'Clino review',
      '',
      `Session: ${report.sessionFilePath}`,
      '',
      'No candidate memories selected.',
      '',
      'No files were changed.',
    ];
  }

  return [
    'Clino review',
    '',
    `Session: ${report.sessionFilePath}`,
    '',
    'Accepted memories:',
    ...selected.map((candidate) => `- ${candidate.id}: ${candidate.text}`),
    '',
    'Written:',
    ...formatMemoryCounts(written),
  ];
}

function formatSkippedReview(sessionPath: string): string[] {
  return [
    'Skipped review for:',
    `  ${basename(sessionPath)}`,
    '',
    'No memory was written.',
  ];
}

function printReviewPending(): number {
  const pending = pendingSessionPathsNewestFirst();
  if (pending.length === 0) {
    console.log('No pending review sessions.');
    return 0;
  }

  const lines = ['Pending review sessions', ''];
  for (const sessionPath of pending) {
    let suffix = 'no candidates';
    let noCandidates = true;
    try {
      const report = buildExtractionReport(sessionPath);
      suffix = formatPendingCandidateCounts(report);
      noCandidates =
        report.counts.decisions +
          report.counts.todos +
          report.counts.bugs +
          report.counts.errors +
          report.counts.resolved +
          report.counts.summary ===
        0;
    } catch {
      /* keep fallback label */
    }
    if (noCandidates) {
      lines.push(`${basename(sessionPath)}  ${suffix}  [empty]`);
      continue;
    }
    const stat = statSync(sessionPath);
    const date = new Date(stat.mtimeMs).toISOString().split('T')[0];
    lines.push(
      `${basename(sessionPath)}  ${suffix}  (${stat.size} bytes, ${date})`,
    );
  }
  lines.push(
    '',
    'Review with:',
    '  clino review latest',
    '  clino review <session-file>',
    '  clino review <session-file> --accept all',
    '  clino review <session-file> --skip',
  );
  console.log(lines.join('\n'));
  return 0;
}

function printReview(args: string[]): number {
  const parsed = parseReviewArgs(args);
  if (!parsed) return 1;

  if (parsed.targetArg === 'pending') {
    if (parsed.accept || parsed.skip) {
      console.error('clino review pending does not accept --accept or --skip.');
      return 1;
    }
    return printReviewPending();
  }

  const target = parsed.targetArg === 'latest'
    ? newestPendingSessionFile()
    : resolveSessionArg(parsed.targetArg);

  if (parsed.targetArg === 'latest' && !target) {
    return printNoPendingReviewSessions();
  }

  const sessionPath = target!;
  if (!existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    console.error('No files were changed.');
    return 1;
  }

  let report: ExtractionReport;
  try {
    report = buildExtractionReport(sessionPath);
  } catch (err) {
    console.error(`Could not review session: ${(err as Error).message}`);
    console.error('No files were changed.');
    return 1;
  }

  const candidates = buildReviewCandidates(report);

  if (parsed.skip) {
    writeReviewMarker(report.sessionFilePath, emptyMemoryCounts(), 'skipped');
    console.log(formatSkippedReview(report.sessionFilePath).join('\n'));
    return 0;
  }

  if (!parsed.accept) {
    console.log(formatReviewPreview(report, candidates, parsed.targetArg).join('\n'));
    return 0;
  }

  const selection = selectReviewCandidates(
    candidates,
    parsed.accept,
    parsed.noSummary,
    parsed.includeSuspicious,
  );
  if (selection.error) {
    console.error(selection.error);
    console.error('No files were changed.');
    return 1;
  }

  const written = writeReviewCandidates(selection.selected, report.sessionFilePath);
  if (shouldWriteReviewMarker(parsed.accept, candidates, selection.selected)) {
    writeReviewMarker(report.sessionFilePath, written, 'reviewed');
  }
  console.log(
    formatAcceptedReview(report, selection.selected, written, {
      accept: parsed.accept,
      candidates,
    }).join('\n'),
  );
  return 0;
}

function buildRebuildPlan(sessionFiles: string[]): RebuildPlan {
  const signals: ReturnType<typeof extractSignals> = {
    decisions: [],
    todos: [],
    bugs: [],
    errors: [],
    resolved: [],
  };
  const summaries: string[] = [];

  for (const sessionFile of sessionFiles) {
    const report = buildExtractionReport(sessionFile);
    signals.decisions.push(...report.signals.decisions);
    signals.todos.push(...report.signals.todos);
    signals.bugs.push(...report.signals.bugs);
    signals.errors.push(...report.signals.errors);
    signals.resolved.push(...report.signals.resolved);
    if (report.summary) summaries.push(report.summary);
  }

  signals.decisions = dedupeMemories(signals.decisions);
  signals.todos = dedupeMemories(signals.todos);
  signals.bugs = dedupeMemories(signals.bugs);
  signals.errors = dedupeMemories(signals.errors);
  signals.resolved = dedupeMemories(signals.resolved);
  const dedupedSummaries = dedupeMemories(summaries);

  return {
    sessionFiles,
    signals,
    summaries: dedupedSummaries,
    counts: memoryCountsFromBuckets(signals, dedupedSummaries),
  };
}

function printRebuildProducedMemory(plan: RebuildPlan): string[] {
  return [
    'Memory to write:',
    ...printCategory('decisions', plan.signals.decisions),
    ...printCategory('todos', plan.signals.todos),
    ...printCategory('bugs', plan.signals.bugs),
    ...printCategory('errors', plan.signals.errors),
    ...printCategory('resolved', plan.signals.resolved),
    ...printCategory('summaries', plan.summaries),
  ];
}

function writeRebuiltBulletFile(filename: string, type: string, items: string[]): void {
  if (items.length === 0) return;
  const body = items.map((item) => `- ${item}`).join('\n');
  writeFileSync(join(MEMORY_DIR, filename), frontmatter(type, REBUILD_SOURCE) + body + '\n', 'utf8');
}

function writeRebuiltSummaryFile(summaries: string[]): void {
  if (summaries.length === 0) return;
  const body = summaries.length === 1
    ? summaries[0]
    : summaries.map((summary) => `- ${summary}`).join('\n');
  writeFileSync(
    join(MEMORY_DIR, 'summaries.md'),
    frontmatter('summaries', REBUILD_SOURCE) + body + '\n',
    'utf8',
  );
}

function writeRebuiltMemory(plan: RebuildPlan): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeRebuiltBulletFile('decisions.md', 'decisions', plan.signals.decisions);
  writeRebuiltBulletFile('todos.md', 'todos', plan.signals.todos);
  writeRebuiltBulletFile('bugs.md', 'bugs', plan.signals.bugs);
  writeRebuiltBulletFile('errors.md', 'errors', plan.signals.errors);
  writeRebuiltBulletFile('resolved.md', 'resolved', plan.signals.resolved);
  writeRebuiltSummaryFile(plan.summaries);
}

function rebuildBackupPath(now = new Date()): string {
  const backupsDir = join(CLINO_DIR, 'backups');
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  let backupPath = join(backupsDir, `memory-${stamp}`);
  let suffix = 2;
  while (existsSync(backupPath)) {
    backupPath = join(backupsDir, `memory-${stamp}-${suffix}`);
    suffix++;
  }
  return backupPath;
}

function backupExistingMemory(): string {
  const backupPath = rebuildBackupPath();
  mkdirSync(backupPath, { recursive: true });
  if (existsSync(MEMORY_DIR)) {
    for (const entry of readdirSync(MEMORY_DIR)) {
      cpSync(join(MEMORY_DIR, entry), join(backupPath, entry), { recursive: true });
    }
  }
  return backupPath;
}

function printNoSessionsForRebuild(dryRun: boolean): number {
  console.error(`No session transcripts found in ${SESSIONS_DIR}.`);
  console.error('Memory rebuild needs at least one .md session transcript.');
  console.error('No files were changed.');
  if (!dryRun) {
    console.error('No backup was created.');
  }
  return 1;
}

function printMemoryRebuild(args: string[]): number {
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    console.error(`Unknown memory rebuild option: ${arg}`);
    console.error('Usage: clino memory rebuild [--dry-run]');
    return 1;
  }

  const sessionFiles = sessionTranscriptFiles();
  if (sessionFiles.length === 0) return printNoSessionsForRebuild(dryRun);

  let plan: RebuildPlan;
  try {
    plan = buildRebuildPlan(sessionFiles);
  } catch (err) {
    console.error(`Could not rebuild memory: ${(err as Error).message}`);
    console.error('No files were changed.');
    return 1;
  }

  if (dryRun) {
    const lines = [
      'Clino memory rebuild dry run',
      '',
      `Sessions: ${plan.sessionFiles.length}`,
      '',
      'Current memory:',
      ...formatMemoryCounts(currentMemoryCounts()),
      '',
      'Rebuilt memory:',
      ...formatMemoryCounts(plan.counts),
      '',
      ...printRebuildProducedMemory(plan),
      '',
      'No files were changed.',
    ];
    console.log(lines.join('\n'));
    return 0;
  }

  let backupPath: string;
  try {
    backupPath = backupExistingMemory();
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    writeRebuiltMemory(plan);
  } catch (err) {
    console.error(`Could not replace memory: ${(err as Error).message}`);
    return 1;
  }

  const lines = [
    'Clino memory rebuilt',
    '',
    `Sessions: ${plan.sessionFiles.length}`,
    `Backup: ${backupPath}`,
    '',
    'New memory:',
    ...formatMemoryCounts(plan.counts),
  ];
  console.log(lines.join('\n'));
  return 0;
}

function parseMemoryType(value: string): MemoryDisplayType | null {
  return MEMORY_TYPE_ALIASES[value.toLowerCase()] ?? null;
}

function printMemoryList(args: string[]): number {
  let typeFilter: MemoryDisplayType | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--include-resolved') continue;
    if (arg === '--type') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('Usage: clino memory list [--type <type>] [--include-resolved]');
        return 1;
      }
      const parsedType = parseMemoryType(value);
      if (!parsedType) {
        console.error(`Unknown memory type: ${value}`);
        return 1;
      }
      typeFilter = parsedType;
      i++;
      continue;
    }
    console.error(`Unknown memory list option: ${arg}`);
    return 1;
  }

  const items = readAllMemoryItems().filter((item) => !typeFilter || item.type === typeFilter);
  if (items.length === 0) {
    console.log(typeFilter ? `No memory found for type: ${typeFilter}.` : 'No memory found.');
    return 0;
  }

  const idWidth = Math.max(2, ...items.map((item) => item.id.length)) + 2;
  const typeWidth = Math.max(4, ...items.map((item) => item.type.length)) + 2;
  const lines = ['Memory', ''];
  for (const item of items) {
    const status = item.resolved ? ' [resolved]' : '';
    lines.push(
      `${rightPad(item.id, idWidth)}${rightPad(item.type, typeWidth)}${shortMemoryText(item.text)}${status}`,
    );
  }

  console.log(lines.join('\n'));
  return 0;
}

function statusForMemoryItem(item: ListedMemoryItem): string | null {
  if (item.type === 'resolved') return 'resolved';
  if (item.type === 'bug' || item.type === 'todo') return item.resolved ? 'resolved' : 'open';
  return null;
}

function findMemoryItem(id: string): ListedMemoryItem | undefined {
  const normalizedId = id.toLowerCase();
  return readAllMemoryItems().find((item) => item.id === normalizedId);
}

function printMemoryShow(args: string[]): number {
  if (args.length !== 1) {
    console.error('Usage: clino memory show <id>');
    return 1;
  }

  const item = findMemoryItem(args[0]);
  if (!item) {
    console.error(`Memory item not found: ${args[0]}`);
    return 1;
  }

  const lines = [
    'Memory item',
    '',
    `ID: ${item.id}`,
    `Type: ${item.type}`,
  ];
  const status = statusForMemoryItem(item);
  if (status) lines.push(`Status: ${status}`);
  if (item.date) lines.push(`Date: ${item.date}`);
  if (item.source) lines.push(`Source: ${item.source}`);
  lines.push(`File: ${item.filePath}`, '', 'Text:', item.text);

  console.log(lines.join('\n'));
  return 0;
}

function deleteMemoryItem(item: ListedMemoryItem): void {
  const descriptor = MEMORY_FILES.find((file) => file.category === item.category);
  if (!descriptor) throw new Error(`Unknown memory category: ${item.category}`);

  const parsed = readMemoryFile(descriptor);
  if (!parsed) throw new Error(`Memory file no longer exists: ${item.filePath}`);

  if (item.category === 'summaries' && typeof item.bodyLineIndex !== 'number') {
    writeFileSync(parsed.filePath, `${parsed.frontmatter}\n`, 'utf8');
    return;
  }

  if (typeof item.bodyLineIndex !== 'number') {
    throw new Error(`Memory item has no line location: ${item.id}`);
  }

  const lines = parsed.body.split(/\r?\n/);
  if (!bulletText(lines[item.bodyLineIndex] ?? '')) {
    throw new Error(`Could not locate memory item: ${item.id}`);
  }
  lines.splice(item.bodyLineIndex, 1);
  let body = lines.join('\n');
  if (body && !body.endsWith('\n')) body += '\n';
  writeFileSync(parsed.filePath, parsed.frontmatter + body, 'utf8');
}

function printMemoryDelete(args: string[]): number {
  let id: string | undefined;
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--')) {
      console.error(`Unknown memory delete option: ${arg}`);
      return 1;
    }
    if (id) {
      console.error('Usage: clino memory delete <id> [--dry-run]');
      return 1;
    }
    id = arg;
  }

  if (!id) {
    console.error('Usage: clino memory delete <id> [--dry-run]');
    return 1;
  }

  const item = findMemoryItem(id);
  if (!item) {
    console.error(`Memory item not found: ${id}`);
    return 1;
  }

  const preview = `${item.id} (${item.type}): ${shortMemoryText(item.text)}`;
  if (dryRun) {
    console.log(`Would delete ${preview}`);
    return 0;
  }

  try {
    deleteMemoryItem(item);
  } catch (err) {
    console.error(`Could not delete ${item.id}: ${(err as Error).message}`);
    return 1;
  }

  console.log(`Deleted ${preview}`);
  return 0;
}

function runMemoryCommand(args: string[]): number {
  const subcommand = args[0];
  switch (subcommand) {
    case 'list':
      return printMemoryList(args.slice(1));
    case 'show':
      return printMemoryShow(args.slice(1));
    case 'delete':
      return printMemoryDelete(args.slice(1));
    case 'rebuild':
      return printMemoryRebuild(args.slice(1));
    default:
      console.error('Usage: clino memory <list|show|delete|rebuild>');
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Count `.md` files in a directory, treating a missing directory as zero. */
function countMarkdown(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}

/** Count stored bullet memories in a memory file (0 if the file is absent). */
function countMemoryItems(filename: string): number {
  const filePath = join(MEMORY_DIR, filename);
  if (!existsSync(filePath)) return 0;
  return parseMemoryItems(readFileSync(filePath, 'utf8')).length;
}

/**
 * Count stored summaries. Summaries are written as a single synthesized
 * paragraph rather than bullets, so report presence (0 or 1) instead.
 */
function countSummaries(filename: string): number {
  const filePath = join(MEMORY_DIR, filename);
  if (!existsSync(filePath)) return 0;
  const parsed = parseFrontmatter(readFileSync(filePath, 'utf8'));
  return summaryTextItems(parsed.body).length;
}

/** True if a root `.gitignore` has an uncommented entry for `.clino`. */
function gitignoreHasClino(gitRoot: string): boolean {
  const giPath = join(gitRoot, '.gitignore');
  if (!existsSync(giPath)) return false;
  return readFileSync(giPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .some((l) => l.replace(/^\//, '').replace(/\/$/, '') === '.clino');
}

/**
 * Whether Git ignores the Clino directory. Prefers `git check-ignore` (which
 * also honors nested ignores and excludes); if the git binary is unavailable or
 * the repo can't be read, falls back to scanning the root `.gitignore`.
 */
function detectClinoIgnored(gitRoot: string, clinoDir: string): boolean {
  const rel = relative(gitRoot, clinoDir);
  if (!rel || rel.startsWith('..')) return false; // outside the repo
  const res = spawnSync('git', ['-C', gitRoot, 'check-ignore', '--', rel], {
    encoding: 'utf8',
  });
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  return gitignoreHasClino(gitRoot); // git missing / repo unreadable
}

function clinoIgnoredLabel(storage: ClinoStorage): string {
  if (storage.overrideActive) return 'n/a (custom CLINO_HOME)';
  if (!storage.gitRoot) return 'n/a (not a git repo)';
  return detectClinoIgnored(storage.gitRoot, storage.home) ? 'yes' : 'no';
}

/**
 * Print where Clino stores memory for this project plus a quick health summary.
 * Read-only: it never creates `.clino/` or any memory file, so the resolved home
 * is reported even when nothing has been captured yet (all counts show zero).
 */
function printStatus(): void {
  const inGitRepo = STORAGE.gitRoot !== null;

  const storageMode = STORAGE.overrideActive
    ? 'custom (CLINO_HOME)'
    : inGitRepo
      ? 'project-local'
      : 'project-local (no git repo)';

  // `.clino/` ignore status is only meaningful for a project-local home inside a
  // repo; a custom CLINO_HOME or no repo makes it not applicable.
  const ignored = clinoIgnoredLabel(STORAGE);

  const lines = [
    'Clino status',
    '',
    `Home: ${CLINO_DIR}`,
    `Storage mode: ${storageMode}`,
    `CLINO_HOME override: ${STORAGE.overrideActive ? 'active' : 'not set'}`,
    `Git repo: ${inGitRepo ? 'yes' : 'no'}`,
    `Git ignored: ${ignored}`,
    '',
    `Sessions: ${countMarkdown(SESSIONS_DIR)}`,
    `Memory files: ${countMarkdown(MEMORY_DIR)}`,
    `- decisions: ${countMemoryItems('decisions.md')}`,
    `- todos: ${countMemoryItems('todos.md')}`,
    `- bugs: ${countMemoryItems('bugs.md')}`,
    `- errors: ${countMemoryItems('errors.md')}`,
    `- resolved: ${countMemoryItems('resolved.md')}`,
    `- summaries: ${countSummaries('summaries.md')}`,
    '',
    'Review:',
    `- pending sessions: ${countPendingReviewSessions()}`,
    `- reviewed sessions: ${countReviewedSessions()}`,
    ...(countSkippedReviewSessions() > 0
      ? [`- skipped sessions: ${countSkippedReviewSessions()}`]
      : []),
    '',
    'Try:',
    '- clino find "auth"',
    '- clino inject "storage"',
    '- clino run claude',
  ];
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

function configuredCliBin(pkg: PackageInfo | null): string | null {
  if (!pkg?.bin) return null;
  if (typeof pkg.bin === 'string') return pkg.bin;
  return pkg.bin.clino ?? null;
}

function packageCliBinStatus(pkg: PackageInfo | null): { ok: boolean; label: string; warning?: string; serious?: boolean } {
  if (!pkg) {
    return {
      ok: false,
      label: 'missing',
      warning: 'package.json could not be read',
      serious: true,
    };
  }

  const bin = configuredCliBin(pkg);
  if (!bin) {
    return {
      ok: false,
      label: 'missing',
      warning: 'package.json has no bin entry for clino',
      serious: true,
    };
  }

  return { ok: true, label: `ok (${bin})` };
}

function buildOutputStatus(pkg: PackageInfo | null): { label: string; warning?: string } {
  const bin = configuredCliBin(pkg);
  const target = bin ?? pkg?.main ?? 'dist/index.js';
  const normalizedTarget = target.replace(/^\.\//, '');
  const exists = existsSync(join(PACKAGE_ROOT, normalizedTarget));
  return exists
    ? { label: `exists (${normalizedTarget})` }
    : { label: `missing (${normalizedTarget})`, warning: `${normalizedTarget} missing after build` };
}

function printDoctor(): number {
  const pkg = readPackageInfo();
  const pty = nodePtyStatus();
  const cliBin = packageCliBinStatus(pkg);
  const buildOutput = buildOutputStatus(pkg);
  const gitIgnored = clinoIgnoredLabel(STORAGE);
  const warnings: string[] = [];
  let seriousIssue = false;

  if (!pty.ok) {
    warnings.push(`node-pty could not be loaded${pty.message ? `: ${pty.message}` : ''}`);
    seriousIssue = true;
  }
  if (cliBin.warning) {
    warnings.push(cliBin.warning);
    seriousIssue = seriousIssue || Boolean(cliBin.serious);
  }
  if (buildOutput.warning) warnings.push(buildOutput.warning);
  if (!STORAGE.overrideActive && STORAGE.gitRoot && gitIgnored === 'no') {
    warnings.push('.clino/ is not ignored by Git');
  }

  const lines = [
    'Clino doctor',
    '',
    `Version: clino ${pkg?.version ?? clinoVersion()}`,
    `Node: ${process.version}`,
    `Platform: ${process.platform} ${process.arch}`,
    `CWD: ${process.cwd()}`,
    '',
    'Storage:',
    `- Home: ${CLINO_DIR}`,
    `- Mode: ${STORAGE.mode}`,
    `- Git repo: ${STORAGE.gitRoot ? 'yes' : 'no'}`,
    `- Git ignored: ${gitIgnored}`,
    `- Sessions dir: ${existsSync(SESSIONS_DIR) ? 'exists' : 'missing'}`,
    `- Memory dir: ${existsSync(MEMORY_DIR) ? 'exists' : 'missing'}`,
    '',
    'Runtime:',
    `- node-pty: ${pty.ok ? 'ok' : 'error'}`,
    `- CLI bin: ${cliBin.label}`,
    `- Build output: ${buildOutput.label}`,
    '',
    'Warnings:',
    ...(warnings.length === 0 ? ['- none'] : warnings.map((warning) => `- ${warning}`)),
  ];

  console.log(lines.join('\n'));
  return seriousIssue ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  printVersion();
  process.exit(0);
}

switch (command) {
  case 'run': {
    const parsed = parseRunArgs(process.argv.slice(3));
    if (!parsed) {
      process.exit(1);
    }
    runCommand(parsed.command, parsed.args, parsed.mode).then((code) => {
      process.exit(code);
    });
    break;
  }

  case 'summarize': {
    process.exitCode = printSummarize(process.argv.slice(3));
    break;
  }

  case 'inspect': {
    process.exitCode = printInspect(process.argv.slice(3));
    break;
  }

  case 'review': {
    process.exitCode = printReview(process.argv.slice(3));
    break;
  }

  case 'memory': {
    process.exitCode = runMemoryCommand(process.argv.slice(3));
    break;
  }

  case 'find': {
    if (!process.argv[3]) {
      console.error('Usage: clino find <query>');
      process.exit(1);
    }
    const findQuery = process.argv[3];
    const findResults = searchMemory(findQuery);

    if (findResults.length === 0) {
      console.log(`No memories found for: "${findQuery}"`);
    } else {
      console.log(`Found ${findResults.length} relevant memory files:\n`);
      findResults.forEach((result) => {
        const key = result.file.replace('.md', '');
        const label = key === 'resolved' ? `${result.file} (Resolved)` : result.file;
        console.log(`📄 ${label}:`);
        result.matches.forEach((match, i) => {
          console.log(`  ${i + 1}. ${match.replace(/^[-*]\s+/, '')}`);
        });
        console.log('');
      });
    }
    break;
  }

  case 'status': {
    printStatus();
    break;
  }

  case 'doctor': {
    process.exitCode = printDoctor();
    break;
  }

  case 'resolve': {
    const query = process.argv[3];
    if (!query) {
      console.error('Usage: clino resolve <id>');
      console.error('       clino resolve <query>');
      process.exit(1);
    }
    ensureClinoDirs();

    // Check if argument is a memory ID (e.g. todo-5, bug-1)
    const idMatch = query.match(/^(todo|bug|decision|error|resolved|summary)-(\d+)$/i);
    if (idMatch) {
      const fullId = idMatch[1].toLowerCase() + '-' + idMatch[2];
      const item = findMemoryItem(fullId);
      if (!item) {
        console.error(`❌ Memory item not found: ${query}`);
        process.exit(1);
      }
      if (item.type !== 'todo' && item.type !== 'bug') {
        console.error('❌ Only open todos and bugs can be resolved.');
        process.exit(1);
      }
      if (item.resolved) {
        console.log(`Already resolved: ${item.text}`);
        break;
      }

      const resolvedText = repairMemoryText(`Resolved: ${item.text}`);
      if (!isQualityMemory(resolvedText, 'resolved')) {
        console.error(`❌ Could not create a useful resolved memory for: "${item.text}"`);
        process.exit(1);
      }

      writeMemoryFile('resolved.md', [resolvedText], 'manual');
      console.log(`Resolved ${fullId}:`);
      console.log(`  ${item.text}`);
      console.log('');
      console.log('Created resolved memory:');
      console.log(`  ${resolvedText}`);
      break;
    }

    // Text-based resolve (existing behavior)
    const resolveText = process.argv.slice(3).join(' ');
    const resolved = repairMemoryText(`Resolved ${resolveText}`);
    if (!isQualityMemory(resolved, 'resolved')) {
      console.error(`❌ Could not create a useful resolved memory for: "${resolveText}"`);
      process.exit(1);
    }
    writeMemoryFile('resolved.md', [resolved], 'manual');
    console.log(`Resolved memory recorded: ${resolved}`);
    break;
  }

  case 'inject': {
    if (!process.argv[3]) {
      console.error('Usage: clino inject <query> [--max-chars <number>]');
      process.exit(1);
    }
    const injectQuery = process.argv[3];
    let maxChars = 3000;
    const maxCharsIndex = process.argv.indexOf('--max-chars');
    if (maxCharsIndex !== -1 && process.argv[maxCharsIndex + 1]) {
      maxChars = parseInt(process.argv[maxCharsIndex + 1], 10);
      if (isNaN(maxChars)) {
        console.error('❌ Invalid value for --max-chars');
        process.exit(1);
      }
    }
    console.log(generateContext(injectQuery, maxChars));
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "clino help" for usage.');
    process.exit(1);
}
