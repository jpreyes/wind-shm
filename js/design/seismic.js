// ──────────────────────────────────────────────────────────────────────────────
// seismic.js — Detallado SÍSMICO por capacidad–demanda (#68).
//
// «Columna fuerte – viga débil» (ACI 318-19 §18.7.3.2 / AISC 341): en cada nudo,
// la suma de las capacidades flexionales de las COLUMNAS debe superar a la de las
// VIGAS por un factor γ (6/5=1.2 en ACI; 1.0 con sobrerresistencia en AISC):
//
//     Σ Mnc  ≥  γ · Σ Mnb
//
// El módulo es agnóstico del análisis: recibe las capacidades nominales Mn de cada
// barra (vía un callback `MnOf`) y la topología del modelo, clasifica cada barra
// que llega al nudo como columna/viga por su verticalidad, y devuelve el cociente
// demanda/capacidad por nudo.
// ──────────────────────────────────────────────────────────────────────────────

// Chequeo puntual columna fuerte-viga débil. Devuelve demanda/capacidad/ratio.
export function strongColumnWeakBeam({ sumMnc, sumMnb, gamma = 1.2 }) {
  const dem = gamma * sumMnb, cap = sumMnc;
  return {
    demanda: +dem.toFixed(4), capacidad: +cap.toFixed(4),
    ratio: cap > 1e-12 ? +(dem / cap).toFixed(4) : Infinity,
    cumple: cap >= dem - 1e-9,
    formula: `ΣMnc ≥ ${gamma}·ΣMnb (columna fuerte–viga débil)`,
  };
}

// Clasifica una barra por su verticalidad: 'column' | 'beam' | 'brace'.
export function classifyMember(n1, n2) {
  const dx = n2.x - n1.x, dy = n2.y - n1.y, dz = n2.z - n1.z;
  const L = Math.hypot(dx, dy, dz) || 1;
  const vert = Math.abs(dz) / L;
  return vert > 0.8 ? 'column' : vert < 0.2 ? 'beam' : 'brace';
}

/**
 * Recorre los nudos del modelo y aplica el chequeo columna fuerte-viga débil.
 * @param {Model} model
 * @param {(elemId)=>number} MnOf  capacidad flexional NOMINAL de la barra (kN·m).
 * @param {object} opts  { gamma = 1.2 }
 * @returns [{ node, sumMnc, sumMnb, ratio, cumple, nCol, nBeam }]  (sólo nudos
 *          con al menos una columna y una viga; orden por ratio descendente).
 */
export function jointSCWB(model, MnOf, opts = {}) {
  const gamma = opts.gamma ?? 1.2;
  // Barras conectadas a cada nodo.
  const byNode = new Map();
  for (const el of model.elements.values()) {
    for (const nid of [el.n1, el.n2]) { if (!byNode.has(nid)) byNode.set(nid, []); byNode.get(nid).push(el); }
  }
  const out = [];
  for (const [nid, els] of byNode) {
    let sumMnc = 0, sumMnb = 0, nCol = 0, nBeam = 0;
    for (const el of els) {
      const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
      if (!n1 || !n2) continue;
      const kind = classifyMember(n1, n2);
      const Mn = Math.abs(MnOf(el.id) || 0);
      if (kind === 'column') { sumMnc += Mn; nCol++; }
      else if (kind === 'beam') { sumMnb += Mn; nBeam++; }
    }
    if (nCol && nBeam) {
      const r = strongColumnWeakBeam({ sumMnc, sumMnb, gamma });
      out.push({ node: nid, sumMnc: +sumMnc.toFixed(2), sumMnb: +sumMnb.toFixed(2), ratio: r.ratio, cumple: r.cumple, nCol, nBeam });
    }
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}
