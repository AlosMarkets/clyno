#!/usr/bin/env node

import { spawn } from 'node-pty';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

import {
  extractSignals,
  synthesizeSummary,
  dedupeMemories,
  parseMemoryItems,
  stripFrontmatter,
  repairMemoryText,
  isQualityMemory,
  type MemoryType,
} from './memory.js';

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
function resolveClinoHome(): string {
  if (process.env.CLINO_HOME) return process.env.CLINO_HOME;
  const gitRoot = findGitRoot(process.cwd());
  return join(gitRoot ?? process.cwd(), '.clino');
}

// Configuration. All commands read and write through this single resolved home.
const CLINO_DIR = resolveClinoHome();
const SESSIONS_DIR = join(CLINO_DIR, 'sessions');
const MEMORY_DIR = join(CLINO_DIR, 'memory');
const PROCESSED_SESSIONS_FILE = join(CLINO_DIR, 'processed.sessions');

/**
 * Create the Clino state directories on demand. Only the writing commands
 * (`run`, `summarize`) call this; read-only commands (`status`, `find`, `inject`)
 * never create `.clino/` just to inspect or report on it.
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
  summaries: 'Summary',
};

/**
 * Run a command through a real PTY, wiring it to the parent terminal so the
 * child behaves exactly as if launched directly: colors, prompts, raw keystrokes
 * (arrows, Ctrl+C), and window resizes all pass through. The full byte stream is
 * captured for the session transcript. No Clino output is written while the child
 * is running — a single summary line is printed only after it exits.
 *
 * Resolves with the child's exit code so the caller can mirror it.
 */
