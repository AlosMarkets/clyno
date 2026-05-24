#!/usr/bin/env node

import { spawn } from 'node-pty';
import { Writable } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Text normalization function for memory deduplication
function normalizeMemoryText(text: string): string {
  // lowercase
  let normalized = text.toLowerCase();
  // trim whitespace
  normalized = normalized.trim();
  // collapse repeated spaces
  normalized = normalized.replace(/\s+/g, ' ');
  // remove repeated punctuation (keep one instance)
  normalized = normalized.replace(/([!?.]){2,}/g, '$1');
  // remove markdown bullet prefixes
  normalized = normalized.replace(/^[\-\*]\s+/, '');
  // normalize quotes
  normalized = normalized.replace(/['"«»„“”]/g, "'");
  // remove trailing periods for comparison
  normalized = normalized.replace(/\.+$/, '');
  
  return normalized;
}

// Fuzzy deduplication using Dice coefficient
function fuzzyDedupe(items: string[], threshold: number = 0.85): string[] {
  if (items.length <= 1) return items;
  
  const normalizedItems = items.map(item => normalizeMemoryText(item));
  const toKeep: boolean[] = new Array(items.length).fill(true);
  
  // Compare each pair of items
  for (let i = 0; i < normalizedItems.length; i++) {
    if (!toKeep[i]) continue;
    
    for (let j = i + 1; j < normalizedItems.length; j++) {
      if (!toKeep[j]) continue;
      
      const similarity = diceCoefficient(normalizedItems[i], normalizedItems[j]);
      if (similarity >= threshold) {
        // Keep the longer item (more information)
        toKeep[j] = items[j].length > items[i].length;
        if (!toKeep[j]) toKeep[i] = false;
      }
    }
  }
  
  return items.filter((_, index) => toKeep[index]);
}

// Dice coefficient for string similarity
function diceCoefficient(str1: string, str2: string): number {
  const bigrams1 = getBigrams(str1);
  const bigrams2 = getBigrams(str2);
  
  if (bigrams1.length === 0 && bigrams2.length === 0) return 1.0;
  if (bigrams1.length === 0 || bigrams2.length === 0) return 0.0;
  
  const intersection = bigrams1.filter(bg => bigrams2.includes(bg)).length;
  return (2.0 * intersection) / (bigrams1.length + bigrams2.length);
}

// Get bigrams from a string
function getBigrams(str: string): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.push(str.substring(i, i + 2));
  }
  return bigrams;
}

// Subsume shorter memories that are substrings of longer ones in the same list
function subsumeMemories(memories: string[]): string[] {
  if (memories.length <= 1) return memories;

  const normalized = memories.map(m => normalizeMemoryText(m));
  const toKeep: boolean[] = new Array(memories.length).fill(true);

  for (let i = 0; i < memories.length; i++) {
    if (!toKeep[i]) continue;
    for (let j = i + 1; j < memories.length; j++) {
      if (!toKeep[j]) continue;
      // If memory i is a substring of memory j and i is shorter, remove i
      if (normalized[i].length < normalized[j].length && normalized[j].includes(normalized[i])) {
        toKeep[i] = false;
        break;
      }
      // If memory j is a substring of memory i and j is shorter, remove j
      if (normalized[j].length < normalized[i].length && normalized[i].includes(normalized[j])) {
        toKeep[j] = false;
      }
    }
  }

  return memories.filter((_, index) => toKeep[index]);
}

// Generate tags based on content and type
function generateTags(items: string[], type: string): string[] {
  const tagSet = new Set<string>();
  
  // Always include the type as a tag
  tagSet.add(type);
  
  // Extract common keywords from items
  items.forEach(item => {
    // Convert to lowercase and split into words
    const words = item.toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Remove punctuation
      .split(/\s+/)
      .filter(w => w.length > 2); // Only keep words longer than 2 characters
    
    // Add meaningful words as tags (limit to prevent too many tags)
    words.forEach(word => {
      if (tagSet.size < 10) { // Limit total tags
        tagSet.add(word);
      }
    });
  });
  
  return Array.from(tagSet);
}

