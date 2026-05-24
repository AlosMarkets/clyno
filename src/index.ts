#!/usr/bin/env node

import { spawn } from 'node-pty';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

// Configuration
const CLINO_DIR = join(homedir(), '.clino');
const SESSIONS_DIR = join(CLINO_DIR, 'sessions');
const MEMORY_DIR = join(CLINO_DIR, 'memory');
const PROCESSED_SESSIONS_FILE = join(CLINO_DIR, 'processed.sessions');

// Ensure directories exist
[CLINO_DIR, SESSIONS_DIR, MEMORY_DIR].forEach((dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

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
 * Run a command through PTY and capture session.
 */
async function runCommand(agentCmd: string, agentArgs: string[]): Promise<void> {
  console.log(`🚀 Starting ${agentCmd} with args: ${agentArgs.join(' ')}`);

  const ptyProcess = spawn(agentCmd, agentArgs, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env,
  }) as any;

  let output = '';
  ptyProcess.on('data', (data: string) => {
    output += data;
    process.stdout.write(data); // Forward to user (preserves colors)
  });

  ptyProcess.on('exit', async (exit: { exitCode: number; signal?: number | undefined }) => {
    console.log(`\n📝 Session ended with code ${exit.exitCode}`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionFile = join(SESSIONS_DIR, `${timestamp}.md`);

    const sessionContent = `# Coding Agent Session\n\n**Agent:** ${agentCmd}\n**Arguments:** ${agentArgs.join(' ')}\n**Started:** ${new Date().toISOString()}\n**Ended:** ${new Date().toISOString()}\n\n## Transcript\n\n\`\`\`\n${output}\n\`\`\`\n`;

    writeFileSync(sessionFile, sessionContent, 'utf8');
    console.log(`💾 Session saved to: ${sessionFile}`);

    if (!processedSessions.has(sessionFile)) {
      extractInsights(sessionFile);
      processedSessions.add(sessionFile);
      writeFileSync(PROCESSED_SESSIONS_FILE, Array.from(processedSessions).join('\n'), 'utf8');
    }
  });

  ptyProcess.on('error', (err: Error) => {
    console.error(`❌ PTY error: ${err.message}`);
    process.exit(1);
  });

  process.stdin.pipe(ptyProcess);
}

/**
 * Extract insights from a session file and persist them as clean memories.
 */
function extractInsights(sessionFilePath: string): void {
  console.log('🔍 Extracting insights from session...');

  const content = readFileSync(sessionFilePath, 'utf8');
  const signals = extractSignals(content);

  writeMemoryFile('decisions.md', signals.decisions, sessionFilePath);
  writeMemoryFile('todos.md', signals.todos, sessionFilePath);
  writeMemoryFile('bugs.md', signals.bugs, sessionFilePath);
  writeMemoryFile('errors.md', signals.errors, sessionFilePath);
  writeSummaryFile('summaries.md', synthesizeSummary(signals), sessionFilePath);

  console.log(
    `✅ Extracted: ${signals.decisions.length} decisions, ${signals.todos.length} TODOs, ` +
      `${signals.bugs.length} bugs, ${signals.errors.length} errors`,
  );
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

/**
 * Search memory files. Frontmatter and headings are ignored so keyword tags and
 * metadata never surface as results.
 */
function searchMemory(query: string): Array<{ file: string; matches: string[] }> {
  console.log(`🔍 Searching memory for: "${query}"`);

  const q = query.toLowerCase();
  const results: Array<{ file: string; matches: string[] }> = [];

  readdirSync(MEMORY_DIR).forEach((file) => {
    if (!file.endsWith('.md')) return;
    const body = stripFrontmatter(readFileSync(join(MEMORY_DIR, file), 'utf8'));
    const lines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const matches = lines.filter((l) => l.toLowerCase().includes(q));
    if (matches.length > 0) results.push({ file, matches: matches.slice(0, 8) });
  });

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
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

switch (command) {
  case 'run': {
    if (!process.argv[3]) {
      console.error('Usage: clino run <agent> [args...]');
      process.exit(1);
    }
    runCommand(process.argv[3], process.argv.slice(4));
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

Examples:
  clino run codex
  clino run claude
  clino summarize .clino/sessions/2026-05-24-10-30-00.md
  clino find "auth bug"
  clino inject "auth-system"
  clino inject "auth" --max-chars 6000
`);
}
