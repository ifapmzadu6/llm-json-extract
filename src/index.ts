import { jsonrepair } from "jsonrepair";

export interface ExtractOptions {
  /**
   * Tag names to look for. All configured tags are scanned across the
   * whole input; the match selected is then chosen by `pickLast`. Tag
   * order in this array does NOT affect priority.
   *
   * @default ["result", "json", "output"]
   */
  tags?: string[];

  /**
   * When multiple tag matches are found anywhere in the input, this
   * controls which one is preferred:
   *  - `true`  → the match whose closing tag appears **last** in the text.
   *               Best for "example earlier, real answer at the end" prompts.
   *  - `false` → the match whose opening tag appears **first**.
   *
   * Note that `extractJson` will still try the *other* tag matches as
   * fallbacks if the preferred one fails to parse.
   *
   * @default true
   */
  pickLast?: boolean;

  /**
   * Whether to also try fenced code blocks (```json ... ``` or ``` ... ```)
   * when no tag candidate yields valid JSON.
   *
   * @default true
   */
  tryCodeFence?: boolean;

  /**
   * Whether to fall back to scanning for balanced `{...}` or `[...]` in
   * the raw text when no tag and no fence yields valid JSON.
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

const DEFAULT_TAGS = ["result", "json", "output"];

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
 * Collect all candidate JSON strings from the input, ordered by preference.
 *
 * Order:
 *   1. The preferred tag match (latest or earliest, per `pickLast`).
 *   2. Other tag matches, in document order.
 *   3. Fenced code blocks (```json``` preferred, then bare ``` ```), in document order.
 *   4. Bare balanced `{...}` / `[...]` runs in the text, in document order.
 *
 * Strategies 3 and 4 can be disabled via options. Use this when you want
 * to inspect or try parsing candidates yourself.
 */
export function extractJsonCandidates(text: string, options: ExtractOptions = {}): string[] {
  const tags = options.tags ?? DEFAULT_TAGS;
  const pickLast = options.pickLast ?? true;
  const tryCodeFence = options.tryCodeFence ?? true;
  const tryBareJson = options.tryBareJson ?? true;

  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (s: string | null | undefined): void => {
    if (s === null || s === undefined) return;
    const trimmed = s.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  // Strategy 1: all tag matches, with the preferred one first.
  const tagMatches = findAllTagMatches(text, tags);
  if (tagMatches.length > 0) {
    const sortedByDocPos = [...tagMatches].sort((a, b) => a.start - b.start);
    const preferred = pickLast
      ? [...tagMatches].sort((a, b) => a.end - b.end).pop()
      : sortedByDocPos[0];
    if (preferred !== undefined) push(preferred.body);
    for (const m of sortedByDocPos) push(m.body);
  }

  // Strategy 2: code fences in document order.
  if (tryCodeFence) {
    for (const f of findAllCodeFences(text)) push(f);
  }

  // Strategy 3: bare balanced JSON runs.
  if (tryBareJson) {
    for (const b of findAllBareJson(text)) push(b);
  }

  return candidates;
}

/**
 * Extract a JSON string from LLM output without parsing it.
 *
 * Returns the **preferred** candidate (first entry of {@link extractJsonCandidates}),
 * or `null` if nothing JSON-shaped is found. For parse-aware fallback across
 * multiple candidates, use {@link extractJson}.
 */
export function extractJsonString(text: string, options: ExtractOptions = {}): string | null {
  const [first] = extractJsonCandidates(text, options);
  return first ?? null;
}

/**
 * Extract and parse JSON from LLM output.
 *
 * Each candidate from {@link extractJsonCandidates} is tried in order;
 * the first one that successfully parses (after optional `jsonrepair`)
 * is returned. Throws {@link LlmJsonExtractError} only if no candidate
 * parses, or none was found.
 */
export function extractJson(text: string, options: ExtractOptions = {}): unknown {
  const candidates = extractJsonCandidates(text, options);
  if (candidates.length === 0) {
    throw new LlmJsonExtractError({
      message: "No JSON-like content found in input",
      stage: "extract",
      raw: text,
      extracted: null,
    });
  }
  const repair = options.repair ?? true;
  // Two-pass: prefer object/array results over primitives, because jsonrepair
  // happily turns bare words ("nope") into JSON strings, which would mask a
  // later candidate that holds the real structured answer.
  let lastError: unknown;
  let lastCandidate: string | null = null;
  let primitiveFallback: { value: unknown; extracted: string } | undefined;
  for (const candidate of candidates) {
    lastCandidate = candidate;
    const parsed = tryParse(candidate, repair);
    if (parsed.ok) {
      if (isStructured(parsed.value)) return parsed.value;
      if (primitiveFallback === undefined) {
        primitiveFallback = { value: parsed.value, extracted: candidate };
      }
      continue;
    }
    lastError = parsed.error;
  }
  if (primitiveFallback !== undefined) return primitiveFallback.value;
  throw new LlmJsonExtractError({
    message: `JSON.parse failed for all candidates: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    stage: "parse",
    raw: text,
    extracted: lastCandidate,
    cause: lastError,
  });
}

/**
 * Schema-like object exposing a `parse(unknown) => T` method.
 *
 * Matches the shape of zod (`z.ZodType`), or any custom validator that
 * follows the same convention. Pass the schema directly to
 * {@link extractJsonWith} instead of `(x) => schema.parse(x)` — the
 * library binds the call internally so `this` is preserved and TypeScript's
 * `unbound-method` lint rule is sidestepped.
 */
export interface Validator<T> {
  parse: (value: unknown) => T;
}

/**
 * Extract, parse, and validate JSON from LLM output.
 *
 * Accepts either:
 *  - a {@link Validator} (anything with a `.parse(unknown) => T` method, e.g. a zod schema), or
 *  - a plain `(unknown) => T` function (for valibot, arktype, ad-hoc checks, etc.).
 *
 * Candidates that parse but fail validation are skipped in favor of the
 * next candidate. This handles cases where an earlier candidate happens
 * to be valid JSON but isn't the answer (e.g. a stray object literal in
 * prose).
 *
 * @example
 *   // zod (or anything with `.parse`): pass the schema directly
 *   const User = z.object({ name: z.string(), age: z.number() });
 *   const user = extractJsonWith(text, User);
 *
 * @example
 *   // valibot: wrap in a function
 *   const user = extractJsonWith(text, (x) => v.parse(UserSchema, x));
 */
export function extractJsonWith<T>(
  text: string,
  validator: Validator<T>,
  options?: ExtractOptions,
): T;
export function extractJsonWith<T>(
  text: string,
  validate: (value: unknown) => T,
  options?: ExtractOptions,
): T;
export function extractJsonWith<T>(
  text: string,
  validator: Validator<T> | ((value: unknown) => T),
  options: ExtractOptions = {},
): T {
  const validate: (value: unknown) => T =
    typeof validator === "function" ? validator : (x) => validator.parse(x);
  const candidates = extractJsonCandidates(text, options);
  if (candidates.length === 0) {
    throw new LlmJsonExtractError({
      message: "No JSON-like content found in input",
      stage: "extract",
      raw: text,
      extracted: null,
    });
  }
  const repair = options.repair ?? true;
  // Two passes: try structured (object/array) candidates first, then primitives.
  // Validators that reject primitives won't be tricked by jsonrepair turning
  // stray words into JSON strings.
  let lastError: unknown;
  let lastCandidate: string | null = null;
  let lastStage: "parse" | "validate" = "parse";
  const primitives: { value: unknown; extracted: string }[] = [];
  for (const candidate of candidates) {
    lastCandidate = candidate;
    const parsed = tryParse(candidate, repair);
    if (!parsed.ok) {
      lastStage = "parse";
      lastError = parsed.error;
      continue;
    }
    if (!isStructured(parsed.value)) {
      primitives.push({ value: parsed.value, extracted: candidate });
      continue;
    }
    try {
      return validate(parsed.value);
    } catch (err) {
      lastStage = "validate";
      lastError = err;
    }
  }
  for (const p of primitives) {
    lastCandidate = p.extracted;
    try {
      return validate(p.value);
    } catch (err) {
      lastStage = "validate";
      lastError = err;
    }
  }
  throw new LlmJsonExtractError({
    message: `${lastStage === "parse" ? "JSON.parse" : "Validation"} failed for all candidates: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    stage: lastStage,
    raw: text,
    extracted: lastCandidate,
    cause: lastError,
  });
}

// ---------- internals ----------

interface TagMatch {
  body: string;
  start: number; // index of opening `<`
  end: number; // index just past closing `>`
}

function findAllTagMatches(text: string, tags: readonly string[]): TagMatch[] {
  const out: TagMatch[] = [];
  for (const tag of tags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const openRe = new RegExp(`<${escaped}(?:\\s[^>]*)?>`, "gi");
    let m = openRe.exec(text);
    while (m !== null) {
      const start = m.index;
      const bodyStart = start + m[0].length;
      const close = findTagClose(text, tag, bodyStart);
      if (close === null) {
        openRe.lastIndex = bodyStart;
        m = openRe.exec(text);
        continue;
      }
      out.push({
        body: text.slice(bodyStart, close.start),
        start,
        end: close.end,
      });
      openRe.lastIndex = close.end;
      m = openRe.exec(text);
    }
  }
  return out;
}

function findTagClose(
  text: string,
  tag: string,
  bodyStart: number,
): { start: number; end: number } | null {
  const jsonStart = skipWhitespace(text, bodyStart);
  const first = text[jsonStart];
  if (first === "{" || first === "[") {
    const jsonEnd = findBalancedEnd(text, jsonStart);
    if (jsonEnd !== null) {
      return findClosingTag(text, tag, jsonEnd + 1);
    }
  }
  if (first === '"') {
    const stringEnd = findJsonStringEnd(text, jsonStart);
    if (stringEnd !== null) {
      return findClosingTag(text, tag, stringEnd + 1);
    }
  }
  return findClosingTag(text, tag, bodyStart);
}

function findClosingTag(
  text: string,
  tag: string,
  startFrom: number,
): { start: number; end: number } | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const closeRe = new RegExp(`</${escaped}>`, "gi");
  closeRe.lastIndex = startFrom;
  const m = closeRe.exec(text);
  if (m === null) return null;
  return { start: m.index, end: m.index + m[0].length };
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  return i;
}

function findJsonStringEnd(text: string, start: number): number | null {
  if (text[start] !== '"') return null;
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') return i;
  }
  return null;
}

