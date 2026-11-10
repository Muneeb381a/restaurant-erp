/** Response shapes of the API (hand-written for now; they mirror docs/demo/M1–M3). */

export interface Me {
  id: string;
  username: string;
  fullName: string;
  role: string;
  branchId: string | null;
  discountLimitBps: number;
  permissions: string[];
}

export interface BusinessDay {
  id: string;
  businessDate: string;
  status: string;
}

export interface Shift {
  id: string;
  openingFloatPaisa: number;
  status: string;
}

export type TableStatus = 'FREE' | 'OCCUPIED' | 'BILLED';

export interface FloorTable {
  id: string;
  code: string;
  areaId: string | null;
  seats: number;
  status: TableStatus;
  order: null | {
    id: string;
    orderNo: number;
    guests: number | null;
    openedAt: string;
    held: boolean;
    waiterName: string | null;
    version: number;
    itemCount: number;
    subtotalPaisa: number;
  };
}

export interface Floor {
  areas: { id: string; name: string; sort: number }[];
  tables: FloorTable[];
}

export interface OrderLine {
  id: string;
  parentId: string | null;
  itemId: string;
  variantId: string;
  name: string;
  nameUr: string | null;
  qty: number;
  weightG: number | null;
  unitPricePaisa: number;
  modifiersTotalPaisa: number;
  lineTotalPaisa: number;
  course: number;
  status: 'NEW' | 'SENT' | 'PREPARING' | 'READY' | 'SERVED' | 'VOID';
  note: string | null;
  voidReason: string | null;
  modifiers: { id: string; name: string; priceDeltaPaisa: number }[];
}

export interface Order {
  id: string;
  orderNo: number;
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  status: 'OPEN' | 'BILLED' | 'SETTLED' | 'CANCELLED';
  held: boolean;
  tableId: string | null;
  tableCode: string | null;
  guests: number | null;
  notes: string | null;
  version: number;
  items: OrderLine[];
  subtotalPaisa: number;
}

export interface MenuModifierGroup {
  id: string;
  code: string | null;
  name: string;
  nameUr: string | null;
  minSelect: number;
  maxSelect: number;
  modifiers: { id: string; name: string; nameUr: string | null; priceDeltaPaisa: number }[];
}

export interface MenuDealSlot {
  id: string;
  name: string;
  qty: number;
  options: {
    id: string;
    variantId: string;
    itemName: string;
    itemNameUr: string | null;
    variantName: string;
    priceDeltaPaisa: number;
    isDefault: boolean;
    available: boolean;
  }[];
}

export interface MenuItem {
  id: string;
  code: string | null;
  name: string;
  nameUr: string | null;
  kind: 'STANDARD' | 'WEIGHT' | 'DEAL';
  categoryId: string | null;
  station: string | null;
  available: boolean;
  searchTerms: string | null;
  variants: {
    id: string;
    name: string;
    nameUr: string | null;
    isDefault: boolean;
    pricePaisa: number;
  }[];
  modifierGroups: MenuModifierGroup[];
  deal: { slots: MenuDealSlot[] } | null;
}

export interface Menu {
  priceList: string;
  date: string;
  categories: {
    id: string;
    parentId: string | null;
    name: string;
    nameUr: string | null;
    sort: number;
  }[];
  items: MenuItem[];
}
