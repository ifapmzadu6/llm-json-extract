const DOUBLE_QUOTES = new Set(['"', "\u201c", "\u201d"]);
const SINGLE_QUOTES = new Set(["'", "`", "\u00b4", "\u2018", "\u2019"]);
const ESCAPE_CHARACTERS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "/": "/",
  "\\": "\\",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ["false", "false"],
  ["null", "null"],
  ["true", "true"],
  ["False", "false"],
  ["None", "null"],
  ["True", "true"],
  ["undefined", "null"],
];
const NAMED_HTML_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
];

/**
 * Repair the small, predictable set of JSON mistakes commonly emitted by LLMs.
 *
 * This intentionally produces JSON text and lets the native `JSON.parse` create
 * the value. Besides keeping parsing semantics familiar, that avoids evaluating
 * untrusted model output as JavaScript.
 */
export function repairJson(input: string): string {
  return new JsonRepairParser(unwrapMarkdownCodeFence(input)).repair();
}

class JsonRepairParser {
  private pendingArraySplit = false;
  private position = 0;

  constructor(private readonly input: string) {}

  repair(): string {
    this.skipIgnorable();
    if (this.atEnd()) throw this.syntaxError("Expected a JSON value");

    const values = [this.parseValue()];
    let separator = this.skipIgnorable();

    // A comma after the root value is just a trailing comma.
    if (this.peek() === ",") {
      const splitArray = this.pendingArraySplit;
      this.pendingArraySplit = false;
      this.position++;
      separator = this.skipIgnorable();
      if (this.atEnd()) return values[0]!;

      // jsonrepair 3.15 interprets a doubled comma inside a top-level array
      // as the end of that array followed by more root values.
      if (splitArray) {
        while (!this.atEnd() && this.canStartValueAt(this.position)) {
          values.push(this.parseValue());
          separator = this.skipIgnorable();
          if (this.peek() !== ",") break;
          this.pendingArraySplit = false;
          this.position++;
          separator = this.skipIgnorable();
        }
      }
    }

    // Retain useful support for newline-delimited JSON while keeping unrelated
    // trailing prose an error.
    while (!this.atEnd() && separator.sawNewline && this.canStartValueAt(this.position)) {
      values.push(this.parseValue());
      separator = this.skipIgnorable();
      if (this.peek() === ",") {
        this.position++;
        separator = this.skipIgnorable();
      }
    }

    // Extra closing brackets are a common streaming/truncation artifact.
    while (this.peek() === "}" || this.peek() === "]") {
      this.position++;
      this.skipIgnorable();
    }

    if (!this.atEnd()) {
      throw this.syntaxError(`Unexpected character ${JSON.stringify(this.peek())}`);
    }

    return values.length === 1 ? values[0]! : `[${values.join(",")}]`;
  }

  private parseValue(): string {
    this.skipIgnorable();
    const char = this.peek();

    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (isQuote(char) || this.startsEscapedString() || this.startsHtmlQuotedString()) {
      return this.parseString();
    }
    if (char === "/" && this.peek(1) !== "/" && this.peek(1) !== "*") {
      return JSON.stringify(this.parseRegularExpression());
    }

    const functionValue = this.tryParseFunctionCall();
    if (functionValue !== null) return functionValue;

    const keyword = this.tryParseKeyword();
    if (keyword !== null) return keyword;

    const number = this.tryParseNumber();
    if (number !== null) return number;

    return this.parseUnquotedValue();
  }

  private parseObject(): string {
    this.position++;
    const entries: string[] = [];

    while (true) {
      this.skipIgnorable();
      if (entries.length === 0 && this.peek() === ",") {
        this.position++;
        this.skipIgnorable();
      }

      if (this.peek() === "}") {
        this.position++;
        break;
      }
      // Let the parent consume a mismatched closer; this synthesizes the
      // missing `}` without losing the parent's delimiter.
      if (this.peek() === "]" || this.atEnd()) break;
      if (this.skipEllipsis()) continue;

      const key = this.parseObjectKey();
      this.skipIgnorable();
      const hasColon = this.peek() === ":";
      if (hasColon) this.position++;
      this.skipIgnorable();
      const missingColonBeforeKeyword = !hasColon && this.isKeywordAt(this.position);

      let value: string;
      const next = this.peek();
      if (next === undefined || next === "," || next === "}" || next === "]") {
        // A present colon with no value, or a truncated `key:`, is best
        // represented by null rather than dropping the key entirely.
        if (!hasColon) throw this.syntaxError("Expected ':' after object key");
        value = "null";
      } else if (!hasColon && !this.canStartValueAt(this.position) && !this.startsEscapedString()) {
        throw this.syntaxError("Expected ':' after object key");
      } else {
        value = this.parseValue();
      }
      entries.push(`${key}:${value}`);

      this.skipIgnorable();
      if (missingColonBeforeKeyword && this.peek() === ",") {
        throw this.syntaxError("Expected ':' after object key");
      }
      if (this.pendingArraySplit) {
        throw this.syntaxError("Unexpected array separator in object value");
      }
      if (this.peek() === ",") {
        this.position++;
        continue;
      }
      if (this.peek() === "}") {
        this.position++;
        break;
      }
      if (this.peek() === "]" || this.atEnd()) break;
      // Otherwise the comma was omitted; the next loop parses the next key.
    }

    return `{${entries.join(",")}}`;
  }