function findAllCodeFences(text: string): string[] {
  const labeled: { body: string; start: number }[] = [];
  const bare: { body: string; start: number }[] = [];
  // Labeled ```json fences (case-insensitive) take priority.
  // Support both standard newline form and inline space-separated form.
  for (const m of text.matchAll(/```json(?:[ \t]*\r?\n|[ \t]+)([\s\S]*?)```/gi)) {
    if (m[1] !== undefined && m.index !== undefined) {
      labeled.push({ body: m[1], start: m.index });
    }
  }
  // Bare ``` fences that don't have a language tag.
  for (const m of text.matchAll(/```(?:[ \t]*\r?\n|[ \t]+)([\s\S]*?)```/g)) {
    if (m[1] !== undefined && m.index !== undefined) {
      bare.push({ body: m[1], start: m.index });
    }
  }
  labeled.sort((a, b) => a.start - b.start);
  bare.sort((a, b) => a.start - b.start);
  return [...labeled.map((x) => x.body), ...bare.map((x) => x.body)];
}

function findAllBareJson(text: string): string[] {
  const spans: { start: number; end: number }[] = [];
  const stack: StackFrame[] = [];
  let lastBraceIndex = -1;
  let lastBracketIndex = -1;
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    if (stack.length === 0) {
      if (ch === "{" || ch === "[") {
        const state = pushStackFrame(stack, i, ch === "{" ? "}" : "]", {
          lastBraceIndex,
          lastBracketIndex,
        });
        lastBraceIndex = state.lastBraceIndex;
        lastBracketIndex = state.lastBracketIndex;
        inString = false;
        escaped = false;
        lineComment = false;
        blockComment = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && text[i + 1] === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "/" && text[i + 1] === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const state = pushStackFrame(stack, i, ch === "{" ? "}" : "]", {
        lastBraceIndex,
        lastBracketIndex,
      });
      lastBraceIndex = state.lastBraceIndex;
      lastBracketIndex = state.lastBracketIndex;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const matchingIndex = ch === "}" ? lastBraceIndex : lastBracketIndex;
      if (matchingIndex === -1) {
        stack.length = 0;
        lastBraceIndex = -1;
        lastBracketIndex = -1;
        inString = false;
        escaped = false;
        lineComment = false;
        blockComment = false;
        continue;
      }
      const span = stack[matchingIndex];
      if (span !== undefined) spans.push({ start: span.start, end: i });
      stack.length = matchingIndex;
      lastBraceIndex = span?.prevBraceIndex ?? -1;
      lastBracketIndex = span?.prevBracketIndex ?? -1;
      if (stack.length === 0) {
        inString = false;
        escaped = false;
        lineComment = false;
        blockComment = false;
      }
    }
  }
  return outermostSpans(spans).map((span) => text.slice(span.start, span.end + 1));
}

