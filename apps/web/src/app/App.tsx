import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminIndex, AdminLayout } from '../features/admin/AdminLayout';
import { FiscalAdmin } from '../features/admin/FiscalAdmin';
import { MenuAdmin } from '../features/admin/MenuAdmin';
import { PrintersAdmin } from '../features/admin/PrintersAdmin';
import { QrMenuAdmin } from '../features/admin/QrMenuAdmin';
import { SetupAdmin } from '../features/admin/SetupAdmin';
import { RolesAdmin } from '../features/admin/RolesAdmin';
import { SettingsAdmin } from '../features/admin/SettingsAdmin';
import { CostsAdmin } from '../features/admin/CostsAdmin';
import { PurchasesAdmin } from '../features/admin/PurchasesAdmin';
import { RecipesAdmin } from '../features/admin/RecipesAdmin';
import { StockAdmin } from '../features/admin/StockAdmin';
import { TaxAdmin } from '../features/admin/TaxAdmin';
import { TablesAdmin } from '../features/admin/TablesAdmin';
import { UsersAdmin } from '../features/admin/UsersAdmin';
import { BillsPage } from '../features/billing/BillsPage';
import { PayPage } from '../features/billing/PayPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { FloorPage } from '../features/floor/FloorPage';
import { KhataDetail } from '../features/khata/KhataDetail';
import { KhataPage } from '../features/khata/KhataPage';
import { KitchenPage } from '../features/kitchen/KitchenPage';
import { LoginPage } from '../features/login/LoginPage';
import { OrderPage } from '../features/order/OrderPage';
import { PublicMenuPage } from '../features/publicmenu/PublicMenuPage';
import { Shell } from '../features/shell/Shell';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/m" element={<PublicMenuPage />} />
      <Route element={<Shell />}>
        <Route index element={<FloorPage />} />
        <Route path="order/:id" element={<OrderPage />} />
        <Route path="order/:id/pay" element={<PayPage />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="kitchen" element={<KitchenPage />} />
        <Route path="bills" element={<BillsPage />} />
        <Route path="khata" element={<KhataPage />} />
        <Route path="khata/:id" element={<KhataDetail />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<AdminIndex />} />
          <Route path="menu" element={<MenuAdmin />} />
          <Route path="printers" element={<PrintersAdmin />} />
          <Route path="tables" element={<TablesAdmin />} />
          <Route path="qr-menu" element={<QrMenuAdmin />} />
          <Route path="users" element={<UsersAdmin />} />
          <Route path="stock" element={<StockAdmin />} />
          <Route path="purchases" element={<PurchasesAdmin />} />
          <Route path="recipes" element={<RecipesAdmin />} />
          <Route path="costs" element={<CostsAdmin />} />
          <Route path="tax" element={<TaxAdmin />} />
          <Route path="fiscal" element={<FiscalAdmin />} />
          <Route path="roles" element={<RolesAdmin />} />
          <Route path="settings" element={<SettingsAdmin />} />
          <Route path="setup" element={<SetupAdmin />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
