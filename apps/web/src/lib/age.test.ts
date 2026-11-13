import { describe, expect, it } from 'vitest';
import { formatAge } from './age';

// a tiny stand-in for i18next: returns the key with its values, enough to see which unit was chosen
const t = ((key: string, o?: Record<string, unknown>) => `${key}:${JSON.stringify(o)}`) as never;
const strip = (s: string): string => s.replace(/[\u2066\u2069]/g, '');

describe('formatAge', () => {
  it('uses minutes under an hour, hours under a day and days after that', () => {
    expect(strip(formatAge(0, t))).toBe('age.min:{"count":0}');
    expect(strip(formatAge(59, t))).toBe('age.min:{"count":59}');
    expect(strip(formatAge(60, t))).toBe('age.h:{"h":1}');
    expect(strip(formatAge(65, t))).toBe('age.hm:{"h":1,"m":"05"}');
    expect(strip(formatAge(1439, t))).toBe('age.hm:{"h":23,"m":"59"}');
    expect(strip(formatAge(1440, t))).toBe('age.d:{"count":1}');
    expect(strip(formatAge(2801, t))).toBe('age.d:{"count":1}');
  });
  it('never goes negative', () => {
    expect(strip(formatAge(-5, t))).toBe('age.min:{"count":0}');
  });
});
