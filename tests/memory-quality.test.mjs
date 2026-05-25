import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repairMemoryText,
  isQualityMemory,
  dedupeMemories,
  extractSignals,
  synthesizeSummary,
  parseMemoryItems,
  stripMetadataPrefix,
  cleanTranscriptForExtraction,
  compactForUiMatch,
  memoryResolvesItem,
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

test('extract: resolution language creates resolved memories, not open bugs', () => {
  const examples = [
    'Fixed GUARDRAILS.md unclosed code fence.',
    'Resolved the GUARDRAILS.md truncation issue.',
    'Completed the guardrails document.',
    'Fixed the incomplete GUARDRAILS.md file.',
    'Closed the documentation bug about GUARDRAILS.md code fence.',
    'Addressed the SETTINGS.md validation issue.',
    'Repaired the CLI startup regression.',
  ];

  const signals = extractSignals(examples.join('\n'));
  assert.deepEqual(signals.bugs, []);
  assert.deepEqual(signals.todos, []);
  assert.equal(signals.resolved.length, examples.length);
  assert.match(signals.resolved[0], /Fixed GUARDRAILS\.md unclosed code fence/);
  assert.match(signals.resolved[1], /Resolved the GUARDRAILS\.md truncation issue/);
  assert.match(signals.resolved[5], /Addressed the SETTINGS\.md validation issue/);
  assert.match(signals.resolved[6], /Repaired the CLI startup regression/);
});

