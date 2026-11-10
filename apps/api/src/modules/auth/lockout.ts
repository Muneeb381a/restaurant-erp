/** PIN/password lockout policy: 5 failures within a 10-minute window lock the account for 10 minutes. */
export const MAX_FAILED_ATTEMPTS = 5;
export const FAILURE_WINDOW_MS = 10 * 60_000;
export const LOCK_DURATION_MS = 10 * 60_000;

export interface LockState {
  failedAttempts: number;
  lastFailedAt: Date | null;
  lockedUntil: Date | null;
}

export function isLocked(state: LockState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** State after one more failed attempt at `now`. Failures outside the window start a new count. */
export function onFailure(state: LockState, now: Date): LockState {
  const inWindow =
    state.lastFailedAt !== null && now.getTime() - state.lastFailedAt.getTime() < FAILURE_WINDOW_MS;
  const failedAttempts = inWindow ? state.failedAttempts + 1 : 1;
  const lockedUntil =
    failedAttempts >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCK_DURATION_MS) : null;
  return { failedAttempts, lastFailedAt: now, lockedUntil };
}

export const CLEAN_STATE: LockState = { failedAttempts: 0, lastFailedAt: null, lockedUntil: null };