function runCommand(agentCmd: string, agentArgs: string[]): Promise<number> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const interactive = Boolean(stdin.isTTY && stdout.isTTY);
    const startedAt = new Date();

    let ptyProcess;
    try {
      ptyProcess = spawn(agentCmd, agentArgs, {
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
      finalizeSession(agentCmd, agentArgs, startedAt, transcript, code, signal);
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

  let counts = { decisions: 0, todos: 0, bugs: 0, errors: 0 };
  if (!processedSessions.has(sessionFile)) {
    counts = extractInsights(sessionFile, { quiet: true });
    processedSessions.add(sessionFile);
    writeFileSync(PROCESSED_SESSIONS_FILE, Array.from(processedSessions).join('\n'), 'utf8');
  }

  // The single, simple post-session message (requirement: nothing during run).
  process.stdout.write(
    `\n[clino] session saved → ${sessionFile}\n` +
      `[clino] learned ${counts.decisions} decisions, ${counts.todos} todos, ` +
      `${counts.bugs} bugs, ${counts.errors} errors\n`,
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
): { decisions: number; todos: number; bugs: number; errors: number } {
  if (!opts.quiet) console.log('🔍 Extracting insights from session...');

  ensureClinoDirs();
  const content = readFileSync(sessionFilePath, 'utf8');
  const signals = extractSignals(content);

  writeMemoryFile('decisions.md', signals.decisions, sessionFilePath);
  writeMemoryFile('todos.md', signals.todos, sessionFilePath);
  writeMemoryFile('bugs.md', signals.bugs, sessionFilePath);
  writeMemoryFile('errors.md', signals.errors, sessionFilePath);
  writeSummaryFile('summaries.md', synthesizeSummary(signals), sessionFilePath);

  const counts = {
    decisions: signals.decisions.length,
    todos: signals.todos.length,
    bugs: signals.bugs.length,
    errors: signals.errors.length,
  };

  if (!opts.quiet) {
    console.log(
      `✅ Extracted: ${counts.decisions} decisions, ${counts.todos} TODOs, ` +
        `${counts.bugs} bugs, ${counts.errors} errors`,
    );
  }

  return counts;
}

/**
 * Merge freshly extracted items with what is already stored, re-running repair
 * and the quality filter over existing content (so legacy junk is cleaned too),
 * then dedupe with richer-memory preference and rewrite the file.
 */
function writeMemoryFile(filename: string, items: string[], source: string): void {
  const type = filename.replace('.md', '') as MemoryType;
  const filePath = join(MEMORY_DIR, filename);

  const existing = existsSync(filePath)
    ? parseMemoryItems(readFileSync(filePath, 'utf8'))
        .map(repairMemoryText)
        .filter((m) => isQualityMemory(m, type))
    : [];

  const merged = dedupeMemories([...items, ...existing]);
  if (merged.length === 0) return;

  const body = merged.map((m) => `- ${m}`).join('\n');
  writeFileSync(filePath, frontmatter(type, source) + body + '\n', 'utf8');
}

/**
 * Write the synthesized summary. Summaries are regenerated fresh each run and
 * must not duplicate the raw decision/bug/todo bullets.
 */
function writeSummaryFile(filename: string, summary: string, source: string): void {
  if (!summary) return;
  const filePath = join(MEMORY_DIR, filename);
  writeFileSync(filePath, frontmatter('summaries', source) + summary + '\n', 'utf8');
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

  for (const result of results) {
    const key = result.file.replace('.md', '');
    const title = FILE_TITLES[key] || key;

    // Re-apply the quality/dedupe layer at inject time (defense in depth).
    const items = dedupeMemories(
      result.matches
        .map((m) => m.replace(/^[-*]\s+/, '').trim())
        .map(repairMemoryText)
        .filter((m) => key === 'summaries' || isQualityMemory(m, key as MemoryType)),
    );
    if (items.length === 0) continue;

    context += `## ${title}\n`;
    context += items.map((i) => `- ${i}`).join('\n');
    context += '\n\n';
  }

  if (context.length > maxChars) {
    context = context.slice(0, maxChars) + '\n\n*[Context truncated for token efficiency]*\n';
  }

  return context;
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
  return stripFrontmatter(readFileSync(filePath, 'utf8')).trim() ? 1 : 0;
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

/**
 * Print where Clino stores memory for this project plus a quick health summary.
 * Read-only: it never creates `.clino/` or any memory file, so the resolved home
 * is reported even when nothing has been captured yet (all counts show zero).
 */
function printStatus(): void {
  const overrideActive = Boolean(process.env.CLINO_HOME);
  const gitRoot = findGitRoot(process.cwd());
  const inGitRepo = gitRoot !== null;

  const storageMode = overrideActive
    ? 'custom (CLINO_HOME)'
    : inGitRepo
      ? 'project-local'
      : 'project-local (no git repo)';

  // `.clino/` ignore status is only meaningful for a project-local home inside a
  // repo; a custom CLINO_HOME or no repo makes it not applicable.
  let ignored: string;
  if (overrideActive) ignored = 'n/a (custom CLINO_HOME)';
  else if (!inGitRepo) ignored = 'n/a (not a git repo)';
  else ignored = detectClinoIgnored(gitRoot, CLINO_DIR) ? 'yes' : 'no';

  const lines = [
    'Clino status',
    '',
    `Home: ${CLINO_DIR}`,
    `Storage mode: ${storageMode}`,
    `CLINO_HOME override: ${overrideActive ? 'active' : 'not set'}`,
    `Git repo: ${inGitRepo ? 'yes' : 'no'}`,
    `Git ignored: ${ignored}`,
    '',
    `Sessions: ${countMarkdown(SESSIONS_DIR)}`,
    `Memory files: ${countMarkdown(MEMORY_DIR)}`,
    `- decisions: ${countMemoryItems('decisions.md')}`,
    `- todos: ${countMemoryItems('todos.md')}`,
    `- bugs: ${countMemoryItems('bugs.md')}`,
    `- errors: ${countMemoryItems('errors.md')}`,
    `- summaries: ${countSummaries('summaries.md')}`,
    '',
    'Try:',
    '- clino find "auth"',
    '- clino inject "storage"',
    '- clino run claude',
  ];
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

switch (command) {
  case 'run': {
    if (!process.argv[3]) {
      console.error('Usage: clino run <agent> [args...]');
      process.exit(1);
    }
    runCommand(process.argv[3], process.argv.slice(4)).then((code) => {
      process.exit(code);
    });
    break;
  }

  case 'summarize': {
    if (!process.argv[3]) {
      console.error('Usage: clino summarize <session-file>');
      process.exit(1);
    }
    extractInsights(process.argv[3]);
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
        console.log(`📄 ${result.file}:`);
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
    console.log(`
Clino - Persistent Memory for AI Coding Agents

Usage:
  clino run <agent> [args...]   Run an agent through Clino's PTY wrapper
  clino summarize <file>        Extract insights from a session file
  clino find <query>            Search memory for relevant information
  clino inject <query> [--max-chars <number>]  Generate compact context for agent injection
  clino status                  Show storage location and a memory health summary

Examples:
  clino run codex
  clino run claude
  clino summarize .clino/sessions/2026-05-24-10-30-00.md
  clino find "auth bug"
  clino inject "auth-system"
  clino inject "auth" --max-chars 6000
  clino status
`);
}
