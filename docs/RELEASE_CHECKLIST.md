# Release Checklist

Run through this before tagging a release. Clyno is **not published to npm yet**;
the publish step is intentionally left for later.

## 1. Verify the build and tests

```bash
npm test       # type-checks and runs the test suite
npm run build  # compiles TypeScript to dist/
```

Both must pass with no errors.

## 2. Manual smoke test

```bash
clyno run echo   # PTY wrapper launches, captures, and exits cleanly
clyno status     # prints the resolved .clyno/ home and memory counts
clyno find       # search runs and returns results (or an empty result)
```

## 3. Verify privacy defaults

- Confirm `.clyno/` is ignored by Git:

  ```bash
  git check-ignore .clyno && echo "ignored OK"
  ```

- Confirm no transcripts or memory files are staged for commit.

## 4. Review docs

- [ ] `README.md` install/usage instructions are accurate.
- [ ] `CHANGELOG.md` has an entry describing this release.

## 5. Tag the release

```bash
git tag vX.Y.Z
git push --tags
```

## 6. Publish (later)

Publishing to npm is deferred. When ready:

```bash
npm publish   # prepublishOnly runs clean + build + test automatically
```
