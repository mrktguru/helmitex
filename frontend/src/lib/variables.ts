/** Token regex: {{token}} where token matches /^[a-zA-Z_][a-zA-Z0-9_]*$/ */
export const VARIABLE_TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Plain token name validation (without braces). */
export const VARIABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Replace `{{token}}` occurrences in text with corresponding `vars[token]` value.
 * Unknown or empty tokens are kept as-is (e.g. `{{date}}` stays literal).
 */
export function substituteVariables(text: string, vars: Record<string, string>): string {
  if (!text || !text.includes('{{')) return text;
  return text.replace(VARIABLE_TOKEN_RE, (m, key) => {
    const v = vars[key];
    return v !== undefined && v !== '' ? v : m;
  });
}

/** True if the given text contains at least one `{{token}}` reference. */
export function hasVariableRefs(text: string): boolean {
  if (!text) return false;
  VARIABLE_TOKEN_RE.lastIndex = 0;
  return VARIABLE_TOKEN_RE.test(text);
}