// Configuration
const CLINO_DIR = join(homedir(), '.clino');
const SESSIONS_DIR = join(CLINO_DIR, 'sessions');
const MEMORY_DIR = join(CLINO_DIR, 'memory');
const PROCESSED_SESSIONS_FILE = join(CLINO_DIR, 'processed.sessions');

// Ensure directories exist
[CLINO_DIR, SESSIONS_DIR, MEMORY_DIR].forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

// Load processed sessions
let processedSessions: Set<string> = new Set();
if (existsSync(PROCESSED_SESSIONS_FILE)) {
  const content = readFileSync(PROCESSED_SESSIONS_FILE, 'utf8');
  content.split('\n').forEach(line => {
    if (line.trim()) {
      processedSessions.add(line.trim());
    }
  });
}

// Ensure directories exist
[CLINO_DIR, SESSIONS_DIR, MEMORY_DIR].forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

/**
 * Run a command through PTY and capture session
 */
async function runCommand(agentCmd: string, agentArgs: string[]): Promise<void> {
  console.log(`🚀 Starting ${agentCmd} with args: ${agentArgs.join(' ')}`);
  
  // Use node-pty for proper PTY handling
  const ptyProcess = spawn(agentCmd, agentArgs, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env
  }) as any;

  let output = '';
  ptyProcess.on('data', (data: string) => {
    output += data;
    process.stdout.write(data); // Forward to user (preserves colors)
  });

  ptyProcess.on('exit', async (exit: { exitCode: number; signal?: number | undefined }) => {
    console.log(`\n📝 Session ended with code ${exit.exitCode}`);
    
    // Save session transcript
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sessionFile = join(SESSIONS_DIR, `${timestamp}.md`);
    
    const sessionContent = `# Coding Agent Session\n\n**Agent:** ${agentCmd}\n**Arguments:** ${agentArgs.join(' ')}\n**Started:** ${new Date().toISOString()}\n**Ended:** ${new Date().toISOString()}\n\n## Transcript\n\n\`\`\`\n${output}\n\`\`\`\n`;
    
    writeFileSync(sessionFile, sessionContent, 'utf8');
    console.log(`💾 Session saved to: ${sessionFile}`);
    
    // Auto-extract insights (only if not already processed)
    if (!processedSessions.has(sessionFile)) {
      extractInsights(sessionFile);
      processedSessions.add(sessionFile);
      
      // Save processed sessions to file
      const processedList = Array.from(processedSessions).join('\n');
      writeFileSync(PROCESSED_SESSIONS_FILE, processedList, 'utf8');
    }
  });

  ptyProcess.on('error', (err: Error) => {
    console.error(`❌ PTY error: ${err.message}`);
    process.exit(1);
  });

  // Forward stdin to child process
  process.stdin.pipe(ptyProcess);
}

/**
 * Extract insights from a session file
 */
/**
 * Split text into sentences for better classification
 */
function splitIntoSentences(text: string): string[] {
  // Split by common sentence endings followed by whitespace or end of string
  // This handles periods, exclamation marks, and question marks
  const sentenceEndings = /[.!?]+(?:\s+|$)/g;
  const sentences = text.split(sentenceEndings);
  // Filter out empty strings and trim
  return sentences
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Split compound sentences based on conjunctions for better signal separation
 */
function splitCompoundSentences(sentences: string[]): string[] {
  const result: string[] = [];
  
  const conjunctions = [
    ' and need to ',
    ' but need to ',
    ' and still need to ',
    ' but still need to ',
    ' and we need to ',
    ' but we need to '
  ];
  
  sentences.forEach(sentence => {
    let shouldSplit = false;
    let splitIndex = -1;
    let matchedConjunction = '';
    
    // Check for each conjunction
    for (const conj of conjunctions) {
      const index = sentence.toLowerCase().indexOf(conj);
      if (index !== -1) {
        shouldSplit = true;
        splitIndex = index;
        matchedConjunction = conj;
        break;
      }
    }
    
    if (shouldSplit && splitIndex !== -1) {
      // Split the sentence
      const firstPart = sentence.substring(0, splitIndex).trim();
      const secondPart = sentence.substring(splitIndex + matchedConjunction.length).trim();
      
      // Only add non-empty parts
      if (firstPart.length > 0) {
        result.push(firstPart);
      }
      if (secondPart.length > 0) {
        result.push(secondPart);
      }
    } else {
      // No conjunction found, keep original sentence
      result.push(sentence);
    }
  });
  
  return result;
}

/**
 * Extract decisions from sentences
 */
function extractDecisionsFromSentences(sentences: string[]): string[] {
  const decisionPatterns: RegExp[] = [
    /we (decided|choose|go with|use)\s+(.+?)(?:\.|$)/gi,
    /decision:?\s*(.+?)(?:\.|$)/gi,
    /we'll use\s+(.+?)(?:\.|$)/gi,
    /going with\s+(.+?)(?:\.|$)/gi
  ];
  
  const decisions: string[] = [];
  sentences.forEach(sentence => {
    decisionPatterns.forEach(pattern => {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(sentence)) !== null) {
        decisions.push(match[0].trim());
      }
    });
  });
  
  // Apply normalization and exact deduplication
  const normalizedDecisions = new Map<string, string>();
  decisions.forEach(decision => {
    const normalized = normalizeMemoryText(decision);
    if (!normalizedDecisions.has(normalized)) {
      normalizedDecisions.set(normalized, decision);
    }
  });
  
  // Convert to array and apply fuzzy deduplication
  const dedupedDecisions = Array.from(normalizedDecisions.values());
  return fuzzyDedupe(dedupedDecisions, 0.85);
}

