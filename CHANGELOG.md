# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-05-18

### Fixed

- `findBalancedEnd` no longer treats `\` as an escape outside of JSON strings.
  In practice this only affected inputs where stray backslashes in surrounding
  prose happened to land next to a brace, but the previous behavior could
  miscount brace balance in pathological cases.

### Added

- README badges (CI status, downloads, bundle size, types).
- Multi-Node CI matrix (Node 20, 22, 24).
- `SECURITY.md`, `CONTRIBUTING.md`, Dependabot configuration.
- More edge-case tests: unicode, deep nesting, escaped quotes, stray
  backslashes in prose, empty objects/arrays.

## [0.4.0] - 2026-05-18

### Added

- `extractJsonCandidates(text, options)` — returns all candidate JSON strings
  in priority order. Useful for inspecting, logging, or implementing custom
  scoring on top of the library.
- `extractJson` and `extractJsonWith` now perform **parse-aware fallthrough**:
  if the preferred candidate fails to parse (or fails the supplied validator),
  the next candidate is tried automatically.
- Object/array results are preferred over primitive results, so that stray
  words in prose (which `jsonrepair` happily turns into JSON strings) don't
  mask the real structured answer elsewhere in the response.

### Changed

- `extractJsonString` now always returns a trimmed string (previously the
  bare-JSON fallback path returned untrimmed).

## [0.3.0] - 2026-05-18

### Changed

- CI / release workflow upgraded to `actions/{checkout,setup-node}@v6` and
  Node 24 (ships with npm 11). Resolves the Node 20 runner deprecation warning
  and lets npm auto-detect OIDC for trusted publishing without an explicit
  npm-upgrade step. No runtime behavior change for library consumers.

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

[0.5.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ifapmzadu6/llm-json-extract/releases/tag/v0.1.0
