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
const PACKAGE = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

function markGitRoot(dir) {
  const gitDir = join(dir, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
}

function writeMemoryFixture(work) {
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'decisions.md'),
    '---\ntype: decisions\ndate: 2026-05-25\nsource: sessions/test.md\n---\n\n' +
      '- Use project-local .clino storage.\n',
  );
  writeFileSync(
    join(memDir, 'todos.md'),
    '---\ntype: todos\ndate: 2026-05-25\nsource: sessions/test.md\n---\n\n' +
      '- Add clino status command.\n',
  );
  writeFileSync(
    join(memDir, 'bugs.md'),
    '---\ntype: bugs\ndate: 2026-05-25\nsource: sessions/test.md\n---\n\n' +
      '- GUARDRAILS.md has an unclosed code fence.\n',
  );
  writeFileSync(
    join(memDir, 'errors.md'),
    '---\ntype: errors\ndate: 2026-05-25\nsource: sessions/test.md\n---\n\n' +
      '- Module type not specified.\n',
  );
  writeFileSync(
    join(memDir, 'resolved.md'),
    '---\ntype: resolved\ndate: 2026-05-25\nsource: sessions/fixed.md\n---\n\n' +
      '- Fixed GUARDRAILS.md unclosed code fence.\n',
  );
  writeFileSync(
    join(memDir, 'summaries.md'),
    '---\ntype: summaries\ndate: 2026-05-25\nsource: sessions/test.md\n---\n\n' +
      'This session captured project-local storage work.\n',
  );
  return memDir;
}

function writeSessionFixture(work, name, transcript) {
  const sessionsDir = join(work, '.clino', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, name);
  writeFileSync(
    sessionFile,
    [
      '# Coding Agent Session',
      '',
      '**Agent:** echo',
      '**Arguments:** debug extraction',
      '**Started:** 2026-05-25T10:00:00.000Z',
      '**Ended:** 2026-05-25T10:00:02.000Z',
      '**Exit code:** 0',
      '',
      '## Transcript',
      '',
      '```',
      transcript,
      '```',
      '',
    ].join('\n'),
  );
  return sessionFile;
}

function writeHomeSessionFixture(home, name, transcript) {
  const sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, name);
  writeFileSync(sessionFile, `# Session\n\n## Transcript\n\n\`\`\`\n${transcript}\n\`\`\`\n`);
  return sessionFile;
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// CLI polish
// ---------------------------------------------------------------------------