/**
 * Extract TODOs from sentences
 */
function extractTodosFromSentences(sentences: string[]): string[] {
  const todoPatterns: RegExp[] = [
    /TODO:?\s*(.+?)(?:\.|$)/gi,
    /FIXME:?\s*(.+?)(?:\.|$)/gi,
    /we need to\s+(.+?)(?:\.|$)/gi,
    /remaining:?\s*(.+?)(?:\.|$)/gi
  ];
  
  const todos: string[] = [];
  sentences.forEach(sentence => {
    todoPatterns.forEach(pattern => {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(sentence)) !== null) {
        todos.push(match[0].trim());
      }
    });
  });
  
  // Apply normalization and exact deduplication
  const normalizedTodos = new Map<string, string>();
  todos.forEach(todo => {
    const normalized = normalizeMemoryText(todo);
    if (!normalizedTodos.has(normalized)) {
      normalizedTodos.set(normalized, todo);
    }
  });
  
  // Convert to array and apply fuzzy deduplication
  const dedupedTodos = Array.from(normalizedTodos.values());
  return fuzzyDedupe(dedupedTodos, 0.85);
}

/**
 * Extract bugs from sentences
 */
function extractBugsFromSentences(sentences: string[]): string[] {
  const bugPatterns: RegExp[] = [
    /bug:?\s*(.+?)(?:\.|$)/gi,
    /issue:?\s*(.+?)(?:\.|$)/gi,
    /problem:?\s*(.+?)(?:\.|$)/gi,
    /fix:?\s*(.+?)(?:\.|$)/gi,
    /error:?\s*(.+?)(?:\.|$)/gi
  ];
  
  const bugs: string[] = [];
  sentences.forEach(sentence => {
    bugPatterns.forEach(pattern => {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(sentence)) !== null) {
        bugs.push(match[0].trim());
      }
    });
  });
  
  // Apply normalization and exact deduplication
  const normalizedBugs = new Map<string, string>();
  bugs.forEach(bug => {
    const normalized = normalizeMemoryText(bug);
    if (!normalizedBugs.has(normalized)) {
      normalizedBugs.set(normalized, bug);
    }
  });
  
  // Convert to array and apply fuzzy deduplication
  const dedupedBugs = Array.from(normalizedBugs.values());
  return fuzzyDedupe(dedupedBugs, 0.85);
}

/**
 * Extract errors from sentences
 */
