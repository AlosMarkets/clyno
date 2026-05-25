import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSecrets,
  redactSecrets,
  containsSecret,
  extractSignals,
  cleanTranscriptForExtraction,
  synthesizeSummary,
} from '../dist/memory.js';

const PRIVATE_KEY_BLOCK = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
  '-----END PRIVATE KEY-----',
].join('\n');

const SECRET_ONLY_BLOCK = [
  'OPENAI_API_KEY=sk-testsecret1234567890',
  'GITHUB_TOKEN=ghp_testsecret1234567890',
  'DATABASE_URL=postgres://user:pass@example.com/db',
  PRIVATE_KEY_BLOCK,
].join('\n');

// ---------------------------------------------------------------------------
// detectSecrets / containsSecret
// ---------------------------------------------------------------------------

test('containsSecret flags obvious env secrets and token formats', () => {
  assert.equal(containsSecret('OPENAI_API_KEY=sk-testsecret1234567890'), true);
  assert.equal(containsSecret('ANTHROPIC_API_KEY=sk-ant-abcdefg1234567890'), true);
  assert.equal(containsSecret('GITHUB_TOKEN=ghp_testsecret1234567890'), true);
  assert.equal(containsSecret('GITLAB_TOKEN=glpat-abcdefghij'), true);
  assert.equal(containsSecret('NPM_TOKEN=npm_abcdefghij1234567890'), true);
  assert.equal(containsSecret('CLIENT_SECRET=verysecretvalue'), true);
  assert.equal(containsSecret('PASSWORD=hunter2pass'), true);
  assert.equal(containsSecret('SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi'), true);
  assert.equal(containsSecret('DATABASE_URL=postgres://user:pass@example.com/db'), true);
  assert.equal(containsSecret('REDIS_URL=redis://user:pass@localhost:6379'), true);
});

test('containsSecret flags bare token formats and key blocks', () => {
  assert.equal(containsSecret('Use token ghp_abcd1234efgh'), true);
  assert.equal(containsSecret('the key sk-ant-api03-abcdef123456 leaked'), true);
  assert.equal(containsSecret('slack xoxb-123456789012-abcdefghijkl'), true);
  assert.equal(
    containsSecret('github_pat_11ABCDEFG0abcdefghij_abcdefghijklmnop'),
    true,
  );
  assert.equal(containsSecret(PRIVATE_KEY_BLOCK), true);
  assert.equal(containsSecret('https://user:password@example.com/path'), true);
});

test('containsSecret does not flag ordinary project prose', () => {
  assert.equal(containsSecret('We decided to use JWT auth.'), false);
  assert.equal(containsSecret('Users unable to login after password reset.'), false);
  assert.equal(containsSecret('Fix the foreign_key and primary_key indexes.'), false);
  assert.equal(containsSecret('Add a status command to the CLI.'), false);
  assert.equal(containsSecret('The tokenizer handles markdown fences.'), false);
});

test('detectSecrets returns findings for each secret kind', () => {
  assert.ok(detectSecrets('OPENAI_API_KEY=sk-abc123').length >= 1);
  assert.ok(detectSecrets(PRIVATE_KEY_BLOCK).length >= 1);
  assert.equal(detectSecrets('We decided to use JWT auth.').length, 0);
});

// ---------------------------------------------------------------------------
// redactSecrets — exact formats from the spec
// ---------------------------------------------------------------------------

test('redactSecrets: env assignment keeps the key, masks the value', () => {
  assert.equal(redactSecrets('OPENAI_API_KEY=sk-abc123'), 'OPENAI_API_KEY=[REDACTED_SECRET]');
  assert.equal(redactSecrets('GITHUB_TOKEN=ghp_abc123'), 'GITHUB_TOKEN=[REDACTED_SECRET]');
});

test('redactSecrets: credentialed URL value is masked', () => {
  assert.equal(
    redactSecrets('DATABASE_URL=postgres://user:password@localhost/db'),
    'DATABASE_URL=[REDACTED_SECRET]',
  );
});

test('redactSecrets: bare token in prose, trailing context preserved', () => {
  assert.equal(redactSecrets('Use token ghp_abcd1234...'), 'Use token [REDACTED_SECRET]...');
});

