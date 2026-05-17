# Contributing

Thanks for your interest. This is a small library, so the contribution loop is correspondingly small.

## Development

```bash
git clone https://github.com/ifapmzadu6/llm-json-extract.git
cd llm-json-extract
npm install
npm test           # vitest
npm run lint       # biome check
npm run fix        # biome auto-fix
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/
```

`npm test` runs the full suite; `npm run test:watch` for TDD.

## Pull Requests

- Add or update tests for any behavior change.
- Keep the public API surface small. Prefer composition over options; if you find yourself adding a fifth boolean to `ExtractOptions`, reconsider.
- Run `npm run fix` before opening a PR to apply the project's lint/format rules.
- CI runs on Node 20 / 22 / 24. Code that depends on Node-only APIs should be avoided — the library targets browsers and edge runtimes too.

## Issues

When reporting a parsing issue, please include:

1. The exact input string (escape special characters or use a code block).
2. What you expected `extractJson` to return.
3. What it actually returned, or the `LlmJsonExtractError` (`.stage`, `.message`, `.extracted`).

Minimal reproductions are gold.

## Releases

Maintainers tag `vX.Y.Z` from `main`; the GitHub Actions release workflow handles the npm publish with provenance.