  private parseArray(): string {
    this.position++;
    const values: string[] = [];

    while (true) {
      this.skipIgnorable();
      if (values.length === 0 && this.peek() === ",") {
        this.position++;
        this.skipIgnorable();
        if (this.peek() === ",") {
          const checkpoint = this.position;
          this.position++;
          this.skipIgnorable();
          if (this.peek() === "]") {
            this.position++;
            break;
          }
          this.position = checkpoint;
          this.pendingArraySplit = true;
          break;
        }
      } else if (values.length > 0 && this.peek() === ",") {
        // jsonrepair 3.15 accepts one extra comma immediately before the
        // closing bracket (for example `[1, 2,,]`). Keep that compatibility
        // without accepting empty array elements in the middle.
        const checkpoint = this.position;
        this.position++;
        this.skipIgnorable();
        if (this.peek() === "]") {
          this.position++;
          break;
        }
        this.position = checkpoint;
        this.pendingArraySplit = true;
        break;
      }

      if (this.peek() === "]") {
        this.position++;
        break;
      }
      // Synthesize a missing `]`, leaving `}` for the containing object.
      if (this.peek() === "}" || this.atEnd()) break;
      if (this.skipEllipsis()) continue;

      values.push(this.parseValue());
      this.skipIgnorable();
      if (this.peek() === ",") {
        this.pendingArraySplit = false;
        this.position++;
        continue;
      }
      if (this.peek() === "]") {
        this.position++;
        break;
      }
      if (this.peek() === "}" || this.atEnd()) break;
      // Otherwise the comma was omitted; parse another value.
    }

    return `[${values.join(",")}]`;
  }

  private parseObjectKey(): string {
    if (isQuote(this.peek()) || this.startsEscapedString() || this.startsHtmlQuotedString()) {
      return JSON.stringify(this.parseStringValue());
    }

    const start = this.position;
    while (!this.atEnd()) {
      const char = this.peek();
      if (char === undefined || isQuote(char) || ":,{}[]/\n\r".includes(char)) {
        break;
      }
      this.position++;
    }

    const key = trimJsonWhitespace(this.input.slice(start, this.position));
    if (key.length === 0) throw this.syntaxError("Expected an object key");
    return JSON.stringify(key);
  }

  private parseStringValue(): string {
    const escapedBoundary = this.startsEscapedString();
    const openingEntity = escapedBoundary ? null : matchHtmlEntity(this.input, this.position);
    const openedByEntity = openingEntity !== null && isQuote(openingEntity.char);
    const openingQuote = escapedBoundary
      ? this.peek(1)
      : openedByEntity
        ? openingEntity.char
        : this.peek();
    if (openingQuote === undefined || !isQuote(openingQuote)) {
      throw this.syntaxError("Expected a string");
    }
    const quoteFamily = DOUBLE_QUOTES.has(openingQuote) ? DOUBLE_QUOTES : SINGLE_QUOTES;
    this.position += escapedBoundary ? 2 : openedByEntity ? openingEntity.length : 1;

    let value = "";
    while (!this.atEnd()) {
      const char = this.peek();
      if (char === undefined) break;

      if (openedByEntity && char === "&") {
        const entity = matchHtmlEntity(this.input, this.position);
        if (entity !== null) {
          if (
            quoteFamily.has(entity.char) &&
            this.isLikelyClosingQuoteAfter(this.position + entity.length)
          ) {
            this.position += entity.length;
            return value;
          }
          value += entity.char;
          this.position += entity.length;
          continue;
        }
      }

      const quotePosition = escapedBoundary && char === "\\" ? this.position + 1 : this.position;
      const quote = this.input[quotePosition];
      if (quoteFamily.has(quote ?? "")) {
        if (this.isLikelyClosingQuote(quotePosition)) {
          this.position = quotePosition + 1;
          return value;
        }
        // A quote followed immediately by more text is usually an unescaped
        // quote inside the string (for example: "say "hello"").
        value += quote;
        this.position = quotePosition + 1;
        continue;
      }

      if (char === "\\") {
        value += this.parseEscapeSequence();
        continue;
      }

      // If the final container closer is reached without an end quote, leave
      // it for the object/array parser and synthesize the quote here.
      if ((char === "}" || char === "]") && this.onlyIgnorableAfter(this.position + 1)) {
        return trimJsonWhitespaceEnd(value);
      }

      value += char;
      this.position++;
    }

    return trimJsonWhitespaceEnd(value);
  }

