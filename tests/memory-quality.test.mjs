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
  stripTranscriptMetadata,
  cleanTranscriptForExtraction,
  compactForUiMatch,
  isDiffOrCodeNoise,
  isClynoOutputNoise,
  isPromptRequestDirective,
  isCodexTaskChrome,
  isClaudeTaskChrome,
  isClaudeAuthNoise,
  isCursorTaskChrome,
  isRuntimeStatusChrome,
  isReviewAnalysisSummary,
  isSuspiciousCandidate,
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
    repairMemoryText('**Arguments:** We decided to use project-local .clyno storage'),
    'Use project-local .clyno storage.',
  );
  assert.equal(
    repairMemoryText('Arguments: We decided to use project-local .clyno storage'),
    'Use project-local .clyno storage.',
  );
  assert.equal(
    repairMemoryText('We decided to use project-local .clyno storage'),
    'Use project-local .clyno storage.',
  );
});

test('dogfood: plain sentence -> clean decision + todo', () => {
  const signals = extractSignals(
    'We decided to use project-local .clyno storage and need to add clyno status command',
  );
  assert.deepEqual(signals.decisions, ['Use project-local .clyno storage.']);
  assert.deepEqual(signals.todos, ['Add clyno status command.']);
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
    '**Arguments:** We decided to use project-local .clyno storage and need to add clyno status command',
  );
  assert.deepEqual(signals.decisions, ['Use project-local .clyno storage.']);
  assert.deepEqual(signals.todos, ['Add clyno status command.']);
});

test('dogfood: full transcript dedupes header line against the body line', () => {
  // Mirrors a real session file: a metadata header plus the echoed transcript.
  const transcript = [
    '# Coding Agent Session',
    '',
    '**Agent:** echo',
    '**Arguments:** We decided to use project-local .clyno storage and need to add clyno status command',
    '**Started:** 2026-05-25T00-00-00-000Z',
    '**Exit code:** 0',
    '',
    '## Transcript',
    '',
    '```',
    'We decided to use project-local .clyno storage and need to add clyno status command',
    '```',
  ].join('\n');
  const signals = extractSignals(transcript);
  // The junk-vs-clean subsume bug used to keep the polluted version; now the
  // header and body collapse to one clean memory each.
  assert.deepEqual(signals.decisions, ['Use project-local .clyno storage.']);
  assert.deepEqual(signals.todos, ['Add clyno status command.']);
});

