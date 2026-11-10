import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asPaisa } from '../money';
import { TenderError, taxClassOf, validateTenders, type TenderInput } from './tender';

const p = asPaisa;
const cash = (amount: number, extra: Partial<TenderInput> = {}): TenderInput => ({
  methodId: 'cash',
  tenderClass: 'CASH_OTHER',
  isCash: true,
  needsReference: false,
  amountPaisa: p(amount),
  ...extra,
});
const card = (amount: number, extra: Partial<TenderInput> = {}): TenderInput => ({
  methodId: 'card',
  tenderClass: 'DIGITAL',
  isCash: false,
  needsReference: true,
  amountPaisa: p(amount),
  reference: 'RRN123',
  ...extra,
});
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as TenderError).code;
  }
  return undefined;
};

describe('validateTenders', () => {
  it('exact cash: no change', () => {
    const r = validateTenders(p(116700), [cash(116700)]);
    expect(r.changeDuePaisa).toBe(0);
    expect(r.applied[0]).toMatchObject({
      amountPaisa: 116700,
      tenderedPaisa: 116700,
      changePaisa: 0,
    });
    expect(r.taxClass).toBe('CASH_OTHER');
  });

  it('cash over-tendered gives change; the applied amount is still the bill amount', () => {
    const r = validateTenders(p(116700), [cash(116700, { tenderedPaisa: p(150000) })]);
    expect(r.changeDuePaisa).toBe(33300);
    expect(r.applied[0]).toMatchObject({
      amountPaisa: 116700,
      tenderedPaisa: 150000,
      changePaisa: 33300,
    });
  });

  it('split tender: cash + card, change only from the cash part', () => {
    const r = validateTenders(p(200000), [card(120000), cash(80000, { tenderedPaisa: p(100000) })]);
    expect(r.changeDuePaisa).toBe(20000);
    expect(r.applied.map((a) => a.methodId)).toEqual(['card', 'cash']);
    expect(r.taxClass).toBe('CASH_OTHER'); // any non-digital part → the higher-rate class
  });

  it('all-digital settlement is DIGITAL; tips are kept per tender and are not part of the total', () => {
    const r = validateTenders(p(50000), [
      card(30000, { tipPaisa: p(2000) }),
      card(20000, { reference: ' W-9 ' }),
    ]);
    expect(r.taxClass).toBe('DIGITAL');
    expect(r.applied[0]!.tipPaisa).toBe(2000);
    expect(r.applied[1]!.reference).toBe('W-9');
    expect(r.applied[1]!.tipPaisa).toBe(0);
  });

  it('refuses to under- or over-pay', () => {
    expect(code(() => validateTenders(p(1000), [cash(999)]))).toBe('TENDER_SUM_MISMATCH');
    expect(code(() => validateTenders(p(1000), [cash(1001)]))).toBe('TENDER_SUM_MISMATCH');
    expect(code(() => validateTenders(p(1000), []))).toBe('TENDER_SUM_MISMATCH');
    try {
      validateTenders(p(1000), [cash(400)]);
    } catch (e) {
      expect((e as TenderError).extra).toEqual({ totalPaisa: 1000, paidPaisa: 400 });
    }
  });

  it('a zero bill needs no tenders (class defaults to CASH_OTHER)', () => {
    expect(validateTenders(p(0), [])).toEqual({
      applied: [],
      changeDuePaisa: 0,
      taxClass: 'CASH_OTHER',
    });
  });

  it('cash must cover its amount; cards and wallets are exact', () => {
    expect(code(() => validateTenders(p(1000), [cash(1000, { tenderedPaisa: p(900) })]))).toBe(
      'TENDER_TENDERED_TOO_LOW',
    );
    expect(code(() => validateTenders(p(1000), [card(1000, { tenderedPaisa: p(1500) })]))).toBe(
      'TENDER_CHANGE_NOT_ALLOWED',
    );
    expect(() => validateTenders(p(1000), [card(1000, { tenderedPaisa: p(1000) })])).not.toThrow();
  });

  it('requires a reference when the method needs one', () => {
    expect(code(() => validateTenders(p(1000), [card(1000, { reference: undefined })]))).toBe(
      'TENDER_REFERENCE_REQUIRED',
    );
    expect(code(() => validateTenders(p(1000), [card(1000, { reference: '   ' })]))).toBe(
      'TENDER_REFERENCE_REQUIRED',
    );
    expect(() => validateTenders(p(1000), [cash(1000)])).not.toThrow(); // cash needs none
    expect(validateTenders(p(1000), [cash(1000, { reference: 'x' })]).applied[0]!.reference).toBe(
      'x',
    );
  });

  it('rejects bad amounts and tips', () => {
    for (const amount of [0, -5, 1.5]) {
      const bad = { ...cash(100), amountPaisa: amount as never };
      expect(code(() => validateTenders(p(1000), [bad]))).toBe('TENDER_AMOUNT_INVALID');
    }
    for (const tip of [-1, 0.5])
      expect(code(() => validateTenders(p(1000), [cash(1000, { tipPaisa: tip as never })]))).toBe(
        'TENDER_TIP_INVALID',
      );
    expect(
      code(() => validateTenders(p(1000), [cash(1000, { tenderedPaisa: 0.5 as never })])),
    ).toBe('TENDER_TENDERED_TOO_LOW');
  });

  it('property: any split of the total across tenders validates, and change = Σ(tendered − amount)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.integer({ min: 0, max: 50_000 }), { minLength: 5, maxLength: 5 }),
        (parts, overs) => {
          const total = parts.reduce((a, b) => a + b, 0);
          const tenders = parts.map((amount, i) =>
            cash(amount, { tenderedPaisa: p(amount + (overs[i] as number)) }),
          );
          const r = validateTenders(p(total), tenders);
          expect(r.applied.reduce((a, t) => a + t.amountPaisa, 0)).toBe(total);
          expect(r.changeDuePaisa).toBe(overs.slice(0, parts.length).reduce((a, b) => a + b, 0));
        },
      ),
    );
  });
});

describe('taxClassOf', () => {
  it('is DIGITAL only when every tender is digital', () => {
    expect(taxClassOf([])).toBe('CASH_OTHER');
    expect(taxClassOf([{ tenderClass: 'DIGITAL' }])).toBe('DIGITAL');
    expect(taxClassOf([{ tenderClass: 'DIGITAL' }, { tenderClass: 'CASH_OTHER' }])).toBe(
      'CASH_OTHER',
    );
  });
});
