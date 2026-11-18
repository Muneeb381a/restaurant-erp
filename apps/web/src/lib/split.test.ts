import { describe, expect, it } from 'vitest';
import { splitByDishes, splitEqually, type Owner } from './split';

describe('splitEqually', () => {
  it('shares always add up to the bill, with the odd paisa on the last person', () => {
    expect(splitEqually(100_000, 3)).toEqual([33_333, 33_333, 33_334]);
    expect(splitEqually(100_000, 4)).toEqual([25_000, 25_000, 25_000, 25_000]);
    expect(splitEqually(1, 3)).toEqual([0, 0, 1]);
    expect(splitEqually(500_000, 1)).toEqual([500_000]);
  });

  it('adds up exactly for every bill and group size (property check)', () => {
    for (const total of [0, 1, 7, 99, 100, 12_345, 999_999, 5_000_001]) {
      for (let n = 1; n <= 12; n++) {
        const parts = splitEqually(total, n);
        expect(parts).toHaveLength(n);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        // nobody pays more than a paisa-per-person more than anybody else
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(n - 1);
      }
    }
  });

  it('refuses a nonsense group size', () => {
    expect(() => splitEqually(1000, 0)).toThrow(RangeError);
    expect(() => splitEqually(1000, 2.5)).toThrow(RangeError);
    expect(() => splitEqually(1000, 21)).toThrow(RangeError);
  });
});

describe('splitByDishes', () => {
  it('each person pays for their own dishes, extras shared in proportion', () => {
    // A ate 600, B ate 200, total 880 (service charge on top): 600/800 and 200/800 of 880
    expect(splitByDishes(88_000, [60_000, 20_000], [0, 1], 2)).toEqual([66_000, 22_000]);
  });

  it('a dish shared by everybody is split equally on top of the personal ones', () => {
    // 300 shared, A 100, B 0: A pays 150+100, B pays 150
    expect(splitByDishes(40_000, [30_000, 10_000], ['ALL', 0], 2)).toEqual([25_000, 15_000]);
  });

  it('a person with nothing ordered pays nothing, and nobody-ordered-anything is refused', () => {
    expect(splitByDishes(10_000, [10_000], [0], 3)).toEqual([10_000, 0, 0]);
    expect(() => splitByDishes(10_000, [0], [0], 2)).toThrow(RangeError);
  });

  it('refuses nonsense', () => {
    expect(() => splitByDishes(100, [100], [0], 1)).toThrow(RangeError);
    expect(() => splitByDishes(100, [100], [5], 2)).toThrow(RangeError);
    expect(() => splitByDishes(100, [100, 1], [0], 2)).toThrow(RangeError);
    expect(() => splitByDishes(100, [-5], [0], 2)).toThrow(RangeError);
  });

  it('always adds up to the bill, whoever ate what (property check)', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 500; round++) {
      const people = 2 + rnd(7);
      const dishes = 1 + rnd(9);
      const net = Array.from({ length: dishes }, () => 1 + rnd(200_000));
      const owners: Owner[] = net.map(() => (rnd(4) === 0 ? 'ALL' : rnd(people)));
      const total = rnd(3_000_000);
      const shares = splitByDishes(total, net, owners, people);
      expect(shares).toHaveLength(people);
      expect(shares.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});
