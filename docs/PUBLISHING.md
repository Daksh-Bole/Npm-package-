# Publishing awaitfall to npm

Nothing has been published yet. These are the exact steps to do it yourself.

## Pre-publish checklist

- [ ] The package name is still free: `npm view awaitfall` should print `404 Not Found`.
- [ ] `package.json` URLs point at the final repository. If you renamed the repo to `awaitfall`, update `homepage`, `repository.url` and `bugs.url`, plus the links in `README.md` and `CHANGELOG.md`.
- [ ] `version` follows semver. Start at `0.1.0`. While below 1.0, bump minor for breaking changes and patch for fixes.
- [ ] `CHANGELOG.md` has a section for this version with today's date.
- [ ] `npm run check` passes: typecheck, lint, tests, build, smoke tests, publint and attw.
- [ ] The tarball contains only `dist/`, `README.md`, `LICENSE` and `package.json` (see step 4).
- [ ] The README image loads on GitHub. npm only shows `docs/demo.png` if it can resolve it from the repository, so check the npm page after publishing.
- [ ] Two-factor authentication is on for your npm account.

## 1. Install dependencies

```bash
npm ci
```

## 2. Run the tests

```bash
npm test
```

```bash
npm run check
```

## 3. Build the package

```bash
npm run build
```

## 4. Inspect the npm tarball

```bash
npm pack --dry-run
```

To look inside the real tarball and try it in a throwaway project:

```bash
npm pack
```

```bash
tar -tzf awaitfall-0.1.0.tgz
```

```bash
mkdir /tmp/try-awaitfall && cd /tmp/try-awaitfall && npm init -y && npm install /path/to/awaitfall-0.1.0.tgz
```

## 5. Log in to npm

```bash
npm login
```

```bash
npm whoami
```

## 6. Publish

`prepublishOnly` runs `npm run check` again automatically, so a broken build can't be published.

```bash
npm publish --access public
```

If you publish from GitHub Actions instead, add `--provenance` so npm shows a verified build badge. That requires `id-token: write` permission in the workflow.

## After publishing

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

Then create a GitHub release from the tag and paste in the changelog section.

## Later releases

```bash
npm version patch
```

```bash
git push --follow-tags
```

```bash
npm publish
```

Use `npm version minor` or `npm version major` as appropriate, and move the `Unreleased` changelog entries under the new version first.
