import { readFileSync } from "node:fs";
import {
  type ExtractOptions,
  extractJson,
  extractJsonString,
  LlmJsonExtractError,
} from "./index.js";

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface CliArgs {
  help: boolean;
  version: boolean;
  raw: boolean;
  pretty: boolean;
  first: boolean;
  fence: boolean;
  bare: boolean;
  repair: boolean;
  tags: string[];
  /** Input file path, `"-"` for stdin, or `null` when no positional was given. */
  file: string | null;
}

export const HELP = `Usage: llm-json-extract [options] [file]

Extract JSON from messy LLM output. Reads from a file (or stdin when no
file is given, or the file is "-") and prints the extracted JSON to stdout.

Options:
  -t, --tag <name>  Tag name to scan for (repeatable). Giving any --tag
                    replaces the defaults: result, json, output.
  --first           Prefer the first tag match instead of the last.
  --no-fence        Disable the \`\`\`json / \`\`\` code-fence fallback.
  --no-bare         Disable the bare {...} / [...] fallback.
  --no-repair       Disable jsonrepair before parsing.
  -r, --raw         Print the preferred candidate as-is, without parsing
                    or repairing it.
  -p, --pretty      Pretty-print the parsed JSON (2-space indent).
  -h, --help        Show this help.
  -V, --version     Print the version.

Exit codes:
  0  success
  1  no JSON-like content found, or nothing parsed
  2  usage error

Examples:
  claude -p 'List 3 fruits. Reply as <result>{"items":[...]}</result>.' \\
    --output-format json | jq -r .result | llm-json-extract
  llm-json-extract --pretty response.txt
  llm-json-extract --tag answer --raw < response.txt
`;

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
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
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "-V" || arg === "--version") {
      args.version = true;
    } else if (arg === "-r" || arg === "--raw") {
      args.raw = true;
    } else if (arg === "-p" || arg === "--pretty") {
      args.pretty = true;
    } else if (arg === "--first") {
      args.first = true;
    } else if (arg === "--no-fence") {
      args.fence = false;
    } else if (arg === "--no-bare") {
      args.bare = false;
    } else if (arg === "--no-repair") {
      args.repair = false;
    } else if (arg === "-t" || arg === "--tag") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError(`${arg} requires a tag name`);
      }
      args.tags.push(value);
      i++;
    } else if (arg.startsWith("--tag=")) {
      const value = arg.slice("--tag=".length);
      if (value.length === 0) throw new CliUsageError("--tag requires a tag name");
      args.tags.push(value);
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new CliUsageError(`unknown option: ${arg}`);
    } else {
      if (args.file !== null) throw new CliUsageError("only one input file may be given");
      args.file = arg;
    }
  }
  if (args.raw && args.pretty) {
    throw new CliUsageError("--raw and --pretty cannot be combined");
  }
  return args;
}

export interface CliResult {
  exitCode: 0 | 1;
  stdout: string | null;
  stderr: string | null;
}

export function extractForCli(text: string, args: CliArgs): CliResult {
  const options: ExtractOptions = {
    pickLast: !args.first,
    tryCodeFence: args.fence,
    tryBareJson: args.bare,
    repair: args.repair,
  };
  if (args.tags.length > 0) options.tags = args.tags;

  if (args.raw) {
    const extracted = extractJsonString(text, options);
    if (extracted === null) {
      return { exitCode: 1, stdout: null, stderr: "error: no JSON-like content found in input" };
    }
    return { exitCode: 0, stdout: extracted, stderr: null };
  }

  try {
    const value = extractJson(text, options);
    return {
      exitCode: 0,
      stdout: JSON.stringify(value, null, args.pretty ? 2 : undefined),
      stderr: null,
    };
  } catch (err) {
    if (err instanceof LlmJsonExtractError) {
      return { exitCode: 1, stdout: null, stderr: `error: ${err.message} (stage: ${err.stage})` };
    }
    throw err;
  }
}

function readVersion(): string {
  // Resolves to <package root>/package.json from both src/ (tests) and dist/ (build).
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) buffer += chunk;
  return buffer;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${HELP}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  let text: string;
  if (args.file !== null && args.file !== "-") {
    try {
      text = readFileSync(args.file, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: cannot read ${args.file}: ${message}\n`);
      process.exitCode = 1;
      return;
    }
  } else if (args.file === null && process.stdin.isTTY === true) {
    // Interactive terminal with no file argument: nothing to read.
    process.stderr.write(HELP);
    process.exitCode = 2;
    return;
  } else {
    text = await readStdin();
  }

  const result = extractForCli(text, args);
  if (result.stdout !== null) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr !== null) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}
