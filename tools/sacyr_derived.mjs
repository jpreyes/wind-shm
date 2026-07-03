// ─────────────────────────────────────────────────────────────────────────────
// sacyr_derived.mjs — Frente 5 · fase 5.3
// Agregados derivados del modelo canónico (readSacyr) para la UI «Calidad» y la
// integración con Obra: completitud por estructura/área/especialidad, KPIs de
// turnaround (días hábiles por ciclo), y protocolos pendientes.
//
// Todo se calcula DESDE el LOG de protocolos (fuente de verdad de eventos), no
// desde las hojas Matriz/KPI´s del archivo — esas usan otro modelo (matriz de
// 75 actividades planificadas × WTG, «planificado vs entregado») y se leen como
// referencia, no se recalculan. Lo que SÍ se valida contra el archivo es que
// nuestra lectura de ciclos reproduce sus fórmulas O («Ciclo Documento») y P
// («Estado Documento») — ver tools/test_sacyr_derived.mjs.
//
// JS puro, funciones sobre `data`. Node + navegador.
//   CLI:  node tools/sacyr_derived.mjs [entrada.xlsx]
// ─────────────────────────────────────────────────────────────────────────────

const ESTADOS = ['aprobado', 'conComentarios', 'enRevision', 'nulo', 'informativo', 'rechazado', 'otro'];
const emptyTally = () => { const t = { total: 0 }; for (const e of ESTADOS) t[e] = 0; return t; };

function tallyPush(t, estado) { t.total++; if (estado && t[estado] != null) t[estado]++; else t.otro++; }
function withPct(t) {
  const cerrados = t.aprobado + t.informativo;              // «entregado sin pendiente»
  t.pctAprobado = t.total ? +(t.aprobado / t.total).toFixed(4) : 0;
  t.pctCerrado = t.total ? +(cerrados / t.total).toFixed(4) : 0;
  return t;
}

function stats(arr) {
  if (!arr.length) return { n: 0, avg: null, med: null, max: null, p90: null };
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, avg: +(sum / s.length).toFixed(2), med: q(0.5), max: s[s.length - 1], p90: q(0.9) };
}

export function computeDerived(data) {
  const protocolos = data.protocolos || [];

  const porEstructura = {}, porArea = {}, porEspecialidad = {};
  const totales = emptyTally();
  const bucket = (map, key) => (map[key] ??= emptyTally());

  const diasHabiles = [];        // por ciclo, para turnaround
  let ciclosTotal = 0, ciclosConComentarios = 0;
  const pendientes = [];         // protocolos cuyo estado actual no está cerrado
  let conComentariosHist = 0;    // protocolos con ≥1 ciclo con comentarios (crónicos)

  for (const p of protocolos) {
    tallyPush(totales, p.estadoActual);
    if (p.area) tallyPush(bucket(porArea, p.area), p.estadoActual);
    if (p.especialidad) tallyPush(bucket(porEspecialidad, p.especialidad), p.estadoActual);
    if (p.estructuraId) tallyPush(bucket(porEstructura, p.estructuraId), p.estadoActual);

    let tuvoComentarios = false;
    for (const c of p.ciclos) {
      ciclosTotal++;
      if (c.estado === 'conComentarios') { ciclosConComentarios++; tuvoComentarios = true; }
      if (typeof c.diasHabilesCalc === 'number' && c.diasHabilesCalc >= 0) diasHabiles.push(c.diasHabilesCalc);
    }
    if (tuvoComentarios) conComentariosHist++;

    // «Pendiente» = aún no cerrado (ni aprobado ni informativo ni nulo).
    if (!['aprobado', 'informativo', 'nulo'].includes(p.estadoActual)) {
      pendientes.push({
        id: p.id, estructuraId: p.estructuraId, area: p.area, especialidad: p.especialidad,
        documento: p.documento, hitoPago: p.hitoPago, estadoActual: p.estadoActual,
        nCiclos: p.ciclos.length, ultimoComentario: p.ciclos.length ? p.ciclos[p.ciclos.length - 1].comentarios : null,
      });
    }
  }

  for (const m of [porEstructura, porArea, porEspecialidad]) for (const k of Object.keys(m)) withPct(m[k]);
  withPct(totales);

  const turnaround = {
    ciclos: ciclosTotal,
    diasHabiles: stats(diasHabiles),
    pctCiclosConComentarios: ciclosTotal ? +(ciclosConComentarios / ciclosTotal).toFixed(4) : 0,
    conComentariosHist,
  };

  return {
    totales, porEstructura, porArea, porEspecialidad, turnaround,
    pendientes,
    ensayosHormigon: ensayosResumen(data.ensayosHormigon || []),
  };
}

// Resumen de ensayos de hormigón por grado y por estructura (para el CMMS).
function ensayosResumen(ensayos) {
  const porGrado = {}, porEstructura = {};
  for (const e of ensayos) {
    if (e.grado) porGrado[e.grado] = (porGrado[e.grado] || 0) + 1;
    if (e.estructuraId) (porEstructura[e.estructuraId] ??= { total: 0 }).total++;
  }
  return { total: ensayos.length, porGrado, porEstructura };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = typeof process !== 'undefined' && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const fs = await import('node:fs');
  const { readSacyr } = await import('./sacyr_reader.mjs');
  const path = process.argv[2] || 'C:/Users/jprey/Downloads/Log protocolos SACYR.xlsx';
  const data = await readSacyr(new Uint8Array(fs.readFileSync(path)));
  const d = computeDerived(data);
  console.log('── Derivados SACYR ──');
  console.log('totales           :', JSON.stringify(d.totales));
  console.log('turnaround        :', JSON.stringify(d.turnaround));
  console.log('pendientes        :', d.pendientes.length);
  console.log('estructuras       :', Object.keys(d.porEstructura).length);
  console.log('por área          :', Object.entries(d.porArea).map(([k, v]) => `${k}: ${v.aprobado}/${v.total} (${(v.pctAprobado * 100).toFixed(0)}%)`).join(' · '));
  console.log('ensayos hormigón  :', JSON.stringify(d.ensayosHormigon.porGrado));
}
