# llm-json-extract

[![npm version](https://img.shields.io/npm/v/llm-json-extract.svg)](https://www.npmjs.com/package/llm-json-extract)
[![license](https://img.shields.io/npm/l/llm-json-extract.svg)](./LICENSE)

Extract and validate JSON from messy LLM output — **the model is free to think out loud, explain itself, or wrap its answer in prose.** As long as the actual JSON is somewhere in the response (ideally inside `<result>...</result>` tags), you'll get a clean parsed object back.

Designed for workflows where **provider-native structured output is not available** — Claude Code CLI, Codex CLI, agent frameworks, or any pipeline that asks a model for JSON via prompt rather than `tool_use` / `response_format`.

```ts
import { extractJson } from "llm-json-extract";

const text = `
<thinking>The user wants a list of fruits...</thinking>
<result>
{
  "items": ["apple", "banana", "cherry"],
  "count": 3,  // trailing comma — fine
}
</result>
`;

const data = extractJson(text);
// data === { items: ["apple", "banana", "cherry"], count: 3 }
```

With a schema:

```ts
import { extractJsonWith } from "llm-json-extract";
import { z } from "zod";

const Schema = z.object({ items: z.array(z.string()), count: z.number() });
const value = extractJsonWith(text, Schema.parse);
// fully typed, validated
```

## Why?

The Anthropic API has `tool_use`. OpenAI has Structured Outputs. **But CLIs don't expose them.** If you're shelling out to `claude -p` or `codex exec` from a batch script, the only thing you get back is free-form text — possibly with reasoning, prose, code fences, or trailing commas mixed in.

And even when you *can* enforce JSON-only output, doing so often hurts answer quality on reasoning-heavy tasks. Letting the model think freely and just **pulling the JSON back out of its response** is usually the better trade-off.

This package implements the de-facto pattern Anthropic recommends in [their docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags): **ask the model to wrap its answer in an XML tag, then extract it.** With fallbacks for the common cases where the model didn't quite follow instructions.

## Features

- **Prose-tolerant by design** — the model can think out loud; only the tagged answer is extracted
- **XML tag aware** — finds `<result>...</result>`, `<json>...</json>`, etc. (configurable)
- **Multi-stage fallbacks** — tag → fenced code block → bare `{...}` / `[...]` in raw text
- **Parse-aware fallthrough** — if the preferred candidate fails to parse (or fails your schema), the next candidate is tried automatically; object/array results are preferred over stray primitives
- **Document-position `pickLast`** — when the model echoes a prompt example, picks the *real* answer at the end
- **`jsonrepair` integrated** — fixes trailing commas, single quotes, comments, unquoted keys
- **Schema-agnostic validation** — pass `zod.parse`, `valibot`, `arktype`, or any `(unknown) => T`
- **No required peer deps** — works standalone, opt-in validation
- **Typed errors** — `LlmJsonExtractError` with `stage` (`extract` / `parse` / `validate`) and the raw text for debugging
- **ESM + CJS** dual build, full `.d.ts`, npm provenance signed

## Install

```bash
npm install llm-json-extract
# or
pnpm add llm-json-extract
# or
yarn add llm-json-extract
```

## Usage

### Prompt the model

The whole point of this library is that **the model doesn't need to output JSON only** — it can think out loud, explain itself, apologize, add a friendly closing line, whatever. As long as the actual answer is wrapped in `<result>...</result>` somewhere, you'll get clean JSON out. This is a feature, not a bug: forcing JSON-only output often degrades answer quality, especially for reasoning-heavy tasks.

**Minimal — wrap the answer, prose is fine:**

```text
Wrap your final JSON answer in <result>...</result>. You can explain
your reasoning freely before or after.
```

**Encourage reasoning (often improves quality):**

```text
Think through the problem step by step. When you're ready, put the
final JSON answer in <result>...</result>. You don't need to suppress
your reasoning — anything outside the tags is ignored.
```

**With a schema:**

```text
Return JSON matching this schema, wrapped in <result>...</result>:

{
  "name": string,
  "age": integer,
  "hobbies": string[]
}

Trailing commas, comments, and single quotes are tolerated. Prose
outside the tags is fine.
```

**Avoid example-echo collisions:**

If your prompt shows an example like `<result>{"score": 0}</result>`, the model may echo it as part of its reasoning. `pickLast` (default) grabs the **last** `<result>` block, which is normally the real answer — but you can be explicit by using a different tag for the example:

```text
Example format (do not copy these values):
<example>{"score": 0}</example>

Your real answer goes in <result>...</result>.
```

### Extract

```ts
import { extractJson } from "llm-json-extract";

const data = extractJson(modelOutput);
```

### Extract + validate (zod)

```ts
import { extractJsonWith } from "llm-json-extract";
import { z } from "zod";

const User = z.object({
  name: z.string(),
  age: z.number(),
  hobbies: z.array(z.string()),
});

const user = extractJsonWith(modelOutput, User.parse);
//    ^ type is z.infer<typeof User>
```

### Extract + validate (valibot)

```ts
import { extractJsonWith } from "llm-json-extract";
import * as v from "valibot";

const User = v.object({ name: v.string(), age: v.number() });
const user = extractJsonWith(modelOutput, (x) => v.parse(User, x));
```

### Just the string (for piping)

```ts
import { extractJsonString } from "llm-json-extract";

const jsonStr = extractJsonString(modelOutput); // string | null — not parsed
```

### All candidates (advanced)

```ts
import { extractJsonCandidates } from "llm-json-extract";

const candidates = extractJsonCandidates(modelOutput);
// e.g. ["<final answer>", "<earlier echo>", "<fence body>", "<stray bare JSON>"]
```

Useful when you want to score, log, or pick candidates yourself. `extractJson` and `extractJsonWith` already try each candidate automatically, so most users don't need this.

## CLI example

Pipe Claude Code CLI output directly:

```bash
claude -p 'List 3 fruits. Reply as <result>{"items":[...]}</result>.' \
  --output-format json \
  | jq -r .result \
  | node -e '
      import("llm-json-extract").then(({ extractJson }) => {
        let buf=""; process.stdin.on("data",d=>buf+=d).on("end",()=>{
          console.log(extractJson(buf));
        });
      });
    '
```

Or in a Node script that calls `codex exec` / `claude -p`:

```ts
import { execSync } from "node:child_process";
import { extractJsonWith } from "llm-json-extract";
import { z } from "zod";

const out = execSync(`codex exec "List 3 fruits as <result>{...}</result>"`, {
  encoding: "utf8",
});

const Schema = z.object({ items: z.array(z.string()) });
const { items } = extractJsonWith(out, Schema.parse);
```

## Options

```ts
extractJson(text, {
  tags: ["result", "json", "output"], // tag names; document position decides priority (not list order)
  pickLast: true,         // when multiple matches, prefer the one closer to the end
  tryCodeFence: true,     // also collect ```json``` / ``` ``` blocks as candidates
  tryBareJson: true,      // also collect balanced {...} / [...] runs as candidates
  repair: true,           // run jsonrepair before JSON.parse
});
```

## Errors

```ts
import { LlmJsonExtractError } from "llm-json-extract";

try {
  extractJson(text);
} catch (e) {
  if (e instanceof LlmJsonExtractError) {
    e.stage;     // "extract" | "parse" | "validate"
    e.raw;       // the original input
    e.extracted; // the substring we tried to parse (or null)
  }
}
```

## Extraction strategy

A list of candidate JSON strings is built in this order:

1. **Tag match** — `<result>`, `<json>`, `<output>` by default (case-insensitive, attributes OK). The preferred match (last in document by default; controlled by `pickLast`) goes first, then other matches in document order.
2. **Code fence** — ```` ```json ```` blocks first, then bare ```` ``` ``` ```` blocks, in document order.
3. **Bare JSON** — balanced `{...}` / `[...]` runs in the text, respecting strings and escapes.

Then `extractJson` walks the candidate list, running [`jsonrepair`](https://github.com/josdejong/jsonrepair) and `JSON.parse` on each, returning the first one that yields an **object or array**. If only primitives (strings, numbers, etc.) parse — which happens when `jsonrepair` turns a stray prose word like `nope` into a string — those are returned only as a last resort. `extractJsonWith` does the same, additionally skipping candidates that fail your validator.

## When **not** to use this

If you can call the Anthropic or OpenAI API directly, prefer **tool use** (Claude) or **Structured Outputs** (OpenAI) — they enforce schemas at the decoding step, with stronger guarantees than any post-hoc parser can give. This library is for the cases where you can't.

## License

MIT
