/** Replace every occurrence of `secret` in `line` (no-op for empty/short secrets). */
export function redactToken(line: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) {
    return line;
  }
  return line.split(secret).join('<redacted>');
}
