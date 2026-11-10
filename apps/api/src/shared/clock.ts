/** Injected so time-dependent logic (lockout, token expiry) is testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
