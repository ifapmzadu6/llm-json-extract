<div align="center">

<img src="https://raw.githubusercontent.com/ifapmzadu6/llm-json-extract/main/.github/assets/banner.svg" alt="llm-json-extract — extract clean, validated JSON from messy LLM output" width="820">

**Get clean, validated JSON out of any LLM response — even when the model rambles.**

[![npm version](https://img.shields.io/npm/v/llm-json-extract.svg)](https://www.npmjs.com/package/llm-json-extract)
[![CI](https://github.com/ifapmzadu6/llm-json-extract/actions/workflows/ci.yml/badge.svg)](https://github.com/ifapmzadu6/llm-json-extract/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/llm-json-extract.svg)](https://www.npmjs.com/package/llm-json-extract)
[![bundle size](https://img.shields.io/bundlejs/size/llm-json-extract?label=min%2Bgzip)](https://bundlejs.com/?q=llm-json-extract)
[![types](https://img.shields.io/npm/types/llm-json-extract.svg)](https://www.npmjs.com/package/llm-json-extract)
[![license](https://img.shields.io/npm/l/llm-json-extract.svg)](./LICENSE)

</div>

You ask a model for JSON. It gives you *this*:

```text
Sure! Let me think about this.

<thinking>The user wants three fruits with prices...</thinking>

Here's the data you asked for:

<result>
{
  "items": ['apple', 'banana', 'cherry'],  // single quotes + a comment
  "count": 3,                              // ...and a trailing comma
}
</result>

Hope that helps! Let me know if you need anything else.
```

One function call later, you have what you actually wanted:

```ts
import { extractJson } from "llm-json-extract";

const data = extractJson(llmOutput);
// { items: ["apple", "banana", "cherry"], count: 3 }
```

Add a schema and it's **fully typed and validated** too:

```ts
import { extractJsonWith } from "llm-json-extract";
import { z } from "zod";

const Schema = z.object({ items: z.array(z.string()), count: z.number() });

const data = extractJsonWith(llmOutput, Schema);
//    ^? { items: string[]; count: number }
```

No prompt gymnastics. No `"Respond with ONLY JSON, nothing else!!"` begging.
Let the model think out loud — this library finds the answer.

---

## Why does this exist?

The Anthropic API has tool use. OpenAI has Structured Outputs. **But a huge amount of real-world LLM plumbing never touches those APIs:**

- Shelling out to **`claude -p`** or **`codex exec`** from a script — you get free-form text back, period.
- **Local models** via Ollama / llama.cpp, where JSON mode is unreliable or unavailable.
- **Agent pipelines** where the model's response mixes reasoning, tool chatter, and the answer.
- Any place you ask for JSON **via prompt** instead of via API parameter.

And there's a quality angle: forcing a model into JSON-only output often **hurts accuracy on reasoning-heavy tasks**. The pattern that works better — and the one [Anthropic recommends](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags) — is to let the model reason freely and wrap its final answer in an XML tag like `<result>…</result>`, then extract it.

`llm-json-extract` is that pattern, productionized: tag extraction with **layered fallbacks** for every way models don't quite follow instructions, plus [`jsonrepair`](https://github.com/josdejong/jsonrepair) for the almost-JSON they produce, plus **schema validation** that automatically skips wrong candidates.

## Highlights

- 🧠 **Prose-tolerant** — reasoning, apologies, and closing pleasantries are all ignored; only the answer comes out
- 🏷️ **XML-tag aware** — `<result>`, `<json>`, `<output>` by default; fully configurable
- 🪜 **Layered fallbacks** — tag → ` ```json ` fence → bare fence → balanced `{…}` / `[…]` in raw text
- 🔁 **Parse-aware fallthrough** — if the best candidate fails to parse (or fails your schema), the next one is tried automatically
- 🎯 **Example-echo safe** — `pickLast` grabs the *final* `<result>` block, not the example the model copied from your prompt
- 🩹 **Repairs almost-JSON** — trailing commas, single quotes, comments, unquoted keys, via `jsonrepair`
- ✅ **Bring your own validator** — pass a zod schema directly, or any `(unknown) => T` function (valibot, arktype, hand-rolled)
- 🪶 **Tiny & dependable** — one dependency (`jsonrepair`), zero required peer deps, ESM + CJS, full TypeScript types, tree-shakeable
- 🧯 **Typed errors** — `LlmJsonExtractError` tells you *which stage* failed (`extract` / `parse` / `validate`) and hands you the raw text for debugging

## Install

```bash
npm install llm-json-extract
# pnpm add llm-json-extract
# yarn add llm-json-extract
```

Requires Node 18+ (tested on 20 / 22 / 24 / 26; Node 18 is EOL — covered by a smoke test only). Works in ESM and CommonJS.

## 60-second tutorial

**1. Prompt the model** — ask it to wrap the answer, and explicitly *allow* prose:

```text
Think through the problem step by step, then put your final JSON answer
in <result>...</result>. Anything outside the tags is ignored.
```

**2. Extract:**

```ts
import { extractJson } from "llm-json-extract";

const data = extractJson(llmOutput); // unknown — parsed JSON
```

**3. Or extract + validate in one step** (recommended — wrong candidates that happen to parse are skipped until one satisfies your schema):

```ts
import { extractJsonWith } from "llm-json-extract";
import { z } from "zod";

const User = z.object({
  name: z.string(),
  age: z.number(),
  hobbies: z.array(z.string()),
});

const user = extractJsonWith(llmOutput, User);
//    ^? z.infer<typeof User>
```

That's the whole API for most users. Two more functions exist for advanced cases — see [API](#api).

## What it survives

Real model output is messy in predictable ways. All of these extract cleanly with the defaults:

| The model did this | What happens |
| --- | --- |
| Wrapped the answer in `<result>…</result>` with prose around it | Tag body is extracted — the happy path |
| Used `<json>` or `<output>` instead | Also matched by default; tag list is configurable |
| Echoed your prompt's `<result>` example *and* gave a real answer | `pickLast` picks the final block; the echo is still tried as a fallback |
| Ignored the tags and used a ` ```json ` code fence | Fence fallback catches it |
| Ignored the fence too and dumped bare JSON mid-paragraph | Balanced `{…}` / `[…]` scanner catches it |
| Emitted trailing commas, comments, single quotes, unquoted keys | `jsonrepair` fixes it before `JSON.parse` |
| Put triple backticks *inside* a JSON string value | Fence parsing is CommonMark-aware; the fence doesn't end early |
| Produced a first candidate that parses but fails your schema | `extractJsonWith` moves on to the next candidate |
| Returned nothing JSON-shaped at all | Throws `LlmJsonExtractError` with `stage` and the raw text |

## API

| Function | Returns | Use when |
| --- | --- | --- |
| `extractJsonWith(text, schema, opts?)` | `T` (validated) | **Default choice.** You know the shape you expect |
| `extractJson(text, opts?)` | `unknown` (parsed) | You'll validate or inspect it yourself |
| `extractJsonString(text, opts?)` | `string \| null` | You want the raw JSON substring (piping, logging) |
| `extractJsonCandidates(text, opts?)` | `string[]` | You want every candidate to score/pick yourself |

### `extractJsonWith` — extract, parse, validate

Accepts **anything with a `.parse(unknown) => T` method** (zod schemas work as-is) or **any plain function** `(unknown) => T` that throws on bad input:

```ts
// zod — pass the schema directly
const user = extractJsonWith(text, UserSchema);

// valibot
import * as v from "valibot";
const user = extractJsonWith(text, (x) => v.parse(UserSchema, x));

// arktype
import { type } from "arktype";
const User = type({ name: "string", age: "number" });
const user = extractJsonWith(text, (x) => User.assert(x));

// no library at all
const user = extractJsonWith(text, (x) => {
  if (typeof x !== "object" || x === null || !("name" in x)) throw new Error("nope");
  return x as { name: string };
});
```

Candidates that parse but **fail validation are skipped** in favor of the next one — this is what makes stray object literals in prose harmless.

### `extractJson` — extract and parse

```ts
const data = extractJson(llmOutput); // unknown
```

Tries each candidate in order and returns the first that parses. Structured results (objects/arrays) are preferred over primitives, so `jsonrepair` turning a stray prose word into a JSON string can't mask the real answer.

### `extractJsonString` / `extractJsonCandidates`

```ts
const jsonStr = extractJsonString(llmOutput);      // best candidate, unparsed
const all = extractJsonCandidates(llmOutput);      // every candidate, ordered by preference
```

## Recipes

### Pipe from Claude Code CLI

```bash
claude -p 'List 3 fruits. Reply as <result>{"items":[...]}</result>.' \
  --output-format json \
  | jq -r .result \
  | node --input-type=module -e '
      import { extractJson } from "llm-json-extract";
      let buf = "";
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => console.log(JSON.stringify(extractJson(buf))));
    '
```

(`llm-json-extract` must be installed in the current directory's `node_modules`.)

### Wrap `codex exec` (or any CLI) in a typed function

```ts
import { execSync } from "node:child_process";
import { extractJsonWith } from "llm-json-extract";
import { z } from "zod";

const Fruits = z.object({ items: z.array(z.string()) });

function askForFruits(): z.infer<typeof Fruits> {
  const out = execSync(`codex exec "List 3 fruits as <result>{...}</result>"`, {
    encoding: "utf8",
  });
  return extractJsonWith(out, Fruits);
}
```

### Retry loop that feeds the failure back to the model

`LlmJsonExtractError` carries everything you need to tell the model what went wrong:

```ts
import { extractJsonWith, LlmJsonExtractError } from "llm-json-extract";

async function askWithRetry<T>(prompt: string, schema: { parse: (x: unknown) => T }) {
  let lastHint = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const output = await callModel(prompt + lastHint);
    try {
      return extractJsonWith(output, schema);
    } catch (e) {
      if (!(e instanceof LlmJsonExtractError)) throw e;
      lastHint = `\n\nYour previous reply failed at the "${e.stage}" stage` +
        `${e.extracted ? ` on: ${e.extracted}` : ""}. ` +
        `Reply again with valid JSON inside <result>...</result>.`;
    }
  }
  throw new Error("Model never produced valid JSON");
}
```

### Prompting tips

The library's superpower is that **you don't have to suppress the model's reasoning** — so don't. Prompts like this get better answers *and* parse reliably:

```text
Think step by step. When you're done, wrap your final JSON answer in
<result>...</result>. Prose outside the tags is fine and will be ignored.
```

If your prompt contains a formatting *example*, use a different tag for it so it can never be confused with the answer:

```text
Example format (do not copy these values):
<example>{"score": 0}</example>

Your real answer goes in <result>...</result>.
```

(Even if the model echoes a `<result>` example, `pickLast` usually saves you — the real answer comes last. The distinct tag just makes it bulletproof.)

## Options

Every function takes the same options object. These are the defaults:

```ts
extractJson(llmOutput, {
  tags: ["result", "json", "output"], // tag names to scan for (case-insensitive, attributes OK)
  pickLast: true,     // prefer the tag match closest to the end of the text
  tryCodeFence: true, // fall back to ```json / ``` fenced blocks
  tryBareJson: true,  // fall back to balanced {...} / [...] runs in raw text
  repair: true,       // run jsonrepair before JSON.parse
});
```

> **Note:** tag priority is decided by *document position* (per `pickLast`), not by order in the `tags` array.

## Error handling

All failures throw a single, inspectable error type:

```ts
import { extractJson, LlmJsonExtractError } from "llm-json-extract";

try {
  const data = extractJson(llmOutput);
} catch (e) {
  if (e instanceof LlmJsonExtractError) {
    e.stage;     // "extract" — nothing JSON-shaped found
                 // "parse"   — candidates found, none parsed
                 // "validate"— parsed, but your schema rejected everything
    e.raw;       // the full original input
    e.extracted; // the substring that was attempted (or null)
    e.cause;     // the underlying JSON.parse / validator error
  }
}
```

## How it works

```
input text
   │
   ├─ 1. tag matches        <result>…</result>, <json>…</json>, <output>…</output>
   │       preferred match first (pickLast), then the rest in document order
   ├─ 2. code fences        ```json blocks first, then bare ``` blocks
   └─ 3. bare JSON          balanced {…} / […] runs, string- and escape-aware
   │
   ▼
candidate list ──► for each: jsonrepair → JSON.parse → (your validator)
                             first success wins; objects/arrays beat primitives
```

Details worth knowing:

- Tag matching is case-insensitive and tolerates attributes (`<result lang="json">`).
- The bare-JSON scanner respects JSON strings, escapes, and `//` / `/* */` comments, so braces inside string values never confuse it.
- Fence parsing follows CommonMark closing rules — a ```` ``` ```` inside a JSON string won't terminate the block.
- Everything is a single linear scan per strategy; the fence regexes were specifically hardened against ReDoS.

## When *not* to use this

If you're calling the Anthropic or OpenAI API directly, use **tool use** (Claude) or **Structured Outputs** (OpenAI). They enforce the schema at the decoding step — a stronger guarantee than any post-hoc parser can give. This library is for all the places where that option doesn't exist.

| | Provider structured output | `JSON.parse` | `jsonrepair` alone | **llm-json-extract** |
| --- | :-: | :-: | :-: | :-: |
| Works with CLI / local / prompt-only output | ❌ | ✅ | ✅ | ✅ |
| Finds JSON buried in prose & reasoning | — | ❌ | ❌ | ✅ |
| Repairs trailing commas, comments, quotes | — | ❌ | ✅ | ✅ |
| Multiple candidates with fallback | — | ❌ | ❌ | ✅ |
| Schema validation with candidate retry | ✅ (enforced) | ❌ | ❌ | ✅ |

## FAQ

**Does it need zod?**
No. There are zero required peer dependencies. Validation is opt-in and works with zod, valibot, arktype, or any function that throws on bad input.

**What if the model outputs *only* JSON, no tags or prose?**
Works fine — the bare-JSON fallback picks it up. Tags just make extraction unambiguous.

**Can I use my own tag names?**
Yes: `extractJson(text, { tags: ["answer"] })`.

**Does it handle streaming?**
Buffer the stream first (see the CLI recipe) — extraction operates on complete text.

**How big is it?**
A few kilobytes plus `jsonrepair`. Check the bundle badge at the top for the current min+gzip number.

## Contributing

Bug reports and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). The test suite (`npm test`) covers every fallback path, and CI runs on Node 20–26.

## License

[MIT](./LICENSE) © Keisuke Karijuku
