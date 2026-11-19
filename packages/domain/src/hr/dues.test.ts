import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dueBalance, installmentsLeft, recoveryAmount, type DueEntry } from './dues';
import { PayrollError } from './payroll';

describe('dueBalance', () => {
  it('given and fined add, recovered and written off subtract', () => {
    expect(
      dueBalance([
        { kind: 'DISBURSE', amountPaisa: 1_000_000 },
        { kind: 'RECOVERY', amountPaisa: 250_000 },
        { kind: 'FINE', amountPaisa: 50_000 },
        { kind: 'WRITE_OFF', amountPaisa: 100_000 },
      ]),
    ).toBe(700_000);
    expect(dueBalance([])).toBe(0);
  });
  it('refuses fractions and negatives', () => {
    expect(() => dueBalance([{ kind: 'DISBURSE', amountPaisa: 1.5 }])).toThrow(PayrollError);
    expect(() => dueBalance([{ kind: 'RECOVERY', amountPaisa: -1 }])).toThrow(PayrollError);
  });
  it('paying back every instalment brings it to exactly zero, in ceil(principal / instalment) steps (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 1, max: 120 }),
        (principal, count) => {
          const inst = Math.ceil(principal / count);
          const entries: DueEntry[] = [{ kind: 'DISBURSE', amountPaisa: principal }];
          let steps = 0;
          while (dueBalance(entries) > 0) {
            const take = recoveryAmount({
              balancePaisa: dueBalance(entries),
              installmentPaisa: inst,
              netBeforePaisa: Number.MAX_SAFE_INTEGER,
            });
            expect(take).toBeGreaterThan(0);
            entries.push({ kind: 'RECOVERY', amountPaisa: take });
            steps++;
          }
          expect(dueBalance(entries)).toBe(0);
          expect(steps).toBe(Math.ceil(principal / inst));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('recoveryAmount', () => {
  const base = { balancePaisa: 900_000, installmentPaisa: 300_000, netBeforePaisa: 3_000_000 };
  it('takes the instalment', () => expect(recoveryAmount(base)).toBe(300_000));
  it('never more than is owed (the last, smaller instalment)', () => {
    expect(recoveryAmount({ ...base, balancePaisa: 120_000 })).toBe(120_000);
  });
  it('never more than the pay left after the other lines; never negative', () => {
    expect(recoveryAmount({ ...base, netBeforePaisa: 100_000 })).toBe(100_000);
    expect(recoveryAmount({ ...base, netBeforePaisa: 0 })).toBe(0);
    expect(recoveryAmount({ ...base, netBeforePaisa: -5_000 })).toBe(0);
  });
  it('nothing when paused, closed, settled or recovered by hand (instalment 0)', () => {
    expect(recoveryAmount({ ...base, paused: true })).toBe(0);
    expect(recoveryAmount({ ...base, closed: true })).toBe(0);
    expect(recoveryAmount({ ...base, balancePaisa: 0 })).toBe(0);
    expect(recoveryAmount({ ...base, installmentPaisa: 0 })).toBe(0);
  });
});

describe('installmentsLeft', () => {
  it('rounds up; null when there is no instalment', () => {
    expect(installmentsLeft(1_000_000, 300_000)).toBe(4);
    expect(installmentsLeft(900_000, 300_000)).toBe(3);
    expect(installmentsLeft(0, 300_000)).toBe(0);
    expect(installmentsLeft(500, 0)).toBeNull();
  });
});
