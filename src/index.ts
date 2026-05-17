import { jsonrepair } from "jsonrepair";

export interface ExtractOptions {
  /**
   * Tag names to look for, in order. The text inside `<tag>...</tag>` is
   * treated as the JSON payload.
   *
   * @default ["result", "json", "output", "answer", "response"]
   */
  tags?: string[];

  /**
   * If true and a tag appears multiple times, use the **last** occurrence.
   * This is usually what you want — models often show an example earlier
   * and the real answer last.
   *
   * @default true
   */
  pickLast?: boolean;

  /**
   * Whether to also try fenced code blocks (```json ... ``` or ``` ... ```)
   * when no tag is found.
   *
   * @default true
   */
  tryCodeFence?: boolean;

  /**
   * Whether to fall back to scanning for the first balanced `{...}` or
   * `[...]` in the raw text when no tag and no fence are found.
   *
   * @default true
   */
  tryBareJson?: boolean;

  /**
   * Whether to run `jsonrepair` on the extracted string before `JSON.parse`.
   * Fixes trailing commas, single quotes, comments, unquoted keys, etc.
   *
   * @default true
   */
  repair?: boolean;
}

const DEFAULT_TAGS = ["result", "json", "output", "answer", "response"];

export class LlmJsonExtractError extends Error {
  readonly stage: "extract" | "parse" | "validate";
  readonly raw: string;
  readonly extracted: string | null;

  constructor(opts: {
    message: string;
    stage: "extract" | "parse" | "validate";
    raw: string;
    extracted: string | null;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmJsonExtractError";
    this.stage = opts.stage;
    this.raw = opts.raw;
    this.extracted = opts.extracted;
  }
}

/**
 * Extract a JSON string from LLM output without parsing it.
 *
 * Tries each strategy in turn:
 *   1. `<result>...</result>` (or other configured tags)
 *   2. ```json ... ``` / ``` ... ``` fenced blocks
 *   3. First balanced `{...}` or `[...]` in the raw text
 *
 * Returns `null` if nothing JSON-shaped can be found.
 */
export function extractJsonString(
  text: string,
  options: ExtractOptions = {},
): string | null {
  const tags = options.tags ?? DEFAULT_TAGS;
  const pickLast = options.pickLast ?? true;
  const tryCodeFence = options.tryCodeFence ?? true;
  const tryBareJson = options.tryBareJson ?? true;

  // Strategy 1: tags. Try each tag in order; within a tag, pick first or last match.
  for (const tag of tags) {
    const matches = findTagMatches(text, tag);
    if (matches.length === 0) continue;
    const picked = pickLast ? matches[matches.length - 1] : matches[0];
    if (picked !== undefined) return picked.trim();
  }

  // Strategy 2: fenced code blocks.
  if (tryCodeFence) {
    const fenced = matchCodeFence(text);
    if (fenced !== null) return fenced.trim();
  }

  // Strategy 3: bare JSON.
  if (tryBareJson) {
    const bare = extractBareJson(text);
    if (bare !== null) return bare;
  }

  return null;
}

/**
 * Extract and parse JSON from LLM output.
 *
 * Throws `LlmJsonExtractError` if extraction or parsing fails.
 */
export function extractJson(text: string, options: ExtractOptions = {}): unknown {
  const extracted = extractJsonString(text, options);
  if (extracted === null) {
    throw new LlmJsonExtractError({
      message: "No JSON-like content found in input",
      stage: "extract",
      raw: text,
      extracted: null,
    });
  }
  const repair = options.repair ?? true;
  const candidate = repair ? safeRepair(extracted) : extracted;
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new LlmJsonExtractError({
      message: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
      stage: "parse",
      raw: text,
      extracted,
      cause: err,
    });
  }
}

/**
 * Extract, parse, and validate JSON from LLM output with a user-supplied
 * validator. Works with any schema library — pass `schema.parse` for zod,
 * `(x) => v.parse(schema, x)` for valibot, etc.
 *
 * @example
 *   const User = z.object({ name: z.string(), age: z.number() });
 *   const user = extractJsonWith(text, User.parse);
 */
export function extractJsonWith<T>(
  text: string,
  validate: (value: unknown) => T,
  options: ExtractOptions = {},
): T {
  const parsed = extractJson(text, options);
  try {
    return validate(parsed);
  } catch (err) {
    throw new LlmJsonExtractError({
      message: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
      stage: "validate",
      raw: text,
      extracted: JSON.stringify(parsed),
      cause: err,
    });
  }
}

// ---------- internals ----------

function findTagMatches(text: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, "gi");
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function matchCodeFence(text: string): string | null {
  // Prefer explicit ```json fences; fall back to bare ``` fences.
  const labeled = text.match(/```json[ \t]*\r?\n([\s\S]*?)```/i);
  if (labeled?.[1] !== undefined) return labeled[1];
  const bare = text.match(/```[ \t]*\r?\n([\s\S]*?)```/);
  if (bare?.[1] !== undefined) return bare[1];
  return null;
}

function extractBareJson(text: string): string | null {
  // Scan for the first '{' or '[' and walk forward respecting strings/escapes.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const end = findBalancedEnd(text, i);
      if (end !== null) return text.slice(i, end + 1);
    }
  }
  return null;
}

function findBalancedEnd(text: string, start: number): number | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function safeRepair(input: string): string {
  try {
    return jsonrepair(input);
  } catch {
    // jsonrepair threw — fall back to raw input so JSON.parse surfaces the
    // original parse error instead of jsonrepair's internal one.
    return input;
  }
}
