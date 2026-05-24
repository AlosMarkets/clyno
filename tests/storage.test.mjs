import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'index.js');

/**
 * Invoke clino with a chosen working directory and (optionally) CLINO_HOME.
 * CLINO_HOME is always cleared first so the storage-resolution tests below see
 * a clean environment and exercise the git-root / cwd fallbacks deterministically.
 * These commands need no PTY, so spawnSync keeps them fast and isolated.
 */
function clino(args, { cwd, clinoHome } = {}) {
  const env = { ...process.env };
  delete env.CLINO_HOME;
  if (clinoHome) env.CLINO_HOME = clinoHome;
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    input: '',
    timeout: 20000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

test('CLINO_HOME is used exactly, ignoring git root and cwd', () => {
  const home = tmp('clino-home-');
  const work = tmp('clino-work-');
  // Make the cwd a git repo too, to prove CLINO_HOME wins over both fallbacks.
  mkdirSync(join(work, '.git'), { recursive: true });
  try {
    const { code } = clino(['run', 'echo', 'override-test'], { cwd: work, clinoHome: home });
    assert.equal(code, 0);
    assert.ok(existsSync(join(home, 'sessions')), 'sessions dir created under CLINO_HOME');
    assert.equal(readdirSync(join(home, 'sessions')).length, 1, 'one transcript written to CLINO_HOME');
    assert.ok(!existsSync(join(work, '.clino')), 'no .clino created in cwd when CLINO_HOME is set');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('inside a git repo, state resolves to <git-root>/.clino (not the nested cwd)', () => {
  const root = tmp('clino-gitroot-');
  const nested = join(root, 'packages', 'app');
  mkdirSync(join(root, '.git'), { recursive: true }); // mark the repo root
  mkdirSync(nested, { recursive: true });
  try {
    const { code } = clino(['run', 'echo', 'git-root-test'], { cwd: nested });
    assert.equal(code, 0);
    assert.ok(existsSync(join(root, '.clino', 'sessions')), 'resolves to git root');
    assert.ok(!existsSync(join(nested, '.clino')), 'does not create .clino in the nested cwd');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside any git repo, state falls back to <cwd>/.clino', () => {
  // mkdtemp dirs live under the OS temp dir, which has no .git ancestor.
  const work = tmp('clino-nogit-');
  try {
    const { code } = clino(['run', 'echo', 'cwd-fallback-test'], { cwd: work });
    assert.equal(code, 0);
    assert.ok(existsSync(join(work, '.clino', 'sessions')), 'creates .clino in the cwd');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('run writes the transcript into the resolved .clino/sessions', () => {
  const work = tmp('clino-sess-');
  try {
    const { code } = clino(['run', 'echo', 'transcript-marker'], { cwd: work });
    assert.equal(code, 0);
    const sessionsDir = join(work, '.clino', 'sessions');
    const files = readdirSync(sessionsDir);
    assert.equal(files.length, 1, 'exactly one transcript');
    const content = readFileSync(join(sessionsDir, files[0]), 'utf8');
    assert.match(content, /transcript-marker/, 'transcript captures child output');
    assert.match(content, /\*\*Exit code:\*\* 0/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('summarize writes memory into the resolved home', () => {
  const work = tmp('clino-summ-');
  const sessionsDir = join(work, '.clino', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, 'manual.md');
  writeFileSync(
    sessionFile,
    "# Session\n\n## Transcript\n\n```\nWe decided to use JWT auth because it's stateless.\n```\n",
  );
  try {
    const { code } = clino(['summarize', sessionFile], { cwd: work });
    assert.equal(code ?? 0, 0);
    const decisions = join(work, '.clino', 'memory', 'decisions.md');
    assert.ok(existsSync(decisions), 'decisions memory written under resolved home');
    assert.match(readFileSync(decisions, 'utf8'), /Use JWT auth because it is stateless\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('find and inject read from the same resolved home', () => {
  const work = tmp('clino-read-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'decisions.md'),
    '---\ntype: decisions\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Use JWT authentication because it is stateless.\n',
  );
  const other = tmp('clino-other-');
  try {
    const found = clino(['find', 'JWT'], { cwd: work });
    assert.match(found.stdout, /JWT authentication/, 'find reads the resolved home');

    const injected = clino(['inject', 'JWT'], { cwd: work });
    assert.match(injected.stdout, /JWT authentication/, 'inject reads the resolved home');

    // Pointing CLINO_HOME elsewhere must not surface this project's memory,
    // proving every command shares one resolved home.
    const elsewhere = clino(['find', 'JWT'], { cwd: work, clinoHome: other });
    assert.doesNotMatch(elsewhere.stdout, /JWT authentication/);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
