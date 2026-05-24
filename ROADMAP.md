# Clino: Persistent Memory for AI Coding Agents

## Vision
Build a local-first, privacy-respecting system that provides persistent structured memory for terminal-based AI coding agents (Codex, Claude Code, Aider, Goose, etc.) to eliminate token waste from reloading entire session histories and enable instant context rehydration.

## Core Principles
- **Local-first**: Nothing leaves the user's machine unless explicitly opted-in
- **Agent-agnostic**: Works with any terminal agent via STDIN/STDOUT or file-based protocols
- **Markdown-native**: Knowledge base stored as readable, version-controlled Markdown files
- **Git-friendly**: Designed to commit cleanly alongside source code
- **Selective context**: Only relevant memory chunks loaded into agent context window
- **Intelligent compression**: Automatic summarization, deduplication, and extraction of signal from noise

---

## Implementation Roadmap

### Phase 0: Exploration & Validation (Weeks 1-2)
**Goal**: Validate core assumptions with minimal viable prototype.

**Activities**:
- [ ] Survey terminal agents' integration points (environment variables, config files, hook scripts)
- [ ] Build simple file-watcher that captures assistant turns from terminal output
- [ ] Implement basic session summarization using heuristics (no LLM yet)
- [ ] Create markdown export with folder-per-component structure
- [ ] Test manual `/load-memory`-style injection with Codex/Claude Code

**Official Docs References**:
- Electron: https://www.electronjs.org/docs/latest/tutorial/quick-start
- Tauri: https://tauri.app/v1/guides/
- Node.js PTY: https://nodejs.org/api/pty.html
- Chokidar (file watcher): https://github.com/paulmillr/chokidar
- Terminus (PTY library): https://github.com/xtermjs/tty.js

**Deliverable**: Proof-of-concept that can capture a Codex session, summarize it to markdown, and be manually reloaded.

---

### Phase 1: Core Engine (Weeks 3-6)
**Goal**: Build the foundational memory system with automated capture and basic retrieval.

**Components**:
1. **Terminal Observer** (PTY-based)
   - Spawns agent in PTY, captures bidirectional traffic
   - Filters noise (spinners, progress bars, token stats)
   - Extracts semantic turns: assistant replies, user prompts, code blocks, errors
   - Official docs: Node.js PTY, child_process.spawn with {stdio: ['pipe', 'pipe', 'pipe']}

2. **Signal Extractor & Compressor**
   - Uses rule-based + lightweight ML to identify:
     - Architectural decisions (keywords: "decide", "choose", "we'll use")
     - Bug fixes (keywords: "fixed", "bug", "issue", stack traces)
     - TODOs & plans (keywords: "todo", "next", "plan")
     - Environment setup (commands, installs, config changes)
     - Failed attempts (keywords: "failed", "doesn't work", "error")
   - Official docs: 
     - Sentence Transformers (for lightweight semantic scoring): https://sbert.io/docs/
     - Regex cookbook: https://github.com/tringuyen98/regex-cookbook

3. **Memory Store**
   - Hierarchical markdown filesystem: `/project-memory/{component}/{aspect}.md`
   - Frontmatter for metadata (timestamp, tags, component, session-id)
   - Official docs:
     - Gray-matter (frontmatter parser): https://github.com/jonschlinkert/gray-matter
     - Markdown-it (markdown parsing/rendering): https://github.com/markdown-it/markdown-it
     - SQLite FTS5 for metadata indexing: https://www.sqlite.org/fts5.html

4. **Retrieval Interface**
   - Simple CLI: `clino retrieve --component auth-system --query "jwt"`
   - Returns top-K relevant markdown chunks based on:
     - Exact tag match
     - TF-IDF scoring (later upgrade to embeddings)
     - Recency boost
   - Official docs:
     - Natural (TF-IDF in JS): https://naturalnode.github.io/natural/
     - Or use Python's sklearn for offline index building: https://scikit-learn.org/stable/modules/feature_extraction.html#text-feature-extraction

5. **Rehydration API**
   - Generates concise summary prompt for agent consumption:
     ```
     # Project Memory Context (auth-system)
     
     ## Decisions
     - JWT chosen for stateless auth (2024-05-20)
     - Redis blacklist for token revocation
     
     ## Active TODOs
     - Implement refresh token rotation
     
     ## Recent Bug Fixes
     - Fixed cookie parsing edge case (see bugs.md#L15)
     ```
   - Agent injects this at session start via environment variable or temporary file.

**Official Docs for Build System**:
- Electron builder: https://www.electronjs.org/docs/tutorial/application-distribution
- Tauri bundler: https://tauri.app/v1/guides/bundling/
- Cross-platform packaging: https://github.com/electron-userland/electron-builder

**Deliverable**: Working desktop app (Electron/Tauri) that runs agent in PTY, builds searchable markdown memory, and can inject context summaries.

---

### Phase 2: Intelligence Layer (Weeks 7-10)
**Goal**: Add semantic search, automatic summarization, and smarter compression.