test('redactSecrets: keeps surrounding prose and trailing punctuation', () => {
  assert.equal(
    redactSecrets('TODO: rotate leaked GITHUB_TOKEN=ghp_abc123.'),
    'TODO: rotate leaked GITHUB_TOKEN=[REDACTED_SECRET].',
  );
  assert.equal(
    redactSecrets('Bug: login failed because OPENAI_API_KEY=sk-abc123 was missing from env.'),
    'Bug: login failed because OPENAI_API_KEY=[REDACTED_SECRET] was missing from env.',
  );
});

test('redactSecrets: private key block collapses to a single placeholder', () => {
  const out = redactSecrets(`before\n${PRIVATE_KEY_BLOCK}\nafter`);
  assert.match(out, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(out, /BEGIN PRIVATE KEY/);
  assert.doesNotMatch(out, /MIIEvQ/);
  assert.match(out, /before/);
  assert.match(out, /after/);
});

test('redactSecrets: masks varied token formats', () => {
  assert.doesNotMatch(redactSecrets('key sk-ant-api03-abcdef123456 here'), /sk-ant-api03/);
  assert.doesNotMatch(redactSecrets('slack xoxb-123456789012-abcdefghijkl'), /xoxb-/);
  assert.doesNotMatch(
    redactSecrets('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123-_signature'),
    /eyJhbGci/,
  );
});

test('redactSecrets: leaves ordinary prose untouched', () => {
  for (const text of [
    'We decided to use JWT auth.',
    'Users unable to login after password reset.',
    'The foreign_key and primary_key constraints differ.',
    'PRIMARY_KEY=id_column',
    'Add a status command to the CLI.',
  ]) {
    assert.equal(redactSecrets(text), text);
  }
});

test('redactSecrets is idempotent', () => {
  for (const text of [
    'OPENAI_API_KEY=sk-abc123',
    'DATABASE_URL=postgres://user:password@localhost/db',
    'TODO: rotate leaked GITHUB_TOKEN=ghp_abc123.',
    `before\n${PRIVATE_KEY_BLOCK}\nafter`,
    'Use token ghp_abcd1234...',
  ]) {
    const once = redactSecrets(text);
    assert.equal(redactSecrets(once), once, `not idempotent for: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// extractSignals — reject secret-only, keep useful-but-redacted
// ---------------------------------------------------------------------------

test('extractSignals: rejects candidates that are only a secret/env line', () => {
  const signals = extractSignals(SECRET_ONLY_BLOCK);
  for (const list of Object.values(signals)) assert.deepEqual(list, []);
  const serialized = JSON.stringify(signals);
  assert.doesNotMatch(serialized, /sk-testsecret/);
  assert.doesNotMatch(serialized, /ghp_testsecret/);
  assert.doesNotMatch(serialized, /user:pass@/);
  assert.doesNotMatch(serialized, /MIIEvQ/);
  assert.equal(synthesizeSummary(signals), '');
});

test('extractSignals: keeps a useful memory but redacts the embedded secret', () => {
  const signals = extractSignals(
    'Bug: login failed because OPENAI_API_KEY=sk-abc123 was missing from env.',
  );
  const all = [...signals.bugs, ...signals.errors, ...signals.decisions, ...signals.todos];
  assert.ok(all.length >= 1, 'a useful memory should survive');
  const joined = all.join('\n');
  assert.match(joined, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(joined, /sk-abc123/);
});

// ---------------------------------------------------------------------------
// cleanTranscriptForExtraction redacts secrets (drives inspect --show-cleaned)
// ---------------------------------------------------------------------------

test('cleanTranscriptForExtraction redacts secrets in cleaned output', () => {
  const cleaned = cleanTranscriptForExtraction(
    'We set OPENAI_API_KEY=sk-abc123 and used ghp_abcd1234efgh for CI.',
  );
  assert.doesNotMatch(cleaned, /sk-abc123/);
  assert.doesNotMatch(cleaned, /ghp_abcd1234efgh/);
  assert.match(cleaned, /\[REDACTED_SECRET\]/);
});
