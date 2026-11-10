import { describe, expect, it } from 'vitest';
import {
  CLEAN_STATE,
  FAILURE_WINDOW_MS,
  LOCK_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  isLocked,
  onFailure,
  type LockState,
} from './lockout';

const t0 = new Date('2026-08-01T10:00:00Z');
const at = (ms: number): Date => new Date(t0.getTime() + ms);

function failTimes(n: number, step = 1000): LockState {
  let s = CLEAN_STATE;
  for (let i = 0; i < n; i++) s = onFailure(s, at(i * step));
  return s;
}

describe('lockout policy', () => {
  it('does not lock before the limit', () => {
    const s = failTimes(MAX_FAILED_ATTEMPTS - 1);
    expect(s.failedAttempts).toBe(MAX_FAILED_ATTEMPTS - 1);
    expect(s.lockedUntil).toBeNull();
  });

  it('locks on the 5th failure for 10 minutes', () => {
    const s = failTimes(MAX_FAILED_ATTEMPTS);
    const lastAt = at((MAX_FAILED_ATTEMPTS - 1) * 1000);
    expect(s.lockedUntil).toEqual(new Date(lastAt.getTime() + LOCK_DURATION_MS));
    expect(isLocked(s, lastAt)).toBe(true);
    expect(isLocked(s, new Date(lastAt.getTime() + LOCK_DURATION_MS - 1))).toBe(true);
    expect(isLocked(s, new Date(lastAt.getTime() + LOCK_DURATION_MS))).toBe(false);
  });

  it('restarts the count when the previous failure is outside the window', () => {
    const first = onFailure(CLEAN_STATE, t0);
    const later = onFailure(first, at(FAILURE_WINDOW_MS));
    expect(later.failedAttempts).toBe(1);
    const inside = onFailure(first, at(FAILURE_WINDOW_MS - 1));
    expect(inside.failedAttempts).toBe(2);
  });

  it('a clean state is never locked', () => {
    expect(isLocked(CLEAN_STATE, t0)).toBe(false);
  });
});
