# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-17

### Breaking

- **Tag selection is now document-position based, not tag-list-order based.**
  Previously, the first tag in `tags` that appeared anywhere in the input took
  priority. Now, *all* configured tags are scanned across the whole input, and
  the match is selected by document position (`pickLast` controls earliest vs
  latest). This is what most users actually expected for "example earlier in
  the prompt, real answer at the end" scenarios.
- **Default tag list narrowed** from `["result", "json", "output", "answer", "response"]`
  to `["result", "json", "output"]`. `answer` and `response` are common in
  non-JSON contexts and caused false positives; they are now opt-in via
  `tags: ["result", "json", "output", "answer", "response"]`.

### Added

- Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
  via GitHub Actions OIDC.
- Biome lint + formatter; `npm run lint` / `npm run fix`.

## [0.1.0] - 2026-05-17

Initial release.
