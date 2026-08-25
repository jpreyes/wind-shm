// ─────────────────────────────────────────────────────────────────────────────
// npz.js — decodifica en el navegador un `.npz` de numpy (np.savez_compressed):
// un ZIP (DEFLATE) que contiene arreglos `.npy`. Es el formato de las ventanas
// crudas que sube el sensor (ax/ay/az/fs) → Storage `waves/`. Sin dependencias:
// inflado con DecompressionStream('deflate-raw'), parseo de ZIP y de .npy a mano.
//
// decodeNpz(ArrayBuffer) → { [nombre]: { dtype, shape, data: TypedArray } }
// Para el sensor: { ax:{data:Float32Array}, ay:{…}, az:{…}, fs:{data:[150]} }.
// ─────────────────────────────────────────────────────────────────────────────

// Inflado de un bloque DEFLATE crudo (sin cabecera zlib, como usa ZIP).
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Parsea un buffer `.npy` (magic \x93NUMPY + cabecera dict + datos LE).
function parseNpy(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8[0] !== 0x93 || String.fromCharCode(...u8.slice(1, 6)) !== 'NUMPY') throw new Error('npy inválido');
  const major = u8[6];
  let headerLen, headerStart;
  if (major === 1) { headerLen = dv.getUint16(8, true); headerStart = 10; }
  else { headerLen = dv.getUint32(8, true); headerStart = 12; }
  const header = new TextDecoder().decode(u8.slice(headerStart, headerStart + headerLen));
  const descr = (header.match(/'descr'\s*:\s*'([^']+)'/) || [])[1] || '<f8';
  const shapeStr = (header.match(/'shape'\s*:\s*\(([^)]*)\)/) || [])[1] || '';
  const shape = shapeStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const dataStart = headerStart + headerLen;
  const bytes = u8.slice(dataStart);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const t = descr.replace(/^[<>|=]/, '');   // quita el orden de bytes (asumimos LE)
  const map = {
    f4: Float32Array, f8: Float64Array, i1: Int8Array, i2: Int16Array,
    i4: Int32Array, i8: BigInt64Array, u1: Uint8Array, u2: Uint16Array, u4: Uint32Array,
  };
  const Ctor = map[t] || Float64Array;
  let data = new Ctor(buf);
  if (Ctor === BigInt64Array) data = Array.from(data, (v) => Number(v));   // i8 → number usable
  return { dtype: descr, shape, data };
}

export async function decodeNpz(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  // 1) Localiza el End Of Central Directory (firma 0x06054b50), buscando desde el final.
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65557; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP sin EOCD (no es .npz)');
  const nEntries = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true);   // offset del central directory
  const out = {};
  for (let e = 0; e < nEntries; e++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break;   // firma de entrada de central dir
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const fnLen = dv.getUint16(cd + 28, true);
    const extraLen = dv.getUint16(cd + 30, true);
    const commentLen = dv.getUint16(cd + 32, true);
    const localOff = dv.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(u8.slice(cd + 46, cd + 46 + fnLen));
    // Cabecera local: los datos empiezan tras nombre+extra del LOCAL header (no el del CD).
    const lFnLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lFnLen + lExtraLen;
    const comp = u8.slice(dataOff, dataOff + compSize);
    const raw = method === 0 ? comp : await inflateRaw(comp);   // 0=store, 8=deflate
    try { out[name.replace(/\.npy$/, '')] = parseNpy(raw); } catch { /* ignora entradas no-npy */ }
    cd += 46 + fnLen + extraLen + commentLen;
  }
  return out;
}
