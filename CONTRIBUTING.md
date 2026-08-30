# Contributing

Thanks for helping improve the Hume React SDK. This document covers local setup,
the checks CI runs, and the conventions that are easy to miss — changing a public
API and updating the documentation in particular.

## Getting set up

Development requires Node `22.18` (see `.nvmrc`) and pnpm `11.24` (pinned by
`packageManager`). The published packages themselves support a lower Node
floor; see each package's `engines` field.

```sh
pnpm install
pnpm dev
```

`pnpm dev` watch-builds every package and example.

### Repository map

| Path                   | What it is                                                    |
| ---------------------- | ------------------------------------------------------------- |
| `packages/react`       | `@humeai/voice-react` — headless hooks and components         |
| `packages/embed`       | `@humeai/voice-embed` — framework-agnostic hosted widget      |
| `packages/embed-react` | `@humeai/voice-embed-react` — React wrapper for the widget    |
| `examples/`            | Three runnable apps that exercise the packages                |
| `docs/`                | The VitePress documentation site                              |
| `tools/`               | Build, documentation, and release scripts                     |
| `tools/lint-contract/` | A meta-lint proving the lint config rejects what it claims to |

## Day-to-day commands

| Command                  | What it does                                            |
| ------------------------ | ------------------------------------------------------- |
| `pnpm dev`               | Watch-build every package and example                   |
| `pnpm dev:iframe`        | Watch-build the packages and the embed example only     |
| `pnpm test`              | Run the unit tests                                      |
| `pnpm test:tools`        | Run the `tools/` test suites only                       |
| `pnpm lint`              | Type-aware Oxlint plus the lint-config contract tests   |
| `pnpm format`            | Apply Oxfmt formatting                                  |
| `pnpm docs:dev`          | Regenerate the API reference and serve the site locally |
| `pnpm docs:build`        | Build the site exactly as CI does                       |
| `pnpm api-report:update` | Regenerate the committed public API reports             |
| `pnpm check`             | The full gate — everything CI runs                      |

## Running the examples

Each example needs its own credentials. Copy its `.env.example` to `.env.local`
and fill it in, then start it from the repository root.

| Example                   | Package it exercises                       | Port |
| ------------------------- | ------------------------------------------ | ---- |
| `examples/next-app`       | `@humeai/voice-react`                      | 3003 |
| `examples/vite-app-embed` | `@humeai/voice-embed-react`                | 3002 |
| `examples/vite-app`       | none — the raw `hume` client, for contrast | 3001 |

Ports are fixed with `--strictPort` so a stale process fails loudly rather than
silently moving. Port 3000 is left free for a locally-run widget renderer.

To run one example on its own, use `pnpm --filter <workspace-name> dev` — for
instance `pnpm --filter example-next-app dev`.

Adding an example means creating `examples/<name>` with `dev`, `build`, `lint`,
`typecheck`, and `typecheck:deps` scripts; Turbo drives them by name, so no
`turbo.json` change is needed. Note that `.github/workflows/test-examples.yml`
builds a **published** tarball against an external example repository, not the
in-repo examples — those are exercised by `turbo build`, `typecheck`, and `lint`.

## Changing a public API

Each package's public API is whatever its api-extractor entry point exports, and
it is recorded in a committed report at `packages/*/etc/*.api.md`.

- **Run `pnpm api-report:update` and commit the report diff.** CI's
  `packages-api` job runs `pnpm api-report:check` without `--local`, so it fails
  on any drift between the source and the committed report. The report diff is
  also the best review artifact for an API change — it shows the surface delta
  directly.
- **Write TSDoc on the exported symbol.** The API reference is generated from
  the emitted declarations, so an undocumented export ships an empty page. Never
  edit the generated Markdown; edit the doc comment.
- **Removing or renaming an export is breaking.** Add an entry under
  `## [Unreleased]` in `CHANGELOG.md`, and for `@humeai/voice-react` a section in
  `packages/react/MIGRATION.md` describing the replacement.
- **Deprecating** means a `@deprecated` TSDoc tag. The reference sidebar files
  deprecated exports into their own collapsed group automatically.

## Documentation: generated versus committed

Some of `docs/` is written by hand and some is produced by `pnpm docs:api`.
Editing a generated file is always wasted work — it is deleted on the next build.

**Generated (gitignored, never edit):**

