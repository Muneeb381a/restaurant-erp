import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/db/types.ts');
let src = await readFile(file, 'utf8');

// 1) kysely-codegen types BIGINT as string (node-postgres default). We register a type parser
//    (src/shared/db.ts, ADR 0001) that yields a safe-integer number, so align the generated type.
const int8From =
  'export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;';
const int8To =
  'export type Int8 = ColumnType<number, number | string, number | string>; // paisa, see ADR 0001';
if (!src.includes(int8From)) {
  throw new Error('Int8 definition not found — kysely-codegen output changed?');
}
src = src.replace(int8From, int8To);

// 2) Business dates must stay YYYY-MM-DD strings (a JS Date at local midnight shifts days across
//    timezones). src/shared/db.ts registers a string parser for the date type; align the types.
const dateProps =
  /\b(business_date|effective_from|effective_to): (Generated<Timestamp>|Timestamp(?: \| null)?)/g;
src = src.replace(
  dateProps,
  (_m, prop: string, type: string) => `${prop}: ${type.replace('Timestamp', 'DateString')}`,
);
src = src.replace(
  'export type Int8 =',
  '/** Postgres date as YYYY-MM-DD (see ADR 0001 / shared/db.ts). */\n' +
    'export type DateString = ColumnType<string, string, string>;\n\n' +
    'export type Int8 =',
);

await writeFile(file, src);
console.log('patched Int8 -> number, business/effective dates -> DateString');
