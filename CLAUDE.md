# CLAUDE.md

Guidance for working in this repo. This package is published to npm as
**`cc-statusline-simple`** (binary: `cc-statusline` → `dist/cli.js`).

## Build

Source is `src/index.ts`; the published/runtime artifact is `dist/cli.js`.

```bash
npm run build      # esbuild bundle + minify -> dist/cli.js
npm run smoke      # render sample status lines, eyeball the output
```

`dist/` is **gitignored** (it is a build artifact, never committed). It is still
shipped to npm because `package.json` `files` whitelists `["dist", "README.md"]` —
the whitelist overrides `.gitignore` for packaging.

## Publishing to npm

`prepublishOnly` runs `npm run build`, so `npm publish` always rebuilds `dist/`
from the current `src/` — no manual pre-build needed.

Full sequence from a clean working tree on `main`:

```bash
npm run smoke                        # optional: eyeball the rendered lines
npm version patch                    # e.g. 0.1.3 -> 0.1.4; makes a commit + git tag
npm publish --auth-type=legacy       # prepublishOnly rebuilds dist first
git push --follow-tags               # push the version commit AND the vX.Y.Z tag
```

Verify before and after:

```bash
npm pack --dry-run         # list exactly what will be published (expect 3 files:
                           # dist/cli.js, README.md, package.json)
npm view cc-statusline-simple version   # confirm the registry updated
```

### Gotchas (learned the hard way)

- **Bump the version every time.** The registry rejects republishing an existing
  version with `403 You cannot publish over the previously published versions`.
  Check `npm view cc-statusline-simple version` vs local `package.json`.
- **Always pass `--auth-type=legacy`** to both `npm login` and `npm publish` in
  this environment. Without it npm uses the browser/web auth flow, which does not
  work here; `--auth-type=legacy` prompts for username/password/OTP in the
  terminal instead.
- **`npm login` and `npm publish` are interactive** (credentials + OTP if 2FA is
  on). A present-but-stale token in `~/.npmrc` still returns `401` on
  `npm whoami` — re-run `npm login --auth-type=legacy` if so. These steps cannot
  be done headlessly; run them yourself in a real terminal.
- **`npm version patch` commits and tags** on the current branch, so run it with a
  clean tree. Use `git push --follow-tags` afterwards so the tag reaches GitHub —
  easy to forget: `v0.1.3` was published to npm but its tag sat unpushed until the
  `v0.1.4` release.
- **Verify from the registry, not from local `dist/`.** After publishing, run the
  published artifact from a clean directory:
  ```bash
  npm pack cc-statusline-simple@X.Y.Z && tar xzf cc-statusline-simple-X.Y.Z.tgz
  echo '{"model":{"display_name":"Opus 5"},"effort":{"level":"max"}}' | node package/dist/cli.js
  ```

## Global install (local dev)

The status line is installed globally and invoked by Claude Code per render
(`statusLine.command: "cc-statusline"` in `~/.claude/settings.json`). After
editing source, propagate to the live status line with:

```bash
npm run build && npm install -g .
```

A plain `npm run build` updates this repo's `dist/` but NOT the global install —
they are separate copies.