test('version flags print the package version', () => {
  const work = tmp('clino-version-');
  try {
    for (const args of [['--version'], ['-v']]) {
      const { code, stdout, stderr } = clino(args, { cwd: work });
      assert.equal(code ?? 0, 0);
      assert.equal(stdout.trim(), `clino ${PACKAGE.version}`);
      assert.equal(stderr, '');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('help commands show clean help', () => {
  const work = tmp('clino-help-');
  try {
    for (const args of [['help'], ['--help'], ['-h']]) {
      const { code, stdout, stderr } = clino(args, { cwd: work });
      assert.equal(code ?? 0, 0);
      assert.equal(stderr, '');
      assert.match(stdout, /Clino .* local memory for terminal coding agents/);
      assert.match(stdout, /clino run \[--review\|--no-memory\] <command> \[args\.\.\.\]/);
      assert.match(stdout, /clino inspect latest/);
      assert.match(stdout, /clino review pending/);
      assert.match(stdout, /clino review latest/);
      assert.match(stdout, /clino summarize \[--dry-run\]/);
      assert.match(stdout, /clino find <query>/);
      assert.match(stdout, /clino inject <query>/);
      assert.match(stdout, /clino status/);
      assert.match(stdout, /clino doctor/);
      assert.match(stdout, /--review\s+Save transcript and show candidates without writing memory/);
      assert.match(stdout, /--no-memory\s+Save transcript only, skipping extraction/);
      assert.match(stdout, /clino run --review claude/);
      assert.match(stdout, /clino run --no-memory codex/);
      assert.match(stdout, /-v, --version\s+Show version/);
      assert.match(stdout, /-h, --help\s+Show help/);
      assert.match(stdout, /CLINO_HOME can override storage location/);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('unknown command exits with a useful error', () => {
  const work = tmp('clino-unknown-');
  try {
    const { code, stdout, stderr } = clino(['wat'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Unknown command: wat/);
    assert.match(stderr, /clino help/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// clino doctor
// ---------------------------------------------------------------------------

test('doctor: empty project reports setup without creating .clino', () => {
  const work = tmp('clino-doctor-empty-');
  try {
    const { code, stdout, stderr } = clino(['doctor'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Clino doctor/);
    assert.match(stdout, new RegExp(`Version: clino ${escapeRegExp(PACKAGE.version)}`));
    assert.match(stdout, /Node: v\d+\.\d+\.\d+/);
    assert.match(stdout, new RegExp(`CWD: ${escapeRegExp(work)}`));
    assert.match(stdout, new RegExp(`- Home: ${escapeRegExp(join(work, '.clino'))}`));
    assert.match(stdout, /- Mode: cwd fallback/);
    assert.match(stdout, /- Git repo: no/);
    assert.match(stdout, /- Git ignored: n\/a \(not a git repo\)/);
    assert.match(stdout, /- Sessions dir: missing/);
    assert.match(stdout, /- Memory dir: missing/);
    assert.match(stdout, /- node-pty: ok/);
    assert.match(stdout, /- CLI bin: ok \(\.\/dist\/index\.js\)/);
    assert.match(stdout, /- Build output: exists \(dist\/index\.js\)/);
    assert.match(stdout, /Warnings:\n- none/);
    assert.ok(!existsSync(join(work, '.clino')), 'doctor does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('doctor: reports CLINO_HOME override without creating storage dirs', () => {
  const home = tmp('clino-doctor-home-');
  const work = tmp('clino-doctor-work-');
  markGitRoot(work);
  try {
    const { code, stdout } = clino(['doctor'], { cwd: work, clinoHome: home });
    assert.equal(code ?? 0, 0);
    assert.match(stdout, new RegExp(`- Home: ${escapeRegExp(home)}`));
    assert.match(stdout, /- Mode: CLINO_HOME override/);
    assert.match(stdout, /- Git repo: yes/);
    assert.match(stdout, /- Git ignored: n\/a \(custom CLINO_HOME\)/);
    assert.match(stdout, /- Sessions dir: missing/);
    assert.match(stdout, /- Memory dir: missing/);
    assert.ok(!existsSync(join(home, 'sessions')), 'doctor does not create sessions dir');
    assert.ok(!existsSync(join(home, 'memory')), 'doctor does not create memory dir');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('doctor: reports project-local Git storage and ignore status', () => {
  const root = tmp('clino-doctor-git-');
  const nested = join(root, 'packages', 'app');
  markGitRoot(root);
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.clino/\n');
  mkdirSync(nested, { recursive: true });
  try {
    const { code, stdout } = clino(['doctor'], { cwd: nested });
    assert.equal(code ?? 0, 0);
    assert.match(stdout, new RegExp(`- Home: ${escapeRegExp(join(root, '.clino'))}`));
    assert.match(stdout, /- Mode: project-local Git root/);
    assert.match(stdout, /- Git repo: yes/);
    assert.match(stdout, /- Git ignored: yes/);
    assert.match(stdout, /Warnings:\n- none/);
    assert.ok(!existsSync(join(root, '.clino')), 'doctor does not create .clino');
    assert.ok(!existsSync(join(nested, '.clino')), 'doctor does not create nested .clino');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLINO_HOME is used exactly, ignoring git root and cwd', () => {
  const home = tmp('clino-home-');
  const work = tmp('clino-work-');
  // Make the cwd a git repo too, to prove CLINO_HOME wins over both fallbacks.
  markGitRoot(work);
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
  markGitRoot(root); // mark the repo root
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

test('run --review saves transcript, leaves memory unwritten, and can be accepted later', () => {
  const home = tmp('clino-run-review-home-');
  const work = tmp('clino-run-review-work-');
  const message = 'We decided to keep Clino private-by-default and need to add review mode';
  try {
    const run = clino(['run', '--review', 'echo', message], { cwd: work, clinoHome: home });
    assert.equal(run.code ?? 0, 0);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /We decided to keep Clino private-by-default and need to add review mode/);
    assert.match(run.stdout, /\[clino\] session saved/);
    assert.match(run.stdout, /\[clino\] review mode: memory was not written/);
    assert.match(run.stdout, /\[clino\] candidates: 1 decisions, 1 todos, 0 bugs, 0 errors, 0 resolved/);
    assert.match(run.stdout, /clino review latest/);

    const sessionsDir = join(home, 'sessions');
    const sessionFiles = readdirSync(sessionsDir);
    assert.equal(sessionFiles.length, 1, 'one transcript written under CLINO_HOME');
    assert.match(readFileSync(join(sessionsDir, sessionFiles[0]), 'utf8'), /add review mode/);
    assert.ok(!existsSync(join(work, '.clino')), 'cwd storage is untouched when CLINO_HOME is set');
    assert.equal(readIfExists(join(home, 'processed.sessions')), null, 'review mode does not mark sessions processed');

    const before = clino(['memory', 'list'], { cwd: work, clinoHome: home });
    assert.equal(before.code ?? 0, 0);
    assert.match(before.stdout, /No memory found\./);

    const preview = clino(['review', 'latest'], { cwd: work, clinoHome: home });
    assert.equal(preview.code ?? 0, 0);
    assert.match(preview.stdout, /decision-1\s+decision\s+Keep Clino private-by-default\./);
    assert.match(preview.stdout, /todo-1\s+todo\s+Add review mode\./);

    const accepted = clino(['review', 'latest', '--accept', 'all'], { cwd: work, clinoHome: home });
    assert.equal(accepted.code ?? 0, 0);
    assert.match(accepted.stdout, /Written:\n- decisions: 1\n- todos: 1/m);

    const after = clino(['memory', 'list'], { cwd: work, clinoHome: home });
    assert.match(after.stdout, /decision-1\s+decision\s+Keep Clino private-by-default\./);
    assert.match(after.stdout, /todo-1\s+todo\s+Add review mode\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('run --no-memory saves transcript and leaves it reviewable without writing memory', () => {
  const home = tmp('clino-run-no-memory-home-');
  const work = tmp('clino-run-no-memory-work-');
  try {
    const run = clino(
      ['run', '--no-memory', 'echo', 'We decided to keep Clino private-by-default'],
      { cwd: work, clinoHome: home },
    );
    assert.equal(run.code ?? 0, 0);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /\[clino\] session saved/);
    assert.match(run.stdout, /\[clino\] memory extraction skipped \(--no-memory\)/);

    const sessionsDir = join(home, 'sessions');
    assert.equal(readdirSync(sessionsDir).length, 1, 'transcript is still saved');
    assert.equal(readIfExists(join(home, 'processed.sessions')), null, 'no-memory does not mark sessions processed');

    const memory = clino(['memory', 'list'], { cwd: work, clinoHome: home });
    assert.equal(memory.code ?? 0, 0);
    assert.match(memory.stdout, /No memory found\./);

    const preview = clino(['review', 'latest'], { cwd: work, clinoHome: home });
    assert.equal(preview.code ?? 0, 0);
    assert.match(preview.stdout, /decision-1\s+decision\s+Keep Clino private-by-default\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('run default still writes memory automatically', () => {
  const work = tmp('clino-run-default-memory-');
  try {
    const run = clino(['run', 'echo', 'We decided to keep automatic memory writes by default'], { cwd: work });
    assert.equal(run.code ?? 0, 0);
    assert.match(run.stdout, /\[clino\] learned 1 decisions, 0 todos, 0 bugs, 0 errors, 0 resolved/);

    const memory = clino(['memory', 'list'], { cwd: work });
    assert.match(memory.stdout, /decision-1\s+decision\s+Keep automatic memory writes by default\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('run rejects conflicting review and no-memory modes before running a child', () => {
  const work = tmp('clino-run-conflict-');
  try {
    const { code, stdout, stderr } = clino(['run', '--review', '--no-memory', 'echo', 'hello'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Cannot combine --review and --no-memory/);
    assert.match(stderr, /Usage: clino run \[--review\|--no-memory\] <command> \[args\.\.\.\]/);
    assert.ok(!existsSync(join(work, '.clino')), 'conflict does not create storage or run the child');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('run --review without a command exits nonzero with usage', () => {
  const work = tmp('clino-run-review-missing-');
  try {
    const { code, stdout, stderr } = clino(['run', '--review'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Usage: clino run \[--review\|--no-memory\] <command> \[args\.\.\.\]/);
    assert.ok(!existsSync(join(work, '.clino')), 'missing command does not create storage');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('run memory modes preserve child exit codes', () => {
  const home = tmp('clino-run-exit-home-');
  const work = tmp('clino-run-exit-work-');
  try {
    const review = clino(['run', '--review', 'bash', '-c', 'exit 7'], { cwd: work, clinoHome: home });
    assert.equal(review.code, 7);
    assert.match(review.stdout, /\[clino\] review mode: memory was not written/);

    const noMemory = clino(['run', '--no-memory', 'bash', '-c', 'exit 7'], { cwd: work, clinoHome: home });
    assert.equal(noMemory.code, 7);
    assert.match(noMemory.stdout, /\[clino\] memory extraction skipped \(--no-memory\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// clino inspect / summarize debug mode
// ---------------------------------------------------------------------------

test('inspect latest: no sessions exits nonzero without creating .clino', () => {
  const work = tmp('clino-inspect-empty-');
  try {
    const { code, stdout, stderr } = clino(['inspect', 'latest'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /No session transcripts found/);
    assert.ok(!existsSync(join(work, '.clino')), 'inspect latest does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('inspect latest: reports the newest session metadata, preview, and counts', () => {
  const work = tmp('clino-inspect-latest-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'manual.md',
      "We decided to use JWT auth because it's stateless.\nremaining: add unit tests for auth module",
    );
    const { code, stdout, stderr } = clino(['inspect', 'latest'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Clino inspect/);
    assert.match(stdout, new RegExp(`File: ${escapeRegExp(sessionFile)}`));
    assert.match(stdout, /Size: \d+ bytes/);
    assert.match(stdout, /Started: 2026-05-25T10:00:00\.000Z/);
    assert.match(stdout, /Ended: 2026-05-25T10:00:02\.000Z/);
    assert.match(stdout, /Exit code: 0/);
    assert.match(stdout, /Cleaned preview:/);
    assert.match(stdout, /We decided to use JWT auth/);
    assert.match(stdout, /Extraction counts:/);
    assert.match(stdout, /- decisions: 1/);
    assert.match(stdout, /- todos: 1/);
    assert.match(stdout, /- summary: 1/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('inspect explicit session supports absolute and relative paths', () => {
  const work = tmp('clino-inspect-file-');
  try {
    const sessionFile = writeSessionFixture(work, 'explicit.md', 'We decided to use local markdown memory.');

    const absolute = clino(['inspect', sessionFile], { cwd: work });
    assert.equal(absolute.code ?? 0, 0);
    assert.match(absolute.stdout, new RegExp(`File: ${escapeRegExp(sessionFile)}`));
    assert.match(absolute.stdout, /- decisions: 1/);

    const relativePath = join('.clino', 'sessions', 'explicit.md');
    const relativeResult = clino(['inspect', relativePath], { cwd: work });
    assert.equal(relativeResult.code ?? 0, 0);
    assert.match(relativeResult.stdout, new RegExp(`File: ${escapeRegExp(sessionFile)}`));
    assert.match(relativeResult.stdout, /We decided to use local markdown memory/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('inspect missing file exits nonzero with a clear error', () => {
  const work = tmp('clino-inspect-missing-');
  try {
    const { code, stdout, stderr } = clino(['inspect', 'missing.md'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Session file not found:/);
    assert.match(stderr, /missing\.md/);
    assert.ok(!existsSync(join(work, '.clino')), 'inspect missing file does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('summarize --dry-run prints extracted categories without writing memory', () => {
  const work = tmp('clino-dry-run-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'dry.md',
      [
        "We decided to use JWT auth because it's stateless.",
        'remaining: add unit tests for auth module',
        'GUARDRAILS.md has an unclosed code fence.',
        'error: module type not specified',
        'Fixed Redis blacklist bug.',
      ].join('\n'),
    );
    const { code, stdout, stderr } = clino(['summarize', '--dry-run', sessionFile], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Clino summarize dry run/);
    assert.match(stdout, /No memory files were written\./);
    assert.match(stdout, /Candidate memories:/);
    assert.match(stdout, /decisions \(1\)\n- Use JWT auth because it is stateless\./);
    assert.match(stdout, /todos \(1\)\n- Add unit tests for auth module\./);
    assert.match(stdout, /bugs \(1\)\n- GUARDRAILS\.md has an unclosed code fence\./);
    assert.match(stdout, /errors \(1\)\n- Module type not specified\./);
    assert.match(stdout, /resolved \(1\)\n- Fixed Redis blacklist bug\./);
    assert.match(stdout, /summary \(1\)\nThis session captured/);
    assert.ok(!existsSync(join(work, '.clino', 'memory')), 'dry-run does not create memory dir');
    assert.ok(!existsSync(join(work, '.clino', 'processed.sessions')), 'dry-run does not mark processed sessions');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('summarize --dry-run leaves existing memory unchanged', () => {
  const work = tmp('clino-dry-existing-');
  try {
    const memDir = join(work, '.clino', 'memory');
    mkdirSync(memDir, { recursive: true });
    const decisions = join(memDir, 'decisions.md');
    const before = '---\ntype: decisions\n---\n\n- Keep existing memory untouched.\n';
    writeFileSync(decisions, before);

    const sessionFile = writeSessionFixture(
      work,
      'new.md',
      'We decided to use dry-run previews for extraction debugging.',
    );
    const { code, stdout, stderr } = clino(['summarize', '--dry-run', sessionFile], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Final stored memories if written:/);
    assert.match(stdout, /Keep existing memory untouched\./);
    assert.match(stdout, /Use dry-run previews for extraction debugging\./);
    assert.equal(readFileSync(decisions, 'utf8'), before);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('summarize --show-cleaned strips ANSI and control noise', () => {
  const work = tmp('clino-show-cleaned-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'cleaned.md',
      [
        '\x1b[39;49m\x1b[K Tip: New Use /fast to enable our fastest inference.\x1b[0m',
        '10;rgb:ffff/ffff/ffff11;rgb:3c95/3c95/3c95',
        "We decided to use JWT auth because it's stateless.",
      ].join('\n'),
    );
    const { code, stdout, stderr } = clino(
      ['summarize', '--dry-run', '--show-cleaned', sessionFile],
      { cwd: work },
    );
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Cleaned transcript:/);
    assert.match(stdout, /We decided to use JWT auth/);
    assert.doesNotMatch(stdout, /\x1b/);
    assert.doesNotMatch(stdout, /rgb:/i);
    assert.doesNotMatch(stdout, /Tip: New Use/i);
    assert.ok(!existsSync(join(work, '.clino', 'memory')), 'show-cleaned dry-run does not write memory');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('show-cleaned honors --max-chars', () => {
  const work = tmp('clino-max-cleaned-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'long.md',
      `We decided to use JWT auth because it's stateless. ${'x'.repeat(200)}`,
    );
    const { code, stdout } = clino(
      ['inspect', sessionFile, '--show-cleaned', '--max-chars', '25'],
      { cwd: work },
    );
    assert.equal(code ?? 0, 0);
    assert.match(stdout, /Cleaned transcript:/);
    assert.match(stdout, /\[truncated to 25 of \d+ chars\]/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// clino review
// ---------------------------------------------------------------------------

test('review latest: no pending sessions exits zero without creating .clino', () => {
  const work = tmp('clino-review-empty-');
  try {
    const { code, stdout, stderr } = clino(['review', 'latest'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /No pending review sessions\./);
    assert.match(stdout, /clino review pending/);
    assert.ok(!existsSync(join(work, '.clino')), 'review latest does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review latest: shows deterministic candidate IDs without writing memory', () => {
  const work = tmp('clino-review-latest-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'review.md',
      [
        'We decided to keep Clino private-by-default.',
        'remaining: add a manual memory review workflow',
      ].join('\n'),
    );

    const { code, stdout, stderr } = clino(['review', 'latest'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Clino review/);
    assert.match(stdout, new RegExp(`Session: ${escapeRegExp(sessionFile)}`));
    assert.match(stdout, /Candidate memories:/);
    assert.match(stdout, /decision-1\s+decision\s+Keep Clino private-by-default\./);
    assert.match(stdout, /todo-1\s+todo\s+Add a manual memory review workflow\./);
    assert.match(stdout, /summary-1\s+summary\s+This session captured/);
    assert.match(stdout, /No files were changed\./);
    assert.match(stdout, /clino review latest --accept all/);
    assert.match(stdout, /clino review latest --accept decision-1,todo-1/);
    assert.ok(!existsSync(join(work, '.clino', 'memory')), 'review preview does not create memory');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review explicit session supports absolute and relative paths', () => {
  const work = tmp('clino-review-file-');
  try {
    const sessionFile = writeSessionFixture(work, 'explicit.md', 'We decided to use local markdown memory.');

    const absolute = clino(['review', sessionFile], { cwd: work });
    assert.equal(absolute.code ?? 0, 0);
    assert.match(absolute.stdout, new RegExp(`Session: ${escapeRegExp(sessionFile)}`));
    assert.match(absolute.stdout, /decision-1\s+decision\s+Use local markdown memory\./);

    const relativePath = join('.clino', 'sessions', 'explicit.md');
    const relativeResult = clino(['review', relativePath], { cwd: work });
    assert.equal(relativeResult.code ?? 0, 0);
    assert.match(relativeResult.stdout, new RegExp(`Session: ${escapeRegExp(sessionFile)}`));
    assert.match(relativeResult.stdout, /clino review \.clino\/sessions\/explicit\.md --accept all/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review missing file exits nonzero with a clear error', () => {
  const work = tmp('clino-review-missing-');
  try {
    const { code, stdout, stderr } = clino(['review', 'missing.md'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Session file not found:/);
    assert.match(stderr, /missing\.md/);
    assert.match(stderr, /No files were changed\./);
    assert.ok(!existsSync(join(work, '.clino')), 'review missing file does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review is read-only by default even when memory already exists', () => {
  const work = tmp('clino-review-readonly-');
  try {
    const memDir = writeMemoryFixture(work);
    const before = Object.fromEntries(
      readdirSync(memDir).map((file) => [file, readFileSync(join(memDir, file), 'utf8')]),
    );
    const sessionFile = writeSessionFixture(
      work,
      'readonly.md',
      'We decided to use read-only review previews.',
    );

    const { code, stderr } = clino(['review', sessionFile], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    for (const [file, content] of Object.entries(before)) {
      assert.equal(readFileSync(join(memDir, file), 'utf8'), content, `${file} unchanged`);
    }
    assert.ok(!existsSync(join(work, '.clino', 'processed.sessions')), 'review does not mark sessions processed');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review --accept all writes candidates and summaries', () => {
  const work = tmp('clino-review-accept-all-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'accept.md',
      [
        'We decided to use review acceptance for memory.',
        'remaining: add review acceptance tests',
      ].join('\n'),
    );

    const { code, stdout, stderr } = clino(['review', sessionFile, '--accept', 'all'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Accepted memories:/);
    assert.match(stdout, /- decision-1: Use review acceptance for memory\./);
    assert.match(stdout, /- todo-1: Add review acceptance tests\./);
    assert.match(stdout, /Written:\n- decisions: 1\n- todos: 1/m);
    assert.match(stdout, /- summaries: 1/);

    const memDir = join(work, '.clino', 'memory');
    assert.match(readFileSync(join(memDir, 'decisions.md'), 'utf8'), /Use review acceptance for memory\./);
    assert.match(readFileSync(join(memDir, 'todos.md'), 'utf8'), /Add review acceptance tests\./);
    assert.match(readFileSync(join(memDir, 'summaries.md'), 'utf8'), /This session captured 1 decision and 1 TODO/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review --accept all --no-summary writes extracted memories except summary', () => {
  const work = tmp('clino-review-no-summary-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'no-summary.md',
      [
        'We decided to use review no-summary accepts.',
        'remaining: add review no-summary tests',
      ].join('\n'),
    );

    const { code, stdout, stderr } = clino(
      ['review', sessionFile, '--accept', 'all', '--no-summary'],
      { cwd: work },
    );
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /- decision-1: Use review no-summary accepts\./);
    assert.match(stdout, /- todo-1: Add review no-summary tests\./);
    assert.doesNotMatch(stdout, /summary-1:/);
    assert.match(stdout, /- summaries: 0/);

    const memDir = join(work, '.clino', 'memory');
    assert.match(readFileSync(join(memDir, 'decisions.md'), 'utf8'), /Use review no-summary accepts\./);
    assert.match(readFileSync(join(memDir, 'todos.md'), 'utf8'), /Add review no-summary tests\./);
    assert.equal(readIfExists(join(memDir, 'summaries.md')), null);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review --accept all is idempotent and does not duplicate memory', () => {
  const work = tmp('clino-review-idempotent-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'idempotent.md',
      [
        'We decided to use idempotent review accepts.',
        'remaining: add idempotent review tests',
      ].join('\n'),
    );

    const first = clino(['review', sessionFile, '--accept', 'all'], { cwd: work });
    assert.equal(first.code ?? 0, 0);
    const second = clino(['review', sessionFile, '--accept', 'all'], { cwd: work });
    assert.equal(second.code ?? 0, 0);
    assert.match(second.stdout, /Written:\n- decisions: 0\n- todos: 0/m);
    assert.match(second.stdout, /- summaries: 0/);

    const decisions = readFileSync(join(work, '.clino', 'memory', 'decisions.md'), 'utf8');
    const todos = readFileSync(join(work, '.clino', 'memory', 'todos.md'), 'utf8');
    assert.equal((decisions.match(/Use idempotent review accepts\./g) ?? []).length, 1);
    assert.equal((todos.match(/Add idempotent review tests\./g) ?? []).length, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review --accept selected IDs writes only selected candidates', () => {
  const work = tmp('clino-review-selected-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'selected.md',
      [
        'We decided to use selected review writes.',
        'remaining: add selected review tests',
        'GUARDRAILS.md has an unclosed code fence.',
      ].join('\n'),
    );

    const { code, stdout, stderr } = clino(
      ['review', sessionFile, '--accept', 'decision-1,todo-1'],
      { cwd: work },
    );
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /- decision-1: Use selected review writes\./);
    assert.match(stdout, /- todo-1: Add selected review tests\./);
    assert.doesNotMatch(stdout, /bug-1:/);

    const memDir = join(work, '.clino', 'memory');
    assert.match(readFileSync(join(memDir, 'decisions.md'), 'utf8'), /Use selected review writes\./);
    assert.match(readFileSync(join(memDir, 'todos.md'), 'utf8'), /Add selected review tests\./);
    assert.equal(readIfExists(join(memDir, 'bugs.md')), null);
    assert.equal(readIfExists(join(memDir, 'summaries.md')), null);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review invalid accept ID writes nothing and exits nonzero', () => {
  const work = tmp('clino-review-invalid-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'invalid.md',
      'We decided to validate review candidate IDs before writing.',
    );

    const { code, stdout, stderr } = clino(['review', sessionFile, '--accept', 'decision-99'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Invalid accept ID: decision-99/);
    assert.match(stderr, /No files were changed\./);
    assert.ok(!existsSync(join(work, '.clino', 'memory')), 'invalid accept does not create memory');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review respects CLINO_HOME for latest sessions and memory writes', () => {
  const home = tmp('clino-review-home-');
  const work = tmp('clino-review-work-');
  try {
    writeHomeSessionFixture(home, 'home.md', 'We decided to keep CLINO_HOME review isolated.');

    const { code, stdout, stderr } = clino(['review', 'latest', '--accept', 'all'], {
      cwd: work,
      clinoHome: home,
    });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, new RegExp(`Session: ${escapeRegExp(join(home, 'sessions', 'home.md'))}`));
    assert.match(readFileSync(join(home, 'memory', 'decisions.md'), 'utf8'), /Keep CLINO_HOME review isolated\./);
    assert.ok(!existsSync(join(work, '.clino')), 'cwd storage is untouched when CLINO_HOME is set');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('review uses cleaning filters so Codex intro/login noise yields zero candidates', () => {
  const work = tmp('clino-review-codex-noise-');
  try {
    const codexIntro =
      "_._:=+===+,_ WelcometoCodex,OpenAI'scommand-linecodingagent" +
      'SigninwithChatGPTtouseCodexaspartofyourpaidplanorconnectanAPIkeyforusage-basedbilling' +
      'PressEntertocontinue';
    const sessionFile = writeSessionFixture(work, 'codex.md', codexIntro);

    const { code, stdout, stderr } = clino(['review', sessionFile], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /No candidate memories found\./);
    assert.match(stdout, /No files were changed\./);
    assert.ok(!existsSync(join(work, '.clino', 'memory')), 'noise-only review does not create memory');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review uses prompt/spec and Clino-output filters', () => {
  const work = tmp('clino-review-spec-noise-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'spec.md',
      [
        'Goal:',
        '- Add clino review latest',
        'Requirements:',
        '- clino review latest',
        'Candidate memories:',
        'decision-1  decision  Keep Clino private-by-default.',
        'todo-1      todo      Add a manual memory review workflow.',
        'No files were changed.',
        'To write all candidates:',
        '  clino review latest --accept all',
      ].join('\n'),
    );

    const { code, stdout, stderr } = clino(['review', sessionFile], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /No candidate memories found\./);
    assert.doesNotMatch(stdout, /Keep Clino private-by-default/);
    assert.ok(!existsSync(join(work, '.clino', 'memory')), 'spec/output review does not create memory');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review dogfood prompt and Codex chrome do not become candidates', () => {
  const work = tmp('clino-review-dogfood-');
  try {
    writeSessionFixture(
      work,
      'dogfood.md',
      [
        'Review the current Clino MVP from README.md, ROADMAP.md, and GUARDRAILS.md. Do not edit files. Identify the top 3 remaining MVP risks and the smallest next fixes.',
        'Based on the docs, the MVP is close on positioning but still has three material gaps: › Find and fix a bug in @filename gpt-5.4-mini medium · ~/Desktop/clino',
        'Need to add clino status command.',
      ].join('\n'),
    );

    const preview = clino(['review', 'latest'], { cwd: work });
    assert.equal(preview.code ?? 0, 0);
    assert.match(preview.stdout, /todo-1\s+todo\s+Add clino status command\./);
    assert.doesNotMatch(preview.stdout, /Identify the top 3 remaining MVP risks/i);
    assert.doesNotMatch(preview.stdout, /Based on the docs/i);
    assert.doesNotMatch(preview.stdout, /Find and fix a bug in @filename/i);
    assert.doesNotMatch(preview.stdout, /gpt-5\.4-mini/i);
    assert.doesNotMatch(preview.stdout, /Focus areas:.*\bBased\b/i);

    const acceptAll = clino(['review', 'latest', '--accept', 'all', '--no-summary'], { cwd: work });
    assert.equal(acceptAll.code ?? 0, 0);
    assert.match(acceptAll.stdout, /todo-1:/);
    assert.doesNotMatch(acceptAll.stdout, /Identify the top 3/i);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review --accept all skips [suspicious] candidates unless --include-suspicious', () => {
  const work = tmp('clino-review-suspicious-');
  try {
    writeSessionFixture(
      work,
      'suspicious.md',
      [
        'Identify the top 3 remaining MVP risks and the smallest next fixes.',
        'We decided to use JWT auth because it is stateless.',
      ].join('\n'),
    );

    const preview = clino(['review', 'latest'], { cwd: work });
    assert.equal(preview.code ?? 0, 0);
    assert.match(preview.stdout, /decision-1\s+decision\s+Use JWT auth because it is stateless\./);
    assert.doesNotMatch(preview.stdout, /todo-1.*Identify the top 3/i);
    if (/summary-1.*\[suspicious\]/.test(preview.stdout)) {
      assert.match(preview.stdout, /--include-suspicious/);
      const acceptDefault = clino(['review', 'latest', '--accept', 'all'], { cwd: work });
      assert.equal(acceptDefault.code ?? 0, 0);
      assert.match(acceptDefault.stdout, /decision-1:/);
      assert.doesNotMatch(acceptDefault.stdout, /summary-1:/);

      const acceptSuspicious = clino(
        ['review', 'latest', '--accept', 'all', '--include-suspicious'],
        { cwd: work },
      );
      assert.equal(acceptSuspicious.code ?? 0, 0);
      assert.match(acceptSuspicious.stdout, /summary-1:/);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// clino review tracking
// ---------------------------------------------------------------------------

test('run --review creates session but no reviewed marker', () => {
  const home = tmp('clino-review-marker-run-');
  const work = tmp('clino-review-marker-run-work-');
  try {
    const run = clino(
      ['run', '--review', 'echo', 'We decided to keep review markers and need to show pending reviews'],
      { cwd: work, clinoHome: home },
    );
    assert.equal(run.code ?? 0, 0);
    const sessionsDir = join(home, 'sessions');
    assert.equal(readdirSync(sessionsDir).length, 1);
    assert.ok(!existsSync(join(home, 'reviews')), 'run --review does not create reviews dir');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('review pending lists unreviewed sessions newest first', () => {
  const home = tmp('clino-review-pending-list-');
  const work = tmp('clino-review-pending-list-work-');
  try {
    writeHomeSessionFixture(
      home,
      '2026-05-25T15-55-00-100Z.md',
      'We decided to use older pending ordering.',
    );
    writeHomeSessionFixture(
      home,
      '2026-05-25T16-10-43-353Z.md',
      'We decided to keep review markers and need to add pending review listing',
    );

    const { code, stdout, stderr } = clino(['review', 'pending'], { cwd: work, clinoHome: home });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Pending review sessions/);
    assert.match(stdout, /2026-05-25T16-10-43-353Z\.md\s+decisions:1 todos:1 bugs:0 errors:0 resolved:0/);
    assert.match(stdout, /2026-05-25T15-55-00-100Z\.md\s+decisions:1 todos:0 bugs:0 errors:0 resolved:0/);
    const newerPos = stdout.indexOf('2026-05-25T16-10-43-353Z.md');
    const olderPos = stdout.indexOf('2026-05-25T15-55-00-100Z.md');
    assert.ok(newerPos < olderPos, 'newest pending session is listed first');
    assert.ok(!existsSync(join(home, 'reviews')), 'review pending does not create reviews dir');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('review latest --accept all creates reviewed marker and clears pending', () => {
  const home = tmp('clino-review-marker-accept-');
  const work = tmp('clino-review-marker-accept-work-');
  try {
    clino(
      ['run', '--review', 'echo', 'We decided to keep review markers and need to add review mode'],
      { cwd: work, clinoHome: home },
    );
    const accepted = clino(['review', 'latest', '--accept', 'all'], { cwd: work, clinoHome: home });
    assert.equal(accepted.code ?? 0, 0);

    const reviewsDir = join(home, 'reviews');
    const markers = readdirSync(reviewsDir).filter((file) => file.endsWith('.reviewed.json'));
    assert.equal(markers.length, 1);
    const marker = JSON.parse(readFileSync(join(reviewsDir, markers[0]), 'utf8'));
    assert.match(marker.session, /\.md$/);
    assert.ok(marker.reviewedAt);
    assert.equal(marker.accepted.decisions, 1);
    assert.equal(marker.accepted.todos, 1);
    assert.equal(marker.accepted.summaries, 1);

    const pending = clino(['review', 'pending'], { cwd: work, clinoHome: home });
    assert.match(pending.stdout, /No pending review sessions\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('review selected accept creates marker only after successful write', () => {
  const work = tmp('clino-review-marker-selected-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'selected-marker.md',
      [
        'We decided to use selected review markers.',
        'remaining: add selected marker tests',
      ].join('\n'),
    );
    const accepted = clino(['review', sessionFile, '--accept', 'decision-1,todo-1'], { cwd: work });
    assert.equal(accepted.code ?? 0, 0);

    const markerPath = join(work, '.clino', 'reviews', 'selected-marker.reviewed.json');
    assert.ok(existsSync(markerPath));
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(marker.session, 'selected-marker.md');
    assert.equal(marker.accepted.decisions, 1);
    assert.equal(marker.accepted.todos, 1);
    assert.equal(marker.accepted.summaries, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review invalid accept ID creates no marker', () => {
  const work = tmp('clino-review-marker-invalid-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'invalid-marker.md',
      'We decided to validate review marker guards before writing.',
    );
    const rejected = clino(['review', sessionFile, '--accept', 'decision-99'], { cwd: work });
    assert.equal(rejected.code, 1);
    assert.ok(!existsSync(join(work, '.clino', 'reviews')), 'invalid accept does not create reviews dir');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review --accept all with zero candidates still creates reviewed marker', () => {
  const work = tmp('clino-review-marker-zero-');
  try {
    const sessionFile = writeSessionFixture(work, 'codex-only.md', 'SigninwithChatGPT PressEntertocontinue');
    const accepted = clino(['review', sessionFile, '--accept', 'all'], { cwd: work });
    assert.equal(accepted.code ?? 0, 0);
    assert.match(accepted.stdout, /No candidate memories found\./);
    assert.match(accepted.stdout, /Marked session as reviewed\./);
    assert.match(accepted.stdout, /No memory was written\./);
    assert.doesNotMatch(accepted.stdout, /No candidate memories selected\./);

    const markerPath = join(work, '.clino', 'reviews', 'codex-only.reviewed.json');
    assert.ok(existsSync(markerPath));
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(marker.session, 'codex-only.md');
    assert.equal(marker.status, 'reviewed');
    assert.ok(marker.reviewedAt);
    assert.deepEqual(marker.accepted, {
      decisions: 0,
      todos: 0,
      bugs: 0,
      errors: 0,
      resolved: 0,
      summaries: 0,
    });
    assert.ok(!existsSync(join(work, '.clino', 'memory')), 'zero-candidate accept does not write memory');

    const pending = clino(['review', 'pending'], { cwd: work });
    assert.match(pending.stdout, /No pending review sessions\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review latest selects newest pending session, not reviewed zero-candidate latest', () => {
  const home = tmp('clino-review-latest-pending-');
  const work = tmp('clino-review-latest-pending-work-');
  try {
    writeHomeSessionFixture(
      home,
      '2026-05-25T16-00-00-000Z.md',
      'We decided to keep review latest pending-aware and need to add pending review tests',
    );
    writeHomeSessionFixture(home, '2026-05-25T17-00-00-000Z.md', 'SigninwithChatGPT PressEntertocontinue');

    const markLatest = clino(['review', 'latest', '--accept', 'all'], { cwd: work, clinoHome: home });
    assert.equal(markLatest.code ?? 0, 0);
    assert.match(markLatest.stdout, /2026-05-25T17-00-00-000Z\.md/);
    assert.match(markLatest.stdout, /Marked session as reviewed\./);

    const preview = clino(['review', 'latest'], { cwd: work, clinoHome: home });
    assert.equal(preview.code ?? 0, 0);
    assert.match(preview.stdout, /2026-05-25T16-00-00-000Z\.md/);
    assert.match(preview.stdout, /decision-1\s+decision\s+Keep review latest pending-aware\./);
    assert.match(preview.stdout, /todo-1\s+todo\s+Add pending review tests\./);
    assert.doesNotMatch(preview.stdout, /2026-05-25T17-00-00-000Z\.md/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('review latest --skip creates skipped marker and clears pending', () => {
  const home = tmp('clino-review-skip-');
  const work = tmp('clino-review-skip-work-');
  try {
    clino(
      ['run', '--review', 'echo', 'We decided to keep review skip markers and need to add skip tests'],
      { cwd: work, clinoHome: home },
    );

    const skipped = clino(['review', 'latest', '--skip'], { cwd: work, clinoHome: home });
    assert.equal(skipped.code ?? 0, 0);
    assert.match(skipped.stdout, /Skipped review for:/);
    assert.match(skipped.stdout, /No memory was written\./);

    const reviewsDir = join(home, 'reviews');
    const markers = readdirSync(reviewsDir).filter((file) => file.endsWith('.reviewed.json'));
    assert.equal(markers.length, 1);
    const marker = JSON.parse(readFileSync(join(reviewsDir, markers[0]), 'utf8'));
    assert.equal(marker.status, 'skipped');
    assert.deepEqual(marker.accepted, {
      decisions: 0,
      todos: 0,
      bugs: 0,
      errors: 0,
      resolved: 0,
      summaries: 0,
    });
    const memDir = join(home, 'memory');
    if (existsSync(memDir)) {
      assert.equal(readdirSync(memDir).filter((f) => f.endsWith('.md')).length, 0);
    }

    const pending = clino(['review', 'pending'], { cwd: work, clinoHome: home });
    assert.match(pending.stdout, /No pending review sessions\./);

    const status = clino(['status'], { cwd: work, clinoHome: home });
    assert.match(status.stdout, /- reviewed sessions: 1/);
    assert.match(status.stdout, /- skipped sessions: 1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('review explicit session still works when session is already reviewed or skipped', () => {
  const work = tmp('clino-review-explicit-reviewed-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'already-reviewed.md',
      'We decided to keep explicit review paths working after markers exist.',
    );
    const accepted = clino(['review', sessionFile, '--accept', 'all'], { cwd: work });
    assert.equal(accepted.code ?? 0, 0);

    const preview = clino(['review', sessionFile], { cwd: work });
    assert.equal(preview.code ?? 0, 0);
    assert.match(preview.stdout, /decision-1\s+decision\s+Keep explicit review paths working after markers exist\./);

    const skipped = clino(['review', sessionFile, '--skip'], { cwd: work });
    assert.equal(skipped.code ?? 0, 0);
    assert.match(skipped.stdout, /Skipped review for:\n  already-reviewed\.md/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review latest with all sessions reviewed reports no pending sessions', () => {
  const work = tmp('clino-review-latest-all-reviewed-');
  try {
    const sessionFile = writeSessionFixture(
      work,
      'reviewed-only.md',
      'We decided to keep review latest empty when every session has a marker.',
    );
    const accepted = clino(['review', sessionFile, '--accept', 'all'], { cwd: work });
    assert.equal(accepted.code ?? 0, 0);

    const latest = clino(['review', 'latest'], { cwd: work });
    assert.equal(latest.code ?? 0, 0);
    assert.match(latest.stdout, /No pending review sessions\./);
    assert.match(latest.stdout, /clino review pending/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review pending shows no-candidate sessions as [empty]', () => {
  const home = tmp('clino-review-pending-empty-');
  const work = tmp('clino-review-pending-empty-work-');
  try {
    writeHomeSessionFixture(home, '2026-05-25T18-00-00-000Z.md', 'SigninwithChatGPT PressEntertocontinue');
    const { code, stdout } = clino(['review', 'pending'], { cwd: work, clinoHome: home });
    assert.equal(code ?? 0, 0);
    assert.match(stdout, /2026-05-25T18-00-00-000Z\.md\s+no candidates\s+\[empty\]/);
    assert.match(stdout, /clino review latest/);
    assert.match(stdout, /clino review <session-file> --skip/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('status shows pending and reviewed session counts', () => {
  const home = tmp('clino-review-marker-status-');
  const work = tmp('clino-review-marker-status-work-');
  try {
    clino(
      ['run', '--review', 'echo', 'We decided to keep review markers and need to add review mode'],
      { cwd: work, clinoHome: home },
    );

    const before = clino(['status'], { cwd: work, clinoHome: home });
    assert.match(before.stdout, /- pending sessions: 1/);
    assert.match(before.stdout, /- reviewed sessions: 0/);

    clino(['review', 'latest', '--accept', 'all'], { cwd: work, clinoHome: home });

    const after = clino(['status'], { cwd: work, clinoHome: home });
    assert.match(after.stdout, /- pending sessions: 0/);
    assert.match(after.stdout, /- reviewed sessions: 1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('status empty project shows zero pending and reviewed without creating reviews dir', () => {
  const work = tmp('clino-review-marker-status-empty-');
  try {
    const { code, stdout } = clino(['status'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.match(stdout, /- pending sessions: 0/);
    assert.match(stdout, /- reviewed sessions: 0/);
    assert.ok(!existsSync(join(work, '.clino', 'reviews')), 'status does not create reviews dir');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review tracking respects CLINO_HOME', () => {
  const home = tmp('clino-review-marker-home-');
  const work = tmp('clino-review-marker-home-work-');
  try {
    writeHomeSessionFixture(home, 'home.md', 'We decided to keep CLINO_HOME review markers isolated.');
    const pending = clino(['review', 'pending'], { cwd: work, clinoHome: home });
    assert.match(pending.stdout, /home\.md/);
    assert.ok(!existsSync(join(work, '.clino')), 'cwd storage is untouched when CLINO_HOME is set');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('review pending in empty project does not create .clino', () => {
  const work = tmp('clino-review-pending-empty-');
  try {
    const { code, stdout } = clino(['review', 'pending'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.match(stdout, /No pending review sessions\./);
    assert.ok(!existsSync(join(work, '.clino')), 'review pending does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review selected resolved item writes resolved memory and suppresses matching open bug during inject', () => {
  const work = tmp('clino-review-resolved-');
  try {
    const bugSession = writeSessionFixture(
      work,
      'bug.md',
      'GUARDRAILS.md is incomplete/truncated: it ends with an unclosed code fence.',
    );
    const fixedSession = writeSessionFixture(work, 'fixed.md', 'Fixed GUARDRAILS.md unclosed code fence.');

    assert.equal(clino(['summarize', bugSession], { cwd: work }).code ?? 0, 0);
    const reviewed = clino(['review', fixedSession, '--accept', 'resolved-1'], { cwd: work });
    assert.equal(reviewed.code ?? 0, 0);
    assert.match(reviewed.stdout, /- resolved-1: Fixed GUARDRAILS\.md unclosed code fence\./);

    const resolved = join(work, '.clino', 'memory', 'resolved.md');
    assert.match(readFileSync(resolved, 'utf8'), /Fixed GUARDRAILS\.md unclosed code fence\./);

    const injected = clino(['inject', 'GUARDRAILS'], { cwd: work });
    assert.doesNotMatch(injected.stdout, /## Open Bugs/);
    assert.doesNotMatch(injected.stdout, /incomplete\/truncated/);
    assert.match(injected.stdout, /## Recently Resolved/);
    assert.match(injected.stdout, /Fixed GUARDRAILS\.md unclosed code fence\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// clino status
// ---------------------------------------------------------------------------

test('status: empty project shows the resolved path and zero counts', () => {
  const work = tmp('clino-status-empty-');
  try {
    const { code, stdout } = clino(['status'], { cwd: work });
    assert.equal(code ?? 0, 0);
    // Reports where memory *would* live without creating it.
    assert.match(stdout, new RegExp(`Home: ${join(work, '.clino')}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(stdout, /Sessions: 0/);
    assert.match(stdout, /- pending sessions: 0/);
    assert.match(stdout, /- reviewed sessions: 0/);
    assert.match(stdout, /Memory files: 0/);
    assert.match(stdout, /- decisions: 0/);
    assert.match(stdout, /- summaries: 0/);
    assert.match(stdout, /Try:/);
    // Read-only: status must not create the directory just to report on it.
    assert.ok(!existsSync(join(work, '.clino')), 'status does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('status: counts sessions and memory items that exist', () => {
  const work = tmp('clino-status-full-');
  const sessionsDir = join(work, '.clino', 'sessions');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(sessionsDir, '2026-05-25-00-00-00.md'), '# Session\n');
  writeFileSync(
    join(memDir, 'decisions.md'),
    '---\ntype: decisions\n---\n\n- Use project-local .clino storage.\n',
  );
  writeFileSync(join(memDir, 'todos.md'), '---\ntype: todos\n---\n\n- Add clino status command.\n');
  writeFileSync(
    join(memDir, 'summaries.md'),
    '---\ntype: summaries\n---\n\nThis session captured 1 decision and 1 TODO.\n',
  );
  try {
    const { code, stdout } = clino(['status'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.match(stdout, /Sessions: 1/);
    assert.match(stdout, /Memory files: 3/);
    assert.match(stdout, /- decisions: 1/);
    assert.match(stdout, /- todos: 1/);
    assert.match(stdout, /- bugs: 0/);
    assert.match(stdout, /- errors: 0/);
    assert.match(stdout, /- resolved: 0/);
    assert.match(stdout, /- summaries: 1/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('status: reflects the CLINO_HOME override', () => {
  const home = tmp('clino-status-home-');
  const work = tmp('clino-status-work-');
  // A git repo in cwd proves Git-repo detection is independent of the override.
  markGitRoot(work);
  try {
    const { code, stdout } = clino(['status'], { cwd: work, clinoHome: home });
    assert.equal(code ?? 0, 0);
    assert.match(stdout, new RegExp(`Home: ${home}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(stdout, /Storage mode: custom \(CLINO_HOME\)/);
    assert.match(stdout, /CLINO_HOME override: active/);
    assert.match(stdout, /Git repo: yes/);
    assert.match(stdout, /Git ignored: n\/a \(custom CLINO_HOME\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('status: detects whether .clino is git-ignored', () => {
  // Ignored: a repo whose .gitignore lists `.clino/`.
  const ignoredRepo = tmp('clino-status-ign-');
  markGitRoot(ignoredRepo);
  writeFileSync(join(ignoredRepo, '.gitignore'), 'node_modules/\n.clino/\n');
  // Not ignored: a repo whose .gitignore does not mention `.clino`.
  const trackedRepo = tmp('clino-status-trk-');
  markGitRoot(trackedRepo);
  writeFileSync(join(trackedRepo, '.gitignore'), 'node_modules/\n');
  try {
    const ignored = clino(['status'], { cwd: ignoredRepo });
    assert.match(ignored.stdout, /Git repo: yes/);
    assert.match(ignored.stdout, /Git ignored: yes/);

    const tracked = clino(['status'], { cwd: trackedRepo });
    assert.match(tracked.stdout, /Git repo: yes/);
    assert.match(tracked.stdout, /Git ignored: no/);
  } finally {
    rmSync(ignoredRepo, { recursive: true, force: true });
    rmSync(trackedRepo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// clino memory
// ---------------------------------------------------------------------------

test('memory list: empty project reports no memory without creating .clino', () => {
  const work = tmp('clino-memory-empty-');
  try {
    const { code, stdout, stderr } = clino(['memory', 'list'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /No memory found\./);
    assert.ok(!existsSync(join(work, '.clino')), 'memory list does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory list: shows display IDs, types, text, summaries, and resolved labels', () => {
  const work = tmp('clino-memory-list-');
  try {
    writeMemoryFixture(work);
    const { code, stdout, stderr } = clino(['memory', 'list'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /^Memory/m);
    assert.match(stdout, /decision-1\s+decision\s+Use project-local \.clino storage\./);
    assert.match(stdout, /todo-1\s+todo\s+Add clino status command\./);
    assert.match(stdout, /bug-1\s+bug\s+GUARDRAILS\.md has an unclosed code fence\. \[resolved\]/);
    assert.match(stdout, /error-1\s+error\s+Module type not specified\./);
    assert.match(stdout, /resolved-1\s+resolved\s+Fixed GUARDRAILS\.md unclosed code fence\./);
    assert.match(stdout, /summary-1\s+summary\s+This session captured project-local storage work\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory list: filters by type', () => {
  const work = tmp('clino-memory-type-');
  try {
    writeMemoryFixture(work);
    const { code, stdout } = clino(['memory', 'list', '--type', 'bug'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.match(stdout, /bug-1\s+bug\s+GUARDRAILS\.md has an unclosed code fence/);
    assert.doesNotMatch(stdout, /decision-1/);
    assert.doesNotMatch(stdout, /todo-1/);
    assert.doesNotMatch(stdout, /resolved-1/);
    assert.doesNotMatch(stdout, /summary-1/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory show: prints full item details for a valid ID', () => {
  const work = tmp('clino-memory-show-');
  try {
    const memDir = writeMemoryFixture(work);
    const { code, stdout, stderr } = clino(['memory', 'show', 'decision-1'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Memory item/);
    assert.match(stdout, /ID: decision-1/);
    assert.match(stdout, /Type: decision/);
    assert.match(stdout, /Date: 2026-05-25/);
    assert.match(stdout, /Source: sessions\/test\.md/);
    assert.match(stdout, new RegExp(`File: ${escapeRegExp(join(memDir, 'decisions.md'))}`));
    assert.match(stdout, /Text:\nUse project-local \.clino storage\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory show: invalid ID exits nonzero without creating .clino', () => {
  const work = tmp('clino-memory-show-missing-');
  try {
    const { code, stdout, stderr } = clino(['memory', 'show', 'bug-1'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Memory item not found: bug-1/);
    assert.ok(!existsSync(join(work, '.clino')), 'memory show does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory delete: removes a valid ID from its memory file', () => {
  const work = tmp('clino-memory-delete-');
  try {
    const memDir = writeMemoryFixture(work);
    const { code, stdout, stderr } = clino(['memory', 'delete', 'todo-1'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Deleted todo-1 \(todo\): Add clino status command\./);
    const todos = readFileSync(join(memDir, 'todos.md'), 'utf8');
    assert.match(todos, /type: todos/);
    assert.doesNotMatch(todos, /Add clino status command/);
    const listed = clino(['memory', 'list'], { cwd: work });
    assert.doesNotMatch(listed.stdout, /todo-1/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory delete: invalid ID exits nonzero without modifying memory or creating storage', () => {
  const work = tmp('clino-memory-delete-missing-');
  try {
    const { code, stdout, stderr } = clino(['memory', 'delete', 'todo-1'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Memory item not found: todo-1/);
    assert.ok(!existsSync(join(work, '.clino')), 'missing memory delete does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory delete --dry-run: previews deletion without modifying files', () => {
  const work = tmp('clino-memory-dry-');
  try {
    const memDir = writeMemoryFixture(work);
    const before = readFileSync(join(memDir, 'bugs.md'), 'utf8');
    const { code, stdout, stderr } = clino(['memory', 'delete', 'bug-1', '--dry-run'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Would delete bug-1 \(bug\): GUARDRAILS\.md has an unclosed code fence\./);
    assert.equal(readFileSync(join(memDir, 'bugs.md'), 'utf8'), before);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory delete: deleted items disappear from find and inject results', () => {
  const work = tmp('clino-memory-delete-search-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'decisions.md'),
    '---\ntype: decisions\ndate: 2026-05-25\nsource: sessions/test.md\n---\n\n' +
      '- Use JWT authentication because it is stateless.\n',
  );
  try {
    assert.match(clino(['find', 'JWT'], { cwd: work }).stdout, /JWT authentication/);
    assert.match(clino(['inject', 'JWT'], { cwd: work }).stdout, /JWT authentication/);

    const deleted = clino(['memory', 'delete', 'decision-1'], { cwd: work });
    assert.equal(deleted.code ?? 0, 0);

    assert.doesNotMatch(clino(['find', 'JWT'], { cwd: work }).stdout, /JWT authentication/);
    assert.doesNotMatch(clino(['inject', 'JWT'], { cwd: work }).stdout, /JWT authentication/);
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

test('memory rebuild --dry-run: no sessions exits clearly without creating storage', () => {
  const work = tmp('clino-rebuild-empty-');
  try {
    const { code, stdout, stderr } = clino(['memory', 'rebuild', '--dry-run'], { cwd: work });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /No session transcripts found/);
    assert.match(stderr, /Memory rebuild needs at least one \.md session transcript/);
    assert.match(stderr, /No files were changed\./);
    assert.ok(!existsSync(join(work, '.clino')), 'dry-run with no sessions does not create .clino');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory rebuild --dry-run: previews rebuilt memory without modifying files', () => {
  const work = tmp('clino-rebuild-dry-');
  try {
    const memDir = writeMemoryFixture(work);
    const beforeDecisions = readFileSync(join(memDir, 'decisions.md'), 'utf8');
    const beforeTodos = readFileSync(join(memDir, 'todos.md'), 'utf8');
    const beforeBugs = readFileSync(join(memDir, 'bugs.md'), 'utf8');
    writeSessionFixture(
      work,
      'rebuild.md',
      'We decided to use dry-run previews for memory rebuilds and need to add rebuild tests.',
    );

    const { code, stdout, stderr } = clino(['memory', 'rebuild', '--dry-run'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Clino memory rebuild dry run/);
    assert.match(stdout, /Sessions: 1/);
    assert.match(stdout, /Current memory:\n- decisions: 1\n- todos: 1\n- bugs: 1/m);
    assert.match(stdout, /Rebuilt memory:\n- decisions: 1\n- todos: 1\n- bugs: 0/m);
    assert.match(stdout, /Memory to write:/);
    assert.match(stdout, /Use dry-run previews for memory rebuilds\./);
    assert.match(stdout, /Add rebuild tests\./);
    assert.match(stdout, /No files were changed\./);
    assert.equal(readFileSync(join(memDir, 'decisions.md'), 'utf8'), beforeDecisions);
    assert.equal(readFileSync(join(memDir, 'todos.md'), 'utf8'), beforeTodos);
    assert.equal(readFileSync(join(memDir, 'bugs.md'), 'utf8'), beforeBugs);
    assert.ok(!existsSync(join(work, '.clino', 'backups')), 'dry-run does not create backups');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory rebuild: backs up old memory before replacing it', () => {
  const work = tmp('clino-rebuild-backup-');
  try {
    const memDir = writeMemoryFixture(work);
    writeSessionFixture(work, 'new.md', 'We decided to use rebuilt memory from raw sessions.');

    const { code, stdout, stderr } = clino(['memory', 'rebuild'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /Clino memory rebuilt/);
    assert.match(stdout, /Sessions: 1/);
    assert.match(stdout, /New memory:\n- decisions: 1/m);

    const backupPath = stdout.match(/^Backup: (.+)$/m)?.[1];
    assert.ok(backupPath, 'prints backup path');
    assert.match(backupPath, new RegExp(`${escapeRegExp(join(work, '.clino', 'backups'))}/memory-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}`));
    assert.match(readFileSync(join(backupPath, 'decisions.md'), 'utf8'), /Use project-local \.clino storage\./);
    assert.match(readFileSync(join(memDir, 'decisions.md'), 'utf8'), /Use rebuilt memory from raw sessions\./);
    assert.doesNotMatch(readFileSync(join(memDir, 'decisions.md'), 'utf8'), /Use project-local \.clino storage\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory rebuild: removes stale polluted memory rejected by current extraction', () => {
  const work = tmp('clino-rebuild-polluted-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'bugs.md'),
    '---\ntype: bugs\n---\n\n' +
      '- Memory show invalid ID.\n' +
      '- Does not write to `.clino/memory\n' +
      '- 691 + decision: Use stale polluted memory.\n',
  );
  writeFileSync(
    join(memDir, 'errors.md'),
    '---\ntype: errors\n---\n\n' +
      '- Memory extraction for decisions/todos/bugs/errors/summaries/resolved.\n',
  );
  try {
    writeSessionFixture(
      work,
      'pollution.md',
      [
        'Memory extraction for decisions/todos/bugs/errors/summaries/resolved',
        'Memory list with decisions/todos/bugs/resolved/summaries',
        'Memory show invalid ID.',
        'Memory delete invalid ID.',
        'Does not write to `.clino/memory',
        '691 + decision: Use stale polluted memory.',
        'OpenAI Codex (v0.133.0)',
        '/status',
        'Account: user@example.com',
        'We decided to keep Clino private-by-default.',
      ].join('\n'),
    );

    const rebuilt = clino(['memory', 'rebuild'], { cwd: work });
    assert.equal(rebuilt.code ?? 0, 0);
    assert.equal(readIfExists(join(memDir, 'bugs.md')), null);
    assert.equal(readIfExists(join(memDir, 'errors.md')), null);

    const listed = clino(['memory', 'list'], { cwd: work });
    assert.match(listed.stdout, /Keep Clino private-by-default\./);
    assert.doesNotMatch(listed.stdout, /Memory show invalid ID/);
    assert.doesNotMatch(listed.stdout, /Does not write to/);
    assert.doesNotMatch(listed.stdout, /stale polluted memory/);
    assert.doesNotMatch(listed.stdout, /\berror-1\b/);
    assert.doesNotMatch(listed.stdout, /\bbug-1\b/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory rebuild: preserves legitimate decisions, todos, and resolved memories', () => {
  const work = tmp('clino-rebuild-preserve-');
  try {
    writeSessionFixture(
      work,
      'decision-todo.md',
      'We decided to keep Clino private-by-default and need to add a manual memory review workflow.',
    );
    writeSessionFixture(work, 'resolved.md', 'Fixed GUARDRAILS.md unclosed code fence.');

    const { code, stderr } = clino(['memory', 'rebuild'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');

    const listed = clino(['memory', 'list'], { cwd: work });
    assert.match(listed.stdout, /decision-1\s+decision\s+Keep Clino private-by-default\./);
    assert.match(listed.stdout, /todo-1\s+todo\s+Add a manual memory review workflow\./);
    assert.match(listed.stdout, /resolved-1\s+resolved\s+Fixed GUARDRAILS\.md unclosed code fence\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory rebuild: dedupes memories across sessions', () => {
  const work = tmp('clino-rebuild-dedupe-');
  try {
    writeSessionFixture(work, 'one.md', 'We decided to use JWT auth because it is stateless.');
    writeSessionFixture(work, 'two.md', 'We decided to use JWT auth because it is stateless.');

    const { code } = clino(['memory', 'rebuild'], { cwd: work });
    assert.equal(code ?? 0, 0);

    const decisions = readFileSync(join(work, '.clino', 'memory', 'decisions.md'), 'utf8');
    assert.equal((decisions.match(/Use JWT auth because it is stateless\./g) ?? []).length, 1);
    const listed = clino(['memory', 'list'], { cwd: work });
    assert.match(listed.stdout, /decision-1\s+decision\s+Use JWT auth because it is stateless\./);
    assert.doesNotMatch(listed.stdout, /decision-2/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory rebuild: respects CLINO_HOME', () => {
  const home = tmp('clino-rebuild-home-');
  const work = tmp('clino-rebuild-work-');
  try {
    writeHomeSessionFixture(home, 'home.md', 'We decided to keep CLINO_HOME rebuilds isolated.');
    const memDir = join(home, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'todos.md'), '---\ntype: todos\n---\n\n- Old home memory.\n');

    const { code, stdout, stderr } = clino(['memory', 'rebuild'], { cwd: work, clinoHome: home });
    assert.equal(code ?? 0, 0);
    assert.equal(stderr, '');
    assert.match(stdout, new RegExp(`Backup: ${escapeRegExp(join(home, 'backups'))}/memory-`));
    assert.match(readFileSync(join(home, 'memory', 'decisions.md'), 'utf8'), /Keep CLINO_HOME rebuilds isolated\./);
    assert.ok(!existsSync(join(work, '.clino')), 'cwd storage is untouched when CLINO_HOME is set');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory rebuild: does not delete raw session transcripts', () => {
  const work = tmp('clino-rebuild-sessions-');
  try {
    const sessionFile = writeSessionFixture(work, 'keep.md', 'We decided to keep raw sessions untouched.');
    const before = readFileSync(sessionFile, 'utf8');

    const { code } = clino(['memory', 'rebuild'], { cwd: work });
    assert.equal(code ?? 0, 0);
    assert.ok(existsSync(sessionFile), 'session file still exists');
    assert.equal(readFileSync(sessionFile, 'utf8'), before);
    assert.deepEqual(readdirSync(join(work, '.clino', 'sessions')), ['keep.md']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('find and inject use lightweight documentation aliases', () => {
  const work = tmp('clino-alias-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  const guardrailsMemory =
    'GUARDRAILS.md is directionally strong and aligned with the same boundaries, ' +
    'but it appears incomplete/truncated: it ends at line 79 with an unclosed code fence and no closing sections.';
  writeFileSync(
    join(memDir, 'bugs.md'),
    '---\ntype: bugs\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      `- ${guardrailsMemory}\n`,
  );
  try {
    const documentation = clino(['find', 'documentation'], { cwd: work });
    assert.match(documentation.stdout, /GUARDRAILS\.md/, 'documentation alias finds guardrails memory');
    assert.match(documentation.stdout, /unclosed code fence/);

    const injected = clino(['inject', 'documentation'], { cwd: work });
    assert.match(injected.stdout, /GUARDRAILS\.md/, 'inject uses the same documentation alias');
    assert.match(injected.stdout, /unclosed code fence/);

    const codeFence = clino(['find', 'code fence'], { cwd: work });
    assert.match(codeFence.stdout, /GUARDRAILS\.md/, 'code fence query finds guardrails memory');

    const guardrails = clino(['find', 'guardrails'], { cwd: work });
    assert.match(guardrails.stdout, /GUARDRAILS\.md/, 'guardrails query finds guardrails memory');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('inject preserves synthesized summaries without re-repairing them', () => {
  const work = tmp('clino-summary-inject-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'summaries.md'),
    '---\ntype: summaries\ndate: 2026-05-25\nsource: sessions/*\n---\n\n' +
      '- This session captured 1 resolved item. Focus areas: GUARDRAILS.md, code fence, documentation.\n',
  );
  try {
    const injected = clino(['inject', 'GUARDRAILS'], { cwd: work });
    assert.match(injected.stdout, /## Summary/);
    assert.match(injected.stdout, /This session captured 1 resolved item/);
    assert.doesNotMatch(injected.stdout, /## Summary\n-\s*\n/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolved memories suppress matching open bugs during inject and are labeled in find', () => {
  const work = tmp('clino-resolved-');
  const sessionsDir = join(work, '.clino', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const bugSession = join(sessionsDir, 'bug.md');
  const fixedSession = join(sessionsDir, 'fixed.md');
  writeFileSync(
    bugSession,
    '# Session\n\n## Transcript\n\n```\nGUARDRAILS.md is incomplete/truncated: it ends with an unclosed code fence.\n```\n',
  );
  writeFileSync(
    fixedSession,
    '# Session\n\n## Transcript\n\n```\nFixed GUARDRAILS.md unclosed code fence.\n```\n',
  );

  try {
    assert.equal(clino(['summarize', bugSession], { cwd: work }).code ?? 0, 0);
    assert.equal(clino(['summarize', fixedSession], { cwd: work }).code ?? 0, 0);

    const resolved = join(work, '.clino', 'memory', 'resolved.md');
    assert.ok(existsSync(resolved), 'resolved memory file is written');
    assert.match(readFileSync(resolved, 'utf8'), /type: resolved/);
    assert.match(readFileSync(resolved, 'utf8'), /Fixed GUARDRAILS\.md unclosed code fence\./);

    const found = clino(['find', 'GUARDRAILS'], { cwd: work });
    assert.match(found.stdout, /bugs\.md/);
    assert.match(found.stdout, /incomplete\/truncated/);
    assert.match(found.stdout, /resolved\.md \(Resolved\)/);
    assert.match(found.stdout, /Fixed GUARDRAILS\.md unclosed code fence\./);

    const injected = clino(['inject', 'GUARDRAILS'], { cwd: work });
    assert.doesNotMatch(injected.stdout, /## Open Bugs/);
    assert.doesNotMatch(injected.stdout, /incomplete\/truncated/);
    assert.match(injected.stdout, /## Recently Resolved/);
    assert.match(injected.stdout, /Fixed GUARDRAILS\.md unclosed code fence\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve command records a marker that suppresses matching open work', () => {
  const work = tmp('clino-resolve-cmd-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'bugs.md'),
    '---\ntype: bugs\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- GUARDRAILS.md is incomplete/truncated: it ends with an unclosed code fence.\n',
  );

  try {
    const resolved = clino(['resolve', 'GUARDRAILS code fence'], { cwd: work });
    assert.equal(resolved.code ?? 0, 0);
    assert.match(resolved.stdout, /Resolved memory recorded: Resolved GUARDRAILS code fence\./);

    const injected = clino(['inject', 'GUARDRAILS'], { cwd: work });
    assert.doesNotMatch(injected.stdout, /## Open Bugs/);
    assert.match(injected.stdout, /## Recently Resolved/);
    assert.match(injected.stdout, /Resolved GUARDRAILS code fence\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('README search prefers direct README memories over broader docs aliases', () => {
  const work = tmp('clino-readme-alias-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'decisions.md'),
    '---\ntype: decisions\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- README.md documents JWT setup.\n',
  );
  writeFileSync(
    join(memDir, 'bugs.md'),
    '---\ntype: bugs\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- GUARDRAILS.md documentation has an unclosed code fence.\n',
  );
  try {
    const found = clino(['find', 'README'], { cwd: work });
    assert.match(found.stdout, /README\.md documents JWT setup/);
    assert.doesNotMatch(found.stdout, /GUARDRAILS\.md documentation/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// clino resolve
// ---------------------------------------------------------------------------

test('resolve: resolving a todo by ID creates a resolved memory', () => {
  const work = tmp('clino-resolve-todo-id-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'todos.md'),
    '---\ntype: todos\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Add clino status command.\n',
  );
  try {
    const res = clino(['resolve', 'todo-1'], { cwd: work });
    assert.equal(res.code ?? 0, 0);
    assert.match(res.stdout, /Resolved todo-1/);
    assert.match(res.stdout, /Add clino status command/);
    assert.match(res.stdout, /Created resolved memory/);
    assert.match(res.stdout, /Resolved: Add clino status command/);

    const resolvedFile = join(memDir, 'resolved.md');
    assert.ok(existsSync(resolvedFile));
    const content = readFileSync(resolvedFile, 'utf8');
    assert.match(content, /Resolved: Add clino status command\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: resolving a bug by ID creates a resolved memory', () => {
  const work = tmp('clino-resolve-bug-id-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'bugs.md'),
    '---\ntype: bugs\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- GUARDRAILS.md has an unclosed code fence.\n',
  );
  try {
    const res = clino(['resolve', 'bug-1'], { cwd: work });
    assert.equal(res.code ?? 0, 0);
    assert.match(res.stdout, /Resolved bug-1/);
    assert.match(res.stdout, /GUARDRAILS\.md has an unclosed code fence/);
    assert.match(res.stdout, /Created resolved memory/);
    assert.match(res.stdout, /Resolved: GUARDRAILS\.md has an unclosed code fence/);

    const resolvedFile = join(memDir, 'resolved.md');
    assert.ok(existsSync(resolvedFile));
    const content = readFileSync(resolvedFile, 'utf8');
    assert.match(content, /Resolved: GUARDRAILS\.md has an unclosed code fence\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: resolved todo is suppressed from inject open TODOs', () => {
  const work = tmp('clino-resolve-suppress-todo-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'todos.md'),
    '---\ntype: todos\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Add clino status command.\n',
  );
  try {
    const res = clino(['resolve', 'todo-1'], { cwd: work });
    assert.equal(res.code ?? 0, 0);

    const injected = clino(['inject', 'status'], { cwd: work });
    assert.doesNotMatch(injected.stdout, /## Open Todos/);
    assert.match(injected.stdout, /## Recently Resolved/);
    assert.match(injected.stdout, /Resolved: Add clino status command\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: resolved bug is suppressed from inject open bugs', () => {
  const work = tmp('clino-resolve-suppress-bug-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'bugs.md'),
    '---\ntype: bugs\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- GUARDRAILS.md has an unclosed code fence.\n',
  );
  try {
    const res = clino(['resolve', 'bug-1'], { cwd: work });
    assert.equal(res.code ?? 0, 0);

    const injected = clino(['inject', 'GUARDRAILS'], { cwd: work });
    assert.doesNotMatch(injected.stdout, /## Open Bugs/);
    assert.match(injected.stdout, /## Recently Resolved/);
    assert.match(injected.stdout, /Resolved: GUARDRAILS\.md has an unclosed code fence\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: memory list labels the original item as [resolved]', () => {
  const work = tmp('clino-resolve-list-label-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'todos.md'),
    '---\ntype: todos\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Add clino status command.\n',
  );
  try {
    const res = clino(['resolve', 'todo-1'], { cwd: work });
    assert.equal(res.code ?? 0, 0);

    const listed = clino(['memory', 'list'], { cwd: work });
    assert.match(listed.stdout, /todo-1\s+todo\s+Add clino status command\. \[resolved\]/);
    assert.match(listed.stdout, /resolved-1\s+resolved\s+Resolved: Add clino status command\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: invalid ID exits nonzero and writes nothing', () => {
  const work = tmp('clino-resolve-invalid-id-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'todos.md'),
    '---\ntype: todos\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Add clino status command.\n',
  );
  try {
    const res = clino(['resolve', 'todo-999'], { cwd: work });
    assert.notEqual(res.code ?? 0, 0);
    assert.match(res.stderr, /not found/);

    const resolvedFile = join(memDir, 'resolved.md');
    assert.ok(!existsSync(resolvedFile), 'resolved.md should not be created');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: resolving decision ID exits nonzero and writes nothing', () => {
  const work = tmp('clino-resolve-decision-id-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'decisions.md'),
    '---\ntype: decisions\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Use project-local .clino storage.\n',
  );
  try {
    const res = clino(['resolve', 'decision-1'], { cwd: work });
    assert.notEqual(res.code ?? 0, 0);
    assert.match(res.stderr, /Only open todos and bugs can be resolved/);

    const resolvedFile = join(memDir, 'resolved.md');
    assert.ok(!existsSync(resolvedFile), 'resolved.md should not be created');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: resolving already resolved item no-ops', () => {
  const work = tmp('clino-resolve-already-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'todos.md'),
    '---\ntype: todos\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Add clino status command.\n',
  );
  writeFileSync(
    join(memDir, 'resolved.md'),
    '---\ntype: resolved\ndate: 2026-05-25\nsource: manual\n---\n\n' +
      '- Resolved: Add clino status command.\n',
  );
  try {
    const res = clino(['resolve', 'todo-1'], { cwd: work });
    assert.equal(res.code ?? 0, 0);
    assert.match(res.stdout, /Already resolved/);

    // resolved.md should still have exactly one entry
    const content = readFileSync(join(memDir, 'resolved.md'), 'utf8');
    const matches = content.match(/- Resolved: Add clino status command\./g);
    assert.equal(matches?.length ?? 0, 1, 'should not duplicate resolved entry');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: duplicate idempotency does not duplicate resolved memory', () => {
  const work = tmp('clino-resolve-idempotent-');
  const memDir = join(work, '.clino', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'todos.md'),
    '---\ntype: todos\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Add clino status command.\n',
  );
  try {
    const res1 = clino(['resolve', 'todo-1'], { cwd: work });
    assert.equal(res1.code ?? 0, 0);

    const res2 = clino(['resolve', 'todo-1'], { cwd: work });
    assert.equal(res2.code ?? 0, 0);
    assert.match(res2.stdout, /Already resolved/);

    const content = readFileSync(join(memDir, 'resolved.md'), 'utf8');
    const matches = content.match(/- Resolved: Add clino status command\./g);
    assert.equal(matches?.length ?? 0, 1, 'should not duplicate resolved entry');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('resolve: CLINO_HOME respected', () => {
  const work = tmp('clino-resolve-home-');
  const memDir = join(work, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'todos.md'),
    '---\ntype: todos\ndate: 2026-05-25\nsource: test.md\n---\n\n' +
      '- Add clino status command.\n',
  );
  try {
    const res = clino(['resolve', 'todo-1'], { clinoHome: work });
    assert.equal(res.code ?? 0, 0);
    assert.match(res.stdout, /Resolved todo-1/);

    const resolvedFile = join(memDir, 'resolved.md');
    assert.ok(existsSync(resolvedFile));
    assert.match(readFileSync(resolvedFile, 'utf8'), /Resolved: Add clino status command\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Secret redaction (extraction / review / find / inject / inspect)
// ---------------------------------------------------------------------------

const RAW_SECRET = 'sk-livesecret1234567890';
const BUG_WITH_SECRET = `Bug: login failed because OPENAI_API_KEY=${RAW_SECRET} was missing from env.`;
const SECRET_ONLY_TRANSCRIPT = [
  'OPENAI_API_KEY=sk-onlysecret1234567890',
  'GITHUB_TOKEN=ghp_onlysecret1234567890',
  'DATABASE_URL=postgres://user:pass@example.com/db',
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw',
  '-----END PRIVATE KEY-----',
].join('\n');

function readAllMemory(work) {
  const memDir = join(work, '.clino', 'memory');
  if (!existsSync(memDir)) return '';
  return readdirSync(memDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(join(memDir, f), 'utf8'))
    .join('\n');
}

test('run default redacts secrets in stored memory, never a raw secret', () => {
  const work = tmp('clino-secret-run-');
  try {
    const run = clino(['run', 'echo', BUG_WITH_SECRET], { cwd: work });
    assert.equal(run.code ?? 0, 0);

    const memory = readAllMemory(work);
    assert.doesNotMatch(memory, new RegExp(escapeRegExp(RAW_SECRET)));
    assert.match(memory, /\[REDACTED_SECRET\]/);
    // The synthesized summary must not surface the placeholder words as topics.
    const summaries = join(work, '.clino', 'memory', 'summaries.md');
    if (existsSync(summaries)) {
      assert.doesNotMatch(readFileSync(summaries, 'utf8'), /REDACTED|\bSECRET\b/);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review shows redacted candidates marked [redacted] and writes redacted memory', () => {
  const work = tmp('clino-secret-review-');
  try {
    const sessionFile = writeSessionFixture(work, 'secret.md', BUG_WITH_SECRET);

    const preview = clino(['review', sessionFile], { cwd: work });
    assert.equal(preview.code ?? 0, 0);
    assert.doesNotMatch(preview.stdout, new RegExp(escapeRegExp(RAW_SECRET)));
    assert.match(preview.stdout, /\[REDACTED_SECRET\]/);
    assert.match(preview.stdout, /\[redacted\]/);

    const accepted = clino(['review', sessionFile, '--accept', 'all'], { cwd: work });
    assert.equal(accepted.code ?? 0, 0);
    assert.doesNotMatch(accepted.stdout, new RegExp(escapeRegExp(RAW_SECRET)));

    const memory = readAllMemory(work);
    assert.doesNotMatch(memory, new RegExp(escapeRegExp(RAW_SECRET)));
    assert.match(memory, /\[REDACTED_SECRET\]/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('review of a secret-only session offers no candidates and leaks nothing', () => {
  const work = tmp('clino-secret-only-review-');
  try {
    const sessionFile = writeSessionFixture(work, 'only.md', SECRET_ONLY_TRANSCRIPT);
    const preview = clino(['review', sessionFile], { cwd: work });
    assert.equal(preview.code ?? 0, 0);
    assert.match(preview.stdout, /No candidate memories found\./);
    assert.doesNotMatch(preview.stdout, /sk-onlysecret/);
    assert.doesNotMatch(preview.stdout, /ghp_onlysecret/);
    assert.doesNotMatch(preview.stdout, /user:pass@/);
    assert.doesNotMatch(preview.stdout, /MIIEvQ/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('memory rebuild redacts secrets from session transcripts', () => {
  const work = tmp('clino-secret-rebuild-');
  try {
    writeSessionFixture(work, 'rebuild-secret.md', BUG_WITH_SECRET);
    const rebuilt = clino(['memory', 'rebuild'], { cwd: work });
    assert.equal(rebuilt.code ?? 0, 0);

    const memory = readAllMemory(work);
    assert.doesNotMatch(memory, new RegExp(escapeRegExp(RAW_SECRET)));
    assert.match(memory, /\[REDACTED_SECRET\]/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('find redacts secrets that somehow live in a memory file (defense in depth)', () => {
  const work = tmp('clino-secret-find-');
  try {
    const memDir = join(work, '.clino', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'bugs.md'),
      '---\ntype: bugs\ndate: 2026-05-25\nsource: manual\n---\n\n' +
        `- Login failed because OPENAI_API_KEY=${RAW_SECRET} was missing.\n`,
    );

    const res = clino(['find', 'login'], { cwd: work });
    assert.equal(res.code ?? 0, 0);
    assert.doesNotMatch(res.stdout, new RegExp(escapeRegExp(RAW_SECRET)));
    assert.match(res.stdout, /\[REDACTED_SECRET\]/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('inject redacts secrets that somehow live in a memory file (defense in depth)', () => {
  const work = tmp('clino-secret-inject-');
  try {
    // Plant in summaries.md: summaries bypass repairMemoryText, so only inject's
    // final defense-in-depth scrub can catch a secret that lives there.
    const memDir = join(work, '.clino', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'summaries.md'),
      '---\ntype: summaries\ndate: 2026-05-25\nsource: manual\n---\n\n' +
        `- Login flow failed because OPENAI_API_KEY=${RAW_SECRET} was missing.\n`,
    );

    const res = clino(['inject', 'login'], { cwd: work });
    assert.equal(res.code ?? 0, 0);
    assert.doesNotMatch(res.stdout, new RegExp(escapeRegExp(RAW_SECRET)));
    assert.match(res.stdout, /\[REDACTED_SECRET\]/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('inspect --show-cleaned redacts secrets and notes raw transcripts are unchanged', () => {
  const work = tmp('clino-secret-inspect-');
  try {
    const sessionFile = writeSessionFixture(work, 'inspect-secret.md', BUG_WITH_SECRET);
    const res = clino(['inspect', sessionFile, '--show-cleaned'], { cwd: work });
    assert.equal(res.code ?? 0, 0);
    assert.doesNotMatch(res.stdout, new RegExp(escapeRegExp(RAW_SECRET)));
    assert.match(res.stdout, /\[REDACTED_SECRET\]/);
    // Raw transcript on disk is never rewritten.
    assert.match(readFileSync(sessionFile, 'utf8'), new RegExp(escapeRegExp(RAW_SECRET)));
    assert.match(res.stdout, /raw transcript/i);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('doctor reports the secret-redaction privacy note', () => {
  const work = tmp('clino-secret-doctor-');
  try {
    const res = clino(['doctor'], { cwd: work });
    assert.equal(res.code ?? 0, 0);
    assert.match(res.stdout, /Secret redaction: enabled for extraction\/review\/inject output/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('status reports the secret-redaction privacy note', () => {
  const work = tmp('clino-secret-status-');
  try {
    const res = clino(['status'], { cwd: work });
    assert.equal(res.code ?? 0, 0);
    assert.match(res.stdout, /Secret redaction: enabled for extraction\/review\/inject output/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
