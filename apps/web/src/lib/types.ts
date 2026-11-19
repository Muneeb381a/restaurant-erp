/** Response shapes of the API (hand-written for now; they mirror docs/demo/M1–M3). */

export interface Me {
  id: string;
  username: string;
  fullName: string;
  role: string;
  branchId: string | null;
  discountLimitBps: number;
  /** A temporary password is still in use: the server serves nothing else until it is changed. */
  mustChangePassword?: boolean;
  /** When their photo was last set (changes with every new photo), or null when they have none. */
  avatarVersion?: number | null;
  permissions: string[];
}

/** The receipt as the API sends it for the browser to print (mirrors packages/printing ReceiptDoc). */
export interface ReceiptDocView {
  restaurant: string;
  restaurantUr?: string | null;
  address?: string | null;
  phone?: string | null;
  ntn?: string | null;
  strn?: string | null;
  taxLabel?: string | null;
  fiscalNo?: string | null;
  billNo: number;
  orderNo: number;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableCode?: string | null;
  waiter?: string | null;
  cashier?: string | null;
  dateTime: string;
  lines: {
    qty: number;
    name: string;
    nameUr?: string | null;
    weightG?: number | null;
    modifiers?: string[];
    amountPaisa: number;
  }[];
  subtotalPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  taxPaisa: number;
  roundOffPaisa: number;
  totalPaisa: number;
  payments: {
    method: string;
    amountPaisa: number;
    tenderedPaisa?: number | null;
    changePaisa: number;
  }[];
  khataCustomer?: string | null;
  duplicate?: number;
}

export interface BusinessDay {
  id: string;
  businessDate: string;
  status: string;
  openedAt?: string;
}

export interface Shift {
  id: string;
  openingFloatPaisa: number;
  status: string;
  openedAt?: string;
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
    /** Kitchen tickets that are ready to be carried to the table. */
    ticketsReady: number;
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
  /** changes when the dish photo is replaced; null = no photo */
  imageVer?: number | null;
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
  description: string | null;
  descriptionUr: string | null;
  hiddenFromGuests: boolean;
  guestTags: string[];
  allergens: string[];
  hasImage: boolean;
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
  avatar_version: number | null;
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
  creditNotes?: CreditNoteSummary[];
  refundedPaisa?: number;
  taxRateBps?: number | null;
  fiscalStatus?: 'NOT_REQUIRED' | 'PENDING' | 'SUBMITTED' | 'FAILED';
  fiscalInvoiceNo?: string | null;
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
  /** When the oldest part of what is still owed was put on the account; null when nothing is owed. */
  owingSince: string | null;
  lastPaymentAt: string | null;
}

export interface KhataSummary {
  owedPaisa: number;
  accountsOwing: number;
  nearLimit: number;
  accounts: number;
}

export interface KhataEntry {
  /** What the customer owed right after this entry. */
  balanceAfterPaisa: number;
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

export interface CreditNoteSummary {
  id: string;
  cnNo: number;
  totalPaisa: number;
  reason: string;
  createdAt: string;
  method: string | null;
}

export interface Refundable {
  billId: string;
  billNo: number;
  totalPaisa: number;
  refundedPaisa: number;
  lines: {
    id: string;
    description: string;
    qty: number;
    refundedQty: number;
    remainingQty: number;
    netPaisa: number;
  }[];
  creditNotes: CreditNoteSummary[];
}

export interface RefundPreview {
  totalPaisa: number;
  completesBill: boolean;
  lines: { billLineId: string; description: string; qty: number; paisa: number }[];
}

export interface BillListItem {
  id: string;
  orderId: string;
  billNo: number;
  status: 'SETTLED' | 'PRE_BILLED';
  totalPaisa: number;
  settledAt: string | null;
  businessDate: string;
  orderNo: number | null;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | null;
  tableCode: string | null;
  /** payment methods used, by name */
  methods: string[];
  /** some of it was returned (a credit note exists) */
  refunded: boolean;
}

export interface BillQuoteTotals {
  subtotalPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  taxPaisa: number;
  roundOffPaisa: number;
  totalPaisa: number;
  taxRateBps?: number | null;
}
export interface BillQuotes {
  taxEnabled: boolean;
  CASH_OTHER: BillQuoteTotals;
  DIGITAL: BillQuoteTotals;
}

export interface TaxCategory {
  id: string;
  code: string;
  name: string;
}
export interface TaxRuleRow {
  id: string;
  authority: string;
  categoryId: string;
  categoryCode: string;
  paymentClass: 'CASH_OTHER' | 'DIGITAL' | 'ANY';
  rateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceNote: string | null;
  verifiedBy: string | null;
}
export interface TaxReadiness {
  ready: boolean;
  date: string;
  problems: {
    code: string;
    message: string;
    categoryCode?: string;
    paymentClass?: string;
    ruleId?: string;
  }[];
}

export interface Ingredient {
  id: string;
  name: string;
  nameUr: string | null;
  category: string | null;
  baseUom: 'g' | 'ml' | 'pcs';
  purchaseUom: string;
  purchaseToBase: string;
  yieldBps: number;
  isPrep: boolean;
  isActive: boolean;
  reorderLevel: string | null;
  avgCostPerBase: string;
  onHand: string;
  stockValuePaisa: number;
  needsReorder: boolean;
}
export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  notes?: string | null;
  isActive?: boolean;
  purchasedPaisa: number;
  paidPaisa: number;
  owedPaisa: number;
}
export interface PurchaseRow {
  id: string;
  invoiceRef: string | null;
  supplier: string | null;
  totalPaisa: number;
  paidPaisa: number;
  owedPaisa: number;
  createdAt: string;
}
export interface RecipeView {
  outputQty: string;
  costPaisa: number;
  lines: { ingredientId: string; name: string; baseUom: string; qty: string; costPaisa: number }[];
}
export interface MarginRow {
  variantId: string;
  item: string;
  variant: string;
  costPaisa: number;
  pricePaisa: number | null;
  foodCostBps: number | null;
}
export interface StocktakeView {
  id: string;
  status: 'OPEN' | 'POSTED';
  lines: {
    ingredientId: string;
    name: string;
    baseUom: string;
    systemQty: string;
    countedQty: string | null;
    varianceQty: string | null;
  }[];
}
export interface FoodCostReport {
  items: {
    itemId: string;
    name: string;
    qty: number;
    revenuePaisa: number;
    costPaisa: number;
    marginPaisa: number;
    foodCostBps: number;
    uncostedLines: number;
  }[];
  totals: { revenuePaisa: number; costPaisa: number; marginPaisa: number; foodCostBps: number };
  wastagePaisa: number;
  staffMealPaisa: number;
}
export interface ExpenseList {
  items: {
    id: string;
    category: string;
    amountPaisa: number;
    paidFrom: string;
    note: string | null;
    createdAt: string;
  }[];
  totalPaisa: number;
  byCategory: { category: string; totalPaisa: number }[];
}
