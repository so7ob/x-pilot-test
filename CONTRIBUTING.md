# Contributing

## Branches

- `main` contains stable, installable releases.
- `develop` contains the next integration state.
- `feature/<name>` is used for new capabilities.
- `fix/<name>` is used for corrections.
- `release/<version>` is used for final release checks.

Every change starts on a feature or fix branch. Before integration, run `npm run build` and `npm test`, and for changes touching the Local Runner also `cd local-runner && npm run build && npm test`. Review the user-visible behavior, permissions impact, persistence or schema impact, and known limitations. Stable releases are merged from `develop` into `main` and tagged semantically.

## Versioning

The version in `package.json`, `public/manifest.json`, and release tags must remain synchronized (`local-runner/package.json` follows the same release number). Patch releases fix defects, minor releases add backward-compatible features, and major releases may change persisted data or extension behavior. Persisted schema changes require an explicit migration before the schema is changed. Optional, backward-compatible fields must be documented in CHANGELOG.md under the releasing version.

## Pull requests

Each pull request must describe the user-visible behavior, permissions impact, data migration impact, tests run, and known limitations. Never commit tokens, private keys, browser profiles, local backups, or generated `dist/` archives.
