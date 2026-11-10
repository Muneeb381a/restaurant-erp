import { COLUMNS, EscPos, twoColumns, type PaperMm } from './escpos';

/** A short ticket to check wiring, paper width and the cutter ("Print test page" in settings). */
export function renderTestPage(
  printerName: string,
  time: string,
  paperMm: PaperMm = 80,
): Uint8Array {
  const cols = COLUMNS[paperMm];
  return new EscPos()
    .init()
    .align('center')
    .bold(true)
    .size(2, 2)
    .line('TEST PAGE')
    .size(1, 1)
    .bold(false)
    .align('left')
    .rule(cols)
    .line(twoColumns('Printer', printerName, cols))
    .line(twoColumns('Paper', `${paperMm} mm (${cols} columns)`, cols))
    .line(twoColumns('Time', time, cols))
    .rule(cols)
    .line('0123456789'.repeat(Math.ceil(cols / 10)).slice(0, cols))
    .line('If readable: printer OK')
    .feed(3)
    .cut()
    .build();
}
