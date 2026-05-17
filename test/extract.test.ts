import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractJson,
  extractJsonString,
  extractJsonWith,
  LlmJsonExtractError,
} from "../src/index.js";

describe("extractJsonString", () => {
  it("extracts from <result> tag", () => {
    const out = extractJsonString(
      `Thinking...\n<result>{"a": 1}</result>\nDone.`,
    );
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

  it("supports custom tags", () => {
    const out = extractJsonString(`<final>{"ok":true}</final>`, {
      tags: ["final"],
    });
    expect(out).toBe('{"ok":true}');
  });

  it("falls back to ```json fence", () => {
    const out = extractJsonString("Sure!\n```json\n{\"a\":1}\n```\n");
    expect(out).toBe('{"a":1}');
  });

  it("falls back to bare ``` fence", () => {
    const out = extractJsonString("```\n[1,2]\n```");
    expect(out).toBe("[1,2]");
  });

  it("falls back to bare JSON object", () => {
    const out = extractJsonString("Here you go: {\"a\":1,\"b\":2} done.");
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
    expect(extractJsonString("<RESULT>{\"a\":1}</RESULT>")).toBe('{"a":1}');
  });

  it("tag with attributes works", () => {
    expect(extractJsonString('<result type="json">{"a":1}</result>')).toBe(
      '{"a":1}',
    );
  });
});

describe("extractJson (parse)", () => {
  it("parses repaired JSON (trailing comma)", () => {
    expect(extractJson("<result>{\"a\":1,}</result>")).toEqual({ a: 1 });
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

  it("repair=false rejects malformed input", () => {
    expect(() =>
      extractJson("<result>{a: 1}</result>", { repair: false }),
    ).toThrow(LlmJsonExtractError);
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
