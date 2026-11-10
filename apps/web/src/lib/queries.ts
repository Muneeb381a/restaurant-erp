import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type {
  Bill,
  BusinessDay,
  Floor,
  Me,
  Menu,
  Order,
  PaymentMethod,
  PrinterHealth,
  Shift,
} from './types';

/** Polling interval until the WebSocket events of M3b-2 replace it. */
const LIVE_MS = 3000;

export const useMe = () =>
  useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), staleTime: 60_000 });

export const useDay = () =>
  useQuery({
    queryKey: ['day'],
    queryFn: async () => (await api<{ day: BusinessDay | null }>('/business-days/current')).day,
    refetchInterval: 15_000,
  });

export const useShift = () =>
  useQuery({
    queryKey: ['shift'],
    queryFn: async () => (await api<{ shift: Shift | null }>('/shifts/current')).shift,
    refetchInterval: 15_000,
  });

export const useFloor = () =>
  useQuery({ queryKey: ['floor'], queryFn: () => api<Floor>('/floor'), refetchInterval: LIVE_MS });

export const useOrder = (id: string) =>
  useQuery({
    queryKey: ['order', id],
    queryFn: () => api<Order>(`/orders/${id}`),
    refetchInterval: LIVE_MS + 1000,
  });

/** The POS menu: one payload; the browser revalidates it with ETag/If-None-Match (304 is cheap). */
export const useMenu = (priceList: string | undefined) =>
  useQuery({
    queryKey: ['menu', priceList],
    queryFn: () => api<Menu>(`/menu?priceList=${encodeURIComponent(priceList ?? 'DINE_IN')}`),
    enabled: !!priceList,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

export function can(me: Me | undefined, permission: string): boolean {
  return !!me && me.permissions.includes(permission);
}

/** Printer status for the counter: a kitchen printer going offline must be noticed immediately. */
export const usePrinterHealth = () =>
  useQuery({
    queryKey: ['printers-health'],
    queryFn: async () => (await api<{ items: PrinterHealth[] }>('/printers/health')).items,
    refetchInterval: 5000,
  });

export const useBill = (orderId: string, enabled: boolean) =>
  useQuery({
    queryKey: ['bill', orderId],
    queryFn: () => api<Bill>(`/orders/${orderId}/bill`),
    enabled,
  });

export const usePaymentMethods = () =>
  useQuery({
    queryKey: ['payment-methods'],
    queryFn: async () =>
      (await api<{ items: PaymentMethod[] }>('/payment-methods')).items.filter((m) => m.is_active),
    staleTime: 60_000,
  });
