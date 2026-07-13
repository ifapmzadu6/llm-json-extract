import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractJson,
  extractJsonCandidates,
  extractJsonString,
  extractJsonWith,
  LlmJsonExtractError,
} from "../src/index.js";

describe("extractJsonString", () => {
  it("extracts from <result> tag", () => {
    const out = extractJsonString(`Thinking...\n<result>{"a": 1}</result>\nDone.`);
    expect(out).toBe('{"a": 1}');
  });

  it("picks the last <result> when pickLast=true (default)", () => {
    const text = `Example: <result>{"x": 0}</result>\nFinal: <result>{"x": 9}</result>`;
    expect(extractJsonString(text)).toBe('{"x": 9}');
  });

  it("picks the first when pickLast=false", () => {
    const text = `<result>{"x": 0}</result>\n<result>{"x": 9}</result>`;
    expect(extractJsonString(text, { pickLast: false })).toBe('{"x": 0}');
  });

  it("falls through tag order to <json>", () => {
    const out = extractJsonString(`<json>[1,2,3]</json>`);
    expect(out).toBe("[1,2,3]");
  });

  it("picks the tag that appears LAST in document, not the highest-priority tag", () => {
    // <result> is in the defaults but appears before <output>. pickLast (default)
    // should pick the <output> match because it appears later in the text.
    const text = `<result>{"old": 1}</result>\n\n<output>{"new": 2}</output>`;
    expect(extractJsonString(text)).toBe('{"new": 2}');
  });

  it("picks the FIRST tag occurrence regardless of tag list order when pickLast=false", () => {
    const text = `<output>{"new": 2}</output>\n<result>{"old": 1}</result>`;
    expect(extractJsonString(text, { pickLast: false })).toBe('{"new": 2}');
  });

  it("does NOT match <answer> by default (not in default tag list anymore)", () => {
    // Bare-JSON fallback will still find the inner JSON, but the tag itself
    // is not honored as a tag boundary.
    const out = extractJsonString(`prose <answer>{"a":1}</answer> tail`);
    // Bare JSON falls back to first balanced {...}.
    expect(out).toBe('{"a":1}');
  });

  it("matches <answer> when explicitly enabled", () => {
    const text = `prose <answer>{"a":1}</answer> tail`;
    expect(extractJsonString(text, { tags: ["answer"] })).toBe('{"a":1}');
  });

  it("supports custom tags", () => {
    const out = extractJsonString(`<final>{"ok":true}</final>`, {
      tags: ["final"],
    });
    expect(out).toBe('{"ok":true}');
  });

  it("falls back to ```json fence", () => {
    const out = extractJsonString('Sure!\n```json\n{"a":1}\n```\n');
    expect(out).toBe('{"a":1}');
  });

  it("falls back to bare ``` fence", () => {
    const out = extractJsonString("```\n[1,2]\n```");
    expect(out).toBe("[1,2]");
  });

  it("extracts inline ```json fence", () => {
    const out = extractJsonString('```json {"a":1} ```');
    expect(out).toBe('{"a":1}');
  });

  it("extracts inline bare ``` fence", () => {
    const out = extractJsonString("``` [1,2] ```");
    expect(out).toBe("[1,2]");
  });

  it("prefers inline ```json fence over inline bare ``` fence", () => {
    const out = extractJsonString('```json {"a":1} ``` ``` [2,3] ```');
    expect(out).toBe('{"a":1}');
  });

  it("extracts inline ```json fence with extra whitespace", () => {
    const out = extractJsonString('```json   {"a":1}   ```');
    expect(out).toBe('{"a":1}');
  });

  it("falls back to bare JSON when fence has no separator after language tag", () => {
    const out = extractJsonString('```json{"a":1}```');
    expect(out).toBe('{"a":1}');
  });

  it("returns quickly on an unterminated inline fence with a long whitespace run (no ReDoS)", () => {
    // A `[ \t]+` separator paired with the lazy `[^\n]*?` body used to backtrack
    // polynomially on unterminated fences. This adversarial input must stay linear.
    const evil = `\`\`\`json${" ".repeat(200_000)}x`;
    const start = performance.now();
    const out = extractJsonString(evil);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out).toBeNull();
  });

  it("does not close a block ```json fence on triple backticks inside a string", () => {
    const out = extractJson('```json\n{"code": "```py"}\n```');
    expect(out).toEqual({ code: "```py" });
  });

  it("does not close a block bare ``` fence on triple backticks inside a string", () => {
    const out = extractJson('```\n{"code": "```py"}\n```');
    expect(out).toEqual({ code: "```py" });
  });

  it("ignores mid-line triple backticks when closing a block fence", () => {
    const out = extractJsonString('```json\n{"a":1}\n```\ntrailing ``` noise');
    expect(out).toBe('{"a":1}');
  });

  it("falls back to bare JSON object", () => {
    const out = extractJsonString('Here you go: {"a":1,"b":2} done.');
    expect(out).toBe('{"a":1,"b":2}');
  });

  it("falls back to bare JSON array", () => {
    const out = extractJsonString("answer is [1, 2, 3] yes");
    expect(out).toBe("[1, 2, 3]");
  });

  it("returns null when nothing JSON-like", () => {
    expect(extractJsonString("just prose here")).toBeNull();
  });

  it("ignores braces inside strings", () => {
    const out = extractJsonString('text {"k":"a } b"} tail');
    expect(out).toBe('{"k":"a } b"}');
  });

  it("handles escaped quotes inside strings", () => {
    const out = extractJsonString('{"k":"a \\"b\\" c"}');
    expect(out).toBe('{"k":"a \\"b\\" c"}');
  });

  it("tag match is case-insensitive", () => {
    expect(extractJsonString('<RESULT>{"a":1}</RESULT>')).toBe('{"a":1}');
  });

  it("tag with attributes works", () => {
    expect(extractJsonString('<result type="json">{"a":1}</result>')).toBe('{"a":1}');
  });
});

