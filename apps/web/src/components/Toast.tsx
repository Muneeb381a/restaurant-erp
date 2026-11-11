import { useEffect } from 'react';
import { create } from 'zustand';
import { Icon } from './Icon';

type Tone = 'ok' | 'warn' | 'bad';
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}
interface Store {
  items: ToastItem[];
  push: (text: string, tone?: Tone) => void;
  dismiss: (id: number) => void;
}
let seq = 0;

/** Short confirmations ("Sent to kitchen", "Saved") appear here and fade; they never block the screen. */
export const useToasts = create<Store>((set) => ({
  items: [],
  push: (text, tone = 'ok') =>
    set((s) => ({ items: [...s.items.slice(-2), { id: ++seq, text, tone }] })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));
export const toast = (text: string, tone: Tone = 'ok'): void =>
  useToasts.getState().push(text, tone);

const TONE: Record<Tone, string> = {
  ok: 'bg-slate-900 text-white',
  warn: 'bg-amber-400 text-slate-900',
  bad: 'bg-rose-600 text-white',
};

function Item({ item }: { item: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const t = setTimeout(() => dismiss(item.id), item.tone === 'bad' ? 6000 : 3200);
    return () => clearTimeout(t);
  }, [item, dismiss]);
  return (
    <div
      role={item.tone === 'bad' ? 'alert' : 'status'}
      className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-sheet ${TONE[item.tone]}`}
    >
      <Icon name={item.tone === 'ok' ? 'check' : 'alert'} size={18} />
      {item.text}
    </div>
  );
}

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 md:bottom-4 flex flex-col items-center gap-2 px-4">
      {items.map((i) => (
        <div key={i.id} className="pointer-events-auto">
          <Item item={i} />
        </div>
      ))}
    </div>
  );
}
