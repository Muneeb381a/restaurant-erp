import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatRs } from '../../lib/money';
import type { ReceiptDocView } from '../../lib/types';

/** Money for a printed receipt: the amount, no currency word on every line. */
const amt = (paisa: number): string => formatRs(paisa).replace(/^Rs\s*/, '');

const TYPE = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' } as const;

function Row({ left, right, strong }: { left: string; right: string; strong?: boolean }) {
  return (
    <div className={`rc-row ${strong ? 'rc-strong' : ''}`}>
      <span>{left}</span>
      <span className="rc-amt">{right}</span>
    </div>
  );
}

/**
 * The bill as a printed slip, sized for an 80 mm roll. It is rendered into <body>, outside the app,
 * and shown only while printing (index.css), so the browser's print dialog prints just the receipt.
 * Urdu receipts use the browser's own text rendering, which handles the script natively.
 */
export function ReceiptSheet({
  doc,
  language,
  logoUrl,
  onDone,
}: {
  doc: ReceiptDocView;
  language: 'en' | 'ur';
  /** The restaurant's logo, printed above its name. */
  logoUrl?: string | null;
  onDone: () => void;
}) {
  const ur = language === 'ur';
  // the callback may be a new function on every render of the page: the print must open ONCE per sheet,
  // so the effect below does not depend on it (it used to re-run, cancel and re-open the dialog)
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    document.body.dataset.printing = 'receipt';
    const finish = (): void => {
      delete document.body.dataset.printing;
      done.current();
    };
    window.addEventListener('afterprint', finish, { once: true });
    // let the sheet paint, then open the print dialog
    const id = requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('afterprint', finish);
      delete document.body.dataset.printing;
    };
  }, []);

  return createPortal(
    <div className="receipt-print" dir={ur ? 'rtl' : 'ltr'} data-testid="receipt-sheet">
      {doc.provisional ? (
        <div className="rc-banner">{ur ? 'بل — ادائیگی باقی' : 'BILL - NOT PAID'}</div>
      ) : null}
      {doc.duplicate ? (
        <div className="rc-banner">
          {ur ? `نقل نمبر ${doc.duplicate}` : `DUPLICATE #${doc.duplicate}`}
        </div>
      ) : null}
      {logoUrl && <img src={logoUrl} alt="" className="rc-logo" />}
      <div className="rc-center rc-title">
        {ur && doc.restaurantUr ? doc.restaurantUr : doc.restaurant}
      </div>
      {doc.address && <div className="rc-center">{doc.address}</div>}
      {doc.phone && <div className="rc-center">{doc.phone}</div>}
      {(doc.ntn || doc.strn) && (
        <div className="rc-center">
          {doc.ntn ? `NTN ${doc.ntn}` : ''} {doc.strn ? `STRN ${doc.strn}` : ''}
        </div>
      )}
      <hr />
      <div className="rc-token">
        {ur ? 'ٹوکن' : 'TOKEN'} {doc.orderNo}
      </div>
      {doc.orderType !== 'DINE_IN' && (
        <div className="rc-banner">{doc.orderType === 'DELIVERY' ? 'DELIVERY' : 'TAKEAWAY'}</div>
      )}
      <Row left={`Bill #${doc.billNo}`} right={doc.dateTime} />
      <Row left={`${TYPE[doc.orderType]}${doc.tableCode ? ` · ${doc.tableCode}` : ''}`} right="" />
      {doc.customer?.name && <div className="rc-small">Name: {doc.customer.name}</div>}
      {doc.customer?.phone && <div className="rc-small">Phone: {doc.customer.phone}</div>}
      {doc.orderType === 'DELIVERY' && doc.customer?.address && (
        <div className="rc-small">Address: {doc.customer.address}</div>
      )}
      {(doc.cashier || doc.waiter) && (
        <div className="rc-small">
          {doc.cashier ? `Cashier: ${doc.cashier}` : ''}
          {doc.cashier && doc.waiter ? ' · ' : ''}
          {doc.waiter ? `Waiter: ${doc.waiter}` : ''}
        </div>
      )}
      <hr />
      {doc.lines.map((l, i) => (
        <div key={i} className="rc-line">
          <Row
            left={`${l.weightG ? `${l.weightG} g` : `${l.qty} ×`} ${ur && l.nameUr ? l.nameUr : l.name}`}
            right={amt(l.amountPaisa)}
          />
          {(l.modifiers ?? []).map((m) => (
            <div key={m} className="rc-small rc-mod">
              + {m}
            </div>
          ))}
        </div>
      ))}
      <hr />
      <Row left="Subtotal" right={amt(doc.subtotalPaisa)} />
      {doc.discountPaisa > 0 && <Row left="Discount" right={`-${amt(doc.discountPaisa)}`} />}
      {doc.serviceChargePaisa > 0 && (
        <Row left="Service charge" right={amt(doc.serviceChargePaisa)} />
      )}
      {doc.taxPaisa > 0 && <Row left={doc.taxLabel ?? 'Tax'} right={amt(doc.taxPaisa)} />}
      {doc.roundOffPaisa !== 0 && <Row left="Round off" right={amt(doc.roundOffPaisa)} />}
      <Row strong left="TOTAL" right={`Rs ${amt(doc.totalPaisa)}`} />
      <hr />
      {doc.payments.map((p, i) => (
        <div key={i}>
          <Row left={p.method} right={amt(p.amountPaisa)} />
          {p.tenderedPaisa != null && (
            <>
              <Row left="Cash given" right={amt(p.tenderedPaisa)} />
              {p.changePaisa > 0 && <Row left="Change" right={amt(p.changePaisa)} />}
            </>
          )}
        </div>
      ))}
      {doc.khataCustomer && <div className="rc-small">On credit: {doc.khataCustomer}</div>}
      {doc.fiscalNo && <div className="rc-center rc-small">Fiscal invoice {doc.fiscalNo}</div>}
      <hr />
      <div className="rc-center">
        {doc.provisional
          ? ur
            ? 'براہ کرم کاؤنٹر پر ادائیگی کریں'
            : 'Please pay at the counter'
          : ur
            ? 'شکریہ، دوبارہ تشریف لائیے'
            : 'Thank you, please visit again'}
      </div>
    </div>,
    document.body,
  );
}
