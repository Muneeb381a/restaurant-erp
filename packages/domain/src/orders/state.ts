export type OrderStatus = 'OPEN' | 'BILLED' | 'SETTLED' | 'CANCELLED';
export type ItemStatus = 'NEW' | 'SENT' | 'PREPARING' | 'READY' | 'SERVED' | 'VOID';

const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  OPEN: ['BILLED', 'CANCELLED'],
  BILLED: ['OPEN', 'SETTLED'], // re-open only before any payment (enforced where payments are known)
  SETTLED: [],
  CANCELLED: [],
};

/** ARCHITECTURE §5 order state machine. SETTLED and CANCELLED are final. */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Orders in these states can still be changed (items, table, guests). */
export function isOrderEditable(status: OrderStatus): boolean {
  return status === 'OPEN';
}

export interface VoidRule {
  allowed: boolean;
  /** Needs the `kot.void` permission and a reason (the kitchen has already seen it). */
  needsPermission: boolean;
  /** Food was already being prepared or served: counts as wastage in inventory (Phase 2). */
  wastage: boolean;
}

/**
 * Voiding an item: free while it is still NEW (never reached the kitchen); once sent it needs
 * permission + reason, and is wastage if it was already being prepared or served.
 */
export function voidRule(status: ItemStatus): VoidRule {
  switch (status) {
    case 'NEW':
      return { allowed: true, needsPermission: false, wastage: false };
    case 'SENT':
      return { allowed: true, needsPermission: true, wastage: false };
    case 'PREPARING':
    case 'READY':
    case 'SERVED':
      return { allowed: true, needsPermission: true, wastage: true };
    case 'VOID':
      return { allowed: false, needsPermission: false, wastage: false };
  }
}

/** Quantity, modifiers, notes and weight are editable only before the KOT is sent. */
export function isItemEditable(status: ItemStatus): boolean {
  return status === 'NEW';
}

const ITEM_PROGRESS: Record<ItemStatus, readonly ItemStatus[]> = {
  NEW: ['SENT', 'VOID'],
  SENT: ['PREPARING', 'READY', 'SERVED', 'VOID'],
  PREPARING: ['READY', 'SERVED', 'VOID'],
  READY: ['SERVED', 'VOID'],
  SERVED: ['VOID'],
  VOID: [],
};

/** Kitchen progress only moves forward (a station may skip PREPARING); VOID is always terminal. */
export function canTransitionItem(from: ItemStatus, to: ItemStatus): boolean {
  return ITEM_PROGRESS[from].includes(to);
}