function extractErrorsFromSentences(sentences: string[]): string[] {
  // Look for stack traces, exception patterns, etc.
  const errorPatterns: RegExp[] = [
    /Error:?\s*(.+?)(?:\n|$)/gi,
    /exception:?\s*(.+?)(?:\n|$)/gi,
    /failed:?\s*(.+?)(?:\n|$)/gi,
    /\bat\b\s+\S+\.js:\d+:\d+/g
  ];
  
  const errors: string[] = [];
  sentences.forEach(sentence => {
    errorPatterns.forEach(pattern => {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(sentence)) !== null) {
        errors.push(match[0].trim());
      }
    });
  });
  
  // Apply normalization and exact deduplication
  const normalizedErrors = new Map<string, string>();
  errors.forEach(error => {
    const normalized = normalizeMemoryText(error);
    if (!normalizedErrors.has(normalized)) {
      normalizedErrors.set(normalized, error);
    }
  });
  
  // Convert to array and apply fuzzy deduplication
  const dedupedErrors = Array.from(normalizedErrors.values());
  return fuzzyDedupe(dedupedErrors, 0.85);
}

function extractInsights(sessionFilePath: string): void {
  console.log('🔍 Extracting insights from session...');
  
  const content = readFileSync(sessionFilePath, 'utf8');
  
  // Split content into sentences for better classification
  let sentences = splitIntoSentences(content);
  
  // Split compound sentences based on conjunctions for better signal separation
  sentences = splitCompoundSentences(sentences);
  
  // Simple rule-based extraction (MVP version)
  const decisions: string[] = extractDecisionsFromSentences(sentences);
  const todos: string[] = extractTodosFromSentences(sentences);
  const bugs: string[] = extractBugsFromSentences(sentences);
  const errors: string[] = extractErrorsFromSentences(sentences);
  
  // Save to memory files
  appendToMemoryFile('decisions.md', decisions, sessionFilePath);
  appendToMemoryFile('todos.md', todos, sessionFilePath);
  appendToMemoryFile('bugs.md', bugs, sessionFilePath);
  appendToMemoryFile('errors.md', errors, sessionFilePath);
  appendToMemoryFile('summaries.md', [...decisions, ...todos, ...bugs, ...errors], sessionFilePath);
  
  console.log(`✅ Extracted: ${decisions.length} decisions, ${todos.length} TODOs, ${bugs.length} bugs, ${errors.length} errors`);
}

/**
 * Extract decisions from content (simple keyword matching)
 */
function extractDecisions(content: string): string[] {
  const decisionPatterns: RegExp[] = [
    /we (decided|choose|go with|use)\s+(.+?)(?:\.|\n)/gi,
    /decision:?\s*(.+?)(?:\.|\n)/gi,
    /we'll use\s+(.+?)(?:\.|\n)/gi,
    /going with\s+(.+?)(?:\.|\n)/gi
  ];
  
  const decisions: string[] = [];
  decisionPatterns.forEach(pattern => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      decisions.push(match[0].trim());
    }
  });
  
  // Apply normalization and exact deduplication
  const normalizedDecisions = new Map<string, string>();
  decisions.forEach(decision => {
    const normalized = normalizeMemoryText(decision);
    if (!normalizedDecisions.has(normalized)) {
      normalizedDecisions.set(normalized, decision);
    }
  });
  
  // Convert to array and apply fuzzy deduplication
  const dedupedDecisions = Array.from(normalizedDecisions.values());
  return fuzzyDedupe(dedupedDecisions, 0.85);
}

/**
 * Extract TODOs from content
 */
function extractTodos(content: string): string[] {
  const todoPatterns: RegExp[] = [
    /TODO:?\s*(.+?)(?:\.|\n)/gi,
    /FIXME:?\s*(.+?)(?:\.|\n)/gi,
    /we need to\s+(.+?)(?:\.|\n)/gi,
    /remaining:?\s*(.+?)(?:\.|\n)/gi
  ];
  
  const todos: string[] = [];
  todoPatterns.forEach(pattern => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      todos.push(match[0].trim());
    }
  });
  
  // Apply normalization and exact deduplication
  const normalizedTodos = new Map<string, string>();
  todos.forEach(todo => {
    const normalized = normalizeMemoryText(todo);
    if (!normalizedTodos.has(normalized)) {
      normalizedTodos.set(normalized, todo);
    }
  });
  
  // Convert to array and apply fuzzy deduplication
  const dedupedTodos = Array.from(normalizedTodos.values());
  return fuzzyDedupe(dedupedTodos, 0.85);
}

/**
 * Extract bugs from content
 */
