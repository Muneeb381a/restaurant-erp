/** Shape of GET /reports/dashboard (apps/api/src/modules/reports/dashboard.service.ts). Amounts are integer paisa. */
export interface PeriodSummary {
  bills: number;
  covers: number;
  grossSalesPaisa: number;
  discountPaisa: number;
  servicePaisa: number;
  refundsPaisa: number;
  netSalesPaisa: number;
  taxPaisa: number;
  avgBillPaisa: number;
  costOfFoodPaisa: number;
  grossProfitPaisa: number;
  expensesPaisa: number;
  netProfitPaisa: number;
  purchasesPaisa: number;
  foodCostBps: number | null;
  netMarginBps: number | null;
  uncostedLines: number;
}

export interface DayPoint {
  date: string;
  bills: number;
  salesPaisa: number;
  costOfFoodPaisa: number;
  expensesPaisa: number;
  profitPaisa: number;
}

export interface Dashboard {
  range: { from: string; to: string; days: number };
  previousRange: { from: string; to: string };
  current: PeriodSummary;
  previous: PeriodSummary;
  daily: DayPoint[];
  hourly: { hour: number; salesPaisa: number; bills: number }[];
  payments: {
    code: string;
    method: string;
    isCash: boolean;
    isCredit: boolean;
    count: number;
    amountPaisa: number;
    shareBps: number | null;
  }[];
  orderTypes: { type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'; bills: number; salesPaisa: number }[];
  topItems: {
    name: string;
    qty: number;
    revenuePaisa: number;
    costPaisa: number;
    marginPaisa: number;
  }[];
  slowItems: { name: string; qty: number; revenuePaisa: number }[];
  categories: { name: string; revenuePaisa: number }[];
  expensesByCategory: { category: string; totalPaisa: number }[];
  controls: {
    discountBills: number;
    discountPaisa: number;
    discountsApprovedByManager: number;
    voidedAfterKitchenLines: number;
    voidedAfterKitchenPaisa: number;
    complimentaryLines: number;
    complimentaryPaisa: number;
    refundCount: number;
    refundPaisa: number;
    noSaleOpens: number;
    paidOutPaisa: number;
    closedShifts: number;
    shiftsWithDifference: number;
    cashDifferencePaisa: number;
    cashShortPaisa: number;
    wastagePaisa: number;
    staffMealPaisa: number;
  };
  waiters: { name: string; bills: number; discountPaisa: number }[];
  position: {
    khataOwedToUsPaisa: number;
    khataAccountsOwing: number;
    owedToSuppliersPaisa: number;
    suppliersOwed: number;
    stockValuePaisa: number;
    lowStock: { name: string; onHand: string; uom: string }[];
    lowStockCount: number;
    openOrders: number;
    openTables: number;
  };
}
