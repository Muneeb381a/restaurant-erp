import { describe, expect, it } from 'vitest';
import en from './en.json';
import { directionOf, localName } from './index';
import ur from './ur.json';

function keys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe('i18n', () => {
  it('Urdu is right-to-left, English left-to-right', () => {
    expect(directionOf('ur')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
  });

  it('every English string has an Urdu translation and vice versa', () => {
    expect(keys(ur).sort()).toEqual(keys(en).sort());
  });

  it('uses the Urdu name in Urdu when one exists, else falls back to English', () => {
    expect(localName('ur', 'Chicken Tikka', 'چکن تکہ')).toBe('چکن تکہ');
    expect(localName('ur', 'Chicken Tikka', null)).toBe('Chicken Tikka');
    expect(localName('en', 'Chicken Tikka', 'چکن تکہ')).toBe('Chicken Tikka');
  });
});
