import { lazy, Suspense, type ComponentType, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { isStaleChunk, reloadOnce } from '../components/ErrorBoundary';
import { FloorPage } from '../features/floor/FloorPage';
import { LoginPage } from '../features/login/LoginPage';
import { Shell } from '../features/shell/Shell';

/**
 * Only the sign-in, the shell and the floor (what a cashier sees first) ship in the first download.
 * Every other screen is fetched the first time it is opened, which keeps the start fast on a phone.
 */
function page<T extends object>(load: () => Promise<T>, name: keyof T): ReactElement {
  const Page = lazy(async () => {
    try {
      return { default: (await load())[name] as unknown as ComponentType };
    } catch (e) {
      // the app was updated while this tab was open: its page file is gone, a reload brings the new one
      if (isStaleChunk(e)) reloadOnce();
      throw e;
    }
  });
  return (
    <Suspense fallback={<PageLoading />}>
      <Page />
    </Suspense>
  );
}

function PageLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex h-40 items-center justify-center" role="status" aria-live="polite">
      <span
        aria-hidden="true"
        className="size-6 animate-spin rounded-full border-2 border-slate-300 border-t-emerald-600 motion-reduce:animate-none"
      />
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  );
}

// created once at module load: a new lazy() on every render would reload the page each time
const OrderPage = page(() => import('../features/order/OrderPage'), 'OrderPage');
const PayPage = page(() => import('../features/billing/PayPage'), 'PayPage');
const BillsPage = page(() => import('../features/billing/BillsPage'), 'BillsPage');
const DashboardPage = page(() => import('../features/dashboard/DashboardPage'), 'DashboardPage');
const KitchenPage = page(() => import('../features/kitchen/KitchenPage'), 'KitchenPage');
const KhataPage = page(() => import('../features/khata/KhataPage'), 'KhataPage');
const KhataDetail = page(() => import('../features/khata/KhataDetail'), 'KhataDetail');
const PublicMenuPage = page(
  () => import('../features/publicmenu/PublicMenuPage'),
  'PublicMenuPage',
);
const AdminLayout = page(() => import('../features/admin/AdminLayout'), 'AdminLayout');
const AdminIndex = page(() => import('../features/admin/AdminLayout'), 'AdminIndex');
const MenuAdmin = page(() => import('../features/admin/MenuAdmin'), 'MenuAdmin');
const PrintersAdmin = page(() => import('../features/admin/PrintersAdmin'), 'PrintersAdmin');
const TablesAdmin = page(() => import('../features/admin/TablesAdmin'), 'TablesAdmin');
const QrMenuAdmin = page(() => import('../features/admin/QrMenuAdmin'), 'QrMenuAdmin');
const UsersAdmin = page(() => import('../features/admin/UsersAdmin'), 'UsersAdmin');
const StockAdmin = page(() => import('../features/admin/StockAdmin'), 'StockAdmin');
const PurchasesAdmin = page(() => import('../features/admin/PurchasesAdmin'), 'PurchasesAdmin');
const RecipesAdmin = page(() => import('../features/admin/RecipesAdmin'), 'RecipesAdmin');
const CostsAdmin = page(() => import('../features/admin/CostsAdmin'), 'CostsAdmin');
const PaymentsAdmin = page(() => import('../features/admin/PaymentsAdmin'), 'PaymentsAdmin');
const TaxAdmin = page(() => import('../features/admin/TaxAdmin'), 'TaxAdmin');
const FiscalAdmin = page(() => import('../features/admin/FiscalAdmin'), 'FiscalAdmin');
const RolesAdmin = page(() => import('../features/admin/RolesAdmin'), 'RolesAdmin');
const SettingsAdmin = page(() => import('../features/admin/SettingsAdmin'), 'SettingsAdmin');
const EmployeesAdmin = page(() => import('../features/admin/StaffAdmin'), 'EmployeesAdmin');
const AttendanceAdmin = page(() => import('../features/admin/StaffAdmin'), 'AttendanceAdmin');
const ClockScreen = page(() => import('../features/admin/StaffAdmin'), 'ClockScreen');
const LeaveAdmin = page(() => import('../features/admin/LeaveAdmin'), 'LeaveAdmin');
const SetupAdmin = page(() => import('../features/admin/SetupAdmin'), 'SetupAdmin');

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/m" element={PublicMenuPage} />
      <Route element={<Shell />}>
        <Route index element={<FloorPage />} />
        <Route path="order/:id" element={OrderPage} />
        <Route path="order/:id/pay" element={PayPage} />
        <Route path="dashboard" element={DashboardPage} />
        <Route path="kitchen" element={KitchenPage} />
        <Route path="bills" element={BillsPage} />
        <Route path="khata" element={KhataPage} />
        <Route path="khata/:id" element={KhataDetail} />
        <Route path="admin" element={AdminLayout}>
          <Route index element={AdminIndex} />
          <Route path="menu" element={MenuAdmin} />
          <Route path="printers" element={PrintersAdmin} />
          <Route path="tables" element={TablesAdmin} />
          <Route path="qr-menu" element={QrMenuAdmin} />
          <Route path="users" element={UsersAdmin} />
          <Route path="stock" element={StockAdmin} />
          <Route path="purchases" element={PurchasesAdmin} />
          <Route path="recipes" element={RecipesAdmin} />
          <Route path="costs" element={CostsAdmin} />
          <Route path="payments" element={PaymentsAdmin} />
          <Route path="tax" element={TaxAdmin} />
          <Route path="fiscal" element={FiscalAdmin} />
          <Route path="roles" element={RolesAdmin} />
          <Route path="settings" element={SettingsAdmin} />
          <Route path="employees" element={EmployeesAdmin} />
          <Route path="attendance" element={AttendanceAdmin} />
          <Route path="leave" element={LeaveAdmin} />
          <Route path="clock" element={ClockScreen} />
          <Route path="setup" element={SetupAdmin} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
