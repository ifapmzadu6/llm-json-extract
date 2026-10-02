import { describe, expect, it } from "vitest";
import { extractJson, extractJsonCandidates } from "../src/index.js";
import { repairJson } from "../src/repair.js";

describe("quoted strings containing comment markers", () => {
  it.each([
    { name: "double", open: '"', close: '"' },
    { name: "single", open: "'", close: "'" },
    { name: "backtick", open: "`", close: "`" },
    { name: "acute", open: "´", close: "´" },
    { name: "smart single", open: "‘", close: "’" },
    { name: "right single", open: "’", close: "’" },
    { name: "smart double", open: "“", close: "”" },
    { name: "right double", open: "”", close: "”" },
    { name: "HTML double", open: "&quot;", close: "&quot;" },
    { name: "HTML single", open: "&#39;", close: "&#39;" },
  ])("preserves bracket/comment text inside $name quotes", ({ open, close }) => {
    const value = "before } // https://example.com [literal]";
    const body = `{text:${open}${value}${close}}`;
    expect(JSON.parse(repairJson(body))).toEqual({ text: value });
    expect(extractJson(`<result>${body}</result>`, { tryBareJson: false })).toEqual({
      text: value,
    });
  });

  it.each(["a] /* literal", "a} /* literal */ // still literal"])(
    "preserves block-comment markers inside a closed string: %s",
    (value) => {
      expect(JSON.parse(repairJson(`{text:'${value}'}`))).toEqual({ text: value });
    },
  );

  it("preserves escaped apostrophes and quotes after comment markers", () => {
    const body = String.raw`{'text':'O\'Connor } // say \'hello\''}`;
    expect(JSON.parse(repairJson(body))).toEqual({ text: "O'Connor } // say 'hello'" });
    expect(extractJson(body)).toEqual({ text: "O'Connor } // say 'hello'" });
    const value = 'a} // say "hi" then \\';
    expect(JSON.parse(repairJson(`{text:${JSON.stringify(value)}}`))).toEqual({ text: value });
  });

  it("preserves strings whose boundary quotes are escaped", () => {
    const body = String.raw`{\"text\":\"a} // literal\"}`;
    expect(JSON.parse(repairJson(body))).toEqual({ text: "a} // literal" });
  });

  it.each(["\n", "\r", "\r\n"])("preserves literal newlines inside strings: %j", (newline) => {
    const value = `a} // literal${newline}b] /* literal`;
    expect(JSON.parse(repairJson(`{text:'${value}'}`))).toEqual({ text: value });
  });

  it("removes real comments outside closed strings without changing their contents", () => {
    const body = String.raw`{
      // outside ' " ] } \uZZZZ
      text:'a} // literal', /* outside ‘ ] } \uZZZZ */
      url:'https://example.com'
    } // trailing ' " \uZZZZ`;
    expect(JSON.parse(repairJson(body))).toEqual({
      text: "a} // literal",
      url: "https://example.com",
    });
  });

  it.each([
    "{text:'done}",
    "{text:'done} // outside comment",
    "{text:'done} /* outside comment */",
    "{text:'done} // outside comment with 'quoted' text",
    String.raw`{text:'done} // escaped quote \' and invalid escape \uZZZZ`,
  ])("keeps truncated string repair with a trailing container closer: %s", (body) => {
    expect(JSON.parse(repairJson(body))).toEqual({ text: "done" });
  });

  it("rejects invalid Unicode escapes inside a closed string", () => {
    expect(() => repairJson(String.raw`{text:'a} // literal \uZZZZ'}`)).toThrow(SyntaxError);
  });

  it("preserves comment text before a closing quote followed by an omitted comma", () => {
    expect(JSON.parse(repairJson("{text:'a} // literal' next:1}"))).toEqual({
      text: "a} // literal",
      next: 1,
    });
  });

  it("preserves a top-level quoted string containing bracket/comment text", () => {
    expect(JSON.parse(repairJson("'a} // literal'"))).toBe("a} // literal");
  });

  it("preserves a closed string even when the outer container is truncated", () => {
    expect(JSON.parse(repairJson("{text:'a} // literal'"))).toEqual({ text: "a} // literal" });
  });

  it("keeps many bracket/comment sequences without repeatedly rescanning the suffix", () => {
    const value = "a} // literal ".repeat(10_000);
    const start = performance.now();
    expect(JSON.parse(repairJson(`{text:'${value}'}`))).toEqual({ text: value });
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("rejects many speculative quotes without repeatedly scanning the same line comment", () => {
    const body = `{text:'a} /* ${"b'//".repeat(8_000)}\nx`;
    const start = performance.now();
    expect(JSON.parse(repairJson(body))).toEqual({ text: "a" });
    expect(extractJson(`<result>${body}</result>`, { tryBareJson: false })).toEqual({ text: "a" });
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("reuses the rejected boundary after a shared comment and long bare word", () => {
    const body = `{text:'a} /* ${"b'//".repeat(2_000)}\n// another line\n${" ".repeat(20_000)}${"x".repeat(20_000)}`;
    const start = performance.now();
    expect(JSON.parse(repairJson(body))).toEqual({ text: "a" });
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("bounds raw and strict extraction when literal comments share a later newline", () => {
    const body = `{text:'${"a} // ".repeat(8_000)}\nx "end"'}`;
    const text = `${body} then {"ok":true}`;
    const start = performance.now();
    expect(extractJsonCandidates(text)).toEqual([body, '{"ok":true}']);
    expect(extractJson(text, { repair: false })).toEqual({ ok: true });
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("reuses an end quote shared by lookahead from many complete strings", () => {
    const count = 3_000;
    const body = `[${"'a} // x' abc ".repeat(count)}'end "quoted"']`;
    const expected = [
      ...Array.from({ length: count }, () => ["a} // x", "abc"]).flat(),
      'end "quoted"',
    ];
    const start = performance.now();
    expect(JSON.parse(repairJson(body))).toEqual(expected);
    expect(extractJsonCandidates(body)).toEqual([body]);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it.each(["/* */", "/**/", "/*/ */", "/* /*/", "\u200b/* */\u180e"])(
    "keeps comment-prefix lookup semantics at overlapping tokens: %j",
    (comment) => {
      expect(JSON.parse(repairJson(`{text:'a} // literal'${comment}}`))).toEqual({
        text: "a} // literal",
      });
    },
  );
});