test('dogfood: focus areas exclude metadata/junk words', () => {
  const signals = extractSignals(
    'We decided to use project-local .clyno storage and need to add clyno status command',
  );
  const summary = synthesizeSummary(signals);
  assert.match(summary, /1 decision and 1 TODO/);
  // Hard requirement: no metadata/junk focus terms.
  for (const junk of ['arguments', 'decided', 'project', 'local', 'command', 'exit']) {
    assert.doesNotMatch(summary, new RegExp(junk, 'i'), `focus areas must not include "${junk}"`);
  }
  // Meaningful terms survive.
  assert.match(summary, /Clyno/);
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
    'directory: ~/Desktop/clyno',
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
    'We decided to use project-local .clyno storage.',
  ].join('\n');
  const signals = extractSignals(transcript);
  assert.deepEqual(signals.decisions, ['Use project-local .clyno storage.']);
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
    'hitting the context limit gpt-5.5 xhigh · ~/Desktop/clyno';

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

// --------------------------------------------------------------------------
// 10. Diff / code / test-output noise rejection
//
// After the login/menu blobs were removed, the real transcript still dry-ran
// with high fake counts: git diff hunks, line-numbered patch lines, test
// assertions and test-runner output were being minted as decisions/todos/bugs.
// --------------------------------------------------------------------------

test('diff noise: glued patch hunk yields no memories', () => {
  const blob =
    '0, 0); 347 + assert.equal(stderr, ""); 348 + assert.match(stdout, /Clyno inspect/); ' +
    '349 + assert.match(stdout, /- decisions: 1/);';
  const s = extractSignals(blob);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('diff noise: git diff headers and hunk header yield no memories', () => {
  const blob = [
    'diff --git a/src/memory.ts b/src/memory.ts',
    'index 1234abc..5678def 100644',
    '--- a/src/memory.ts',
    '+++ b/src/memory.ts',
    '@@ -10,7 +10,9 @@ export function extractSignals(content) {',
  ].join('\n');
  const s = extractSignals(blob);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('diff noise: line-numbered code/declaration patch lines yield no memories', () => {
  const blob = [
    '653 +type MemoryCategory = MemoryType | "summaries";',
    "682 + { category: 'decisions', filename: 'decisions.md' },",
    '379 - assert.match(relativeResult.stdout, /Use local markdown memory/);',
  ].join('\n');
  const s = extractSignals(blob);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('diff noise: test-runner output yields no memories', () => {
  const blob = ['# tests 77', '# pass 77', '# fail 0', 'ok 1 - does a thing', 'not ok 2 - broken thing', '1..77'].join('\n');
  const s = extractSignals(blob);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('diff noise: a decision living only inside a diff string is not extracted', () => {
  const blob = '440 + "", 441 + "We decided to use JWT auth because it is stateless.", 442 + );';
  assert.deepEqual(extractSignals(blob).decisions, []);
});

test('diff noise: spinner glued to a diff/command line yields no memories', () => {
  const blob = '165 clyno find "auth bug"WWo•Wor•Work•Working•Working•Working•Working•Working';
  const s = extractSignals(blob);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('diff noise: real prose adjacent to diff/test noise still extracts', () => {
  const transcript = [
    'diff --git a/src/memory.ts b/src/memory.ts',
    '347 + assert.equal(stderr, "");',
    'We decided to use project-local .clyno storage.',
    '# pass 77',
    'Need to add clyno status command.',
  ].join('\n');
  const s = extractSignals(transcript);
  assert.deepEqual(s.decisions, ['Use project-local .clyno storage.']);
  assert.deepEqual(s.todos, ['Add clyno status command.']);
  for (const list of [s.bugs, s.errors, s.resolved]) assert.deepEqual(list, []);
});

test('diff noise: must-keep natural-language memories still extract', () => {
  assert.deepEqual(extractSignals('Fixed GUARDRAILS.md unclosed code fence.').resolved, [
    'Fixed GUARDRAILS.md unclosed code fence.',
  ]);
  assert.deepEqual(extractSignals('We decided to use project-local .clyno storage.').decisions, [
    'Use project-local .clyno storage.',
  ]);
  assert.deepEqual(extractSignals('Need to add clyno status command.').todos, ['Add clyno status command.']);
  assert.deepEqual(extractSignals('TODO: add memory delete dry-run test.').todos, [
    'Add memory delete dry-run test.',
  ]);
});

test('quality: rejects a diff/code candidate even when it carries classify keywords', () => {
  assert.equal(isQualityMemory('347 + assert.match(stdout, /fix bug/);', 'bugs'), false);
  assert.equal(isQualityMemory("{ category: 'decisions', filename: 'decisions.md' }", 'decisions'), false);
});

test('isDiffOrCodeNoise: flags diff/code/test-output, keeps natural-language prose', () => {
  for (const noise of [
    'diff --git a/x b/x',
    'index 1234abc..5678def 100644',
    '--- a/src/memory.ts',
    '+++ b/src/memory.ts',
    '@@ -1,2 +1,2 @@',
    '347 + assert.equal(stderr, "");',
    '653 +type MemoryCategory = MemoryType;',
    "{ category: 'decisions', filename: 'decisions.md' }",
    '});',
    "import { extractSignals } from '../dist/memory.js';",
    '# tests 77',
    '# pass 77',
    'ok 1 - a thing',
    'not ok 2 - broken',
    '1..77',
    'WWo•Wor•Work•Working•Working•Working•Working',
    // Single multi-digit line-number marker glued to code punctuation.
    "B[0m', does not write memory'); 460 +.",
    "Does not write memory'); 456 + } finally {.",
  ]) {
    assert.equal(isDiffOrCodeNoise(noise), true, `should be noise: ${noise}`);
  }

  for (const prose of [
    'Fixed GUARDRAILS.md unclosed code fence.',
    'We decided to use project-local .clyno storage.',
    'Need to add clyno status command.',
    'Bug: inject shows resolved GUARDRAILS issue as open.',
    'TODO: add memory delete dry-run test.',
    'GUARDRAILS.md ends with an unclosed code fence (see GUARDRAILS.md:73).',
    'npm run build',
  ]) {
    assert.equal(isDiffOrCodeNoise(prose), false, `should be prose: ${prose}`);
  }
});

// --------------------------------------------------------------------------
// 11. Prompt/spec echo, Clyno-output echo, and session/status metadata
//
// Real transcripts paste large task specs into the agent and paste Clyno's own
// command output back into the conversation. Requirement bullets, command
// examples, memory-list rows, dry-run output, and account/session/rate-limit
// chrome are instructions or tool output — never project memories.
// --------------------------------------------------------------------------

test('prompt/spec echo: a pasted task spec yields zero memories', () => {
  const spec = [
    'We are working on Clyno.',
    'Current project state:',
    'Already implemented:',
    '- clyno run',
    'Goal: Implement Phase 1A from the updated roadmap.',
    'Tasks:',
    '## 1. Add clyno --version',
    'Requirements:',
    '- Add tests.',
    '- Use the existing test style.',
    '- Update README.md to include clyno doctor.',
    'Verification:',
    '- npm test',
    '- npm run build',
    'Do not add embeddings, SQLite, GUI, cloud sync, or unrelated features.',
  ].join('\n');

  const s = extractSignals(spec);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
  assert.equal(synthesizeSummary(s), '');
});

test('prompt/spec echo: pasted-content envelope is removed from cleaned text', () => {
  const transcript = [
    '› Improve documentation [Pasted Content 1234 chars]',
    'We are working on Clyno.',
    'Goal: Implement Phase 1A from the updated roadmap.',
    'Requirements:',
    '- Add tests.',
    '- Use the existing test style.',
    '• I will inspect the code now.',
    'We decided to use project-local .clyno storage.',
  ].join('\n');

  const cleaned = cleanTranscriptForExtraction(transcript);
  assert.doesNotMatch(cleaned, /Implement Phase 1A|Add tests|existing test style/i);

  const s = extractSignals(transcript);
  assert.deepEqual(s.decisions, ['Use project-local .clyno storage.']);
});

test('clyno output echo: pasted summarize/list/delete output yields zero memories', () => {
  const out = [
    'Clyno summarize dry run',
    'Extraction counts:',
    '- decisions: 9',
    'Candidate memories:',
    'decisions (9)',
    '- Decision-1 decision Use project-local .clyno storage.',
    '- Summary-1 summary This session captured 1 decision and 1 TODO',
    'todos (10)',
    '- Todo-1 todo Add clyno status command.',
    'Final stored memories if written:',
    'bugs (15)',
    '- Bug-1 bug GUARDRAILS.md had an unclosed code fence.',
    'No memory files were written.',
  ].join('\n');

  const s = extractSignals(out);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('clyno command examples yield zero memories', () => {
  const cmds = [
    'clyno memory show decision-1',
    'clyno memory delete decision-1 --dry-run',
    'clyno find "auth bug"',
    'clyno run echo "We decided to use manual proof memory."',
    'We decided to use manual proof memory and need to add manual proof delete test.',
    'Use manual proof memory.',
  ].join('\n');

  const s = extractSignals(cmds);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('session/status metadata is cleaned out and yields zero memories', () => {
  const meta = [
    'OpenAI Codex (v0.133.0)',
    '**Agent:** codex',
    '/status',
    'Visit https://chatgpt.com/codex/settings/usage for up-to-date information on rate limits and credits',
    'Permissions: Workspace (on-request)',
    'Agents.md: <none>',
    'Account: user@example.com',
    'Collaboration mode: Default',
    'Session: 019e5cd9-6281-7bc0-800b-f7c93a637342',
    '5h limit: 37% left',
    'Weekly limit: 59% left',
    'Limits: refresh requested; run /status again shortly.',
    'codex',
  ].join('\n');

  const cleaned = stripTranscriptMetadata(cleanTranscriptForExtraction(meta));
  for (const re of [
    /account/i,
    /session\s*:/i,
    /limit\s*:/i,
    /permissions\s*:/i,
    /collaboration mode/i,
    /settings\/usage/i,
    /^codex$/im,
  ]) {
    assert.doesNotMatch(cleaned, re);
  }

  const s = extractSignals(meta);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('isClynoOutputNoise: flags clyno output rows/commands, keeps real prose', () => {
  for (const noise of [
    'decision-1 decision Use project-local .clyno storage.',
    'Decision-1 decision Use project-local .clyno storage.',
    'summary-1 summary This session captured 1 decision and 1 TODO',
    'Would delete decision-1 (decision): Use manual proof memory.',
    'Deleted decision-1 (decision): Use manual proof memory.',
    'decisions (9)',
    '- decisions: 9',
    'No memory files were written.',
    'No memories found for: "auth bug"',
    'clyno memory delete decision-1 --dry-run',
    'clyno find "auth bug"',
    'Memory extraction for decisions/todos/bugs/errors/summaries/resolved',
    'Memory show invalid ID.',
    'Memory delete invalid ID.',
    'Does not write to `.clyno/memory',
    'default and labels resolved bugs/TODOs.',
    'ID: decision-1',
    'Text: Use manual proof memory.',
  ]) {
    assert.equal(isClynoOutputNoise(noise), true, `should be clyno output: ${noise}`);
  }

  for (const prose of [
    'We decided to use project-local .clyno storage.',
    'Need to add clyno status command.',
    'TODO: add memory delete dry-run test.',
    'Bug: inject shows resolved GUARDRAILS issue as open.',
    'Decision: Clyno should keep raw transcripts unchanged and clean only before extraction.',
  ]) {
    assert.equal(isClynoOutputNoise(prose), false, `should be prose: ${prose}`);
  }
});

test('echo rejection still preserves real memories outside spec/output blocks', () => {
  assert.deepEqual(extractSignals('We decided to use project-local .clyno storage.').decisions, [
    'Use project-local .clyno storage.',
  ]);
  assert.deepEqual(extractSignals('Need to add clyno status command.').todos, [
    'Add clyno status command.',
  ]);
  assert.deepEqual(extractSignals('Fixed GUARDRAILS.md unclosed code fence.').resolved, [
    'Fixed GUARDRAILS.md unclosed code fence.',
  ]);
  assert.deepEqual(extractSignals('- Fixed GUARDRAILS.md unclosed code fence.').resolved, [
    'Fixed GUARDRAILS.md unclosed code fence.',
  ]);
  assert.deepEqual(extractSignals('TODO: add memory delete dry-run test.').todos, [
    'Add memory delete dry-run test.',
  ]);
  assert.equal(
    extractSignals(
      'Decision: Clyno should keep raw transcripts unchanged and clean only before extraction.',
    ).decisions.length,
    1,
  );
});

// The new echo/spec/status rejection must not be what blocks real prose: a
// "Bug:"-labeled sentence written as normal conversation survives cleaning and is
// not flagged as Clyno output or session chrome. (Whether it ultimately stores as
// a bug is governed by the separate bug-concreteness gate, not this layer.)
test('echo rejection leaves a "Bug:"-labeled real report untouched', () => {
  const bugLine = 'Bug: inject shows resolved GUARDRAILS issue as open.';
  assert.equal(isClynoOutputNoise(bugLine), false);
  assert.match(cleanTranscriptForExtraction(bugLine), /inject shows resolved GUARDRAILS issue as open/);
});

// Terminal redraw shreds a pasted spec so its headings get orphaned from their
// content; a few process/style directives and goal restatements then survive
// block detection as standalone lines. These are still instructions, not memory.
test('prompt/spec directives survive block-shredding but still yield no memories', () => {
  for (const line of [
    'Use the existing test style.',
    'Use existing style.',
    'Implement Phase 1A from the updated roadmap: CLI polish, --version, improved help, and clyno doctor.',
    'Implement Phase 1B: user control over memory.',
    'Add `clyno --version`.',
    'Add `clyno doctor`.',
    'Add/update tests for:',
    'Update README.md to include:',
    'Update the README with a short memory-management section.',
    'Add stable display IDs for memory items.',
    'Add a short section: Memory management:',
  ]) {
    const s = extractSignals(line);
    for (const list of Object.values(s)) assert.deepEqual(list, [], `leaked: ${line}`);
  }

  // Must-keep imperatives that look superficially similar still extract.
  assert.deepEqual(extractSignals('Use project-local .clyno storage.').decisions, [
    'Use project-local .clyno storage.',
  ]);
  assert.deepEqual(extractSignals('Add unit tests for auth module.').todos, [
    'Add unit tests for auth module.',
  ]);
  assert.deepEqual(extractSignals('Need to add clyno status command.').todos, [
    'Add clyno status command.',
  ]);
});

test('final-report spec/output headings and wrapped bullets yield zero memories', () => {
  const reportEcho = [
    'Manual Proof',
    'proof memory and need to add manual proof delete test"',
    'We decided to use manual proof memory and need to add manual proof delete test',
    'Memory',
    'Memory item',
    'Searching memory for: "manual proof memory"',
    'The manual proof succeeded in /tmp/clyno-manual-a0txYU: the decision item was listed.',
    'Known Limitations',
    '- --include-resolved is accepted, but memory list already shows resolved items by',
    'default and labels resolved bugs/TODOs.',
  ].join('\n');

  const s = extractSignals(reportEcho);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
});

test('bare file-path lines are diff/code noise, prose mentioning a file is not', () => {
  for (const line of ['.clyno/memory/bugs.md', 'src/memory.ts', 'tests/storage.test.mjs']) {
    assert.equal(isDiffOrCodeNoise(line), true, `should be noise: ${line}`);
  }
  assert.equal(isDiffOrCodeNoise('Fixed GUARDRAILS.md unclosed code fence.'), false);
  assert.equal(isDiffOrCodeNoise('Need to add clyno status command.'), false);
});

test('real memory adjacent to a spec block still extracts', () => {
  const transcript = [
    'Requirements:',
    '- Add tests.',
    '- Use the existing test style.',
    'We decided to use project-local .clyno storage.',
    '## 2. clyno doctor',
    '- Diagnose setup issues.',
    'Need to add clyno status command.',
  ].join('\n');

  const s = extractSignals(transcript);
  assert.deepEqual(s.decisions, ['Use project-local .clyno storage.']);
  assert.deepEqual(s.todos, ['Add clyno status command.']);
  for (const list of [s.bugs, s.errors, s.resolved]) assert.deepEqual(list, []);
});

// --------------------------------------------------------------------------
// 8. Review-mode dogfood: prompt instructions, analysis, Codex chrome
// --------------------------------------------------------------------------
test('extract: rejects pasted review prompt instructions', () => {
  const prompt =
    'Review the current Clyno MVP from README.md, ROADMAP.md, and GUARDRAILS.md. Do not edit files. Identify the top 3 remaining MVP risks and the smallest next fixes.';
  const s = extractSignals(prompt);
  assert.deepEqual(s.todos, []);
  assert.deepEqual(s.bugs, []);
  assert.deepEqual(s.decisions, []);
  assert.deepEqual(s.resolved, []);
  assert.deepEqual(s.errors, []);
});

test('extract: review conclusion is not classified as a bug', () => {
  const line = 'Based on the docs, the MVP is close on positioning but still has three material gaps.';
  assert.equal(isReviewAnalysisSummary(line), true);
  const s = extractSignals(line);
  assert.deepEqual(s.bugs, []);
});

test('extract: concrete Bug: prefix and doc defects still extract as bugs', () => {
  assert.deepEqual(
    extractSignals('Bug: clyno run --review writes memory before review.').bugs,
    ['Clyno run --review writes memory before review.'],
  );
  assert.deepEqual(
    extractSignals('GUARDRAILS.md has an unclosed code fence.').bugs,
    ['GUARDRAILS.md has an unclosed code fence.'],
  );
});

test('extract: Codex task chrome is rejected and stripped', () => {
  const contaminated =
    'Based on the docs, the MVP is close on positioning but still has three material gaps: › Find and fix a bug in @filename gpt-5.4-mini medium · ~/Desktop/clyno';
  const s = extractSignals(contaminated);
  assert.deepEqual(s.bugs, []);
  for (const list of Object.values(s)) {
    for (const item of list) {
      assert.doesNotMatch(item, /gpt-5\.4-mini/i);
      assert.doesNotMatch(item, /find and fix a bug/i);
    }
  }
});

test('prompt-request filter keeps real project TODOs', () => {
  for (const line of [
    'Add a manual memory review workflow.',
    'Add clyno status command.',
    'Add memory delete dry-run test.',
    'Fix inject showing resolved bugs as open.',
  ]) {
    assert.equal(isPromptRequestDirective(line), false, line);
  }
  const s = extractSignals(
    [
      'Add a manual memory review workflow.',
      'Need to add clyno status command.',
      'TODO: add memory delete dry-run test.',
      'Bug: inject shows resolved GUARDRAILS issue as open.',
    ].join('\n'),
  );
  assert.ok(s.todos.length >= 2);
  assert.ok(s.bugs.length >= 1);
});

test('suspicious candidate heuristic flags prompt-like survivors', () => {
  assert.equal(
    isSuspiciousCandidate('Identify the top 3 remaining MVP risks and the smallest next fixes.', 'todos'),
    true,
  );
  assert.equal(isSuspiciousCandidate('Add clyno status command.', 'todos'), false);
  assert.equal(isSuspiciousCandidate('This session captured 1 decision.', 'summaries'), true);
  assert.equal(
    isSuspiciousCandidate('This session captured 1 decision. Focus areas: JWT, Auth.', 'summaries'),
    false,
  );
});

test('summary focus areas omit review filler terms', () => {
  const signals = extractSignals(
    'Based on the docs, the MVP is close on positioning but still has three material gaps in README.md and GUARDRAILS.md.',
  );
  const summary = synthesizeSummary(signals);
  if (summary) {
    for (const junk of ['Based', 'Has', 'Positioning']) {
      assert.doesNotMatch(summary, new RegExp(`Focus areas:.*\\b${junk}\\b`));
    }
  }
});

// --------------------------------------------------------------------------
// 9. Claude Code UI/login/skills chrome (dogfood regression)
// --------------------------------------------------------------------------
test('extract: Claude Code login/skills/help UI yields zero memories', () => {
  const claudeUi = [
    'Use when building multi-platform chat bots',
    'Use when configuring model routing, provide',
    'Use when deploying, promoting, ro',
    'Use the url below to sign in (c to copy)',
    'Use when asked to run, star',
    'Update-config Use this skill to configure the Claue Code',
    'Add-di Ad anew workingdirectory',
    'Efies bugs in your branch',
    '/code-review Review the current diff for correctness bugs',
    '● Remote Control failed to connect: /login',
    'Remote Control failed · /login',
    'Please run /login · API Error: 401 Invalid authentication credentials',
  ].join('\n');

  const s = extractSignals(claudeUi);
  assert.deepEqual(s.decisions, []);
  assert.deepEqual(s.todos, []);
  assert.deepEqual(s.bugs, []);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.resolved, []);
  assert.equal(synthesizeSummary(s), '');
});

test('extract: compacted Claude Code UI blob yields zero memories', () => {
  const compact =
    'UsewhenbuildingmultiplatformchatbotsUsetheurlbelowtosigninUpdateconfigUsethisskilltoconfiguretheClaueCodeRemoteControlfailedloginAPIError401Invalidauthenticationcredentials';
  const s = extractSignals(compact);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
  assert.equal(synthesizeSummary(s), '');
});

test('extract: real project bug/todo/error survive Claude UI filtering', () => {
  assert.deepEqual(
    extractSignals('Bug: clyno review accepts Claude login UI as memory.').bugs,
    ['Clyno review accepts Claude login UI as memory.'],
  );
  const npm = extractSignals('npm test failed with exit code 1.');
  assert.equal(npm.errors.length + npm.bugs.length, 1);
  assert.deepEqual(
    extractSignals('TODO: add Claude Code UI filtering.').todos,
    ['Add Claude Code UI filtering.'],
  );
});

test('claude auth noise is never stored as errors', () => {
  assert.equal(
    isClaudeAuthNoise('Please run /login · API Error: 401 Invalid authentication credentials'),
    true,
  );
  assert.equal(isClaudeAuthNoise('npm test failed with exit code 1.'), false);
  assert.equal(isClaudeTaskChrome('Use when building multi-platform chat bots'), true);
  assert.equal(isClaudeTaskChrome('Bug: clyno review accepts Claude login UI as memory.'), false);
  assert.equal(isClaudeTaskChrome('TODO: add Claude Code UI filtering.'), false);
});

test('summary focus areas omit Claude Code UI terms', () => {
  const claudeUi = [
    'Use when building multi-platform chat bots',
    'Use when configuring model routing, provide',
    'Remote Control failed · /login',
  ].join('\n');
  const s = extractSignals(claudeUi);
  const summary = synthesizeSummary(s);
  assert.equal(summary, '');
});

// --------------------------------------------------------------------------
// 13. Cursor Agent TUI/chrome rejection (dogfood regression)
// --------------------------------------------------------------------------

test('cursor chrome: cleaned transcript is empty for Cursor Agent UI noise', () => {
  const bad = [
    'Cursor Agent',
    'v2026.05.24-dda726e',
    'Use /mcp to connect Cursor to your tools and data sources.',
    '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
    '→ Plan, search, build anything',
    '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
    'Auto Auto-run',
    '~/Desktop/clyno · master',
    '⠘⠆ Working',
    '→ Add a follow-up ctrl+c to stop',
  ].join('\n');

  const cleaned = cleanTranscriptForExtraction(bad);
  assert.equal(cleaned.trim(), '');

  const signals = extractSignals(bad);
  assert.deepEqual(signals.decisions, []);
  assert.deepEqual(signals.todos, []);
  assert.deepEqual(signals.bugs, []);
  assert.deepEqual(signals.errors, []);
  assert.deepEqual(signals.resolved, []);

  const summary = synthesizeSummary(signals);
  assert.equal(summary, '');
});

test('cursor chrome: real project memory survives adjacent cursor UI noise', () => {
  const transcript = [
    'Cursor Agent',
    'v2026.05.24-dda726e',
    'Use /mcp to connect Cursor to your tools and data sources.',
    'We decided to use project-local .clyno storage.',
    '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
    'Need to add clyno status command.',
  ].join('\n');

  const signals = extractSignals(transcript);
  assert.deepEqual(signals.decisions, ['Use project-local .clyno storage.']);
  assert.deepEqual(signals.todos, ['Add clyno status command.']);
  for (const list of [signals.bugs, signals.errors, signals.resolved]) assert.deepEqual(list, []);
});

test('cursor chrome: isCursorTaskChrome detects MCP/connect phrases', () => {
  assert.equal(isCursorTaskChrome('Use /mcp to connect Cursor to your tools and data sources.'), true);
  assert.equal(isCursorTaskChrome('/mcp setup'), true);
  assert.equal(isCursorTaskChrome('Use project-local .clyno storage.'), false);
  assert.equal(isCursorTaskChrome('Need to add clyno status command.'), false);
});

test('cursor chrome: prompt template placeholders are dropped', () => {
  const transcript = [
    'CLYNO_MEMORY:',
    'Decision: ...',
    'TODO: ...',
    'Bug: ...',
    'Resolved: ...',
    'Only include concrete long-term project memory. Do not include general commentary.',
    '',
    'Decision: Use project-local .clyno storage.',
    'TODO: Add manual memory review workflow.',
  ].join('\n');

  const cleaned = cleanTranscriptForExtraction(transcript);
  assert.doesNotMatch(cleaned, /CLYNO_MEMORY/);
  assert.doesNotMatch(cleaned, /Decision: \.\.\./);
  assert.doesNotMatch(cleaned, /TODO: \.\.\./);
  assert.doesNotMatch(cleaned, /Bug: \.\.\./);
  assert.doesNotMatch(cleaned, /Resolved: \.\.\./);
  assert.doesNotMatch(cleaned, /Only include concrete/);

  // Real memories must survive.
  assert.match(cleaned, /Use project-local \.clyno storage/);
  assert.match(cleaned, /Add manual memory review workflow/);

  const signals = extractSignals(transcript);
  assert.deepEqual(signals.decisions, ['Use project-local .clyno storage.']);
  assert.deepEqual(signals.todos, ['Add manual memory review workflow.']);
});

test('cursor chrome: slash-command help is rejected as candidate', () => {
  // These should produce zero memories.
  const slashCommands = [
    '/mcp Use /mcp to connect Cursor to your tools and data sources.',
    '/finishing-a-development-branch Use when implementation is complete, all tests pass, and you need to….',
  ].join('\n');
  const s1 = extractSignals(slashCommands);
  for (const list of Object.values(s1)) assert.deepEqual(list, []);

  // Normal "use" sentences must NOT be rejected.
  assert.equal(isQualityMemory('Use PTY/terminal I/O only for agent integration.', 'decisions'), true);
  assert.equal(isQualityMemory('Use markdown memory files for MVP storage.', 'decisions'), true);
  assert.equal(isQualityMemory('Use project-local .clyno storage.', 'decisions'), true);
});

test('cursor chrome: spinner contamination is repaired', () => {
  const repaired = repairMemoryText(
    'Default clyno inject limits are 8 items and 6000 characters; ranking prefers exact matches, ⠘⠆ Working 11k tokens.',
  );
  // Should be cleaned up — the spinner/token suffix removed.
  assert.doesNotMatch(repaired, /Working/);
  assert.doesNotMatch(repaired, /⠘⠆/);
  assert.doesNotMatch(repaired, /tokens/);
  // Core content preserved.
  assert.match(repaired, /Default clyno inject limits/);
  assert.match(repaired, /ranking prefers exact matches/);
});

test('cursor chrome: compact Cursor UI blob yields no memories', () => {
  const compact =
    'CursorAgentv20260524dda726eUseMCPtoconnectCursortoyourtoolsanddatasources' +
    'PlanearchbuildanythingAutoAutorunWorking11ktokens';
  const s = extractSignals(compact);
  for (const list of Object.values(s)) assert.deepEqual(list, []);
  assert.equal(synthesizeSummary(s), '');
});

// --------------------------------------------------------------------------
// 14. Runtime status / progress chrome filtering
// --------------------------------------------------------------------------

test('runtime status chrome: isRuntimeStatusChrome detects auto-run patterns', () => {
  // Must detect.
  assert.equal(isRuntimeStatusChrome('Auto · 7.3% Auto-run'), true);
  assert.equal(isRuntimeStatusChrome('Auto · 100% Auto-run'), true);
  assert.equal(isRuntimeStatusChrome('7.3% Auto-run'), true);
  assert.equal(isRuntimeStatusChrome('⠠⠜ Working'), true);
  assert.equal(isRuntimeStatusChrome('⠠⠜ Working 32 tokens'), true);
  assert.equal(isRuntimeStatusChrome('⠰⠰ Reading'), true);
  // Must NOT detect real prose.
  assert.equal(isRuntimeStatusChrome('Use project-local .clyno storage.'), false);
  assert.equal(isRuntimeStatusChrome('Need to add clyno status command.'), false);
  assert.equal(isRuntimeStatusChrome('Fixed GUARDRAILS.md unclosed code fence.'), false);
  assert.equal(isRuntimeStatusChrome('We decided to use JWT auth.'), false);
});

test('runtime status chrome: standalone auto-run lines are cleaned', () => {
  const bad = [
    'Auto · 7.3% Auto-run',
    '7.3% Auto-run',
    '⠠⠜ Working',
    '⠰⠰ Working 32 tokens',
    '⠘⠣ Reading',
  ].join('\n');

  const cleaned = cleanTranscriptForExtraction(bad);
  assert.equal(cleaned.trim(), '');

  const signals = extractSignals(bad);
  for (const list of Object.values(signals)) assert.deepEqual(list, []);

  assert.equal(synthesizeSummary(signals), '');
});

test('runtime status chrome: real memory adjacent to runtime status still extracts', () => {
  const transcript = [
    'Auto · 7.3% Auto-run',
    'We decided to use project-local .clyno storage.',
    '⠠⠜ Working',
    'Need to add clyno status command.',
    '⠰⠰ Reading',
  ].join('\n');

  const signals = extractSignals(transcript);
  assert.deepEqual(signals.decisions, ['Use project-local .clyno storage.']);
  assert.deepEqual(signals.todos, ['Add clyno status command.']);
  for (const list of [signals.bugs, signals.errors, signals.resolved]) assert.deepEqual(list, []);
});

test('runtime status chrome: trailing auto-run contamination is repaired', () => {
  const repaired = repairMemoryText(
    'Default clyno inject limits are 8 items and 6000 characters; ranking prefers exact matches, Auto · 7.3% Auto-run.',
  );
  // The auto-run suffix must be stripped.
  assert.doesNotMatch(repaired, /Auto-run/);
  assert.doesNotMatch(repaired, /auto\s*·\s*7\.3%/i);
  // Core content preserved.
  assert.match(repaired, /Default clyno inject limits/);
  assert.match(repaired, /ranking prefers exact matches/);
});

test('runtime status chrome: inline contamination in extract is rejected', () => {
  const contaminated =
    'thinking about limits, Auto · 7.3% Auto-run, and ranking';
  // Does not survive extraction.
  const signals = extractSignals(contaminated);
  for (const list of Object.values(signals)) assert.deepEqual(list, []);
});

// --------------------------------------------------------------------------
// 20. Resolution matching — false-positive suppression (tight matching)
// --------------------------------------------------------------------------
test('memoryResolvesItem: resolves own exact text', () => {
  const open = 'Add a manual memory review workflow.';
  const resolved = 'Resolved: Add a manual memory review workflow.';
  assert.equal(memoryResolvesItem(open, resolved), true);
});

test('memoryResolvesItem: resolves close variant without articles', () => {
  assert.equal(memoryResolvesItem('Add manual memory review workflow.', 'Resolved: Add a manual memory review workflow.'), true);
});

test('memoryResolvesItem: resolves variant without generic prefix', () => {
  assert.equal(memoryResolvesItem('Manual memory review workflow.', 'Resolved: Add a manual memory review workflow.'), true);
});

test('memoryResolvesItem: does NOT match unrelated todo sharing generic words', () => {
  const open = 'Add secret detection before any future Git memory export/commit workflow.';
  const resolved = 'Resolved: Add a manual memory review workflow.';
  assert.equal(memoryResolvesItem(open, resolved), false);
});

test('memoryResolvesItem: does NOT match other memory-item todos', () => {
  const resolved = 'Resolved: Add a manual memory review workflow.';
  assert.equal(memoryResolvesItem('Add memory delete dry-run test.', resolved), false);
  assert.equal(memoryResolvesItem('Add Git memory export workflow.', resolved), false);
  assert.equal(memoryResolvesItem('Add clyno status command.', resolved), false);
});

test('memoryResolvesItem: does NOT match unrelated resolved items', () => {
  const openBug = 'GUARDRAILS.md is incomplete/truncated: it ends with an unclosed code fence.';
  assert.equal(memoryResolvesItem(openBug, 'Fixed unrelated Redis blacklist bug.'), false);
});

// --------------------------------------------------------------------------
// 21. Resolution matching — positive matching (guardrails code fence etc.)
// --------------------------------------------------------------------------
test('memoryResolvesItem: closes guardrails code fence bug', () => {
  const openBug = 'GUARDRAILS.md is incomplete/truncated: it ends with an unclosed code fence.';
  const resolved = 'Fixed GUARDRAILS.md unclosed code fence.';
  assert.equal(memoryResolvesItem(openBug, resolved), true);
});

test('memoryResolvesItem: fix guardrails variant also matches', () => {
  assert.equal(memoryResolvesItem('Fix GUARDRAILS.md unclosed code fence.', 'Fixed GUARDRAILS.md unclosed code fence.'), true);
});

test('memoryResolvesItem: documentation todo not suppressed by different bug', () => {
  const resolved = 'Fixed GUARDRAILS.md unclosed code fence.';
  assert.equal(memoryResolvesItem('Add GUARDRAILS.md documentation section.', resolved), false);
});

test('memoryResolvesItem: secret detection stays open when only manual review is resolved', () => {
  const openItems = [
    'Add a manual memory review workflow.',
    'Add secret detection before any future Git memory export/commit workflow.',
    'Add clyno status command.',
    'Add memory delete dry-run test.',
  ];
  const resolved = 'Resolved: Add a manual memory review workflow.';
  const matched = openItems.filter((o) => memoryResolvesItem(o, resolved));
  assert.deepEqual(matched, ['Add a manual memory review workflow.']);
});

test('memoryResolvesItem: inject secret detection should show open todos', () => {
  // Simulating: inject "secret detection" should still show secret detection as open
  const openItems = [
    'Add a manual memory review workflow.',
    'Add secret detection before any future Git memory export/commit workflow.',
    'Add clyno status command.',
    'Add memory delete dry-run test.',
  ];
  const resolved = 'Resolved: Add a manual memory review workflow.';
  const openTodos = openItems.filter((o) => !memoryResolvesItem(o, resolved));
  assert.ok(openTodos.includes('Add secret detection before any future Git memory export/commit workflow.'));
  assert.ok(!openTodos.includes('Add a manual memory review workflow.'));
  assert.equal(openTodos.length, 3);
});

test('memoryResolvesItem: inject memory review should show resolved', () => {
  // Simulating: inject "memory review" — manual review is resolved, others stay open
  const openItems = [
    'Add a manual memory review workflow.',
    'Add secret detection before any future Git memory export/commit workflow.',
  ];
  const resolved = 'Resolved: Add a manual memory review workflow.';
  const suppressed = openItems.filter((o) => memoryResolvesItem(o, resolved));
  assert.deepEqual(suppressed, ['Add a manual memory review workflow.']);
});
