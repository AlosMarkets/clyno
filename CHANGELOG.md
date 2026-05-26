# Changelog

All notable changes to Clyno are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-26

First public release, published to npm as [`@clyno/cli`](https://www.npmjs.com/package/@clyno/cli).
Install with `npm install -g @clyno/cli`; the command remains `clyno`.

### Added

- Rule-based secret redaction: obvious API keys, tokens, JWTs, PEM private-key
  blocks, credentialed URLs, OAuth params, and secret-y env assignments are
  replaced with `[REDACTED_SECRET]` across cleaned extraction output, memory
  files, `clyno find`/`clyno inject` output, review candidates, and summaries.
  Secret-only candidates are dropped; raw transcripts on disk are unchanged.
- Real PTY-backed `clyno run` for wrapping terminal coding agents.
- Project-local `.clyno/` storage resolved from the Git root.
- Private-by-default storage: `.clyno/` is ignored by Git out of the box.
- Memory extraction and transcript cleaning from captured sessions.
- `clyno find`, `clyno inject`, `clyno status`, and `clyno doctor` commands.
- Resolved-memory tracking to avoid re-surfacing handled items.
- Memory management commands: `clyno memory list`, `clyno memory show`,
  and `clyno memory delete`.

[Unreleased]: https://github.com/AlosMarkets/clyno/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AlosMarkets/clyno/releases/tag/v0.1.0