describe("extractJson (parse)", () => {
  it("parses repaired JSON (trailing comma)", () => {
    expect(extractJson('<result>{"a":1,}</result>')).toEqual({ a: 1 });
  });

  it("parses repaired JSON (single quotes)", () => {
    expect(extractJson("<result>{'a': 1}</result>")).toEqual({ a: 1 });
  });

  it("parses repaired JSON (line comment)", () => {
    expect(extractJson('<result>{\n// comment\n"a": 1\n}</result>')).toEqual({
      a: 1,
    });
  });

  it("parses repaired JSON (unquoted keys)", () => {
    expect(extractJson("<result>{a: 1, b: 2}</result>")).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("keeps repairable bare JSON candidates with missing nested closers", () => {
    expect(extractJson("{a: [1, 2}")).toEqual({ a: [1, 2] });
  });

  it("repair=false rejects malformed input", () => {
    expect(() => extractJson("<result>{a: 1}</result>", { repair: false })).toThrow(
      LlmJsonExtractError,
    );
  });

  it("throws extract error when no JSON found", () => {
    try {
      extractJson("nothing here");
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmJsonExtractError);
      expect((e as LlmJsonExtractError).stage).toBe("extract");
    }
  });
});

describe("extractJsonWith (validation)", () => {
  const User = z.object({
    name: z.string(),
    age: z.number(),
  });

  it("validates via zod schema parse", () => {
    const text = `<result>{"name":"taro","age":32}</result>`;
    const u = extractJsonWith(text, User.parse);
    expect(u).toEqual({ name: "taro", age: 32 });
  });

  it("accepts a schema-like object directly (no .parse unwrap)", () => {
    const text = `<result>{"name":"taro","age":32}</result>`;
    // Passing the zod schema as-is — library detects `.parse` method.
    const u = extractJsonWith(text, User);
    expect(u).toEqual({ name: "taro", age: 32 });
  });

  it("accepts a custom { parse } validator", () => {
    const text = `<result>{"x":1}</result>`;
    const schema = {
      parse: (v: unknown): { x: number } => {
        if (typeof v !== "object" || v === null || !("x" in v)) throw new Error("bad");
        return v as { x: number };
      },
    };
    expect(extractJsonWith(text, schema)).toEqual({ x: 1 });
  });

  it("schema-direct path surfaces validate-stage errors the same way", () => {
    const text = `<result>{"name":"taro"}</result>`;
    try {
      extractJsonWith(text, User);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmJsonExtractError);
      expect((e as LlmJsonExtractError).stage).toBe("validate");
    }
  });

  it("validates with a plain function", () => {
    const text = `<result>[1,2,3]</result>`;
    const arr = extractJsonWith(text, (v): number[] => {
      if (!Array.isArray(v)) throw new Error("not array");
      return v as number[];
    });
    expect(arr).toEqual([1, 2, 3]);
  });

  it("throws validate-stage error on schema mismatch", () => {
    const text = `<result>{"name":"taro"}</result>`;
    try {
      extractJsonWith(text, User.parse);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmJsonExtractError);
      expect((e as LlmJsonExtractError).stage).toBe("validate");
    }
  });
});

