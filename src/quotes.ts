// Keep extraction and repair in agreement about supported quote families.
export const DOUBLE_QUOTES: ReadonlySet<string> = new Set(['"', "\u201c", "\u201d"]);
export const SINGLE_QUOTES: ReadonlySet<string> = new Set(["'", "`", "\u00b4", "\u2018", "\u2019"]);

export function isWordCharacter(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}