test('resolution matching closes the guardrails code fence bug', () => {
  const openBug = 'GUARDRAILS.md is incomplete/truncated: it ends with an unclosed code fence.';
  const resolved = 'Fixed GUARDRAILS.md unclosed code fence.';

  assert.equal(memoryResolvesItem(openBug, resolved), true);
  assert.equal(memoryResolvesItem(openBug, 'Fixed unrelated Redis blacklist bug.'), false);
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

// --------------------------------------------------------------------------
// 7. Dogfood regression: transcript metadata must not pollute memory
// --------------------------------------------------------------------------
test('metadata: strips transcript header labels (bold and plain forms)', () => {
  assert.equal(
    stripMetadataPrefix('**Arguments:** We decided to use X'),
    'We decided to use X',
  );
  assert.equal(stripMetadataPrefix('Arguments: We decided to use X'), 'We decided to use X');
  assert.equal(stripMetadataPrefix('**Command:** git status'), 'git status');
  assert.equal(stripMetadataPrefix('**Exit code:** 0'), '0');
  // A line with no metadata label is returned unchanged.
  assert.equal(stripMetadataPrefix('We decided to use X'), 'We decided to use X');
});

test('repair: strips metadata prefix before repairing the content', () => {
  assert.equal(
    repairMemoryText('**Arguments:** We decided to use project-local .clino storage'),
    'Use project-local .clino storage.',
  );
  assert.equal(
    repairMemoryText('Arguments: We decided to use project-local .clino storage'),
    'Use project-local .clino storage.',
  );
  assert.equal(
    repairMemoryText('We decided to use project-local .clino storage'),
    'Use project-local .clino storage.',
  );
});

test('dogfood: plain sentence -> clean decision + todo', () => {
  const signals = extractSignals(
    'We decided to use project-local .clino storage and need to add clino status command',
  );
  assert.deepEqual(signals.decisions, ['Use project-local .clino storage.']);
  assert.deepEqual(signals.todos, ['Add clino status command.']);
  // No "**Arguments:**" or "We decided to use..." leaks into stored memory.
  for (const list of Object.values(signals)) {
    for (const m of list) {
      assert.doesNotMatch(m, /\*\*|arguments/i);
      assert.doesNotMatch(m, /^we decided to use/i);
    }
  }
});

test('dogfood: transcript-style "**Arguments:**" line -> same clean memory', () => {
  const signals = extractSignals(
    '**Arguments:** We decided to use project-local .clino storage and need to add clino status command',
  );
  assert.deepEqual(signals.decisions, ['Use project-local .clino storage.']);
  assert.deepEqual(signals.todos, ['Add clino status command.']);
});

test('dogfood: full transcript dedupes header line against the body line', () => {
  // Mirrors a real session file: a metadata header plus the echoed transcript.
  const transcript = [
    '# Coding Agent Session',
    '',
    '**Agent:** echo',
    '**Arguments:** We decided to use project-local .clino storage and need to add clino status command',
    '**Started:** 2026-05-25T00-00-00-000Z',
    '**Exit code:** 0',
    '',
    '## Transcript',
    '',
    '```',
    'We decided to use project-local .clino storage and need to add clino status command',
    '```',
  ].join('\n');
  const signals = extractSignals(transcript);
  // The junk-vs-clean subsume bug used to keep the polluted version; now the
  // header and body collapse to one clean memory each.
  assert.deepEqual(signals.decisions, ['Use project-local .clino storage.']);
  assert.deepEqual(signals.todos, ['Add clino status command.']);
});

test('dogfood: focus areas exclude metadata/junk words', () => {
  const signals = extractSignals(
    'We decided to use project-local .clino storage and need to add clino status command',
  );
  const summary = synthesizeSummary(signals);
  assert.match(summary, /1 decision and 1 TODO/);
  // Hard requirement: no metadata/junk focus terms.
  for (const junk of ['arguments', 'decided', 'project', 'local', 'command', 'exit']) {
    assert.doesNotMatch(summary, new RegExp(junk, 'i'), `focus areas must not include "${junk}"`);
  }
  // Meaningful terms survive.
  assert.match(summary, /Clino/);
  assert.match(summary, /storage/i);
});

// --------------------------------------------------------------------------
// 8. Dogfood regression: terminal UI/control-code noise must not become memory
// --------------------------------------------------------------------------
test('cleaning: strips ANSI/control noise and Codex UI chrome before extraction', () => {
  const dirty = [
    '10;rgb:ffff/ffff/ffff11;rgb:3c95/3c95/3c95',
    '\x1b[39;49m\x1b[K Tip: New Use /fast to enable our fastest inference with increased plan usage.\x1b[0m',
    'Select Model and Effort',
    'Access legacy models by running codex -m <model_name> or in your config.toml',
    'OpenAI Codex',
    'model: gpt-5.5 xhigh',
    'directory: ~/Desktop/clino',
    '╭───────────────────────────────────────╮',
    '╰───────────────────────────────────────╯',
  ].join('\n');

  const cleaned = cleanTranscriptForExtraction(dirty);
  assert.equal(cleaned.trim(), '');
});

test('dogfood: exact bad transcript snippets produce no memories or focus areas', () => {
  const bad = [
    '10;rgb:ffff/ffff/ffff11;rgb:3c95/3c95/3c95',
    'Tip: New Use /fast to enable our fastest inference with increased plan usage.',
    'Select Model and Effort',
    '• I’ve got the main content; I’m doing one quick pass on the remaining lines to.',
    'Net: strong alignment and mostly clear docs, with one concrete quality issue.',
  ].join('\n');

  const signals = extractSignals(bad);
  assert.deepEqual(signals.decisions, []);
  assert.deepEqual(signals.todos, []);
  assert.deepEqual(signals.bugs, []);
  assert.deepEqual(signals.errors, []);

  const summary = synthesizeSummary(signals);
  for (const junk of ['49m', '1mTip', '22m', '3mNew', '23m', 'Fast', 'quality issue']) {
    assert.doesNotMatch(summary, new RegExp(junk, 'i'));
  }
});

test('classification: rejects process narration but keeps concrete project bugs', () => {
  assert.deepEqual(extractSignals('I’ll read README.md and GUARDRAILS.md directly.').todos, []);
  assert.deepEqual(
    extractSignals('I’ve got the main content; I’m doing one quick pass on the remaining lines to.').todos,
    [],
  );
  assert.deepEqual(
    extractSignals('Net: strong alignment and mostly clear docs, with one concrete quality issue.').bugs,
    [],
  );
  assert.deepEqual(extractSignals('I’ll fix Redis blacklist bug.').bugs, [
    'Fix Redis blacklist bug.',
  ]);

  const signals = extractSignals(
    [
      'GUARDRAILS.md is directionally strong and aligned with the same boundaries,',
      'but it appears incomplete/truncated: it ends at line 79 with an unclosed code',
      'fence and no closing sections (see GUARDRAILS.md:73). That hurts clarity and',
      'makes it feel unfinished as a source of truth.',
    ].join('\n'),
  );
  assert.equal(signals.bugs.length, 1);
  assert.match(signals.bugs[0], /GUARDRAILS\.md/);
  assert.match(signals.bugs[0], /unclosed code fence/);

  const summary = synthesizeSummary(signals);
  for (const weak of ['directionally', 'strong', 'aligned', 'same', 'boundaries']) {
    assert.doesNotMatch(summary, new RegExp(`\\b${weak}\\b`, 'i'));
  }
  assert.match(summary, /GUARDRAILS\.md/);
  assert.match(summary, /code fence|documentation/i);
});

// --------------------------------------------------------------------------
// 9. Codex intro / login / auth blob rejection (block-level cleaning)
// --------------------------------------------------------------------------

// A real dogfood failure: the Codex intro/login screen arrives as ONE compacted
// blob (no whitespace, ASCII/TUI noise, login text glued together). Line-oriented
// cleaning let it through, and extraction minted fake decisions/todos/bugs.

test('codex blob: compacted intro/login blob yields no cleaned text or memories', () => {
  const blob =
    "_._:=+===+,_ WelcometoCodex,OpenAI'scommand-linecodingagent" +
    'SigninwithChatGPTtouseCodexaspartofyourpaidplanorconnectanAPIkeyforusage-basedbilling' +
    '> 1. Sign in with ChatGPT Usage included with Plus, Pro, Business, and Enterprise plans' +
    '2.SigninwithDeviceCode Sign in from another device with a one-time code' +
    '3.ProvideyourownAPIkey Pay for what you use Press enter to continue';

  const cleaned = cleanTranscriptForExtraction(blob);
  assert.doesNotMatch(cleaned, /Welcome to Codex/i);
  assert.doesNotMatch(cleaned, /Sign in with ChatGPT/i);
  assert.doesNotMatch(cleaned, /Device Code/i);
  assert.doesNotMatch(cleaned, /Provide your own API key/i);
  assert.doesNotMatch(cleaned, /WelcometoCodex/i);

  const signals = extractSignals(blob);
  assert.deepEqual(signals.decisions, []);
  assert.deepEqual(signals.todos, []);
  assert.deepEqual(signals.bugs, []);
  assert.deepEqual(signals.errors, []);
  assert.deepEqual(signals.resolved, []);
  assert.equal(synthesizeSummary(signals), '');
});

test('codex blob: embedded OAuth/auth URL is redacted and yields no memories', () => {
  const blob =
    'Welcome to Codex Finish signing in via your browser ' +
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_TEST' +
    '&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback' +
    '&code_challenge=SECRET&state=SECRET';

  const cleaned = cleanTranscriptForExtraction(blob);
  assert.doesNotMatch(cleaned, /auth\.openai\.com/i);
  assert.doesNotMatch(cleaned, /oauth/i);
  assert.doesNotMatch(cleaned, /code_challenge/i);
  assert.doesNotMatch(cleaned, /state=/i);
  assert.doesNotMatch(cleaned, /client_id/i);
  assert.doesNotMatch(cleaned, /redirect_uri/i);

  const signals = extractSignals(blob);
  for (const list of Object.values(signals)) assert.deepEqual(list, []);
});

test('codex blob: fully compacted no-space login text yields no memories', () => {
  const blob =
    'WelcometoCodexOpenAIcommandlinecodingagentSigninwithChatGPT' +
    'SigninwithDeviceCodeProvideyourownAPIkeyPressentertocontinue';

  const signals = extractSignals(blob);
  for (const list of Object.values(signals)) assert.deepEqual(list, []);
  assert.equal(synthesizeSummary(signals), '');
});

test('codex blob: auth markers never survive even when glued into kept prose', () => {
  // The URL is glued directly onto a real sentence with no separating space, so
  // the chunk is not pure login chrome — redaction must still scrub the markers.
  const line =
    'We decided to use project-local storage seehttps://auth.openai.com/oauth/authorize?client_id=x&state=y';
  const cleaned = cleanTranscriptForExtraction(line);
  assert.doesNotMatch(cleaned, /auth\.openai\.com/i);
  assert.doesNotMatch(cleaned, /oauth/i);
  assert.doesNotMatch(cleaned, /client_id/i);
  assert.doesNotMatch(cleaned, /state=/i);
});

test('codex blob: a real decision adjacent to a login blob still survives', () => {
  const transcript = [
    "WelcometoCodex,OpenAI'scommand-linecodingagentSigninwithChatGPT",
    'We decided to use project-local .clino storage.',
  ].join('\n');
  const signals = extractSignals(transcript);
  assert.deepEqual(signals.decisions, ['Use project-local .clino storage.']);
});

test('quality: hard-rejects candidates whose compact form is Codex auth noise', () => {
  assert.equal(isQualityMemory('Welcome to Codex, sign in with ChatGPT.', 'decisions'), false);
  assert.equal(isQualityMemory('Provide your own API key for usage-based billing.', 'decisions'), false);
  assert.equal(isQualityMemory('Finish signing in via your browser.', 'todos'), false);
  // Regression guard: "stateless" must NOT be mistaken for the OAuth "state" param.
  assert.equal(isQualityMemory('Use JWT auth because it is stateless.', 'decisions'), true);
});

test('codex blob: compacted slash-command MENU blob yields no cleaned text or memories', () => {
  // The Codex command menu, glued into one compacted line (the line-oriented
  // isTerminalUiLine check only catches it when it starts a line by itself).
  const menu =
    '─ Worked for 6m 51s › / /model choose what model and reasoning effort to use' +
    '/fast1.5x speed, increased usage/ideinclude current selection, open files' +
    '/permissionschoose what Codex is allowed to do/keymapremap TUI shortcuts' +
    '/vimtoggle Vim mode for the composer/compact summarize conversation to prevent ' +
    'hitting the context limit gpt-5.5 xhigh · ~/Desktop/clino';

  const cleaned = cleanTranscriptForExtraction(menu);
  assert.doesNotMatch(cleaned, /choose what model/i);
  assert.doesNotMatch(cleaned, /remap TUI/i);

  const signals = extractSignals(menu);
  for (const list of Object.values(signals)) assert.deepEqual(list, []);
});

test('codex blob: compacted session-chrome / spinner blob yields no memories', () => {
  const chrome =
    'To continue this session, run codex resume 019e5cd9-6281-7bc0-800b-f7c93a637342' +
    '•Booting MCP server: codex_apps(0s • esc to interrupt)' +
    '•Waiting for background terminal(3m 48s • esc to interrupt)';

  const cleaned = cleanTranscriptForExtraction(chrome);
  assert.doesNotMatch(cleaned, /codex resume/i);
  assert.doesNotMatch(cleaned, /Booting MCP server/i);
  assert.doesNotMatch(cleaned, /esc to interrupt/i);

  const signals = extractSignals(chrome);
  for (const list of Object.values(signals)) assert.deepEqual(list, []);
});

test('compactForUiMatch: strips whitespace/punctuation, preserves letters/numbers', () => {
  assert.equal(
    compactForUiMatch("Welcome to Codex, OpenAI's command-line coding agent"),
    'welcometocodexopenaiscommandlinecodingagent',
  );
  const compact = compactForUiMatch(
    "WelcometoCodex,OpenAI'scommand-linecodingagentSigninwithChatGPT",
  );
  assert.ok(compact.includes('welcometocodex'));
  assert.ok(compact.includes('signinwithchatgpt'));
  assert.ok(compactForUiMatch('ProvideyourownAPIkey').includes('provideyourownapikey'));
});
