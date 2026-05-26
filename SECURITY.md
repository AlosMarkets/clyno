# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Clyno, please report it
**privately** so it can be fixed before public disclosure.

- Use GitHub's [private vulnerability reporting](https://github.com/AlosMarkets/clyno/security/advisories/new)
  (Security tab → "Report a vulnerability"), **or**
- email the maintainer directly.

Please do **not** open a public issue, pull request, or discussion for security
problems.

Include as much as you can:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version(s) (`clyno --version`), and
- any suggested fix.

We aim to acknowledge reports within a few days and will keep you updated on
remediation progress. Once a fix is released we're happy to credit you, unless
you prefer to remain anonymous.

## Scope

Clyno is local-first: transcripts and memory are stored under a project-local
`.clyno/` directory and are not transmitted off your machine by default.
Security reports of particular interest include:

- secret/credential leakage into stored memory, logs, or output that should be
  redacted,
- `.clyno/` data escaping its intended project-local boundary,
- path traversal or injection via session/transcript handling, and
- anything that causes Clyno to exfiltrate data or run untrusted code.

## Supported versions

Clyno is pre-1.0 and under active development. Security fixes are applied to the
latest released version on npm (`@clyno/cli`).
