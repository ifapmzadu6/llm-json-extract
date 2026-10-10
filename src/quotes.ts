// Keep extraction and repair in agreement about supported quote families.
export const DOUBLE_QUOTES: ReadonlySet<string> = new Set(['"', "“", "”"]);
export const SINGLE_QUOTES: ReadonlySet<string> = new Set(["'", "`", "´", "‘", "’"]);
export const ASCII_DOUBLE_QUOTES: ReadonlySet<string> = new Set(['"']);
export const ASCII_SINGLE_QUOTES: ReadonlySet<string> = new Set(["'"]);

/**
 * Quotes that may close a string opened by `opening`. ASCII quotes only close
 * with themselves, so a backtick or smart apostrophe inside `'...'` (or a
 * smart quote inside `"..."`) stays string content. Typographic and other
 * quote-like openers accept any member of their family, as jsonrepair does.
 */
export function closingQuotesFor(opening: string): ReadonlySet<string> {
  if (opening === '"') return ASCII_DOUBLE_QUOTES;
  if (opening === "'") return ASCII_SINGLE_QUOTES;
  return DOUBLE_QUOTES.has(opening) ? DOUBLE_QUOTES : SINGLE_QUOTES;
}

export function isSingleQuoteFamily(quotes: ReadonlySet<string> | null): boolean {
  return quotes === SINGLE_QUOTES || quotes === ASCII_SINGLE_QUOTES;
}

export function isWordCharacter(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}
