# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-14

### Added

- `llm-json-extract` CLI (`npx llm-json-extract`). Reads LLM output from stdin
  or a file and prints the extracted JSON to stdout, exposing the same
  extraction pipeline as the library: `--tag` (repeatable), `--first`,
  `--no-fence`, `--no-bare`, `--no-repair`, `--raw`, and `--pretty`. Exit codes:
  `0` success, `1` nothing extracted/parsed, `2` usage error.

### Fixed

- Removed a polynomial-time backtracking (ReDoS) hazard in the inline code-fence
  patterns. The ` ```json ... ``` ` / ` ``` ... ``` ` regexes paired a `[ \t]+`
  separator with a lazy `[^\n]*?` body whose character class also matches spaces
  and tabs; an unterminated fence containing a long run of whitespace could make
  the two quantifiers backtrack quadratically. They now require a single fixed
  separator character, keeping matching linear. Accepted inputs are unchanged.
- The `bin` entry in `package.json` no longer uses a `./` path prefix. Newer
  npm versions treat the prefixed path as invalid and silently drop the bin
  entry at publish time, which would have shipped the package without the
  `llm-json-extract` executable.

## [1.0.0] - 2026-07-13

First stable release. The public API (`extractJson`, `extractJsonString`,
`extractJsonCandidates`, `extractJsonWith`, `Validator`, `ExtractOptions`,
`LlmJsonExtractError`) is now covered by semantic versioning.

### Fixed

- Block-form code fences (a language tag or bare ` ``` ` followed by a newline)
  now require their closing fence to sit on its own line, matching CommonMark.
  Previously the fence closed at the first triple-backtick sequence anywhere in
  the body, so triple backticks inside a JSON string value terminated the fence
  early and yielded a truncated, wrong-but-parseable candidate.

### Changed

- Updated dependencies: `jsonrepair` ^3.15.0, `@biomejs/biome` ^2.5.3,
  `@types/node` ^26.1.1, `tsup` ^8.5.1, `vitest` ^4.1.10.
- Migrated the Biome configuration to the 2.5 schema.

## [0.6.1] - 2026-05-23

### Fixed

- Avoid truncating tagged JSON when a string value contains a literal closing
  tag such as `</result>`.
- Improve bare JSON scanning to avoid repeated rescans on malformed inputs with
  many unclosed braces or brackets.
- Support JSONC-style comments during bare JSON candidate scanning so
  `jsonrepair` can repair those candidates.
- Preserve repairable malformed candidates with missing nested closers.

## [0.6.0] - 2026-05-18

### Added

- `extractJsonWith` now accepts a schema-like object directly (anything with a
  `.parse(unknown) => T` method, e.g. a zod schema). This sidesteps the
  `@typescript-eslint/unbound-method` warning that fires when passing
  `Schema.parse` as a bare callback, and reads more naturally:

  ```ts
  // before
  extractJsonWith(text, Schema.parse);          // works, but unbound-method warns
  extractJsonWith(text, (x) => Schema.parse(x)); // ugly

  // after
  extractJsonWith(text, Schema);                // clean
  ```

  The existing `(value: unknown) => T` function form continues to work
  unchanged (used for valibot / arktype / ad-hoc validators).
- `Validator<T>` interface exported for typing custom schema-like objects.

## [0.5.2] - 2026-05-18

### Changed

- Dev-only: TypeScript 5 → 6. Added `"ignoreDeprecations": "6.0"` to
  `tsconfig.json` to silence the `baseUrl` deprecation that tsup's bundled
  dts plugin currently triggers under TS 6.

## [0.5.1] - 2026-05-18

### Changed

- Dev-only: bump dev dependencies via Dependabot — `zod` 3 → 4, `vitest`
  2 → 4, `@types/node` 22 → 25. TypeScript pinned at 5.x pending tsup
  compatibility with TS 6 (tsup's dts plugin currently emits a TS5101
  deprecation error under TS 6). No runtime impact for library consumers.

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

[1.1.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.6.1...v1.0.0
[0.6.1]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ifapmzadu6/llm-json-extract/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ifapmzadu6/llm-json-extract/releases/tag/v0.1.0