describe("real-world LLM output samples", () => {
  it("handles Claude-style thinking + result", () => {
    const text = `<thinking>
The user asked for a list. Let me build one.
</thinking>
<result>
{
  "items": ["apple", "banana", "cherry"],
  "count": 3,
}
</result>`;
    expect(extractJson(text)).toEqual({
      items: ["apple", "banana", "cherry"],
      count: 3,
    });
  });

  it("handles example-in-prompt + real answer (pickLast)", () => {
    const text = `Format like: <result>{"score": 0}</result>

Here is the actual answer:
<result>{"score": 87}</result>`;
    expect(extractJson(text)).toEqual({ score: 87 });
  });

  it("handles prose + fenced json", () => {
    const text = `Sure, here you go:

\`\`\`json
{
  "ok": true,
  "ids": [1, 2, 3]
}
\`\`\`

Let me know if you need anything else.`;
    expect(extractJson(text)).toEqual({ ok: true, ids: [1, 2, 3] });
  });

  it("handles raw object only", () => {
    expect(extractJson('{"x":1}')).toEqual({ x: 1 });
  });
});

describe("fallthrough across candidates", () => {
  it("falls through to next tag match when the picked one is unparseable", () => {
    // Last <result> is unparseable garbage; earlier one is valid.
    const text = `<result>{"good": 1}</result>\n<result>this is not json at all{</result>`;
    expect(extractJson(text)).toEqual({ good: 1 });
  });

  it("falls through to fence when all tag bodies are unparseable", () => {
    const text = `<result>nope</result>\n\n\`\`\`json\n{"from":"fence"}\n\`\`\``;
    expect(extractJson(text)).toEqual({ from: "fence" });
  });

  it("falls through to bare JSON when fence is also unparseable", () => {
    const text = `<result>nope</result>\n\`\`\`\njust prose\n\`\`\`\n{"from":"bare"}`;
    expect(extractJson(text)).toEqual({ from: "bare" });
  });

  it("extractJsonWith falls through past parseable-but-invalid candidates", () => {
    // First candidate parses but fails schema; second parses and validates.
    const Schema = z.object({ kind: z.literal("real"), value: z.number() });
    const text = `Earlier I wrote {"kind":"placeholder"} but the real answer is:
<result>{"kind": "real", "value": 42}</result>`;
    expect(extractJsonWith(text, Schema.parse)).toEqual({ kind: "real", value: 42 });
  });

  it("throws with last error when no candidate parses or validates", () => {
    const Schema = z.object({ ok: z.literal(true) });
    const text = `<result>{"ok": false}</result>`;
    try {
      extractJsonWith(text, Schema.parse);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmJsonExtractError);
      expect((e as LlmJsonExtractError).stage).toBe("validate");
    }
  });

  it("reports the structured candidate's error over a later primitive's", () => {
    // Preferred (last) <result> body is bare prose that jsonrepair turns into
    // a string primitive; the earlier <result> is the real structured answer
    // but fails the schema. The reported error should point at the structured
    // candidate, not the stray prose.
    const Schema = z.object({ ok: z.literal(true) });
    const text = `<result>{"ok": false}</result>\n<result>nope</result>`;
    try {
      extractJsonWith(text, Schema.parse);
      expect.fail("should throw");
    } catch (e) {
      const err = e as LlmJsonExtractError;
      expect(err).toBeInstanceOf(LlmJsonExtractError);
      expect(err.stage).toBe("validate");
      expect(err.extracted).toBe('{"ok": false}');
    }
  });
});

