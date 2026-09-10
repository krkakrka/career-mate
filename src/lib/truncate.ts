/**
 * Truncates without splitting a surrogate pair.
 *
 * A bare `slice` cuts by UTF-16 code unit, so a cut landing between the
 * halves of an astral character (an emoji in a job posting is enough)
 * leaves a lone surrogate: legal in a JS string and hashable, but written
 * to disk as UTF-8 it becomes U+FFFD — and then the bytes on disk no
 * longer hash to the hash recorded beside them, which is the one guarantee
 * the page store rests on.
 */
export function truncateAtCodePoint(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const lastUnit = value.charCodeAt(maxLength - 1);
  const splitsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return value.slice(0, splitsSurrogatePair ? maxLength - 1 : maxLength);
}
