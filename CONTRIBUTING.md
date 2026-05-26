# Contributing to Clyno

Thanks for your interest in improving Clyno! This project is a local-first
memory layer for terminal-based AI coding agents, and contributions of all
sizes are welcome — bug reports, docs, tests, and features.

## Ground rules

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

Clyno has a deliberately narrow scope. Before opening a large PR, please read
the **"What Clyno Is Not"** section of the [README](README.md). In short, Clyno
captures and recalls *your own* project context locally. We will **not** accept
contributions that:

- provide or proxy model access (Claude, OpenAI, etc.),
- bypass provider rate limits, usage limits, or authentication,
- extract, store, or transmit provider credentials or session tokens, or
- send transcripts or memory off the user's machine by default.

Privacy and local-first behavior are core invariants, not preferences.

## Development setup

Clyno requires **Node 18+**.

```bash
git clone https://github.com/AlosMarkets/clyno.git
cd clyno
npm install      # installs deps and builds via the prepare script
npm run build    # compile TypeScript to dist/
npm test         # build + run the full test suite
npm link         # optional: put your local `clyno` on PATH
```

Source lives in `src/` (`index.ts` is the CLI, `memory.ts` is the
extraction/storage core). Tests are in `tests/` and run on Node's built-in test
runner.

## Making a change

1. **Open an issue first** for anything non-trivial, so we can agree on the
   approach before you invest time.
2. Create a branch off `master`.
3. Make your change. Match the style of the surrounding code — no new
   dependencies without discussion (Clyno intentionally ships with a tiny
   dependency footprint).
4. **Add or update tests.** New behavior needs coverage; bug fixes should come
   with a regression test.
5. Run `npm test` and make sure it passes locally.
6. Open a pull request using the template. Describe *what* changed and *why*,
   and link the issue it closes.

## Pull request checklist

- [ ] `npm test` passes (CI runs the same on every PR).
- [ ] New/changed behavior is covered by tests.
- [ ] Docs (README/CHANGELOG) updated if user-facing behavior changed.
- [ ] No secrets, transcripts, or `.clyno/` data committed.
- [ ] The change respects Clyno's local-first / privacy invariants.

## Reporting bugs

Use the bug report template. Include your OS, Node version (`node -v`), the
exact command you ran, and what you expected vs. what happened. Never paste real
secrets, tokens, or private transcripts into an issue.

## Reporting security issues

Please do **not** open a public issue for vulnerabilities. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
