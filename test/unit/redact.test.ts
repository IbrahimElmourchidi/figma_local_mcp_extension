import { describe, expect, it } from 'vitest';
import { redactToken } from '../../src/util/redact';

describe('redactToken', () => {
  const token = 'e2e-token-0123456789abcdef';

  it("redacts bridge-cli's pairing-token startup line", () => {
    expect(redactToken(`Pairing token (sensitive): ${token}`, token)).toBe(
      'Pairing token (sensitive): <redacted>',
    );
  });

  it('redacts every occurrence', () => {
    expect(redactToken(`${token} and ${token}`, token)).toBe('<redacted> and <redacted>');
  });

  it('leaves lines alone when there is no token', () => {
    expect(redactToken('Session: abc', undefined)).toBe('Session: abc');
    expect(redactToken('a b', '')).toBe('a b');
  });
});