**Enhancements**:
1. **Local Embedding Engine**
   - Use sentence-transformers or GGUF-format embeddings via llama.cpp
   - Generate embeddings for each markdown chunk/store in SQLite with sqlite-vec extension
   - Official docs:
     - sqlite-vec: https://github.com/asg017/sqlite-vec
     - llama.cpp embeddings: https://github.com/ggerganov/llama.cpp#embeddings
     - SBERT multilingual models: https://www.sbert.net/docs/pretrained_models.html

2. **Abstractive Summarization**
   - Fine-tune small LLM (e.g., Phi-2, TinyLlama) on session-to-summary pairs
   - Or use retrieval-augmented generation: extractive summary + LLM polishing
   - Official docs:
     - HuggingFace Transformers training: https://huggingface.co/docs/transformers/training
     - Llama.cpp fine-tuning guide: https://github.com/ggerganov/llama.cpp/blob/master/examples/fine-tune/readme.md
     - PEFT (Parameter-Efficient Fine-Tuning): https://huggingface.co/docs/peft

3. **Intent-Based Tagging**
   - Auto-tag extracted signals with categories: `decision`, `bug`, `todo`, `env`, `failed-attempt`, `plan`
   - Use zero-shot classification or lightweight fine-tuned model
   - Official docs:
     - HuggingFace zero-shot: https://huggingface.co/docs/transformers/main_classes/pipelines#zero-shot-classification
     - Facebook BART-large-MNLI: https://huggingface.co/facebook/bart-large-mnli

4. **Duplicate Detection & Merging**
   - Similarity threshold to merge related decisions/bug reports
   - Official docs: 
     - Cosine similarity via sqlite-vec or FAISS: https://github.com/facebookresearch/faiss

**Deliverable**: Memory system with semantic search (`clino find "redis auth bug"` returns relevant chunks) and auto-generated session summaries that rival human-written ones.

---

### Phase 3: Integration & Polish (Weeks 11-14)
**Goal**: Deep integrations with popular agents and version control.

**Features**:
1. **Agent-Specific Adapters**
   - Codex CLI: inject via `--context-file` or environment
   - Claude Code: hook into `/memory load` slash command (if supported) or STDIN prefix
   - Aider: modify config to load memory before each round
   - Goose: similar STDIN/STDOUT interception
   - Official docs: 
     - Codex CLI: https://openai.com/blog/codex-cli
     - Claude Code: https://docs.anthropic.com/en/docs/claude-code
     - Aider: https://aider.chat/docs.html
     - Goose: https://block.github.io/goose/

2. **Git Integration**
   - Auto-commit memory changes with meaningful messages
   - Blame-aware memory: show which commit introduced a decision
   - Optional: generate architecture docs from memory for `ARCHITECTURE.md`
   - Official docs:
     - libgit2 (cross-platform git bindings): https://libgit2.github.com/libgit2/
     - Isomorphic-git (pure JS): https://isomorphicgit.org/

3. **Team Memory Sharing (Opt-In)**
   - Encrypted sync via GitHub/GitLab private repos or IPFS
   - Conflict resolution for concurrent edits
   - Official docs:
     - Octokit (GitHub API): https://github.com/octokit/core.js
     - GitLab SDK: https://github.com/gitlabhq/gitlabhq/blob/master/doc/api/README.md

4. **Configuration & Extensibility**
   - TOML/YAML config for components, tags, summarization models
   - Plugin system for custom extractors (e.g., domain-specific language detection)
   - Official docs:
     - TOML spec: https://toml.io/en/v1.0.0
     - Pluggy (plugin framework): https://pluggy.readthedocs.io/

**Deliverable**: Polished, installable desktop app with one-click setup for major coding agents, optional team sync, and comprehensive documentation.

---

### Phase 4: Ecosystem & Growth (Post-Launch)
**Ideas for Future**:
- **Memory Marketplace**: Share curated memory templates for common stacks (React, Django, etc.)
- **Architecture Drift Detection**: Compare current codebase against architectural decisions in memory
- **Auto-generated Changelogs**: From memory TODO/bug sections
- **Voice-to-Memory**: Dictate decisions via voice memos
- **Integration with Issue Trackers**: Auto-create GitHub issues from TODOs in memory
- **Cross-Project Memory**: Global snippets for common algorithms, patterns

---

## Tech Stack Choices

### Primary Options (Choose One)

#### Option A: Electron + Node.js/TypeScript
- **Pros**: Mature ecosystem, easy file system/PTY access, vast npm packages, familiar to web devs
- **Cons**: Higher memory footprint, larger binary size
- **Key Packages**:
  - `pty.js` for PTY handling
  - `chokidar` for file watching
  - `markdown-it` + `gray-matter` for markdown
  - `sqlite3` + `sqlite-vec` for storage/vector search
  - `@xenova/transformers` for running transformers in browser/node (or use huggingface.js)
  - `natural` for TF-IDF
  - `electron-builder` for packaging

