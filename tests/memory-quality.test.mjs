import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repairMemoryText,
  isQualityMemory,
  dedupeMemories,
  extractSignals,
  synthesizeSummary,
  parseMemoryItems,
} from '../dist/memory.js';

// --------------------------------------------------------------------------
// 1. Phrase repair (acceptance criteria #2)
// --------------------------------------------------------------------------
test('repair: fragment -> clean human-readable note', () => {
  assert.equal(repairMemoryText('to use JWT auth'), 'Use JWT auth.');
  assert.equal(repairMemoryText('decided to use JWT auth'), 'Use JWT auth.');
  assert.equal(repairMemoryText('we decided to use JWT auth'), 'Use JWT auth.');
  assert.equal(
    repairMemoryText("we decided to use JWT auth because it's stateless"),
    'Use JWT auth because it is stateless.',
  );
  assert.equal(repairMemoryText('need to fix Redis blacklist bug'), 'Fix Redis blacklist bug.');
  assert.equal(repairMemoryText('fix Redis blacklist bug'), 'Fix Redis blacklist bug.');
  assert.equal(
    repairMemoryText('remaining: add unit tests for auth module'),
    'Add unit tests for auth module.',
  );
});

test('repair: contraction "it\'s" -> "it is"', () => {
  assert.equal(repairMemoryText("it's stateless and that's fine"), 'It is stateless and that is fine.');
  assert.doesNotMatch(repairMemoryText("it's stateless"), /it's/i);
});

test('repair: capitalization is fixed', () => {
  assert.equal(repairMemoryText('fix Redis blacklist bug.'), 'Fix Redis blacklist bug.');
  assert.equal(repairMemoryText('to use JWT auth.'), 'Use JWT auth.');
});

// --------------------------------------------------------------------------
// 2. Quality filter (acceptance criteria #1 and #3)
// --------------------------------------------------------------------------
test('quality: accepts well-formed notes', () => {
  assert.ok(isQualityMemory('Use JWT auth.', 'decisions'));
  assert.ok(isQualityMemory('Use JWT auth because it is stateless.', 'decisions'));
  assert.ok(isQualityMemory('Fix Redis blacklist bug.', 'bugs'));
  assert.ok(isQualityMemory('Add unit tests for auth module.', 'todos'));
});

test('quality: rejects fragments and keyword-only memories', () => {
  assert.equal(isQualityMemory('jwt', 'decisions'), false);
  assert.equal(isQualityMemory('auth', 'decisions'), false);
  assert.equal(isQualityMemory('redis', 'bugs'), false);
  assert.equal(isQualityMemory('to use JWT', 'decisions'), false);
  assert.equal(isQualityMemory('because it is stateless', 'decisions'), false);
});

test('quality: rejects forbidden lowercase / lead-in starts', () => {
  assert.equal(isQualityMemory('to use JWT auth', 'decisions'), false);
  assert.equal(isQualityMemory('decided to use JWT auth', 'decisions'), false);
  assert.equal(isQualityMemory('we decided to use JWT auth', 'decisions'), false);
  assert.equal(isQualityMemory('jwt auth thing here', 'decisions'), false); // lowercase start
});

test('quality: allows explicit errors and command literals', () => {
  assert.ok(isQualityMemory('Module type not specified.', 'errors'));
  assert.ok(isQualityMemory('npm run build', 'errors'));
});

// --------------------------------------------------------------------------
// 3. Richer-memory dedupe (acceptance criteria #5)
// --------------------------------------------------------------------------
test('dedupe: keeps the richer memory', () => {
  const out = dedupeMemories(['Use JWT auth.', 'Use JWT auth because it is stateless.']);
  assert.deepEqual(out, ['Use JWT auth because it is stateless.']);
});

test('dedupe: collapses exact duplicates', () => {
  const out = dedupeMemories(['Fix Redis blacklist bug.', 'Fix Redis blacklist bug.']);
  assert.deepEqual(out, ['Fix Redis blacklist bug.']);
});

// --------------------------------------------------------------------------
// 4. Compound splitting (acceptance criteria #4)
// --------------------------------------------------------------------------
test('extract: splits compound statement into decision + bug', () => {
  const signals = extractSignals(
    'We decided to use JWT auth and need to fix Redis blacklist bug!!!',
  );
  assert.deepEqual(signals.decisions, ['Use JWT auth.']);
  assert.deepEqual(signals.bugs, ['Fix Redis blacklist bug.']);
});

test('extract: full transcript yields clean, deduped, classified memories', () => {
  const signals = extractSignals(
    [
      'We decided to use JWT auth and need to fix Redis blacklist bug!!!',
      'We decided to use JWT auth and need to fix Redis blacklist bug!!!',
      "We decided to use JWT auth because it's stateless.",
      'We need to fix Redis blacklist bug.',
      'remaining: add unit tests for auth module',
      'error: module type not specified',
    ].join('\n'),
  );

  // Richer decision wins; no "Use JWT auth." duplicate remains.
  assert.deepEqual(signals.decisions, ['Use JWT auth because it is stateless.']);
  assert.deepEqual(signals.bugs, ['Fix Redis blacklist bug.']);
  assert.deepEqual(signals.todos, ['Add unit tests for auth module.']);
  assert.deepEqual(signals.errors, ['Module type not specified.']);

  // No stored memory may start with a forbidden lead-in or be lowercase.
  for (const list of Object.values(signals)) {
    for (const m of list) {
      assert.doesNotMatch(m, /^(to use|decided to use|we decided to use)/i);
      assert.match(m, /^[A-Z`$]/, `"${m}" should not start lowercase`);
    }
  }
});

// --------------------------------------------------------------------------
// 5. Summaries must not duplicate decisions (acceptance criteria #6)
// --------------------------------------------------------------------------
test('summary: synthesizes context without repeating raw bullets', () => {
  const signals = extractSignals(
    [
      "We decided to use JWT auth because it's stateless.",
      'We need to fix Redis blacklist bug.',
      'remaining: add unit tests for auth module',
    ].join('\n'),
  );
  const summary = synthesizeSummary(signals);

  // Does not contain the raw decision bullet verbatim.
  assert.doesNotMatch(summary, /Use JWT auth because it is stateless\./);
  assert.doesNotMatch(summary, /^- /m);
  // Does synthesize counts + focus topics.
  assert.match(summary, /captured/i);
  assert.match(summary, /JWT/);
});

// --------------------------------------------------------------------------
// 6. File parsing ignores frontmatter
// --------------------------------------------------------------------------
test('parseMemoryItems: ignores YAML frontmatter and tags', () => {
  const file = [
    '---',
    'type: decisions',
    'tags:',
    '  - jwt',
    '  - auth',
    '---',
    '',
    '- Use JWT auth because it is stateless.',
  ].join('\n');
  assert.deepEqual(parseMemoryItems(file), ['Use JWT auth because it is stateless.']);
});