function extractBugs(content: string): string[] {
  const bugPatterns: RegExp[] = [
    /bug:?\s*(.+?)(?:\.|\n)/gi,
    /issue:?\s*(.+?)(?:\.|\n)/gi,
    /problem:?\s*(.+?)(?:\.|\n)/gi,
    /fix:?\s*(.+?)(?:\.|\n)/gi,
    /error:?\s*(.+?)(?:\.|\n)/gi
  ];
  
  const bugs: string[] = [];
  bugPatterns.forEach(pattern => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      bugs.push(match[0].trim());
    }
  });
  
  // Apply normalization and exact deduplication
  const normalizedBugs = new Map<string, string>();
  bugs.forEach(bug => {
    const normalized = normalizeMemoryText(bug);
    if (!normalizedBugs.has(normalized)) {
      normalizedBugs.set(normalized, bug);
    }
  });
  
  // Convert to array and apply fuzzy deduplication
  const dedupedBugs = Array.from(normalizedBugs.values());
  return fuzzyDedupe(dedupedBugs, 0.85);
}

/**
 * Extract errors from content
 */
function extractErrors(content: string): string[] {
  // Look for stack traces, exception patterns, etc.
  const errorPatterns: RegExp[] = [
    /Error:?\s*(.+?)(?:\n|$)/gi,
    /exception:?\s*(.+?)(?:\n|$)/gi,
    /failed:?\s*(.+?)(?:\n|$)/gi,
    /\bat\b\s+\S+\.js:\d+:\d+/g
  ];
  
  const errors: string[] = [];
  errorPatterns.forEach(pattern => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      errors.push(match[0].trim());
    }
  });
  
  // Apply normalization and exact deduplication
  const normalizedErrors = new Map<string, string>();
  errors.forEach(error => {
    const normalized = normalizeMemoryText(error);
    if (!normalizedErrors.has(normalized)) {
      normalizedErrors.set(normalized, error);
    }
  });
  
  // Convert to array and apply fuzzy deduplication
  const dedupedErrors = Array.from(normalizedErrors.values());
  return fuzzyDedupe(dedupedErrors, 0.85);
}

/**
 * Append extracted items to memory file with frontmatter
 */
