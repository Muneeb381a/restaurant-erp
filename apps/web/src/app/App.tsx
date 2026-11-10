import { Navigate, Route, Routes } from 'react-router-dom';
import { FloorPage } from '../features/floor/FloorPage';
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
