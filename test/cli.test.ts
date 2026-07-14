import { describe, expect, it } from "vitest";
import { type CliArgs, CliUsageError, extractForCli, parseCliArgs } from "../src/cli-core.js";

function args(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    help: false,
    version: false,
    raw: false,
    pretty: false,
    first: false,
    fence: true,
    bare: true,
    repair: true,
    tags: [],
    file: null,
    ...overrides,
  };
}

describe("parseCliArgs", () => {
  it("returns defaults for an empty argv", () => {
    expect(parseCliArgs([])).toEqual(args());
  });

  it("parses boolean flags", () => {
    expect(parseCliArgs(["--raw"])).toEqual(args({ raw: true }));
    expect(parseCliArgs(["-p"])).toEqual(args({ pretty: true }));
    expect(parseCliArgs(["--first"])).toEqual(args({ first: true }));
    expect(parseCliArgs(["--no-fence", "--no-bare", "--no-repair"])).toEqual(
      args({ fence: false, bare: false, repair: false }),
    );
    expect(parseCliArgs(["-h"])).toEqual(args({ help: true }));
    expect(parseCliArgs(["-V"])).toEqual(args({ version: true }));
  });

  it("collects repeated --tag values in all three spellings", () => {
    expect(parseCliArgs(["-t", "answer", "--tag", "data", "--tag=final"])).toEqual(
      args({ tags: ["answer", "data", "final"] }),
    );
  });

  it("treats a positional as the input file, and '-' as stdin", () => {
    expect(parseCliArgs(["response.txt"])).toEqual(args({ file: "response.txt" }));
    expect(parseCliArgs(["-"])).toEqual(args({ file: "-" }));
  });

  it("rejects bad usage", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--tag"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--tag", "--raw"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--tag="])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["a.txt", "b.txt"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--raw", "--pretty"])).toThrow(CliUsageError);
  });
});

const messy = `
Sure! Let me think about this.
<thinking>fruits...</thinking>
<result>
{
  "items": ['apple', 'banana'],  // messy on purpose
  "count": 2,
}
</result>
Hope that helps!
`;

describe("extractForCli", () => {
  it("extracts and parses tagged messy output", () => {
    const result = extractForCli(messy, args());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBeNull();
    expect(JSON.parse(result.stdout ?? "")).toEqual({ items: ["apple", "banana"], count: 2 });
  });

  it("pretty-prints with --pretty", () => {
    const result = extractForCli('<result>{"a":1}</result>', args({ pretty: true }));
    expect(result.stdout).toBe('{\n  "a": 1\n}');
  });

  it("prints the unparsed candidate with --raw", () => {
    const result = extractForCli(messy, args({ raw: true }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("'apple'");
    expect(result.stdout).toContain("// messy on purpose");
  });

  it("honors custom tags", () => {
    const text = '<result>{"wrong": true}</result> <answer>{"right": true}</answer>';
    const result = extractForCli(text, args({ tags: ["answer"] }));
    expect(JSON.parse(result.stdout ?? "")).toEqual({ right: true });
  });

  it("honors --first", () => {
    const text = '<result>{"n": 1}</result> then <result>{"n": 2}</result>';
    expect(JSON.parse(extractForCli(text, args()).stdout ?? "")).toEqual({ n: 2 });
    expect(JSON.parse(extractForCli(text, args({ first: true })).stdout ?? "")).toEqual({ n: 1 });
  });

  it("fails with exit code 1 when nothing JSON-like is found", () => {
    const result = extractForCli("no json here at all", args());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBeNull();
    expect(result.stderr).toContain("stage: extract");
  });

  it("fails with exit code 1 in --raw mode when nothing is found", () => {
    const result = extractForCli("still nothing", args({ raw: true }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no JSON-like content");
  });

  it("respects --no-bare", () => {
    const text = 'here you go: {"a": 1} thanks';
    expect(extractForCli(text, args()).exitCode).toBe(0);
    expect(extractForCli(text, args({ bare: false })).exitCode).toBe(1);
  });

  it("respects --no-repair", () => {
    const text = "<result>{'single': 'quotes',}</result>";
    expect(extractForCli(text, args()).exitCode).toBe(0);
    expect(extractForCli(text, args({ repair: false })).exitCode).toBe(1);
  });
});
