import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// kysely-codegen types BIGINT as string (node-postgres default). We register a type parser
// (src/shared/db.ts, ADR 0001) that yields a safe-integer number, so align the generated type.
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/db/types.ts');
const src = await readFile(file, 'utf8');
const from =
  'export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;';
const to =
  'export type Int8 = ColumnType<number, number | string, number | string>; // paisa, see ADR 0001';
if (!src.includes(from))
  throw new Error('Int8 definition not found — kysely-codegen output changed?');
await writeFile(file, src.replace(from, to));
console.log('patched Int8 -> number');