function findBalancedEnd(text: string, start: number): number | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const stack: StackFrame[] = [];
  let lastBraceIndex = -1;
  let lastBracketIndex = -1;
  let state = pushStackFrame(stack, start, open === "{" ? "}" : "]", {
    lastBraceIndex,
    lastBracketIndex,
  });
  lastBraceIndex = state.lastBraceIndex;
  lastBracketIndex = state.lastBracketIndex;
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && text[i + 1] === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    // Backslash is only an escape character inside JSON strings; outside, it's
    // just literal text. Treating it as escape unconditionally would skip the
    // next character in surrounding prose and could miscount brace balance.
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "/" && text[i + 1] === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      state = pushStackFrame(stack, i, ch === "{" ? "}" : "]", {
        lastBraceIndex,
        lastBracketIndex,
      });
      lastBraceIndex = state.lastBraceIndex;
      lastBracketIndex = state.lastBracketIndex;
    } else if (ch === "}" || ch === "]") {
      const matchingIndex = ch === "}" ? lastBraceIndex : lastBracketIndex;
      if (matchingIndex === -1) continue;
      const frame = stack[matchingIndex];
      stack.length = matchingIndex;
      lastBraceIndex = frame?.prevBraceIndex ?? -1;
      lastBracketIndex = frame?.prevBracketIndex ?? -1;
      if (stack.length === 0) return i;
    }
  }
  return null;
}

interface StackFrame {
  start: number;
  prevBraceIndex: number;
  prevBracketIndex: number;
}

function pushStackFrame(
  stack: StackFrame[],
  start: number,
  expected: "}" | "]",
  state: { lastBraceIndex: number; lastBracketIndex: number },
): { lastBraceIndex: number; lastBracketIndex: number } {
  const nextIndex = stack.length;
  stack.push({
    start,
    prevBraceIndex: state.lastBraceIndex,
    prevBracketIndex: state.lastBracketIndex,
  });
  if (expected === "}") {
    return { lastBraceIndex: nextIndex, lastBracketIndex: state.lastBracketIndex };
  }
  return { lastBraceIndex: state.lastBraceIndex, lastBracketIndex: nextIndex };
}

function outermostSpans(spans: { start: number; end: number }[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = out.at(-1);
    if (previous !== undefined && previous.start <= span.start && span.end <= previous.end) {
      continue;
    }
    out.push(span);
  }
  return out;
}

function isStructured(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function tryParse(
  candidate: string,
  repair: boolean,
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  const input = repair ? safeRepair(candidate) : candidate;
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (err) {
    return { ok: false, error: err };
  }
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
