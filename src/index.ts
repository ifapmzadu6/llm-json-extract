import {
  ASCII_DOUBLE_QUOTES,
  closingQuotesFor,
  DOUBLE_QUOTES,
  isSingleQuoteFamily,
  isWordCharacter,
  SINGLE_QUOTES,
} from "./quotes.js";
import { isClosedJsonContainer, isWordApostrophe, repairJson } from "./repair.js";

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
   * Whether to repair the extracted string before `JSON.parse`.
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
 *   4. Bare balanced `{...}` / `[...]` runs in the text, in document order,
 *      followed by a still-open container that runs to the end of the text
 *      (truncated output). Bracketed prose such as `[1]` or `[Thinking]`
 *      (an array with no quotes, colons, or nested containers) is tried last.
 *
 * A tag whose closing tag never appears (output cut off mid-answer) yields its
 * body up to the end of the text. When a tag or fence body starts with a
 * complete container followed by more text, that container alone is added
 * right after the full body.
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
  // `{...}\nHope this helps!` inside a tag: keep the full body first (it may be
  // NDJSON), then offer the leading container on its own.
  const pushWithLeadingContainer = (body: string): void => {
    push(body);
    push(leadingContainer(body));
  };

  // Strategy 1: all tag matches, with the preferred one first.
  const tagMatches = findAllTagMatches(text, tags);
  if (tagMatches.length > 0) {
    const sortedByDocPos = [...tagMatches].sort((a, b) => a.start - b.start);
    const preferred = pickLast
      ? [...tagMatches].sort((a, b) => a.end - b.end).pop()
      : sortedByDocPos[0];
    if (preferred !== undefined) pushWithLeadingContainer(preferred.body);
    for (const m of sortedByDocPos) pushWithLeadingContainer(m.body);
  }

  // Strategy 2: code fences in document order.
  if (tryCodeFence) {
    for (const f of findAllCodeFences(text)) pushWithLeadingContainer(f);
  }

  // Strategy 3: bare balanced JSON runs.
  // Bracketed prose (`[1]` citations, `[Thinking]`, Markdown links) is valid
  // or repairable JSON too, so it only gets a turn after real-looking data.
  if (tryBareJson) {
    const bare = findAllBareJson(text);
    for (const b of bare) if (!isBracketedProse(b)) push(b);
    for (const b of bare) if (isBracketedProse(b)) push(b);
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
 * the first one that successfully parses (after optional repair)
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
  // Two-pass: prefer object/array results over primitives, because repair can
  // turn bare words ("nope") into JSON strings, which would mask a
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
  // Validators that reject primitives won't be tricked by repair turning
  // stray words into JSON strings.
  let lastError: unknown;
  let lastCandidate: string | null = null;
  let lastStage: "parse" | "validate" = "parse";
  // The first structured candidate is the most likely "real answer"; remember
  // its failure so we can surface it even if a later primitive candidate also
  // fails validation. Without this, the primitives loop would overwrite the
  // structured failure with a less informative stray-prose error.
  let structuredError:
    | { stage: "parse" | "validate"; error: unknown; extracted: string }
    | undefined;
  const primitives: { value: unknown; extracted: string }[] = [];
  for (const candidate of candidates) {
    lastCandidate = candidate;
    const parsed = tryParse(candidate, repair);
    if (!parsed.ok) {
      lastStage = "parse";
      lastError = parsed.error;
      if (structuredError === undefined) {
        structuredError = { stage: "parse", error: parsed.error, extracted: candidate };
      }
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
      if (structuredError === undefined) {
        structuredError = { stage: "validate", error: err, extracted: candidate };
      }
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
  if (structuredError !== undefined) {
    lastStage = structuredError.stage;
    lastError = structuredError.error;
    lastCandidate = structuredError.extracted;
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

function isBracketedProse(candidate: string): boolean {
  return candidate[0] === "[" && !/["\u201c\u201d:{[]/.test(candidate.slice(1));
}

/** The complete container a body starts with, if more text follows it. */
function leadingContainer(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null;
  const end = findBalancedEnd(trimmed, 0);
  if (end === null || end === trimmed.length - 1) return null;
  return trimmed.slice(0, end + 1);
}

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
    const closeRe = new RegExp(`</${escaped}>`, "gi");
    const closeAt = new RegExp(`</${escaped}>`, "iy");
    let m = openRe.exec(text);
    while (m !== null) {
      const start = m.index;
      const bodyStart = start + m[0].length;
      const close = findTagClose(text, closeRe, closeAt, bodyStart);
      if (close === null) {
        // No closing tag follows, so the output was most likely cut off. Take
        // the last opening tag's body through the end of the text; repair
        // can close truncated strings and containers.
        let last = m;
        for (let next = openRe.exec(text); next !== null; next = openRe.exec(text)) last = next;
        out.push({
          body: text.slice(last.index + last[0].length),
          start: last.index,
          end: text.length,
        });
        break;
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
  closeRe: RegExp,
  closeAt: RegExp,
  bodyStart: number,
): { start: number; end: number } | null {
  const jsonStart = skipWhitespace(text, bodyStart);
  const first = text[jsonStart];
  if (first === "{" || first === "[") {
    const jsonEnd = findBalancedEnd(text, jsonStart, closeAt);
    if (jsonEnd !== null) {
      return findClosingTag(text, closeRe, jsonEnd + 1);
    }
  }
  if (first === '"') {
    const stringEnd = findJsonStringEnd(text, jsonStart);
    if (stringEnd !== null) {
      return findClosingTag(text, closeRe, stringEnd + 1);
    }
  }
  return findClosingTag(text, closeRe, bodyStart);
}

function findClosingTag(
  text: string,
  closeRe: RegExp,
  startFrom: number,
): { start: number; end: number } | null {
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

// Block form: the language tag (if any) is followed by a newline and the
// closing ``` sits on its own line (optionally indented). Requiring the close
// to be at a line boundary — rather than the first ``` anywhere — means triple
// backticks embedded inside the body (e.g. inside a JSON string value) don't
// prematurely terminate the fence.
const LABELED_BLOCK_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi;
const BARE_BLOCK_FENCE = /```[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
// Inline form: language tag and body share a single line, closed by the first
// ``` on that line. A single `[ \t]` separator (not `[ \t]+`) is required
// before the body: pairing a `[ \t]+` run with the lazy `[^\n]*?` body — whose
// character class also matches spaces/tabs — lets the two quantifiers split a
// long whitespace run in O(n) ways per start position, so an unterminated fence
// with many spaces triggers polynomial backtracking (ReDoS). With one fixed
// separator char only a single unbounded quantifier remains, keeping matching
// linear. Any extra leading whitespace is folded into the body capture and
// stripped by the caller's trim(), so accepted inputs are unchanged.
const LABELED_INLINE_FENCE = /```json[ \t]([^\n]*?)```/gi;
const BARE_INLINE_FENCE = /```[ \t]([^\n]*?)```/g;

function collectFences(text: string, ...patterns: RegExp[]): string[] {
  const found: { body: string; start: number }[] = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      if (m[1] !== undefined && m.index !== undefined) {
        found.push({ body: m[1], start: m.index });
      }
    }
  }
  return found.sort((a, b) => a.start - b.start).map((x) => x.body);
}

function findAllCodeFences(text: string): string[] {
  // Labeled ```json fences (case-insensitive) take priority over bare ones.
  const labeled = collectFences(text, LABELED_BLOCK_FENCE, LABELED_INLINE_FENCE);
  const bare = collectFences(text, BARE_BLOCK_FENCE, BARE_INLINE_FENCE);
  return [...labeled, ...bare];
}

const COMMENT_GLUE = /[\p{L}_:]/u;

interface ScanState {
  stringQuotes: ReadonlySet<string> | null;
  escaped: boolean;
  lineComment: boolean;
  blockComment: boolean;
  // Omitted from resets so the whole scan remembers whether recovery is needed.
  usedAlternateQuotes?: boolean;
  recoveryRequested?: boolean;
}

function resetScanState(): ScanState {
  return { stringQuotes: null, escaped: false, lineComment: false, blockComment: false };
}

/**
 * Advance the shared string/escape/comment state machine by one character.
 * Used by both `findAllBareJson` and `findBalancedEnd` to decide whether a
 * character is consumed by string/escape/comment bookkeeping (and must be
 * ignored by brace tracking).
 *
 * Returns:
 *   consumed  — true if the char was handled here; brace logic must skip it.
 *   skipNext  — true if a two-char token (`//`, `/*`, `*\/`) also swallowed the
 *               following character; the caller should bump `i` once more.
 */
function stepScan(
  state: ScanState,
  ch: string,
  nextCh: string | undefined,
  text: string,
  index: number,
  allowAlternateQuotes = true,
): {
  consumed: boolean;
  skipNext: boolean;
} {
  if (state.escaped) {
    state.escaped = false;
    return { consumed: true, skipNext: false };
  }
  if (state.lineComment) {
    if (ch === "\n" || ch === "\r") state.lineComment = false;
    return { consumed: true, skipNext: false };
  }
  if (state.blockComment) {
    if (ch === "*" && nextCh === "/") {
      state.blockComment = false;
      return { consumed: true, skipNext: true };
    }
    return { consumed: true, skipNext: false };
  }
  // Backslash is only an escape character inside JSON strings; outside, it's
  // just literal text. Treating it as escape unconditionally would skip the
  // next character in surrounding prose and could miscount brace balance.
  if (state.stringQuotes !== null) {
    // ASCII quotes inside an alternate string may belong to later strict JSON
    // hidden by an unmatched prose opener. Keep recovery available even when
    // desynchronized brackets subsequently empty the stack.
    if (ch === '"' && state.stringQuotes !== ASCII_DOUBLE_QUOTES) state.recoveryRequested = true;
    if (ch === "\\") {
      state.escaped = true;
    } else if (state.stringQuotes.has(ch)) {
      // Word apostrophes such as O'Connor are accepted by the repairer too.
      const singleFamily = isSingleQuoteFamily(state.stringQuotes);
      if (!singleFamily || !isWordApostrophe(text, index)) {
        // An unmatched prose quote can consume the opener of a later string.
        // Remember that ambiguity even if a stray bracket later empties the stack.
        if (singleFamily && isWordCharacter(nextCh) && !isWordCharacter(text[index - 1])) {
          state.recoveryRequested = true;
        }
        state.stringQuotes = null;
      }
    }
    return { consumed: true, skipNext: false };
  }
  if (ch === '"') {
    // Valid JSON may contain literal smart quotes inside an ASCII-quoted value.
    state.stringQuotes = ASCII_DOUBLE_QUOTES;
    return { consumed: true, skipNext: false };
  }
  // Avoid set lookups for ordinary ASCII characters in large numeric arrays.
  if (allowAlternateQuotes && (ch === "'" || ch === "`" || ch >= "\u0080")) {
    if (DOUBLE_QUOTES.has(ch)) {
      state.stringQuotes = closingQuotesFor(ch);
      state.usedAlternateQuotes = true;
      return { consumed: true, skipNext: false };
    }
    if (SINGLE_QUOTES.has(ch) && !isWordCharacter(text[index - 1])) {
      // Like the repairer, an ASCII `'` only closes with `'`, so backticks and
      // smart apostrophes inside it stay string content.
      state.stringQuotes = closingQuotesFor(ch);
      state.usedAlternateQuotes = true;
      return { consumed: true, skipNext: false };
    }
  }
  // `//` or `/*` glued to a word or colon is prose or a URL (`http://`,
  // `src/*`), not a comment; treating it as one would hide later brackets.
  if (
    ch === "/" &&
    (nextCh === "/" || nextCh === "*") &&
    !COMMENT_GLUE.test(text[index - 1] ?? "")
  ) {
    if (nextCh === "/") state.lineComment = true;
    else state.blockComment = true;
    return { consumed: true, skipNext: true };
  }
  return { consumed: false, skipNext: false };
}

function findAllBareJson(text: string): string[] {
  const { spans, openStarts } = findClosedBareJson(text, scanBareJson(text, true));
  return withTruncatedTail(spans, truncatedTail(text, openStarts)).map((span) =>
    text.slice(span.start, span.end + 1),
  );
}

/**
 * A container still open at the end of the text, e.g. output cut off by a
 * token limit. Uses the outermost open bracket that looks like the start of
 * JSON data, so a stray `{` in earlier prose does not swallow the answer.
 */
function truncatedTail(text: string, openStarts: readonly number[]): JsonSpan | null {
  for (const start of openStarts) {
    if (JSON_START.test(text.slice(start + 1, start + 256))) {
      return { start, end: text.length - 1 };
    }
  }
  return null;
}

// After the opening bracket: a string, a nested container, a number, a
// literal, or an unquoted `key:`.
const JSON_START = /^\s*(?:["'\u201c\u2018{[\d-]|(?:true|false|null)\b|[A-Za-z_$][\w$-]*\s*:)/;

/** Insert the truncated span ahead of the closed children it contains. */
function withTruncatedTail(spans: JsonSpan[], truncated: JsonSpan | null): JsonSpan[] {
  if (truncated === null) return spans;
  const index = spans.findIndex((span) => span.start > truncated.start);
  return index === -1
    ? [...spans, truncated]
    : [...spans.slice(0, index), truncated, ...spans.slice(index)];
}

/**
 * Closed bare-JSON spans, plus the brackets still open at the end of the text.
 * In recovery mode the open brackets come from the recovery scan, because the
 * primary scan's leftovers are an artifact of the unmatched quote.
 */
function findClosedBareJson(
  text: string,
  primaryScan: ReturnType<typeof scanBareJson>,
): { spans: JsonSpan[]; openStarts: number[] } {
  const primary = outermostSpans(primaryScan.spans);
  if (!primaryScan.needsRecovery) return { spans: primary, openStarts: primaryScan.openStarts };
  // A balanced span can still be prose or a fragment from a lost quote boundary.
  // Protect containers that parse without completing unmatched quotes or brackets.
  // These spans are disjoint, so classification never reparses nested substrings.
  // Classification does not change the raw candidates or the caller's repair mode.
  const protectedSpans = primary.filter((span) =>
    isClosedJsonContainer(text.slice(span.start, span.end + 1)),
  );
  const recoveryScan = scanBareJson(text, false, protectedSpans);
  const recovered = recoveryScan.spans.filter((span) => {
    const first = firstSpanEndingAtOrAfter(protectedSpans, span.start);
    // A recovery opener inside a protected candidate is string content or a
    // child, not an independent candidate. In particular, it cannot escape into prose.
    if (first !== undefined && first.start <= span.start) return false;
    const last = firstSpanEndingAtOrAfter(protectedSpans, span.end);
    // Only a whole enclosing parent may replace a protected child. Partial
    // overlaps must not truncate it or consume a later independent candidate.
    return last === undefined || last.start > span.end || last.end === span.end;
  });
  const selected = outermostSpans([...protectedSpans, ...recovered]);
  // Keep other malformed primary candidates only in uncovered regions; they
  // cannot displace a complete container or resurrect its nested fragments.
  const remaining = primary.filter((span) => {
    const next = firstSpanEndingAtOrAfter(selected, span.start);
    return next === undefined || next.start > span.end;
  });
  return {
    spans: [...selected, ...remaining].sort((a, b) => a.start - b.start),
    openStarts: recoveryScan.openStarts,
  };
}

interface JsonSpan {
  start: number;
  end: number;
}

/** Binary search over disjoint spans in document order. */
function firstSpanEndingAtOrAfter(
  spans: readonly JsonSpan[],
  position: number,
): JsonSpan | undefined {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (spans[middle]!.end < position) low = middle + 1;
    else high = middle;
  }
  return spans[low];
}

function scanBareJson(
  text: string,
  allowAlternateQuotes: boolean,
  protectedSpans?: readonly JsonSpan[],
): { spans: JsonSpan[]; needsRecovery: boolean; openStarts: number[] } {
  const spans: JsonSpan[] = [];
  const stack: StackFrame[] = [];
  let lastBraceFrameIndex = -1;
  let lastBracketFrameIndex = -1;
  let protectedIndex = 0;
  const scan = resetScanState();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    const protectedSpan = protectedSpans?.[protectedIndex];
    if (protectedSpan?.start === i) {
      protectedIndex++;
      if (scan.stringQuotes === null && !scan.lineComment && !scan.blockComment) {
        // Treat a closed container as an opaque value, including inside a
        // recoverable parent. Its strings cannot spawn false recovery roots.
        // Inside an ASCII string, the enclosing recovery candidate owns the
        // quote state; JSON-shaped text there must remain ordinary string content.
        i = protectedSpan.end;
        continue;
      }
    }
    if (stack.length === 0) {
      if (ch === "{" || ch === "[") {
        const state = pushStackFrame(stack, i, ch === "{" ? "}" : "]", {
          lastBraceFrameIndex,
          lastBracketFrameIndex,
        });
        lastBraceFrameIndex = state.lastBraceFrameIndex;
        lastBracketFrameIndex = state.lastBracketFrameIndex;
        Object.assign(scan, resetScanState());
      }
      continue;
    }

    const r = stepScan(scan, ch, text[i + 1], text, i, allowAlternateQuotes);
    if (r.skipNext) i++;
    if (r.consumed) continue;

    if (ch === "{" || ch === "[") {
      const state = pushStackFrame(stack, i, ch === "{" ? "}" : "]", {
        lastBraceFrameIndex,
        lastBracketFrameIndex,
      });
      lastBraceFrameIndex = state.lastBraceFrameIndex;
      lastBracketFrameIndex = state.lastBracketFrameIndex;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const matchingIndex = ch === "}" ? lastBraceFrameIndex : lastBracketFrameIndex;
      if (matchingIndex === -1) {
        if (scan.usedAlternateQuotes) scan.recoveryRequested = true;
        stack.length = 0;
        lastBraceFrameIndex = -1;
        lastBracketFrameIndex = -1;
        Object.assign(scan, resetScanState());
        continue;
      }
      const span = stack[matchingIndex];
      if (span !== undefined) spans.push({ start: span.start, end: i });
      stack.length = matchingIndex;
      lastBraceFrameIndex = span?.prevBraceFrameIndex ?? -1;
      lastBracketFrameIndex = span?.prevBracketFrameIndex ?? -1;
      if (stack.length === 0) {
        Object.assign(scan, resetScanState());
      }
    }
  }
  return {
    spans,
    openStarts: stack.map((frame) => frame.start),
    needsRecovery:
      scan.usedAlternateQuotes === true && (stack.length > 0 || scan.recoveryRequested === true),
  };
}

/**
 * Index of the bracket closing the container at `start`, or null if it never
 * closes. With `stopAt`, a match outside strings and comments ends the search
 * early: a closing tag there cannot be part of the JSON value, and stopping
 * keeps many unbalanced tag bodies from each scanning to the end of the text.
 */
function findBalancedEnd(text: string, start: number, stopAt?: RegExp): number | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const stack: StackFrame[] = [];
  let lastBraceFrameIndex = -1;
  let lastBracketFrameIndex = -1;
  let state = pushStackFrame(stack, start, open === "{" ? "}" : "]", {
    lastBraceFrameIndex,
    lastBracketFrameIndex,
  });
  lastBraceFrameIndex = state.lastBraceFrameIndex;
  lastBracketFrameIndex = state.lastBracketFrameIndex;
  const scan = resetScanState();
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    const r = stepScan(scan, ch, text[i + 1], text, i);
    if (r.skipNext) i++;
    if (r.consumed) continue;

    if (ch === "{" || ch === "[") {
      state = pushStackFrame(stack, i, ch === "{" ? "}" : "]", {
        lastBraceFrameIndex,
        lastBracketFrameIndex,
      });
      lastBraceFrameIndex = state.lastBraceFrameIndex;
      lastBracketFrameIndex = state.lastBracketFrameIndex;
    } else if (ch === "}" || ch === "]") {
      const matchingIndex = ch === "}" ? lastBraceFrameIndex : lastBracketFrameIndex;
      if (matchingIndex === -1) continue;
      const frame = stack[matchingIndex];
      stack.length = matchingIndex;
      lastBraceFrameIndex = frame?.prevBraceFrameIndex ?? -1;
      lastBracketFrameIndex = frame?.prevBracketFrameIndex ?? -1;
      if (stack.length === 0) return i;
    } else if (ch === "<" && stopAt !== undefined) {
      stopAt.lastIndex = i;
      if (stopAt.test(text)) return null;
    }
  }
  return null;
}

interface StackFrame {
  start: number;
  prevBraceFrameIndex: number;
  prevBracketFrameIndex: number;
}

function pushStackFrame(
  stack: StackFrame[],
  start: number,
  expected: "}" | "]",
  state: { lastBraceFrameIndex: number; lastBracketFrameIndex: number },
): { lastBraceFrameIndex: number; lastBracketFrameIndex: number } {
  const nextIndex = stack.length;
  stack.push({
    start,
    prevBraceFrameIndex: state.lastBraceFrameIndex,
    prevBracketFrameIndex: state.lastBracketFrameIndex,
  });
  if (expected === "}") {
    return { lastBraceFrameIndex: nextIndex, lastBracketFrameIndex: state.lastBracketFrameIndex };
  }
  return { lastBraceFrameIndex: state.lastBraceFrameIndex, lastBracketFrameIndex: nextIndex };
}

function outermostSpans<T extends { start: number; end: number }>(spans: T[]): T[] {
  const out: T[] = [];
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
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (rawError) {
    if (!repair) return { ok: false, error: rawError };
  }

  const input = safeRepair(candidate);
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function safeRepair(input: string): string {
  try {
    return repairJson(input);
  } catch {
    // Repair failed — fall back to raw input so JSON.parse surfaces the
    // original parse error instead of the repairer's internal one.
    return input;
  }
}
