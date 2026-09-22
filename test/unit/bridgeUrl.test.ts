import { describe, expect, it } from 'vitest';
import { bridgeUrl, formatHost } from '../../src/util/bridgeUrl';

describe('bridgeUrl', () => {
  it('formats host and port as an http URL', () => {
    expect(bridgeUrl({ host: '127.0.0.1', port: 3845 })).toBe('http://127.0.0.1:3845');
  });

  it('supports alternate valid hosts', () => {
    expect(bridgeUrl({ host: 'localhost', port: 8080 })).toBe('http://localhost:8080');
  });

  it('brackets IPv6 hosts', () => {
    expect(bridgeUrl({ host: '::1', port: 3845 })).toBe('http://[::1]:3845');
  });

  it('does not double-bracket already-bracketed hosts', () => {
    expect(formatHost('[::1]')).toBe('[::1]');
    expect(bridgeUrl({ host: '[::1]', port: 1 })).toBe('http://[::1]:1');
  });
});
