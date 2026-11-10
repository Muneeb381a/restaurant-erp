import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminIndex, AdminLayout } from '../features/admin/AdminLayout';
import { MenuAdmin } from '../features/admin/MenuAdmin';
import { PrintersAdmin } from '../features/admin/PrintersAdmin';
import { TablesAdmin } from '../features/admin/TablesAdmin';
import { UsersAdmin } from '../features/admin/UsersAdmin';
import { PayPage } from '../features/billing/PayPage';
import { FloorPage } from '../features/floor/FloorPage';
import { KhataDetail, KhataPage } from '../features/khata/KhataPage';
import { LoginPage } from '../features/login/LoginPage';
import { OrderPage } from '../features/order/OrderPage';
import { Shell } from '../features/shell/Shell';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Shell />}>
        <Route index element={<FloorPage />} />
        <Route path="order/:id" element={<OrderPage />} />
        <Route path="order/:id/pay" element={<PayPage />} />
        <Route path="khata" element={<KhataPage />} />
        <Route path="khata/:id" element={<KhataDetail />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<AdminIndex />} />
          <Route path="menu" element={<MenuAdmin />} />
          <Route path="printers" element={<PrintersAdmin />} />
          <Route path="tables" element={<TablesAdmin />} />
          <Route path="users" element={<UsersAdmin />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
