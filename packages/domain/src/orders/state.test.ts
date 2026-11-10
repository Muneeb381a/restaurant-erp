import { describe, expect, it } from 'vitest';
import {
  canTransitionItem,
  canTransitionOrder,
  isItemEditable,
  isOrderEditable,
  voidRule,
  type ItemStatus,
  type OrderStatus,
} from './state';

const ORDER: OrderStatus[] = ['OPEN', 'BILLED', 'SETTLED', 'CANCELLED'];
const ITEM: ItemStatus[] = ['NEW', 'SENT', 'PREPARING', 'READY', 'SERVED', 'VOID'];

describe('order state machine', () => {
  it('allows exactly the transitions in ARCHITECTURE §5', () => {
    const allowed = new Set(['OPEN>BILLED', 'OPEN>CANCELLED', 'BILLED>OPEN', 'BILLED>SETTLED']);
    for (const from of ORDER) {
      for (const to of ORDER) {
        expect(canTransitionOrder(from, to), `${from}>${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('SETTLED and CANCELLED are final; only OPEN is editable', () => {
    expect(ORDER.filter((s) => isOrderEditable(s))).toEqual(['OPEN']);
    for (const to of ORDER) {
      expect(canTransitionOrder('SETTLED', to)).toBe(false);
      expect(canTransitionOrder('CANCELLED', to)).toBe(false);
    }
  });
});

describe('item rules', () => {
  it('voiding is free for NEW, needs permission once sent, is wastage once prepared/served, impossible twice', () => {
    expect(voidRule('NEW')).toEqual({ allowed: true, needsPermission: false, wastage: false });
    expect(voidRule('SENT')).toEqual({ allowed: true, needsPermission: true, wastage: false });
    for (const s of ['PREPARING', 'READY', 'SERVED'] as const) {
      expect(voidRule(s)).toEqual({ allowed: true, needsPermission: true, wastage: true });
    }
    expect(voidRule('VOID').allowed).toBe(false);
  });

  it('only NEW items are editable', () => {
    expect(ITEM.filter((s) => isItemEditable(s))).toEqual(['NEW']);
  });

  it('kitchen progress only moves forward and VOID is terminal', () => {
    expect(canTransitionItem('NEW', 'SENT')).toBe(true);
    expect(canTransitionItem('SENT', 'PREPARING')).toBe(true);
    expect(canTransitionItem('SENT', 'READY')).toBe(true); // a station may skip PREPARING
    expect(canTransitionItem('PREPARING', 'READY')).toBe(true);
    expect(canTransitionItem('READY', 'SERVED')).toBe(true);
    expect(canTransitionItem('READY', 'PREPARING')).toBe(false);
    expect(canTransitionItem('SERVED', 'SENT')).toBe(false);
    expect(canTransitionItem('NEW', 'PREPARING')).toBe(false);
    for (const s of ITEM.filter((x) => x !== 'VOID'))
      expect(canTransitionItem(s, 'VOID')).toBe(true);
    for (const s of ITEM) expect(canTransitionItem('VOID', s)).toBe(false);
  });
});