function appendToMemoryFile(filename: string, items: string[], sourceSession: string): void {
  if (items.length === 0) return;
  
  const filePath = join(MEMORY_DIR, filename);
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
  let existingContent = '';
  if (existsSync(filePath)) {
    existingContent = readFileSync(filePath, 'utf8');
  }
  
  const type = filename.replace('.md', '');
  
  // Generate tags based on content and type
  const tags = generateTags(items, type);
  
  // Process each item with improved classification and formatting
  const processedItems = items.map(item => {
    // Extract clean sentence without extra prefixes
    let cleanItem = item.replace(/^(?:we (?:decided|choose|go with|use)|decision:?|we'll use|going with|TODO:?|FIXME:?|we need to|remaining:?|bug:?|issue:?|problem:?|fix:?|error:?|exception:?|failed:?)\s*/i, '').trim();
    
    // Convert infinitive to imperative where appropriate
    if (cleanItem) {
      const lower = cleanItem.toLowerCase();
      if (lower.startsWith('to ')) {
        // Remove leading 'to ' and capitalize first letter
        cleanItem = cleanItem.substring(3);
        cleanItem = cleanItem.charAt(0).toUpperCase() + cleanItem.slice(1);
      } else if (lower.startsWith('need to ')) {
        // Remove leading 'need to ' and capitalize first letter
        cleanItem = cleanItem.substring(8);
        cleanItem = cleanItem.charAt(0).toUpperCase() + cleanItem.slice(1);
      }
      // Ensure it ends with a period
      if (!cleanItem.endsWith('.')) {
        cleanItem += '.';
      }
    } else {
      // If empty, we return an empty string so that it doesn't create a line
      return '';
    }
    
    return `- ${cleanItem}`;
  }).filter(line => line.length > 0).join('\n');
  
  const frontmatter = `---\ntype: ${type}\ndate: ${timestamp}\nsource: ${sourceSession}\nconfidence: 0.9\ntags:\n  - ${tags.join('\n  - ')}\n---\n\n`;
  
  const newContent = frontmatter + processedItems + '\n' + existingContent;
  
  writeFileSync(filePath, newContent, 'utf8');
}

/**
 * Search memory files
 */
function searchMemory(query: string): Array<{file: string; matches: string[]}> {
  console.log(`🔍 Searching memory for: "${query}"`);
  
  const files: string[] = readdirSync(MEMORY_DIR);
  const results: Array<{file: string; matches: string[]}> = [];
  
  files.forEach(file => {
    if (file.endsWith('.md')) {
      const content = readFileSync(join(MEMORY_DIR, file), 'utf8');
      if (content.toLowerCase().includes(query.toLowerCase())) {
        // Extract matching lines
        const lines = content.split('\n');
        const matchingLines = lines.filter(line => 
          line.toLowerCase().includes(query.toLowerCase()) && 
          !line.startsWith('---') && 
          line.trim() !== ''
        );
        
        if (matchingLines.length > 0) {
          results.push({
            file,
            matches: matchingLines.slice(0, 5) // Limit to 5 matches per file
          });
        }
      }
    }
  });
  
  return results;
}

/**
 * Generate compact context for injection
 */
function generateContext(query: string, maxChars: number = 3000): string {
  console.log(`💡 Generating context for: "${query}"`);
  
  const results = searchMemory(query);
  
  // Apply deduplication at inject output time
  const dedupedResults = deduplicateSearchResults(results);
  
  let context = `# Project Context\n\n`;
  
  if (dedupedResults.length === 0) {
    return context + `No relevant memories found for "${query}".\n`;
  }
  
  dedupedResults.forEach(result => {
    context += `## ${result.file.replace('.md', '')}\n`;
    result.matches.forEach(match => {
      context += `${match}\n`;
    });
    context += '\n';
  });
  
  // Limit context size
  if (context.length > maxChars) {
    context = context.slice(0, maxChars) + '\n\n*[Context truncated for token efficiency]*\n';
  }
  
  return context;
}

// Deduplicate search results by normalizing and comparing content
function deduplicateSearchResults(results: Array<{file: string; matches: string[]}>): Array<{file: string; matches: string[]}> {
  if (results.length <= 1) return results;
  
  const normalizedMatches = new Set<string>();
  const dedupedResults: Array<{file: string; matches: string[]}> = [];
  
  results.forEach(result => {
    const dedupedMatches = result.matches.filter(match => {
      const normalized = normalizeMemoryText(match);
      if (!normalizedMatches.has(normalized)) {
        normalizedMatches.add(normalized);
        return true;
      }
      return false;
    });
    
    // Only add result if it has matches after deduplication
    if (dedupedMatches.length > 0) {
      dedupedResults.push({
        file: result.file,
        matches: dedupedMatches
      });
    }
  });
  
  return dedupedResults;
}

// CLI Commands
const command = process.argv[2];

switch (command) {
  case 'run':
    if (!process.argv[3]) {
      console.error('Usage: clino run <agent> [args...]');
      process.exit(1);
    }
    const agent = process.argv[3];
    const agentArgs = process.argv.slice(4);
    runCommand(agent, agentArgs);
    break;
    
  case 'summarize':
    if (!process.argv[3]) {
      console.error('Usage: clino summarize <session-file>');
      process.exit(1);
    }
    const sessionFile = process.argv[3];
    extractInsights(sessionFile);
    break;
    
  case 'find':
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
      findResults.forEach(result => {
        console.log(`📄 ${result.file}:`);
        result.matches.forEach((match, i) => {
          console.log(`  ${i+1}. ${match}`);
        });
        console.log('');
      });
    }
    break;
    
  case 'inject':
    if (!process.argv[3]) {
      console.error('Usage: clino inject <query> [--max-chars <number>]');
      process.exit(1);
    }
    const injectQuery = process.argv[3];
    let maxChars = 3000; // default
    
    // Check for --max-chars argument
    const maxCharsIndex = process.argv.indexOf('--max-chars');
    if (maxCharsIndex !== -1 && process.argv[maxCharsIndex + 1]) {
      maxChars = parseInt(process.argv[maxCharsIndex + 1], 10);
      if (isNaN(maxChars)) {
        console.error('❌ Invalid value for --max-chars');
        process.exit(1);
      }
    }
    
    const context = generateContext(injectQuery, maxChars);
    console.log(context);
    break;
    
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