  private parseString(): string {
    let value = this.parseStringValue();
    while (true) {
      const checkpoint = this.position;
      this.skipIgnorable();
      if (this.peek() !== "+") {
        this.position = checkpoint;
        break;
      }

      this.position++;
      this.skipIgnorable();
      if (!isQuote(this.peek()) && !this.startsEscapedString() && !this.startsHtmlQuotedString()) {
        this.position = checkpoint;
        break;
      }
      value += this.parseStringValue();
    }
    return JSON.stringify(value);
  }

  private parseEscapeSequence(): string {
    this.position++;
    const escaped = this.peek();
    if (escaped === undefined) return "";

    const value = ESCAPE_CHARACTERS[escaped];
    if (value !== undefined) {
      this.position++;
      return value;
    }

    if (escaped === "u") {
      const hex = this.input.slice(this.position + 1, this.position + 5);
      if (/^[\da-fA-F]{4}$/.test(hex)) {
        this.position += 5;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      if (this.position + 5 >= this.input.length) {
        this.position = this.input.length;
        return "";
      }
      throw this.syntaxError("Invalid Unicode escape sequence");
    }

    if (escaped === "\n" || escaped === "\r") {
      this.position++;
      if (escaped === "\r" && this.peek() === "\n") this.position++;
      return "\n";
    }

    // JSON does not allow escapes such as `\q`. Removing the unnecessary
    // backslash retains the intended character and mirrors common JS repair.
    this.position++;
    return escaped;
  }

  private tryParseKeyword(): string | null {
    for (const [source, repaired] of KEYWORDS) {
      if (!this.input.startsWith(source, this.position)) continue;
      const next = this.peek(source.length);
      if (
        next !== undefined &&
        !isValueBoundary(next) &&
        !isQuote(next) &&
        !this.input.startsWith("...", this.position + source.length)
      ) {
        continue;
      }
      this.position += source.length;
      return repaired;
    }
    return null;
  }

  private tryParseNumber(): string | null {
    const start = this.position;
    let cursor = start;

    if (this.input[cursor] === "-") {
      cursor++;
      const afterMinus = this.input[cursor];
      if (afterMinus === undefined || isValueBoundary(afterMinus)) {
        this.position = cursor;
        return "-0";
      }
    }

    if (!isDigit(this.input[cursor])) return null;
    while (isDigit(this.input[cursor])) cursor++;

    if (this.input[cursor] === ".") {
      cursor++;
      const fractionStart = cursor;
      while (isDigit(this.input[cursor])) cursor++;
      const afterFraction = this.input[cursor];
      if (
        cursor === fractionStart &&
        afterFraction !== undefined &&
        afterFraction !== "e" &&
        afterFraction !== "E" &&
        !isValueBoundary(afterFraction)
      ) {
        return null;
      }
    }

    if (this.input[cursor] === "e" || this.input[cursor] === "E") {
      cursor++;
      if (this.input[cursor] === "+" || this.input[cursor] === "-") cursor++;
      const exponentStart = cursor;
      while (isDigit(this.input[cursor])) cursor++;
      const afterExponent = this.input[cursor];
      if (
        cursor === exponentStart &&
        afterExponent !== undefined &&
        !isValueBoundary(afterExponent)
      ) {
        return null;
      }
    }

    const next = this.input[cursor];
    if (next !== undefined && !isValueBoundary(next)) return null;

    const raw = this.input.slice(start, cursor);
    this.position = cursor;

    if (/^-?0\d/.test(raw)) return JSON.stringify(raw);

    let repaired = raw;
    if (/\.([eE])/.test(repaired)) repaired = repaired.replace(".", ".0");
    else if (repaired.endsWith(".")) repaired += "0";
    if (/[eE][+-]?$/.test(repaired)) repaired += "0";
    return repaired;
  }

  private parseUnquotedValue(): string {
    const start = this.position;
    while (!this.atEnd()) {
      const char = this.peek();
      if (char === undefined || isQuote(char) || ",{}[]\n\r+()".includes(char)) break;
      if (
        char === "/" &&
        (this.peek(1) === "/" || this.peek(1) === "*") &&
        (this.position === start || isWhitespace(this.input[this.position - 1]))
      ) {
        break;
      }
      this.position++;
    }

    const value = trimJsonWhitespace(this.input.slice(start, this.position));
    if (value.length === 0) throw this.syntaxError("Expected a JSON value");

    // A lone end quote most likely belongs to this unquoted string.
    if (isQuote(this.peek()) && this.isLikelyClosingQuote(this.position)) this.position++;
    return value === "undefined" ? "null" : JSON.stringify(value);
  }

  private tryParseFunctionCall(): string | null {
    if (!isIdentifierStart(this.peek())) return null;

    let next = this.position + 1;
    while (isIdentifierPart(this.input[next])) next++;
    while (isWhitespace(this.input[next])) next++;
    if (this.input[next] !== "(") return null;

    this.position = next + 1;
    const value = this.parseValue();
    this.skipIgnorable();
    if (this.peek() === ")") this.position++;
    if (this.peek() === ";") this.position++;
    return value;
  }

  private parseRegularExpression(): string {
    const start = this.position;
    this.position++;
    let escaped = false;
    while (!this.atEnd()) {
      const char = this.peek();
      this.position++;
      if (char === "/" && !escaped) break;
      escaped = char === "\\" && !escaped;
      if (char !== "\\") escaped = false;
    }
    return this.input.slice(start, this.position);
  }

  private skipEllipsis(): boolean {
    if (!this.input.startsWith("...", this.position)) return false;
    this.position += 3;
    // With six dots, jsonrepair treats the first triplet as an ellipsis marker
    // and preserves the second triplet as a string value.
    if (this.input.startsWith("...", this.position)) return false;
    this.skipIgnorable();
    if (this.peek() === ",") this.position++;
    return true;
  }

  private skipIgnorable(): { sawNewline: boolean } {
    let sawNewline = false;
    while (!this.atEnd()) {
      const char = this.peek();
      if (char !== undefined && isWhitespace(char)) {
        if (char === "\n" || char === "\r") sawNewline = true;
        this.position++;
        continue;
      }
      if (char === "/" && this.peek(1) === "/") {
        this.position += 2;
        while (!this.atEnd() && this.peek() !== "\n" && this.peek() !== "\r") this.position++;
        continue;
      }
      if (char === "/" && this.peek(1) === "*") {
        this.position += 2;
        while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) {
          if (this.peek() === "\n" || this.peek() === "\r") sawNewline = true;
          this.position++;
        }
        if (!this.atEnd()) this.position += 2;
        continue;
      }
      break;
    }
    return { sawNewline };
  }

