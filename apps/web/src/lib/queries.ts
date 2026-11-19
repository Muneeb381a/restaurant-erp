import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { pollMs, useLive } from './live';
import { mode } from './tenant';
import type {
  Bill,
  BusinessDay,
  Floor,
  KhataAccount,
  KhataEntry,
  KhataSummary,
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
  useQuery({
    queryKey: ['floor'],
    queryFn: () => api<Floor>('/floor'),
    refetchInterval: () => pollMs(LIVE_MS),
  });

export interface OpenOrder {
  id: string;
  orderNo: number;
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  status: 'OPEN' | 'BILLED';
  tableCode: string | null;
  held: boolean;
  itemCount: number;
  subtotalPaisa: number;
  openedAt: string;
}

/** Open takeaway and delivery orders (dine-in orders show on their table instead). */
export const useCounterOrders = () =>
  useQuery({
    queryKey: ['floor', 'counter-orders'],
    queryFn: async () => {
      const r = await api<{ items: OpenOrder[] }>('/orders?status=active');
      return r.items.filter((o) => o.type !== 'DINE_IN');
    },
    refetchInterval: () => pollMs(LIVE_MS),
  });

export const useOrder = (id: string) =>
  useQuery({
    queryKey: ['order', id],
    queryFn: () => api<Order>(`/orders/${id}`),
    refetchInterval: () => pollMs(LIVE_MS + 1000),
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
    enabled: mode.kind !== 'tenant', // the cloud has no LAN printers to watch
    // on the restaurant's own network a printer going offline must be noticed within seconds; in the
    // cloud (polling mode) there are no LAN printers to watch, so it asks only now and then
    refetchInterval: () => (useLive.getState().polling ? 30_000 : 5000),
  });

export const useBill = (orderId: string, enabled: boolean) =>
  useQuery({
    queryKey: ['bill', orderId],
    queryFn: () => api<Bill>(`/orders/${orderId}/bill`),
    enabled,
    // the fiscal number arrives from a background worker, not from a user action
    refetchInterval: (q) => (q.state.data?.fiscalStatus === 'PENDING' ? 4000 : false),
  });

export const usePaymentMethods = () =>
  useQuery({
    queryKey: ['payment-methods'],
    queryFn: async () =>
      (await api<{ items: PaymentMethod[] }>('/payment-methods')).items.filter((m) => m.is_active),
    staleTime: 60_000,
  });

export const useKhataAccounts = (
  search: string,
  owingOnly = false,
  sort: 'name' | 'owed' = 'name',
) =>
  useQuery({
    queryKey: ['khata', 'list', search, owingOnly, sort],
    queryFn: async () =>
      (
        await api<{ items: KhataAccount[] }>(
          `/khata/accounts?search=${encodeURIComponent(search)}&sort=${sort}${owingOnly ? '&owing=true' : ''}`,
        )
      ).items,
    placeholderData: (prev) => prev,
  });

export const useKhataSummary = () =>
  useQuery({ queryKey: ['khata', 'summary'], queryFn: () => api<KhataSummary>('/khata/summary') });

export const useKhataAccount = (id: string, entries = 100) =>
  useQuery({
    queryKey: ['khata', 'one', id, entries],
    queryFn: () =>
      api<KhataAccount & { notes: string | null; entries: KhataEntry[] }>(
        `/khata/accounts/${id}?limit=${entries}`,
      ),
    placeholderData: (prev) => prev,
  });

export type Settings = Record<string, unknown>;

/** The restaurant's settings (the same call the Settings screen uses, so the two never disagree). */
export const useSettings = () =>
  useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/settings'),
    staleTime: 30_000,
  });

/** false when the owner switched the Kitchen screen off (a counter-only restaurant: the printed ticket is the kitchen). */
export const useKitchenScreen = (): boolean =>
  useSettings().data?.['kitchen.screen_enabled'] !== false;
