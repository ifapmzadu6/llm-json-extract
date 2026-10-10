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

  it("repairs missing separators and Python-style literals", () => {
    const text = "<result>{name: 'Ada' active: True values: [1 2 None]}</result>";
    expect(extractJson(text)).toEqual({
      name: "Ada",
      active: true,
      values: [1, 2, null],
    });
  });

  it("repairs missing colons before containers and adjacent primitive values", () => {
    const text = `<result>{"items"["x" null], "nested"{"ok": true}}</result>`;
    expect(extractJson(text)).toEqual({
      items: ["x", null],
      nested: { ok: true },
    });
  });

  it("repairs smart quotes and apostrophes in single-quoted strings", () => {
    const text = String.raw`<result>{“name”: ‘O\'Connor’}</result>`;
    expect(extractJson(text)).toEqual({ name: "O'Connor" });
  });

  it("closes truncated strings and containers", () => {
    expect(extractJson("<result>{items: [1, 2</result>")).toEqual({ items: [1, 2] });
    expect(extractJson("<result>{message: 'done}</result>")).toEqual({ message: "done" });
  });

  it("repairs escaped and concatenated strings", () => {
    const escaped = String.raw`<result>{\"stringified\": \"content\"}</result>`;
    expect(extractJson(escaped)).toEqual({ stringified: "content" });
    expect(extractJson(`<result>{text: "long " + 'text'}</result>`)).toEqual({
      text: "long text",
    });
  });

  it("repairs unescaped quotes and newline-delimited JSON", () => {
    expect(extractJson(`<result>{"text":"She said "hello"."}</result>`)).toEqual({
      text: 'She said "hello".',
    });
    expect(extractJson(`<result>{"id":1}\n{"id":2}</result>`)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("repairs fenced JSON inside a tag without the fence extraction fallback", () => {
    const text = "<result>```json\n{answer: 42,}\n```</result>";
    expect(extractJson(text, { tryCodeFence: false })).toEqual({ answer: 42 });
  });

  it("repairs ellipses, multi-word keys, and wrapped values", () => {
    const text = `<result>{first name: 'Ada', values: [1, 2, ..., 9], id: NumberLong(2)}</result>`;
    expect(extractJson(text)).toEqual({
      "first name": "Ada",
      values: [1, 2, 9],
      id: 2,
    });
  });

  it("repair=false rejects malformed input", () => {
    expect(() => extractJson("<result>{a: 1}</result>", { repair: false })).toThrow(
      LlmJsonExtractError,
    );
  });

  it("preserves native JSON.parse semantics for already-valid JSON", () => {
    expect(Object.is(extractJson("<result>-0</result>"), -0)).toBe(true);
  });

  it("repairs truncated numeric symbols", () => {
    expect(Object.is(extractJson("<result>-</result>"), -0)).toBe(true);
    expect(extractJson("<result>1.e2</result>")).toBe(100);
  });

  it("matches jsonrepair 3.15 edge behavior for keys and trailing commas", () => {
    expect(extractJson("<result>{\u00a0a\u00a0:\u00a01}</result>")).toEqual({ "a\u00a0": 1 });
    expect(extractJson("<result>[1,2,,]</result>")).toEqual([1, 2]);
    expect(extractJson("<result>[1,,2]</result>")).toEqual([[1], 2]);
    expect(extractJson("<result>[,,1,2]</result>")).toEqual([[], 1, 2]);
    expect(extractJson("<result>{empty: [,,]}</result>")).toEqual({ empty: [] });
    expect(extractJson("<result>[1,2,......]</result>")).toEqual([1, 2, "..."]);
  });

  it("repairs HTML-encoded quoted JSON supported by jsonrepair 3.15", () => {
    const encoded = "<result>{&quot;message&quot;:&quot;Tom &amp; Jerry &lt;3&quot;}</result>";
    expect(extractJson(encoded)).toEqual({ message: "Tom & Jerry <3" });
    expect(extractJson("<result>&#x22;hello&#x22;</result>")).toBe("hello");
  });

  it("recognizes a missing comma after a primitive value", () => {
    expect(extractJson('<result>{"active":true"count":2}</result>')).toEqual({
      active: true,
      count: 2,
    });
  });

  it("handles long colonless text after a quote without regex backtracking", () => {
    const tail = `a${" ".repeat(50_000)}`;
    expect(extractJson(`<result>{"value":"x"${tail}}</result>`)).toEqual({
      value: 'x"a',
    });
  });

  it("repairs truncated strings with long interior whitespace in linear time", () => {
    const value = `a${"\t".repeat(200_000)}z`;
    const start = performance.now();
    expect(extractJson(`<result>"${value}</result>`)).toBe(value);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("repairs large numeric arrays without copying every remaining suffix", () => {
    const values = Array.from({ length: 5_000 }, (_, index) => index);
    expect(extractJson(`<result>[${values.join(",")},]</result>`)).toEqual(values);
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
    // Preferred (last) <result> body is bare prose that repair turns into
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

  it.each([
    { name: "single", open: "'", close: "'" },
    { name: "backtick", open: "`", close: "`" },
    { name: "acute", open: "´", close: "´" },
    { name: "smart single", open: "‘", close: "’" },
    { name: "right single", open: "’", close: "’" },
    { name: "smart double", open: "“", close: "”" },
    { name: "right double", open: "”", close: "”" },
    { name: "mixed single family", open: "‘", close: "'" },
    { name: "mixed double family", open: "“", close: '"' },
  ])("preserves brackets and comment markers inside $name quoted bare JSON", ({ open, close }) => {
    const value = "a}b]c{d[e https://example.com /* literal */";
    const body = `{${open}text${close}:${open}${value}${close}}`;
    const text = `Answer: ${body} done.`;
    expect(extractJsonCandidates(text)).toEqual([body]);
    expect(extractJsonString(text)).toBe(body);
    expect(extractJson(text)).toEqual({ text: value });
    expect(() => extractJson(text, { repair: false })).toThrow(
      expect.objectContaining({ stage: "parse", extracted: body }),
    );
  });

  it("keeps other quote families and escaped apostrophes inside single-quoted strings", () => {
    const body = String.raw`{'text':'O\'Connor says "a}b" // literal', 'path':'C:\\tmp\\'}`;
    expect(extractJsonCandidates(body)).toEqual([body]);
    expect(extractJson(body)).toEqual({
      text: 'O\'Connor says "a}b" // literal',
      path: "C:\\tmp\\",
    });
  });

  it.each(["{'text':'O'Connor a}b // literal'}", "{‘text’:‘O’Connor a}b // literal’}"])(
    "keeps unescaped word apostrophes inside quoted strings: %s",
    (body) => {
      expect(extractJsonCandidates(body)).toEqual([body]);
      expect(extractJson(body)).toEqual({
        text: body.includes("’Connor") ? "O’Connor a}b // literal" : "O'Connor a}b // literal",
      });
    },
  );

  it("does not start strings at apostrophes in bracketed prose", () => {
    const text = `[Here's a draft] then {"ok":true}`;
    // Bracketed prose is still a candidate, but only after real-looking data.
    expect(extractJsonCandidates(text)).toEqual(['{"ok":true}', "[Here's a draft]"]);
    expect(extractJson(text, { repair: false })).toEqual({ ok: true });
    expect(extractJson(text)).toEqual({ ok: true });
  });

  it.each([
    { body: "['a'1]", value: ["a", 1] },
    { body: "['a'true]", value: ["a", true] },
    { body: "{'a':'x'next:1}", value: { a: "x", next: 1 } },
  ])("keeps omitted commas after quoted values: $body", ({ body, value }) => {
    expect(extractJsonCandidates(body)).toEqual([body]);
    expect(extractJson(body)).toEqual(value);
  });

  it("preserves nested quoted objects as one candidate", () => {
    const body = "{'items':[{'text':'a}b // literal'}, ‘x]y’], 'ok':true}";
    expect(extractJsonCandidates(body)).toEqual([body]);
    expect(extractJson(body)).toEqual({ items: [{ text: "a}b // literal" }, "x]y"], ok: true });
  });

  it("ignores quote delimiters inside real comments around single-quoted values", () => {
    const body = `{
      // ‘ ' " } ]
      'url':'https://example.com',
      /* ’ ' " } ] */
      'text':'a}b'
    }`;
    expect(extractJsonCandidates(body)).toEqual([body]);
    expect(extractJson(body)).toEqual({ url: "https://example.com", text: "a}b" });
  });

  it("does not close tags on tag text inside single-quoted values", () => {
    const body = "{'text':'a}b </result> inside'}";
    const text = `<result>${body}</result>`;
    expect(extractJsonCandidates(text)).toEqual([body]);
    expect(extractJsonString(text, { tryBareJson: false })).toBe(body);
    expect(extractJson(text)).toEqual({ text: "a}b </result> inside" });
  });

  it("deduplicates complete quoted candidates from tags and fences", () => {
    const body = "{'text':'a}b // literal'}";
    for (const text of [`<result>${body}</result>`, `\`\`\`json\n${body}\n\`\`\``]) {
      expect(extractJsonCandidates(text)).toEqual([body]);
      expect(extractJson(text)).toEqual({ text: "a}b // literal" });
    }
  });

  it("keeps valid double-quoted JSON strict and skips malformed alternate candidates", () => {
    const body = '{"text":"O\'Connor } // literal", "url":"https://example.com"}';
    const text = `{'text':'a}b'} then ${body}`;
    expect(extractJsonCandidates(text)).toEqual(["{'text':'a}b'}", body]);
    expect(extractJson(text, { repair: false })).toEqual({
      text: "O'Connor } // literal",
      url: "https://example.com",
    });
  });

  it("keeps literal smart quotes inside valid ASCII-quoted JSON strings", () => {
    const value = { text: "“a}b” and ‘x]y’ // literal", "“key}”": true };
    const body = JSON.stringify(value);
    for (const text of [body, `<result>${body}</result>`]) {
      expect(extractJsonCandidates(text)).toEqual([body]);
      expect(extractJson(text, { repair: false })).toEqual(value);
    }
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

  it("recovers later strict JSON after an unmatched single quote in bracketed prose", () => {
    const text = `[note: '90s music] then {"ok":true}`;
    expect(extractJsonCandidates(text)).toEqual(["[note: '90s music]", '{"ok":true}']);
    expect(extractJson(text, { repair: false })).toEqual({ ok: true });
  });

  it("keeps earlier and later strict candidates around unmatched alternate quotes", () => {
    const text = `{"example":0} [note: '90s music] then {"ok":true}`;
    expect(extractJsonCandidates(text)).toEqual([
      '{"example":0}',
      "[note: '90s music]",
      '{"ok":true}',
    ]);
    expect(extractJsonWith(text, z.object({ ok: z.literal(true) }), { repair: false })).toEqual({
      ok: true,
    });
  });

  it("passes bare strings with missing end quotes through to repair", () => {
    const body = "{text:'done}";
    expect(extractJsonCandidates(body)).toEqual([body]);
    expect(extractJson(body)).toEqual({ text: "done" });
    expect(() => extractJson(body, { repair: false })).toThrow(
      expect.objectContaining({ stage: "parse", extracted: body }),
    );
  });

  it.each(["'", "`", "´", "‘", "’", "“", "”"])(
    "recovers strict JSON after an unmatched %s delimiter",
    (quote) => {
      const prefix = `[note: ${quote}90s music]`;
      const text = `${prefix} then {"ok":true}`;
      expect(extractJsonCandidates(text)).toEqual([prefix, '{"ok":true}']);
      expect(extractJson(text, { repair: false })).toEqual({ ok: true });
      expect(extractJson(`{text:${quote}done}`)).toEqual({ text: "done" });
    },
  );

  it("keeps complete quoted spans while recovering later independent candidates", () => {
    const body = "{'text':'a{b'}";
    const prefix = "[note: '90s music]";
    const text = `${body} ${prefix} then {"ok":true} }`;
    expect(extractJsonCandidates(text)).toEqual([body, prefix, '{"ok":true}']);
    expect(extractJsonWith(text, z.object({ ok: z.literal(true) }), { repair: false })).toEqual({
      ok: true,
    });
  });

  it.each([
    { body: "{items:[1],text:'done}", value: { items: [1], text: "done" } },
    { body: "{meta:{ok:true},text:'done}", value: { meta: { ok: true }, text: "done" } },
    { body: "[[1], 'done]", value: [[1], "done"] },
  ])("prefers a recovered parent over its completed children: $body", ({ body, value }) => {
    expect(extractJsonCandidates(body)).toEqual([body]);
    expect(extractJson(body)).toEqual(value);
    expect(() => extractJson(body, { repair: false })).toThrow(
      expect.objectContaining({ stage: "parse", extracted: body }),
    );
  });

  it.each(["[1]", '{"n":1}', "[1] }", "} [1]", "1]", "a}b", '[1] {"x":[2]}'])(
    "preserves strict recovered objects containing JSON-shaped string text: %s",
    (value) => {
      const prefix = "[note: “90s music]";
      const body = JSON.stringify({ text: value, nested: { values: [2, 3] } });
      const text = `${prefix} then ${body}`;
      expect(extractJsonCandidates(text)).toEqual([prefix, body]);
      expect(extractJson(text, { repair: false })).toEqual({
        text: value,
        nested: { values: [2, 3] },
      });
    },
  );

  it("keeps independent candidates ordered while recovering a nested parent", () => {
    const first = '{"example":0}';
    const prefix = "[note: “90s music]";
    const body = '{"text":"[1]"}';
    const last = '{"last":true}';
    const text = `${first} ${prefix} ${body} ${last}`;
    expect(extractJsonCandidates(text)).toEqual([first, prefix, body, last]);
    expect(extractJson(text, { repair: false })).toEqual({ example: 0 });
    expect(extractJsonWith(text, z.object({ text: z.string() }), { repair: false })).toEqual({
      text: "[1]",
    });
    expect(extractJsonWith(text, z.object({ last: z.literal(true) }), { repair: false })).toEqual({
      last: true,
    });
  });

  it.each(["'", "`", "´", "‘", "’", "“", "”"])(
    "recovers strict parents when a literal %s ends a desynchronized string",
    (quote) => {
      const prefix = `[note: ${quote}90s music]`;
      const value = { text: `${quote}]`, nested: { values: [2, 3] } };
      const body = JSON.stringify(value);
      const text = `${prefix} then ${body}`;
      expect(extractJsonCandidates(text)).toEqual([prefix, body]);
      expect(extractJson(text, { repair: false })).toEqual(value);
    },
  );

  it("recovers a complete alternate-quoted parent after unmatched alternate prose", () => {
    const prefix = "[note: '90s music]";
    const body = "{'text':'[1]', 'nested':{'ok':true}}";
    const text = `${prefix} then ${body}`;
    expect(extractJsonCandidates(text)).toEqual([prefix, body]);
    expect(
      extractJsonWith(text, z.object({ text: z.string(), nested: z.object({ ok: z.boolean() }) })),
    ).toEqual({ text: "[1]", nested: { ok: true } });
  });

  it("resynchronizes recovery after a complete string containing a literal ASCII quote", () => {
    const body = `{text:'[1]"'}`;
    const prefix = "[note: '90s music]";
    const text = `${body} ${prefix} then {"ok":true} } ]`;
    expect(extractJsonCandidates(text)).toEqual([body, prefix, '{"ok":true}']);
    expect(extractJson(text)).toEqual({ text: '[1]"' });
    expect(extractJsonWith(text, z.object({ ok: z.literal(true) }), { repair: false })).toEqual({
      ok: true,
    });
  });

  it("keeps a closed repairable candidate opaque to recovery and trailing prose", () => {
    const body = `{'text':'} {"','keep':1}`;
    const text = `${body} Explanation: "}" closes an object.`;
    expect(extractJsonCandidates(text)[0]).toBe(body);
    expect(extractJson(text)).toEqual({ text: '} {"', keep: 1 });
  });

  it("preserves a later strict candidate after an opaque repairable candidate", () => {
    const body = `{'text':'} {"','keep':1}`;
    const strict = '{"ok":true}';
    const text = `${body} then ${strict} Explanation: "}" closes an object.`;
    expect(extractJsonCandidates(text).slice(0, 2)).toEqual([body, strict]);
    expect(extractJson(text)).toEqual({ text: '} {"', keep: 1 });
    expect(extractJson(text, { repair: false })).toEqual({ ok: true });
    expect(extractJsonWith(text, z.object({ ok: z.literal(true) }))).toEqual({ ok: true });
  });

  it("recovers a truncated parent without rescanning a closed child's string content", () => {
    const body = `{child:{text:'} {"',keep:1},tail:'done}`;
    expect(extractJsonCandidates(body)).toEqual([body]);
    expect(extractJson(body)).toEqual({ child: { text: '} {"', keep: 1 }, tail: "done" });
    expect(() => extractJson(body, { repair: false })).toThrow(
      expect.objectContaining({ stage: "parse", extracted: body }),
    );
  });

  it("does not protect a desynchronized fragment that needs an opening quote", () => {
    const prefix = "[note: “90s music]";
    const value = { "a[b'": "'a[b", nested: { keep: 1 } };
    const body = JSON.stringify(value);
    const text = `${prefix} then ${body} [note: '90s music]`;
    expect(extractJsonCandidates(text)).toContain(body);
    expect(extractJson(text, { repair: false })).toEqual(value);
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

describe("prose and truncation around the answer", () => {
  it.each([
    ["a closing line inside a tag", '<result>\n{"a":1}\nHope this helps!\n</result>'],
    ["a closing line inside a fence", '```json\n{"a":1}\nLet me know!\n```'],
  ])("does not wrap the answer in an array when followed by %s", (_, text) => {
    expect(extractJson(text)).toEqual({ a: 1 });
    expect(extractJson(text, { tryBareJson: false })).toEqual({ a: 1 });
  });

  it("still joins newline-delimited containers", () => {
    expect(extractJson('<result>{"id":1}\n{"id":2}</result>')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it.each([
    'Per the docs [1], here you go: {"a":1}',
    '[Thinking] Let me answer.\n{"a":1}',
    'See [the docs](https://example.com). {"a":1}',
  ])("prefers data over earlier bracketed prose: %s", (text) => {
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  it("still returns a bare array answer when there is nothing else", () => {
    expect(extractJson("Answer: [3, 5, 7]")).toEqual([3, 5, 7]);
  });

  it("does not let a URL in braced prose hide later JSON", () => {
    expect(extractJson('Visit {see http://x.com} then {"a":1}')).toEqual({ a: 1 });
  });

  it("repairs a tag body cut off before its closing tag", () => {
    expect(extractJson('Sure. <result>{"a": [1, 2, {"b": "hel')).toEqual({
      a: [1, 2, { b: "hel" }],
    });
    // The truncated final answer wins over an earlier complete example.
    expect(extractJson('<result>{"x":0}</result> now: <result>{"x":1, "y": [')).toEqual({
      x: 1,
      y: [],
    });
  });

  it("repairs bare JSON cut off at the end of the text", () => {
    expect(extractJson('Here: {"a": [1, 2, {"b": "hel')).toEqual({ a: [1, 2, { b: "hel" }] });
    // The truncated parent is tried before its complete children.
    expect(extractJson('Result: [{"a":1}, {"b":')).toEqual([{ a: 1 }, { b: null }]);
    // A stray brace in earlier prose does not swallow the answer.
    expect(extractJson('Use f{x for that. Here: {"a": [1, 2')).toEqual({ a: [1, 2] });
  });

  it("repairs output cut off inside an object key", () => {
    expect(extractJson('<result>{"a": 1, "b')).toEqual({ a: 1, b: null });
  });

  it("does not mistake a stray bracket before the answer for truncated output", () => {
    expect(extractJson('Note [\n{"a":1}\nThanks')).toEqual({ a: 1 });
    expect(extractJson('see [ [\n{"a":1}\nok')).toEqual({ a: 1 });
    expect(extractJson("Ref [1.Hi\n[2]\n")).toEqual([2]);
    expect(extractJson("Set {1 or\n[2]\n")).toEqual([2]);
    // A string cannot span lines, so `['hc` is prose with a stray quote.
    expect(extractJson("x ['hc\n[]\n")).toEqual([]);
  });

  it("keeps empty arrays and number lists ahead of bracketed prose", () => {
    expect(extractJson("- [ ] task\n[]")).toEqual([]);
    expect(extractJson("[Thinking]\n[-5, 8]")).toEqual([-5, 8]);
    expect(extractJson("Answer: [true, false]")).toEqual([true, false]);
  });

  it("does not invent a candidate from a lone trailing brace", () => {
    expect(extractJsonCandidates("Here: {")).toEqual([]);
  });

  it("scans many unclosed tag bodies in linear time", () => {
    const text = "<json>{</json>".repeat(20_000);
    const start = performance.now();
    extractJsonCandidates(text, { tryBareJson: false });
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
