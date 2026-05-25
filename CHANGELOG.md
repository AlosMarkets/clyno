# Changelog

All notable changes to Clino are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Real PTY-backed `clino run` for wrapping terminal coding agents.
- Project-local `.clino/` storage resolved from the Git root.
- Private-by-default storage: `.clino/` is ignored by Git out of the box.
- Memory extraction and transcript cleaning from captured sessions.
- `clino find`, `clino inject`, `clino status`, and `clino doctor` commands.
- Resolved-memory tracking to avoid re-surfacing handled items.
- Memory management commands: `clino memory list`, `clino memory show`,
  and `clino memory delete`.
