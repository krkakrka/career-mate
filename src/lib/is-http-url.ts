/** True for a well-formed absolute http(s) URL. Shared by CLI argument validation and validating LLM-extracted URLs before they're persisted. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
