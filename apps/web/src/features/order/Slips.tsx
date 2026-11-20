import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';

/**
 * The slips as the browser prints them, for a counter with no thermal printer connected (or when the printer is
 * off): the screen opens a modal with the slip and a Print button. The same words and order as the printed ones.
 */

export interface SlipCustomer {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  channel?: string | null;
  ref?: string | null;
}

export interface TokenSlipDoc {
  restaurant: string;
  restaurantUr?: string | null;
  orderNo: number;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableCode?: string | null;
  dateTime: string;
  customer?: SlipCustomer | null;
}

export interface KotTicketDoc {
  orderNo: number;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableCode?: string | null;
  waiter?: string | null;
  customer?: SlipCustomer | null;
  time: string;
  rush?: boolean;
  sections: {
    station: string;
    kotNo: number;
    lines: {
      qty: number;
      name: string;
      weightG?: number | null;
      modifiers: string[];
      note?: string | null;
      fromDeal?: string | null;
    }[];
  }[];
}

const TYPE_LABEL = { DINE_IN: 'DINE-IN', TAKEAWAY: 'TAKEAWAY', DELIVERY: 'DELIVERY' } as const;

function TypeBanner({ type }: { type: TokenSlipDoc['orderType'] }) {
  if (type === 'DINE_IN') return null;
  return <div className="slip-banner">{TYPE_LABEL[type]}</div>;
}

const SOURCE_LABEL: Record<string, string> = {
  PHONE: 'PHONE ORDER',
  WHATSAPP: 'WHATSAPP ORDER',
  FOODPANDA: 'FOODPANDA',
  WEB: 'ONLINE ORDER',
  OTHER: 'ONLINE ORDER',
};

export function SourceBanner({ c }: { c?: SlipCustomer | null }) {
  if (!c?.channel || c.channel === 'POS') return null;
  const label = SOURCE_LABEL[c.channel] ?? c.channel;
  return <div className="slip-banner">{c.ref ? `${label}  #${c.ref}` : label}</div>;
}

function Customer({ c, address = false }: { c?: SlipCustomer | null; address?: boolean }) {
  if (!c) return null;
  return (
    <>
      {c.name && <div className="slip-strong">Name: {c.name}</div>}
      {c.phone && <div dir="ltr">Phone: {c.phone}</div>}
      {address && c.address && <div>Address: {c.address}</div>}
    </>
  );
}

/** The small slip with the token in the biggest type. */
export function TokenSlip({ doc, language }: { doc: TokenSlipDoc; language: 'en' | 'ur' }) {
  const ur = language === 'ur';
  return (
    <div className="slip-print" dir={ur ? 'rtl' : 'ltr'}>
      <div className="slip-center slip-strong slip-title">
        {ur && doc.restaurantUr ? doc.restaurantUr : doc.restaurant}
      </div>
      <hr />
      <div className="slip-center slip-strong slip-label">{ur ? 'ٹوکن' : 'TOKEN'}</div>
      <div className="slip-center slip-token" dir="ltr">
        {doc.orderNo}
      </div>
      <hr />
      <div className="slip-center">
        <TypeBanner type={doc.orderType} />
        <SourceBanner c={doc.customer} />
        {doc.orderType === 'DINE_IN' && (
          <div className="slip-strong">{doc.tableCode ? `Table ${doc.tableCode}` : 'Dine-in'}</div>
        )}
        <Customer c={doc.customer} />
        <div dir="ltr">{doc.dateTime}</div>
      </div>
      <hr />
      <div className="slip-center">
        {ur ? 'یہ پرچی سنبھال کر رکھیں' : 'Keep this slip.'}
        <br />
        {ur ? 'ادائیگی کے وقت دکھائیں' : 'Show it when you pay.'}
      </div>
    </div>
  );
}

/** The kitchen ticket: the token on top, every station under its own heading. */
export function KotSlip({ doc }: { doc: KotTicketDoc }) {
  const items = doc.sections.reduce(
    (n, s) => n + s.lines.reduce((m, l) => m + (l.weightG ? 1 : l.qty), 0),
    0,
  );
  return (
    <div className="slip-print">
      {doc.rush && <div className="slip-banner">*** RUSH ***</div>}
      <div className="slip-center slip-strong slip-token-sm" dir="ltr">
        TOKEN {doc.orderNo}
      </div>
      <TypeBanner type={doc.orderType} />
      <SourceBanner c={doc.customer} />
      <div className="slip-row slip-strong">
        <span>
          {doc.orderType === 'DINE_IN'
            ? doc.tableCode
              ? `Table ${doc.tableCode}`
              : 'DINE-IN'
            : ''}
        </span>
        <span dir="ltr">{doc.time}</span>
      </div>
      {doc.waiter && <div>Waiter: {doc.waiter}</div>}
      <Customer c={doc.customer} />
      <hr />
      {doc.sections.map((s) => (
        <div key={s.kotNo} className="slip-section">
          <div className="slip-head">
            {s.station} (KOT #{s.kotNo})
          </div>
          {s.lines.map((l, i) => (
            <div key={i} className="slip-line">
              <div className="slip-strong slip-item">
                {l.weightG ? `${l.weightG} g` : `${l.qty} x`} {l.name}
              </div>
              {l.fromDeal && <div className="slip-sub">({l.fromDeal})</div>}
              {l.modifiers.map((m) => (
                <div key={m} className="slip-sub">
                  + {m}
                </div>
              ))}
              {l.note && <div className="slip-sub">“{l.note}”</div>}
            </div>
          ))}
        </div>
      ))}
      <hr />
      <div className="slip-row slip-strong">
        <span>ITEMS</span>
        <span>{items}</span>
      </div>
    </div>
  );
}

/** A modal with the slip and a Print button; only the slip is printed (index.css). */
export function SlipModal({
  title,
  hint,
  onClose,
  children,
}: {
  title: string;
  hint: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  // like the bill: the browser's print dialog opens by itself (once), the modal stays for another try
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <Modal
      title={title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
          <button className="btn-primary" onClick={() => window.print()}>
            <Icon name="printer" size={18} />
            {t('slip.print')}
          </button>
        </>
      }
    >
      <p className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">{hint}</p>
      <div className="flex justify-center rounded-lg bg-slate-100 p-3">{children}</div>
    </Modal>
  );
}
