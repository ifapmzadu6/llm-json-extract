import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { extractJson, extractJsonWith, LlmJsonExtractError } from "../src/index.js";

// Strings rich in characters that confuse scanners: brackets, quotes of every
// family, comment markers, escapes, and tag delimiters.
const trickyString = fc.string({
  unit: fc.constantFrom(..."ab {}[]\"'`:,/\\*<>\n’“”#-1"),
  maxLength: 12,
});
const leaf = fc.oneof(
  trickyString,
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
);
const { value: json } = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    leaf,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(trickyString, tie("value"), { maxKeys: 4 }),
  ),
}));
const structured = fc.oneof(
  fc.array(json, { maxLength: 4 }),
  fc.dictionary(trickyString, json, { maxKeys: 4 }),
);
const prose = fc.string({
  unit: fc.constantFrom(..."Here is the answer. I'm sure, it's (ok)! see: http://x.y - note\n"),
  maxLength: 40,
});
const wrappers = [
  (j: string) => `<result>${j}</result>`,
  (j: string) => `<result>\n${j}\n</result>`,
  (j: string) => `\`\`\`json\n${j}\n\`\`\``,
  (j: string) => `\`\`\`\n${j}\n\`\`\``,
  (j: string) => j,
];

describe("properties", () => {
  it("returns valid JSON unchanged when surrounded by prose", () => {
    fc.assert(
      fc.property(
        structured,
        prose,
        prose,
        fc.constantFrom(...wrappers),
        fc.boolean(),
        (value, before, after, wrap, pretty) => {
          const body = JSON.stringify(value, null, pretty ? 2 : undefined);
          expect(extractJson(`${before}${wrap(body)}${after}`)).toEqual(JSON.parse(body));
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("recovers the top-level shape of output cut off mid-answer", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(json, { minLength: 2, maxLength: 4 }),
          fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), json, {
            minKeys: 2,
            maxKeys: 4,
          }),
        ),
        fc.double({ min: 0.5, max: 0.95, noNaN: true }),
        fc.constantFrom(
          (j: string) => `Sure!\n<result>${j}`,
          (j: string) => `Here you go:\n\`\`\`json\n${j}`,
          (j: string) => `Here you go: ${j}`,
        ),
        (value, fraction, wrap) => {
          const body = JSON.stringify(value);
          const cut = body.slice(0, Math.floor(body.length * fraction));
          // `[{...}` cut right after a complete first child is deliberately
          // read as prose around that child (see truncatedTail).
          fc.pre(!/^[[{]+$/.test(cut.slice(0, 2)) || !/[}\]]$/.test(cut));
          const text = wrap(cut);
          expect(Array.isArray(extractJson(text, { allowTruncated: true }))).toBe(
            Array.isArray(value),
          );
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("only ever throws LlmJsonExtractError, on any input", () => {
    const token = fc.constantFrom(
      ..."{}[]\"'`’‘“”:,/\\*<>\n\t abtrunelsfNo0123456789.-+e#&;",
      "<result>",
      "</result>",
      "```json\n",
      "```",
      "&quot;",
      "//",
      "/*",
      "*/",
      "...",
      "True",
      "None",
      "undefined",
      "\\u12",
      "NumberLong(",
    );
    fc.assert(
      fc.property(
        fc.array(token, { maxLength: 60 }).map((tokens) => tokens.join("")),
        (text) => {
          for (const run of [
            () => extractJson(text),
            () => extractJson(text, { repair: false }),
            () => extractJsonWith(text, (x) => x),
          ]) {
            try {
              run();
            } catch (err) {
              expect(err).toBeInstanceOf(LlmJsonExtractError);
            }
          }
        },
      ),
      { numRuns: 3_000 },
    );
  });
});
