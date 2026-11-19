import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptDocView } from '../../lib/types';
import { ReceiptSheet } from './ReceiptSheet';

const doc = {
  restaurant: 'Test',
  billNo: 1,
  orderNo: 1,
  orderType: 'TAKEAWAY',
  dateTime: '2026-11-18T10:00:00Z',
  lines: [],
  subtotalPaisa: 0,
  discountPaisa: 0,
  serviceChargePaisa: 0,
  taxPaisa: 0,
  roundOffPaisa: 0,
  totalPaisa: 0,
  payments: [],
} as unknown as ReceiptDocView;

const frames = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60)); // two animation frames
  });
};

describe('ReceiptSheet', () => {
  let print: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    print = vi.fn();
    window.print = print as unknown as () => void;
  });
  afterEach(() => {
    delete document.body.dataset.printing;
  });

  it('opens the print dialog once, even when the page re-renders with a new callback', async () => {
    const { rerender } = render(<ReceiptSheet doc={doc} language="en" onDone={() => undefined} />);
    // the pay page passes a new arrow function on every render
    rerender(<ReceiptSheet doc={doc} language="en" onDone={() => undefined} />);
    rerender(<ReceiptSheet doc={doc} language="en" onDone={() => undefined} />);
    await frames();
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('calls the latest onDone after printing, and a second print (a new sheet) opens its own dialog', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender, unmount } = render(
      <ReceiptSheet key={1} doc={doc} language="en" onDone={first} />,
    );
    rerender(<ReceiptSheet key={1} doc={doc} language="en" onDone={latest} />);
    await frames();
    window.dispatchEvent(new Event('afterprint'));
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    unmount();

    render(<ReceiptSheet key={2} doc={doc} language="en" onDone={() => undefined} />);
    await frames();
    expect(print).toHaveBeenCalledTimes(2);
  });
});
