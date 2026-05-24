# Clino: Core Components & Tech Stack Outline

## Core Components

### 1. Terminal Observer / PTY Interface
**Purpose**: Spawn and monitor terminal agent sessions, capturing all I/O
**Responsibilities**:
- Launch target agent (Codex, Claude Code, etc.) in pseudo-terminal
- Bidirectional forwarding of stdin/stdout/stderr
- Separate user input, agent output, and system noise
- Detect session start/end events
- Provide clean stream of assistant turns for processing

**Key Challenges**:
- PTY handling across platforms (Linux/macOS/Windows)
- Distinguishing agent-generated content from user input
- Handling applications that manipulate terminal directly (vim, less, etc.)
- Performance: minimal overhead on I/O forwarding

### 2. Signal Extractor & Noise Filter
**Purpose**: Separate valuable context from terminal noise
**Responsibilities**:
- Identify and remove: spinners, progress bars, token stats, repetitive edits
- Extract semantic units: assistant replies, user prompts, code blocks, errors, decisions
- Classify extracted signals by type: decision, bug-fix, todo, environment-setup, failed-attempt, plan
- Apply rule-based and lightweight ML filtering
- Output cleaned, tagged signal stream

**Classification Categories**:
- `decision`: Architectural choices, technology selections
- `bug-fix`: Resolved issues, patches, workarounds
- `todo`: Pending tasks, future work, remaining issues
- `environment`: Setup commands, installs, config changes
- `failed-attempt`: Approaches that didn't work, dead ends
- `plan`: Implementation strategies, approaches considered
- `code`: Significant code changes, refactorings
- `error`: Important errors that required attention

### 3. Memory Store & Compressor
**Purpose**: Persist extracted signals in structured, queryable format
**Responsibilities**:
- Store signals as markdown files in hierarchical folder structure
- Apply compression: summarization, deduplication, merging related items
- Generate and maintain indices for fast retrieval
- Provide versioning and change tracking
- Export/import capabilities for backup/sharing

**Storage Structure**:
```
/project-memory
  /{component-name}
    decisions.md
    bugs.md
    architecture.md
    todos.md
    plans.md
    environment.md
    failed-attempts.md
  timeline.md          # Chronological session log
  summaries.md         # Auto-generated session summaries
  index.db             # SQLite FTS5 + optional vector index
```

**Compression Techniques**:
- Extractive summarization: keep key sentences
- Abstraction: generate novel summary text
- Deduplication: merge similar decisions/bug reports
- Chunking: break large files into topical sections
- Frontmatter metadata: timestamp, tags, component, session-id, importance score

### 4. Retrieval & Ranking Engine
**Purpose**: Find and rank relevant memory chunks for given context/query
**Responsibilities**:
- Accept queries from agent or user (keywords, natural language)
- Search memory using keyword, semantic, and hybrid approaches
- Rank results by relevance, recency, component match, importance
- Return top-K chunks formatted for agent consumption
- Support different retrieval modes: exact match, semantic search, tag-based

**Retrieval Strategies**:
- Keyword search (FTS5)
- TF-IDF vector space
- Embedding similarity (sentence-transformers)
- Hybrid: keyword + semantic reranking
- Graph-based: follow links between related decisions

### 5. Context Rehydration Interface
**Purpose**: Deliver relevant memory to agent at session start or on demand
**Responsibilities**:
- Generate concise context summary for agent injection
- Format output as markdown or plain text suitable for context window
- Support different injection methods: environment variable, temp file, STDIN prefix
- Provide on-demand retrieval via CLI (`clino find "query"`)
- Enable manual memory browsing/viewing

**Rehydration Formats**:
- Summary bullet points by category
- Timeline of recent relevant events
- Specific component deep-dive
- Raw chunk retrieval for agent to process

### 6. Auto-Summarization Pipeline
**Purpose**: Periodically generate session and component summaries
**Responsibilities**:
- Process completed sessions into structured summaries
- Update component memories with new decisions/bugs/todos
- Generate project-level timelines and progress reports
- Apply progressive summarization (hourly → daily → weekly)
- Detect and highlight trends, patterns, recurring issues

**Summary Templates**:
- Session Summary: Objective, Decisions, Bugs Fixed, TODOs, Environment
- Component Summary: Current State, Key Decisions, Known Issues, Active Work
- Project Summary: Progress, Architecture Overview, Risk Areas, Velocity

### 7. Git Integration Layer
**Purpose**: Synchronize memory with source control
**Responsibilities**:
- Auto-commit memory changes with descriptive messages
- Blame-aware queries: "what decisions led to this code?"
- Generate architecture docs from memory for committal
- Optional: link memory items to specific commits/PRs
- Handle merge conflicts in markdown files gracefully

### 8. Configuration & Extensibility System
**Purpose**: Allow customization and extension
**Responsibilities**:
- User-configurable components, tags, extraction rules
- Plugin system for domain-specific signal extractors
- Adjustable compression/summarization parameters
- Integration hooks for other tools (issue trackers, wikis)
- Theming and UI customization (for desktop app)

