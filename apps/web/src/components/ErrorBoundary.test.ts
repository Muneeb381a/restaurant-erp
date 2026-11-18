import { describe, expect, it } from 'vitest';
import { isStaleChunk } from './ErrorBoundary';

describe('isStaleChunk', () => {
  it("recognises the browsers' messages for a page file that no longer exists", () => {
    expect(
      isStaleChunk(new TypeError('Failed to fetch dynamically imported module: /assets/x.js')),
    ).toBe(true);
    expect(isStaleChunk(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunk(new Error('error loading dynamically imported module'))).toBe(true);
  });
  it('does not treat an ordinary error as one (no reload loop for real bugs)', () => {
    expect(isStaleChunk(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleChunk(null)).toBe(false);
  });
});
