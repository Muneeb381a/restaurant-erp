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

export interface SendResult {
  order: Order;
  kots: { id: string; kotNo: number; station: string; lineCount: number; printers: number }[];
  unprinted: string[];
}

export interface PrinterHealth {
  id: string;
  name: string;
  state: 'OK' | 'OFFLINE' | 'UNKNOWN' | 'INACTIVE';
  queued: number;
  dead: number;
  lastError: string | null;
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

// ───────────────────────────────── admin ─────────────────────────────────

export interface AdminVariant {
  id: string;
  name: string;
  nameUr: string | null;
  isDefault: boolean;
  isActive: boolean;
  /** price in paisa by price-list code; null = not sold on that channel */
  prices: Record<string, number | null>;
}

export interface AdminItem {
  id: string;
  code: string | null;
  name: string;
  nameUr: string | null;
  kind: 'STANDARD' | 'WEIGHT' | 'DEAL';
  categoryId: string | null;
  stationId: string | null;
  isAvailable: boolean;
  isActive: boolean;
  searchTerms: string | null;
  variants: AdminVariant[];
}

export interface AdminMenu {
  date: string;
  priceLists: { id: string; code: string; name: string }[];
  stations: { id: string; code: string; name: string }[];
  categories: {
    id: string;
    parentId: string | null;
    name: string;
    nameUr: string | null;
    isActive: boolean;
  }[];
  items: AdminItem[];
}

export interface ImportResult {
  dryRun: boolean;
  ok: boolean;
  effectiveFrom: string;
  summary: {
    categoriesCreated: number;
    itemsCreated: number;
    itemsUpdated: number;
    itemsUnchanged: number;
    variantsCreated: number;
    variantsUpdated: number;
    pricesSet: number;
    pricesUnchanged: number;
  };
  warnings: string[];
  errors: { line: number; message: string }[];
}

export interface PrinterRow {
  id: string;
  name: string;
  kind: 'RECEIPT' | 'KOT';
  conn_type: 'NETWORK' | 'USB' | 'SERIAL';
  host: string | null;
  port: number | null;
  paper_mm: 58 | 80;
  is_active: boolean;
}

export interface PrintJobRow {
  id: string;
  printer_id: string;
  kind: string;
  title: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface TableRow {
  id: string;
  code: string;
  area_id: string | null;
  seats: number;
  is_active: boolean;
}

export interface UserRow {
  id: string;
  username: string;
  full_name: string;
  role_id: string;
  role_code: string;
  discount_limit_bps: number;
  is_active: boolean;
  locked_until: string | null;
  has_pin: boolean;
  has_password: boolean;
}

export interface RoleRow {
  id: string;
  code: string;
  name: string;
}

export interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  tender_class: 'CASH_OTHER' | 'DIGITAL';
  opens_drawer: boolean;
  needs_reference: boolean;
  is_active: boolean;
}

export interface BillPayment {
  id: string;
  methodId: string;
  method: string;
  methodCode: string;
  amountPaisa: number;
  tenderedPaisa: number | null;
  changePaisa: number;
  tipPaisa: number;
  reference: string | null;
}

export interface Bill {
  id: string;
  billNo: number;
  orderId: string;
  orderNo: number;
  status: 'PRE_BILLED' | 'SETTLED' | 'VOID' | 'DRAFT';
  subtotalPaisa: number;
  discountPaisa: number;
  discountReason: string | null;
  serviceChargePaisa: number;
  taxPaisa: number;
  roundOffPaisa: number;
  totalPaisa: number;
  printCount: number;
  lines: { id: string; description: string; qty: number; netPaisa: number }[];
  payments: BillPayment[];
  changeDuePaisa: number;
  khata?: {
    accountId: string;
    customer: string;
    chargedPaisa: number;
    balancePaisa: number;
  } | null;
}

export interface SettleResult {
  bill: Bill;
  changeDuePaisa: number;
  receipts: number;
  replayed: boolean;
}

export interface KhataAccount {
  id: string;
  name: string;
  phone: string | null;
  creditLimitPaisa: number;
  balancePaisa: number;
  availableCreditPaisa: number;
  isActive: boolean;
}

export interface KhataEntry {
  id: string;
  kind: 'CHARGE' | 'PAYMENT' | 'ADJUST_UP' | 'ADJUST_DOWN' | 'REFUND';
  amountPaisa: number;
  deltaPaisa: number;
  note: string | null;
  reference: string | null;
  createdAt: string;
  method: string | null;
  billNo: number | null;
  by: string | null;
}
