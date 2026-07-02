// ─────────────────────────────────────────────────────────────────────────────
// test_xlsx_roundtrip.mjs — verificación autocontenida de xlsx_write ↔ xlsx_lite.
// NO necesita el archivo real: construye un libro sintético con todos los tipos de
// celda, lo escribe y lo relee, y comprueba que la información sobrevive el
// round-trip. Corre en cualquier máquina (Node ≥18).  node tools/test_xlsx_roundtrip.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { writeXlsx } from '../lib/xlsx_write.mjs';
import { readXlsx } from '../lib/xlsx_lite.mjs';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓', m); else { console.log('  ✗', m); fails++; } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

const cells = [
  { ref: 'A1', t: 'string', v: 'Item' },
  { ref: 'B1', t: 'string', v: 'Descripción con acentos: áéíóú ñ ⏎ segunda línea' },
  { ref: 'C1', t: 'string', v: 'XML peligroso < > & " \' escapar' },
  { ref: 'A2', t: 'number', v: 42 },
  { ref: 'B2', t: 'number', v: 3.14159 },
  { ref: 'C2', t: 'number', v: -7 },
  { ref: 'A3', t: 'date', v: '2022-10-17' },
  { ref: 'B3', t: 'date', v: '2024-02-29' },     // año bisiesto real
  { ref: 'C3', t: 'bool', v: true },
  { ref: 'D3', t: 'bool', v: false },
  { ref: 'A4', t: 'error', v: '#REF!' },
  { ref: 'Z10', t: 'string', v: 'celda dispersa lejana' },   // columna/fila altas
];

const bytes = writeXlsx([{ name: 'Prueba', cells }, { name: 'Vacía', cells: [] }]);
console.log('1. Escritura:');
ok(bytes instanceof Uint8Array && bytes.length > 0, `.xlsx generado (${bytes.length} bytes)`);
ok(bytes[0] === 0x50 && bytes[1] === 0x4b, 'firma zip PK correcta');

const wb = await readXlsx(bytes);
console.log('\n2. Relectura:');
eq(wb.sheetNames, ['Prueba', 'Vacía'], 'nombres de hoja');
const sh = wb.sheet('Prueba');

console.log('\n3. Round-trip por tipo:');
eq(sh.val('A1'), 'Item', 'string simple');
eq(sh.val('B1'), 'Descripción con acentos: áéíóú ñ ⏎ segunda línea', 'string unicode + ⏎');
eq(sh.val('C1'), 'XML peligroso < > & " \' escapar', 'string con caracteres XML');
eq(sh.val('A2'), 42, 'entero');
eq(sh.val('B2'), 3.14159, 'decimal');
eq(sh.val('C2'), -7, 'negativo');
const d1 = sh.cell('A3'); ok(d1.isDate && d1.value.toISOString().slice(0, 10) === '2022-10-17', 'fecha 2022-10-17');
const d2 = sh.cell('B3'); ok(d2.isDate && d2.value.toISOString().slice(0, 10) === '2024-02-29', 'fecha bisiesta 2024-02-29');
eq(sh.val('C3'), true, 'bool true');
eq(sh.val('D3'), false, 'bool false');
const e = sh.cell('A4'); ok(e.type === 'error' && e.value === '#REF!', 'error #REF!');
eq(sh.val('Z10'), 'celda dispersa lejana', 'celda dispersa Z10');
ok(sh.maxRow === 10 && sh.maxCol === 26, `dimensiones (maxRow ${sh.maxRow}, maxCol ${sh.maxCol})`);

console.log(`\n${fails === 0 ? '✅ TODO OK' : `❌ ${fails} fallo(s)`}`);
process.exit(fails === 0 ? 0 : 1);