- `docs/reference/api/**` — from the packages' TypeScript declarations
- `docs/guide/migration.md` — from `packages/react/MIGRATION.md`
- `docs/.generated/**` — the intermediate API models

**Committed (edit these):** everything else under `docs/`, including
`docs/index.md`, the guides in `docs/guide/`, `docs/reference/index.md`, and
`docs/.vitepress/`.

Where new prose goes:

| Change                                 | Where it belongs                            |
| -------------------------------------- | ------------------------------------------- |
| How to accomplish a task               | A guide in `docs/guide/`                    |
| A wrong or missing signature           | The TSDoc comment on the exported symbol    |
| What a package _is_, or its quickstart | That package's `README.md`                  |
| A runnable app                         | `examples/` plus a page in `docs/examples/` |

`pnpm docs:dev` regenerates before serving. `pnpm docs:preview` does **not** — it
serves a previously built site. The API reference sidebar is generated at config
load time, so after changing a public API, restart `pnpm docs:dev` rather than
running `pnpm docs:api` in a second terminal.

## The check gate

`pnpm check` runs the same steps as CI, in order:

| Step                          | What a failure usually means                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `build`                       | A package failed to compile or emit types                                                                                             |
| `lint`                        | A type-aware Oxlint rule fired; run `pnpm lint` for the file and line                                                                 |
| `typecheck`, `typecheck:deps` | A type error in source, or in a declaration a package depends on                                                                      |
| `format:check`                | Run `pnpm format`                                                                                                                     |
| `check:deps`                  | Syncpack found a dependency at different versions across manifests                                                                    |
| `check:docs`                  | A spelling miss (add the word to `.cspell.json`, or use a file-local `cspell:words` directive for a one-off) or a Markdown lint error |
| `check:fallow`                | Dead code — an unused file, export, or type. Either use it, delete it, or add it to `entry` in `.fallowrc.jsonc`                      |
| `check:packages`              | `publint` or `are-the-types-wrong` rejected the packed tarball                                                                        |
| `api-report:check`            | The public API changed; run `pnpm api-report:update`                                                                                  |
| `test`                        | A unit test failed                                                                                                                    |

Run `pnpm check` before opening a pull request. To reproduce a CI job more
exactly, the `justfile` has `just local-ci` and `just local-docs`, which run the
workflows under [act](https://github.com/nektos/act).

## Commits and pull requests

Pull requests are squash-merged, so **the PR title becomes the commit message and
feeds GitHub's generated release notes** — write it for someone reading the
changelog, not for yourself. Prefix with `feat:`, `fix:`, `docs:`, `chore:`, or
`refactor:`, optionally scoped (`fix(react):`).

## Releasing

All three packages are versioned in lockstep, and a single repository tag
publishes every package whose `version` matches that tag.

1. In `CHANGELOG.md`, rename `## [Unreleased]` to the new version with today's
   date, and add the `Published:` line naming each package's version.
2. Set `"version"` to the new version in all three of
   `packages/react/package.json`, `packages/embed/package.json`, and
   `packages/embed-react/package.json`. **All three must move together** — a tag
   only publishes packages whose version equals it, and a mismatch is how
   `@humeai/voice-embed` 0.2.15 through 0.2.17 ended up published with no tag.
3. Validate without publishing:

   ```sh
   node tools/release-plan.mjs v1.2.3          # validate the plan only
   node tools/publish-release.mjs v1.2.3 --dry-run
   ```

   Do **not** run `pnpm release` unless you intend to publish — it dry-runs only
   when passed `--dry-run`.

4. Merge, then tag the merge commit and push:

   ```sh
   git tag v1.2.3 && git push origin v1.2.3
   ```

   The tag must be `v` followed by a strict SemVer version; the release tooling
   rejects anything else, which is why the historical `0.1.7` and `v.0.1.19` tags
   could not be created today.

5. The tag push triggers the `publish` job in `.github/workflows/ci.yml`. It
   waits on every other CI job, re-runs `pnpm check`, and publishes through npm
   trusted publishing with provenance. A prerelease version publishes under the
   `next` dist-tag automatically; a stable version publishes under `latest`.
6. Create the GitHub release for the tag and paste that version's changelog
   section as the body.

Note that the documentation site deploys from `main` and does **not** run on a
tag push, so the site tracks `main` rather than the latest release.

## Security

Please do not report security issues through public issues or pull requests. See
[SECURITY.md](SECURITY.md).
