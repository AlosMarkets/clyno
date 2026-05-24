import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node-pty';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'index.js');

/**
 * Run `clino run <args>` inside a real PTY, with an isolated CLINO_HOME so we
 * never touch the user's ~/.clino. `steps` is an array of either strings (sent
 * to the child's stdin) or numbers (a delay in ms) so a test can drive an
 * interactive session. Resolves once clino exits.
 */
function runClino(args, { steps = [], cols = 80, rows = 24 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'clino-test-'));
  return new Promise((resolve) => {
    const pty = spawn(process.execPath, [CLI, 'run', ...args], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, CLINO_HOME: home },
    });

    let output = '';
    pty.onData((d) => (output += d));

    let resized = false;
    pty.onExit(({ exitCode, signal }) => {
      const sessionsDir = join(home, 'sessions');
      const sessions = existsSync(sessionsDir)
        ? readdirSync(sessionsDir).map((f) => readFileSync(join(sessionsDir, f), 'utf8'))
        : [];
      rmSync(home, { recursive: true, force: true });
      resolve({ code: exitCode, signal, output, sessions, pty, didResize: resized });
    });

    // Drive the session.
    (async () => {
      for (const step of steps) {
        if (typeof step === 'number') {
          await new Promise((r) => setTimeout(r, step));
        } else if (step === '__resize__') {
          pty.resize(120, 40);
          resized = true;
        } else {
          pty.write(step);
        }
      }
    })();
  });
}

test('run echo: forwards output, exits 0, writes a transcript', { timeout: 15000 }, async () => {
  const { code, output, sessions } = await runClino(['echo', 'hello-pty']);
  assert.equal(code, 0);
  assert.match(output, /hello-pty/);
  assert.equal(sessions.length, 1, 'one session file should be written');
  assert.match(sessions[0], /hello-pty/, 'transcript should contain the output');
  assert.match(sessions[0], /\*\*Exit code:\*\* 0/);
});

test('run npm --version: exits 0 with a version string', { timeout: 15000 }, async () => {
  const { code, output } = await runClino(['npm', '--version']);
  assert.equal(code, 0);
  assert.match(output, /\d+\.\d+\.\d+/);
});

test('exit code propagates from the child', { timeout: 15000 }, async () => {
  const { code } = await runClino(['bash', '-c', 'exit 7']);
  assert.equal(code, 7);
});

test('no Clino logs appear before the child exits', { timeout: 15000 }, async () => {
  const { output } = await runClino(['echo', 'MARKER']);
  // The "[clino] session saved" line must come *after* the child's output,
  // proving nothing was printed mid-run.
  const markerAt = output.indexOf('MARKER');
  const clinoAt = output.indexOf('[clino] session saved');
  assert.ok(markerAt >= 0 && clinoAt >= 0);
  assert.ok(clinoAt > markerAt, 'clino summary should print only after the child output');
});

test('interactive stdin is forwarded to the child', { timeout: 15000 }, async () => {
  const { code, output } = await runClino(['bash'], {
    steps: [200, 'echo from-stdin-roundtrip\r', 200, 'exit\r', 200],
  });
  assert.equal(code, 0);
  assert.match(output, /from-stdin-roundtrip/);
});

test('Ctrl+C reaches the child as an interrupt', { timeout: 15000 }, async () => {
  // A raw 0x03 byte should travel through the PTY and SIGINT the child group,
  // terminating the sleep instead of hanging until the test timeout.
  const { code, signal } = await runClino(['bash', '-c', 'sleep 30'], {
    steps: [300, '\x03', 500],
  });
  assert.notEqual(code, 0, 'interrupted child should not exit cleanly');
  // bash -c reports 128+SIGINT (130); some platforms surface the signal field.
  assert.ok(code === 130 || signal === 2 || code !== 0);
});

test('resize during a session does not break it', { timeout: 15000 }, async () => {
  const { code, output } = await runClino(['bash', '-c', 'sleep 0.4; echo resized-ok'], {
    steps: [150, '__resize__', 400],
  });
  assert.equal(code, 0);
  assert.match(output, /resized-ok/);
});