describe("edge cases", () => {
  it("handles empty object and array", () => {
    expect(extractJson("<result>{}</result>")).toEqual({});
    expect(extractJson("<result>[]</result>")).toEqual([]);
  });

  it("handles deeply nested structure", () => {
    const text = `<result>${JSON.stringify({ a: { b: { c: { d: [1, [2, [3]]] } } } })}</result>`;
    expect(extractJson(text)).toEqual({ a: { b: { c: { d: [1, [2, [3]]] } } } });
  });

  it("handles unicode and emoji in JSON strings", () => {
    const text = `<result>{"emoji":"🎉","jp":"こんにちは","math":"∑"}</result>`;
    expect(extractJson(text)).toEqual({ emoji: "🎉", jp: "こんにちは", math: "∑" });
  });

  it("handles literal backslash sequences in prose around JSON", () => {
    // A stray backslash in prose used to confuse the brace scanner.
    const text = `Path is C:\\foo\\bar then JSON: {"k":1}`;
    expect(extractJson(text)).toEqual({ k: 1 });
  });

  it("handles escaped quotes correctly inside JSON strings", () => {
    const text = `<result>{"path":"C:\\\\foo\\\\bar","quote":"say \\"hi\\""}</result>`;
    expect(extractJson(text)).toEqual({ path: "C:\\foo\\bar", quote: 'say "hi"' });
  });

  it("handles JSON containing the closing tag string as a value", () => {
    const text = `<result>{"msg":"literal </result> inside"}</result>`;
    expect(extractJsonString(text)).toBe('{"msg":"literal </result> inside"}');
    expect(extractJson(text)).toEqual({ msg: "literal </result> inside" });
  });

  it("handles top-level JSON strings containing the closing tag string", () => {
    const text = `<result>"literal </result> inside"</result>`;
    expect(extractJsonString(text)).toBe('"literal </result> inside"');
    expect(extractJson(text)).toBe("literal </result> inside");
  });

  it("handles comments with quotes and braces in bare JSON", () => {
    const text = `{
      // comment with " and }
      "a": 1,
      /* another comment with " and ] */
      "b": 2,
    }`;
    expect(extractJson(text)).toEqual({ a: 1, b: 2 });
  });

  it("ignores trailing prose after JSON", () => {
    const text = `<result>{"a":1}</result>\n\nThanks!`;
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  it("handles whitespace-only input", () => {
    expect(() => extractJson("   \n\n  \t  ")).toThrow(LlmJsonExtractError);
  });
});

describe("extractJsonCandidates", () => {
  it("returns the preferred candidate first, then doc-order alternates", () => {
    const text = `<result>{"a": 1}</result>\n<result>{"a": 2}</result>\n\`\`\`json
{"a": 3}
\`\`\``;
    const cands = extractJsonCandidates(text);
    // Preferred (pickLast=true → last tag) comes first; remaining tag in doc order; then fence.
    expect(cands[0]).toBe('{"a": 2}');
    expect(cands[1]).toBe('{"a": 1}');
    expect(cands[2]).toBe('{"a": 3}');
  });

  it("dedupes identical candidates", () => {
    const text = `<result>{"a":1}</result>\n{"a":1}`;
    const cands = extractJsonCandidates(text);
    expect(cands).toEqual(['{"a":1}']);
  });

  it("recovers a valid bare JSON candidate after an unclosed opener", () => {
    const text = `bad prefix { never closes, then {"ok":true}`;
    expect(extractJsonCandidates(text)).toEqual(['{"ok":true}']);
  });

  it("returns only the outermost bare JSON candidate for nested objects", () => {
    const text = `before {"a":{"b":1},"c":[{"d":2}]} after`;
    expect(extractJsonCandidates(text)).toEqual(['{"a":{"b":1},"c":[{"d":2}]}']);
  });

  it("keeps deeply mismatched tag bodies as a single candidate", () => {
    const body = `${"[".repeat(1000)}${"}".repeat(1000)}`;
    expect(extractJsonCandidates(`<result>${body}</result>`, { tryBareJson: false })).toEqual([
      body,
    ]);
  });

  it("returns empty array when nothing JSON-like", () => {
    expect(extractJsonCandidates("just prose")).toEqual([]);
  });
});