#### Option B: Tauri + Rust
- **Pros**: Tiny binaries, near-native performance, strong security model, modern tooling
- **Cons**: Rust learning curve, fewer ready-made NLP libraries (may need FFI to Python)
- **Key Crates**:
  - `tauri` + `tauri-plugin-process` for PTY
  - `notify` for file watching
  - `pulldown-cmark` + `maud` for markdown
  - `rusqlite` + `rusqlite` extensions for FTS5/vectors
  - `tokenizers` (from HuggingFace) for embedding tokenization
  - `tract` or `burn` for running lightweight ML models (or use Python via `pyo3`)
  - `serde` for config

#### Option C: Python (PyQt/PySide or Simple GUI + CLI)
- **Pros**: Best-in-class ML/NLP libraries (transformers, sentence-transformers, scikit-learn), rapid prototyping
- **Cons**: Heavier runtime dependency, less smooth desktop app experience
- **Key Packages**:
  - `watchdog` for file watching
  - `ptyprocess` for PTY
  - `python-frontmatter`
  - `sqlite3` + `sqlite-vec` via `pysqlite3-binary`
  - `sentence-transformers` / `transformers` / `torch`
  - `scikit-learn` for TF-IDF
  - `PyInstaller` or `briefcase` for packaging

### Recommended Stack for MVP
**Electron + TypeScript** for fastest iteration and access to JS/TS NLP libraries that run in-node (like `@xenova/transformers` which uses ONNX Runtime). This avoids Python dependency complexity while still enabling embeddings and summarization via quantized models.

If the team prefers Rust for performance and bundle size, **Tauri** is excellent but may require more effort to integrate cutting-edge ML models (could call out to Python via subprocess or use ONNX Runtime via `ort` crate).

### Storage Layer Details
- **Primary**: SQLite database with:
  - FTS5 table for keyword search on markdown content
  - Optional `sqlite-vec` extension for vector similarity search
  - Tables: `sessions`, `chunks` (with component, tags, timestamps, embedding blob)
- **Backup**: Hierarchical markdown files in `~/clino-memory/{project-id}/` for human readability and git compatibility
- **Official Docs**:
  - SQLite FTS5: https://www.sqlite.org/fts5.html
  - sqlite-vec: https://github.com/asg017/sqlite-vec
  - SQLite JSON1 (for flexible metadata): https://www.sqlite.org/json1.html

### Summarization & Extraction Models
- **MVP Phase**: Rule-based + TF-IDF (zero ML dependency)
- **Phase 1**: Use small, quantized embeddings model (e.g., `BAAI/bge-small-en-v1.5` via `@xenova/transformers`) for semantic search
- **Phase 2**: Use distilled summarization model (e.g., `philschmid/bart-large-cnn-samsum` or `Falconsai/text_summarization`) or train a tiny T5 on session-summary pairs
- **Phase 3**: Optionally fine-tune a 1B-parameter LLM (like Phi-2 or TinyLlama) via LoRA for agent-specific summarization style
- **Official Docs**:
  - HuggingFace Model Hub: https://huggingface.co/models
  - ONNX Runtime Web: https://github.com/microsoft/onnxruntime-web
  - llama.cpp GGUF conversion: https://github.com/ggerganov/llama.cpp#converting-models-from-huggingface-format-to-gguf

### PTY / Terminal Interaction
- Need to spawn the target agent (Codex, etc.) in a pseudo-terminal and forward stdin/stdout/stderr
- Must detect agent prompts vs. assistant output vs. user input
- Official docs:
  - Node.js `child_process.spawn` with `stdio: ['pipe', 'pipe', 'pipe', 'ipc']`
  - `pty.js` library: https://github.com/indutny/pty.js
  - For Rust: `tokio-process` or `async-process` with PTY features
  - For Python: `ptyprocess`

### Noise Filtering Heuristics
- Remove lines matching:
  - Spinner patterns: `/\\|/-\\|/`
  - Progress bars: `[=>\\s]*[0-9]+%`
  - Token usage: `^tokens:|^prompt:|^completion:`
  - Repeated empty lines
  - Tool call logs (if agent prints them)
- Official docs: Regex cheat sheet: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions/Cheat_Sheet

### Security & Privacy Considerations
- All processing local by default
- Optional telemetry opt-out
- Memory files stored in user-chosen directory (default `~/clino-memory`)
- Encryption option for memory at rest (using SQLCipher or file-level encryption)
- Official docs:
  - SQLCipher: https://www.zetetic.net/sqlcipher/
  - Web Crypto API (for Electron): https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
  - Tauri security guidelines: https://tauri.app/v1/guides/security/

## Next Steps for You
1. **Choose implementation path** (Electron vs Tauri vs Python)
2. **Define project structure** (monorepo? separate packages for core, CLI, GUI?)
3. **Set up dev environment** with linting, testing, CI
4. **Build vertical slice**: capture one turn → extract signal → save markdown → reload summary

Would you like me to:
- Draft a sample `package.json` or `Cargo.toml` with dependencies?
- Create a basic folder structure for the chosen stack?
- Write a prototype of the Terminal Observer in Node.js/Rust/Python?
- Or continue brainstorming specific components (e.g., summarization strategy, git integration details)?

Let me know how you'd like to proceed!