  private isLikelyClosingQuote(index: number): boolean {
    return this.isLikelyClosingQuoteAfter(index + 1);
  }

  private isLikelyClosingQuoteAfter(afterQuote: number): boolean {
    const next = this.nextSignificantIndex(afterQuote);
    const char = this.input[next];
    if (char === undefined || ",:[]{}+);".includes(char) || isQuote(char) || isDigit(char)) {
      return true;
    }

    // Whitespace between the quote and a new value generally means the comma
    // was omitted. With no whitespace, assume the quote itself was unescaped.
    if (next > afterQuote && this.canStartValueAt(next)) return true;

    if (this.isKeywordAt(next)) return true;
    if (this.looksLikeObjectKeyAt(next)) return true;

    return false;
  }

  private isKeywordAt(index: number): boolean {
    for (const [keyword] of KEYWORDS) {
      if (!this.input.startsWith(keyword, index)) continue;
      const next = this.input[index + keyword.length];
      if (next === undefined || isWhitespace(next) || ",}]".includes(next)) return true;
    }
    return false;
  }

  private looksLikeObjectKeyAt(start: number): boolean {
    if (!isIdentifierStart(this.input[start])) return false;
    for (let index = start + 1; index < this.input.length; index++) {
      const char = this.input[index];
      if (char === ":") return true;
      if (isIdentifierPart(char) || char === "-" || isWhitespace(char)) continue;
      return false;
    }
    return false;
  }

