# Documentation model

This site combines two sources so that conceptual guidance and exact API
contracts can evolve without drifting apart.

## Guides and package documentation

Task-oriented guidance is written directly in `docs/guide/`. Package READMEs
remain the landing pages for npm and GitHub, but the documentation build does
not copy them into this site. Update a guide when readers need a walkthrough,
example, migration path, or troubleshooting procedure.

## API reference

The API reference is generated from the packages' emitted TypeScript declaration
files. API Extractor builds a documentation model from the same public entry
points used by package consumers, and API Documenter renders that model as
Markdown.

Generated reference pages are build artifacts. Improve an incomplete reference
page by updating the exported symbol's TSDoc comment in source rather than
editing generated Markdown.

The build also copies `packages/react/MIGRATION.md` to the generated migration
guide. Run `pnpm docs:api` to refresh that page, the API models, and the API
reference; `pnpm docs:build` performs the same generation before building the
site.

## Release status

The site currently documents the latest `main` branch. Package versions are
independent, so a future versioned site will need to snapshot or route each
package separately rather than assigning one version to the entire monorepo.
