# Documentation model

This site combines two sources so that conceptual guidance and exact API
contracts can evolve without drifting apart.

## Guides and package documentation

The package pages include the package READMEs directly from the repository.
Those files own installation instructions, walkthroughs, examples, migration
notes, and troubleshooting guidance.

## API reference

The API reference is generated from the packages' emitted TypeScript declaration
files. API Extractor builds a documentation model from the same public entry
points used by package consumers, and API Documenter renders that model as
Markdown.

Generated reference pages are build artifacts. Improve an incomplete reference
page by updating the exported symbol's TSDoc comment in source rather than
editing generated Markdown.

## Release status

The site currently documents the latest `main` branch. Package versions are
independent, so a future versioned site will need to snapshot or route each
package separately rather than assigning one version to the entire monorepo.
