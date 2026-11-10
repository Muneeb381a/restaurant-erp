import { CsvError, parse } from 'csv-parse/sync';
import { AppError } from '../../http/errors';

export const MAX_IMPORT_ROWS = 5000;

/**
 * Parses CSV text (UTF-8, optional BOM, quoted cells, embedded commas/newlines/Urdu).
 * Header names are trimmed and lower-cased. Cells are trimmed.
 */
export function parseCsv(text: string): { headers: string[]; records: Record<string, string>[] } {
  let headers: string[] = [];
  try {
    const records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
      columns: (h: string[]) => {
        headers = h.map((x) => x.trim().toLowerCase());
        return headers;
      },
    }) as Record<string, string>[];
    if (records.length > MAX_IMPORT_ROWS) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `Too many rows (${records.length}); the limit is ${MAX_IMPORT_ROWS} per import`,
      );
    }
    return { headers, records };
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof CsvError) {
      throw new AppError(400, 'VALIDATION_FAILED', `CSV is malformed: ${e.message}`, {
        line: e.lines,
      });
    }
    throw e;
  }
}

/** RFC 4180 writer: quotes cells containing comma, quote or newline. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