  private nextSignificantIndex(start: number): number {
    let index = start;
    while (index < this.input.length) {
      const char = this.input[index];
      if (char !== undefined && isWhitespace(char)) {
        index++;
        continue;
      }
      if (char === "/" && this.input[index + 1] === "/") {
        index += 2;
        while (index < this.input.length && !"\n\r".includes(this.input[index] ?? "")) index++;
        continue;
      }
      if (char === "/" && this.input[index + 1] === "*") {
        const close = this.input.indexOf("*/", index + 2);
        if (close === -1) return this.input.length;
        index = close + 2;
        continue;
      }
      break;
    }
    return index;
  }

  private onlyIgnorableAfter(start: number): boolean {
    return this.nextSignificantIndex(start) >= this.input.length;
  }

  private canStartValue(char: string | undefined): boolean {
    return (
      char !== undefined &&
      (char === "{" ||
        char === "[" ||
        char === "/" ||
        char === "-" ||
        isQuote(char) ||
        isDigit(char) ||
        isIdentifierStart(char))
    );
  }

  private canStartValueAt(index: number): boolean {
    return (
      this.canStartValue(this.input[index]) || isQuote(matchHtmlEntity(this.input, index)?.char)
    );
  }

  private startsEscapedString(): boolean {
    return this.peek() === "\\" && isQuote(this.peek(1));
  }

  private startsHtmlQuotedString(): boolean {
    return isQuote(matchHtmlEntity(this.input, this.position)?.char);
  }

  private peek(offset = 0): string | undefined {
    return this.input[this.position + offset];
  }

  private atEnd(): boolean {
    return this.position >= this.input.length;
  }

  private syntaxError(message: string): SyntaxError {
    return new SyntaxError(`${message} at position ${this.position}`);
  }
}

function isQuote(char: string | undefined): boolean {
  return char !== undefined && (DOUBLE_QUOTES.has(char) || SINGLE_QUOTES.has(char));
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isIdentifierStart(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_" || char === "$")
  );
}

function isIdentifierPart(char: string | undefined): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

function isValueBoundary(char: string): boolean {
  return isWhitespace(char) || ",[]{}:/+()".includes(char);
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && (/\s/u.test(char) || char === "\u180e" || char === "\u200b");
}

function trimJsonWhitespace(value: string): string {
  return trimJsonWhitespaceEnd(value.replace(/^[ \t\n\r]+/, ""));
}

function trimJsonWhitespaceEnd(value: string): string {
  return value.replace(/[ \t\n\r]+$/, "");
}

interface HtmlEntity {
  char: string;
  length: number;
}

function matchHtmlEntity(input: string, index: number): HtmlEntity | null {
  if (input[index] !== "&") return null;

  for (const [name, char] of NAMED_HTML_ENTITIES) {
    const entity = `&${name};`;
    if (input.startsWith(entity, index)) return { char, length: entity.length };
  }

  if (input[index + 1] !== "#") return null;
  let cursor = index + 2;
  let radix = 10;
  if (input[cursor] === "x" || input[cursor] === "X") {
    radix = 16;
    cursor++;
  }

  const digitsStart = cursor;
  const maxEnd = Math.min(input.length, index + 12);
  while (cursor < maxEnd && (radix === 16 ? isHexDigit(input[cursor]) : isDigit(input[cursor]))) {
    cursor++;
  }
  if (cursor === digitsStart || input[cursor] !== ";") return null;

  const codePoint = Number.parseInt(input.slice(digitsStart, cursor), radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return null;
  return {
    char: String.fromCodePoint(codePoint),
    length: cursor - index + 1,
  };
}

function isHexDigit(char: string | undefined): boolean {
  return (
    isDigit(char) ||
    (char !== undefined && ((char >= "A" && char <= "F") || (char >= "a" && char <= "f")))
  );
}

function unwrapMarkdownCodeFence(input: string): string {
  const trimmed = input.trim();
  const wrapped =
    (trimmed.startsWith("[```") && trimmed.endsWith("```]")) ||
    (trimmed.startsWith("{```") && trimmed.endsWith("```}"));
  const value = wrapped ? trimmed.slice(1, -1).trim() : trimmed;
  if (!value.startsWith("```")) return input;

  const closingFence = value.lastIndexOf("```");
  const contentEnd = closingFence > 0 ? closingFence : value.length;
  let contentStart = 3;
  while (isIdentifierPart(value[contentStart]) || value[contentStart] === "-") contentStart++;
  while (isWhitespace(value[contentStart])) contentStart++;
  return value.slice(contentStart, contentEnd).trim();
}
