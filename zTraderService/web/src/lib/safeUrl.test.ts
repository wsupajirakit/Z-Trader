import { describe, expect, it } from 'vitest';
import { safeExternalUrl, safeRedirectPath } from './safeUrl';

describe('safeExternalUrl', () => {
  it('keeps http(s) and drops script/data URLs', () => {
    expect(safeExternalUrl('https://www.kitco.com/news/a')).toBe(
      'https://www.kitco.com/news/a',
    );
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeExternalUrl('data:text/html,x')).toBeUndefined();
    expect(safeExternalUrl('not a url')).toBeUndefined();
  });
});

describe('safeRedirectPath', () => {
  it('accepts only same-app paths', () => {
    expect(safeRedirectPath('/archive?mode=swing')).toBe('/archive?mode=swing');
    expect(safeRedirectPath('//evil.example')).toBeUndefined();
    expect(safeRedirectPath('/\\evil.example')).toBeUndefined();
    expect(safeRedirectPath('https://evil.example')).toBeUndefined();
    expect(safeRedirectPath(42)).toBeUndefined();
  });
});
