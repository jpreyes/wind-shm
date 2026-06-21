// ──────────────────────────────────────────────────────────────────────────────
// Discretización de elementos — dividir y unir
//
// splitElement(model, elemId, nParts)   → divide un elemento en N sub-elementos
// splitByLength(model, elemId, len)     → divide cada ≈len metros
// discretizeAll(model, opts)            → divide todos los elementos
// joinElements(model, elemIds)          → une una cadena colineal en 1 elemento
//
// Reglas al dividir:
//  - Las liberaciones del extremo 1 quedan en el primer sub-elemento;
//    las del extremo 2 en el último (los nodos intermedios son continuos).
//  - Las cargas distribuidas (UDL) se replican en cada sub-elemento,
//    en TODOS los casos de carga.
// ──────────────────────────────────────────────────────────────────────────────

const EPS = 1e-9;

/** Divide un elemento en nParts sub-elementos. Devuelve los IDs nuevos (o null). */
export function splitElement(model, elemId, nParts) {
  nParts = Math.max(2, Math.floor(nParts));
  const elem = model.elements.get(elemId);
  if (!elem) return null;
  const n1 = model.nodes.get(elem.n1);
  const n2 = model.nodes.get(elem.n2);
  if (!n1 || !n2) return null;

  // Nodos intermedios
  const chain = [elem.n1];
  for (let k = 1; k < nParts; k++) {
    const t = k / nParts;
    const nd = model.addNode(
      n1.x + t * (n2.x - n1.x),
      n1.y + t * (n2.y - n1.y),
      n1.z + t * (n2.z - n1.z)
    );
    chain.push(nd.id);
  }
  chain.push(elem.n2);

  // Sub-elementos
  const newIds = [];
  for (let k = 0; k < nParts; k++) {
    const e = model.addElement(chain[k], chain[k + 1], elem.matId, elem.secId);
    if (!e) continue;
    newIds.push(e.id);
  }
  // Liberaciones: extremo 1 → primer sub-elemento; extremo 2 → último
  if (elem.releases && newIds.length) {
    const first = model.elements.get(newIds[0]);
    const last  = model.elements.get(newIds[newIds.length - 1]);
    for (let i = 0; i < 6; i++) {
      first.releases[i]    = elem.releases[i]     || 0;
      last.releases[6 + i] = elem.releases[6 + i] || 0;
    }
  }

  // Cargas distribuidas: repartir en cada sub-elemento (todos los casos).
  // Trapecial → se interpola la intensidad en los extremos de cada tramo;
  // uniforme → se replica tal cual (w2 ausente).
  const nSub = newIds.length;
  for (const lc of model.loadCases.values()) {
    const distLoads = lc.loads.filter(l => l.type === 'dist' && l.elemId === elemId);
    if (!distLoads.length) continue;
    lc.loads = lc.loads.filter(l => !(l.type === 'dist' && l.elemId === elemId));
    for (const dl of distLoads) {
      const w1 = dl.w;
      const w2 = (dl.w2 == null) ? null : dl.w2;
      for (let k = 0; k < nSub; k++) {
        if (w2 == null) { lc.loads.push({ ...dl, elemId: newIds[k] }); continue; }
        const ta = k / nSub, tb = (k + 1) / nSub;     // tramos del elemento original
        const wa = w1 + (w2 - w1) * ta;
        const wb = w1 + (w2 - w1) * tb;
        lc.loads.push({ ...dl, elemId: newIds[k], w: wa, w2: wb });
      }
    }
  }

  model.elements.delete(elemId);
  return newIds;
}

/** Divide un elemento en DOS en un nodo existente que cae sobre el segmento. */
function splitElementEnNodo(model, elemId, nodeId) {
  const elem = model.elements.get(elemId);
  if (!elem || elem.n1 === nodeId || elem.n2 === nodeId) return null;
  const e1 = model.addElement(elem.n1, nodeId, elem.matId, elem.secId);
  const e2 = model.addElement(nodeId, elem.n2, elem.matId, elem.secId);
  const newIds = [e1, e2].filter(Boolean).map(e => e.id);
  if (elem.releases && e1 && e2) {
    for (let i = 0; i < 6; i++) { e1.releases[i] = elem.releases[i] || 0; e2.releases[6 + i] = elem.releases[6 + i] || 0; }
  }
  // Parámetro del nodo de corte a lo largo del elemento (para cargas trapeciales)
  const a = model.nodes.get(elem.n1), b = model.nodes.get(elem.n2), c = model.nodes.get(nodeId);
  let tSplit = 0.5;
  if (a && b && c) {
    const dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z, L2=dx*dx+dy*dy+dz*dz;
    if (L2 > 1e-20) tSplit = Math.min(1, Math.max(0, ((c.x-a.x)*dx+(c.y-a.y)*dy+(c.z-a.z)*dz)/L2));
  }
  for (const lc of model.loadCases.values()) {
    const dl = lc.loads.filter(l => l.type === 'dist' && l.elemId === elemId);
    if (!dl.length) continue;
    lc.loads = lc.loads.filter(l => !(l.type === 'dist' && l.elemId === elemId));
    for (const d of dl) {
      if (d.w2 == null) { for (const id of newIds) lc.loads.push({ ...d, elemId: id }); continue; }
      const wSplit = d.w + (d.w2 - d.w) * tSplit;
      lc.loads.push({ ...d, elemId: newIds[0], w: d.w,    w2: wSplit });   // n1 → nodo
      lc.loads.push({ ...d, elemId: newIds[1], w: wSplit, w2: d.w2 });     // nodo → n2
    }
  }
  model.elements.delete(elemId);
  return newIds;
}

/**
 * Une dos elementos que SE INTERSECTAN creando un nodo común en el punto de
 * cruce (y partiendo cada elemento en ese nodo). Maneja cruces en X (interior a
 * ambos) y en T (extremo de uno sobre el interior del otro). Devuelve
 * {ok, nodeId, nuevos} o {ok:false, reason}.
 */
export function intersectarElementos(model, idA, idB, tol = 1e-3) {
  const A = model.elements.get(idA), B = model.elements.get(idB);
  if (!A || !B) return { ok: false, reason: 'Elementos no encontrados.' };
  if (idA === idB) return { ok: false, reason: 'Seleccione dos elementos distintos.' };
  const P1 = model.nodes.get(A.n1), P2 = model.nodes.get(A.n2);
  const Q1 = model.nodes.get(B.n1), Q2 = model.nodes.get(B.n2);
  if (!P1 || !P2 || !Q1 || !Q2) return { ok: false, reason: 'Nodos no encontrados.' };

  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = [P2.x - P1.x, P2.y - P1.y, P2.z - P1.z];
  const d2 = [Q2.x - Q1.x, Q2.y - Q1.y, Q2.z - Q1.z];
  const r = [P1.x - Q1.x, P1.y - Q1.y, P1.z - Q1.z];
  const a = dot(d1, d1), e = dot(d2, d2), b = dot(d1, d2), c = dot(d1, r), f = dot(d2, r);
  const den = a * e - b * b;
  if (Math.abs(den) < 1e-12) return { ok: false, reason: 'Los elementos son paralelos: no se cruzan en un punto.' };
  const s = (b * f - c * e) / den;   // parámetro sobre A
  const t = (a * f - b * c) / den;   // parámetro sobre B
  const PA = [P1.x + s * d1[0], P1.y + s * d1[1], P1.z + s * d1[2]];
  const PB = [Q1.x + t * d2[0], Q1.y + t * d2[1], Q1.z + t * d2[2]];
  const dist = Math.hypot(PA[0] - PB[0], PA[1] - PB[1], PA[2] - PB[2]);
  if (dist > tol) return { ok: false, reason: `Los elementos no se cruzan (separados ${dist.toFixed(3)} m; ¿están en planos distintos?).` };
  const eps = 1e-6;
  if (s < -eps || s > 1 + eps || t < -eps || t > 1 + eps)
    return { ok: false, reason: 'La intersección queda fuera de los elementos (en su prolongación).' };

  const P = [(PA[0] + PB[0]) / 2, (PA[1] + PB[1]) / 2, (PA[2] + PB[2]) / 2];
  // Reusar un extremo existente si la intersección coincide con él (cruce en T/L).
  let nodeId = null;
  for (const nd of [P1, P2, Q1, Q2]) {
    if (Math.hypot(nd.x - P[0], nd.y - P[1], nd.z - P[2]) <= tol * 2) { nodeId = nd.id; break; }
  }
  if (nodeId == null) { nodeId = model.addNode(+P[0].toFixed(6), +P[1].toFixed(6), +P[2].toFixed(6)).id; }

  let nuevos = 0;
  if (A.n1 !== nodeId && A.n2 !== nodeId) { const x = splitElementEnNodo(model, idA, nodeId); if (x) nuevos += x.length; }
  if (B.n1 !== nodeId && B.n2 !== nodeId) { const x = splitElementEnNodo(model, idB, nodeId); if (x) nuevos += x.length; }
  if (nuevos === 0) return { ok: false, reason: 'Los elementos ya comparten ese nodo.' };
  return { ok: true, nodeId, nuevos };
}

/** Divide un elemento en tramos de ≈targetLen metros. */
export function splitByLength(model, elemId, targetLen) {
  const elem = model.elements.get(elemId);
  if (!elem || !(targetLen > EPS)) return null;
  const n1 = model.nodes.get(elem.n1);
  const n2 = model.nodes.get(elem.n2);
  if (!n1 || !n2) return null;
  const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
  const nParts = Math.max(1, Math.round(L / targetLen));
  if (nParts < 2) return [elemId];   // ya es más corto que el objetivo
  return splitElement(model, elemId, nParts);
}

/**
 * Discretiza todos los elementos del modelo.
 * opts: { parts: N }  ó  { length: metros }
 * Devuelve el nº de elementos resultantes.
 */
export function discretizeAll(model, opts = {}) {
  const ids = [...model.elements.keys()];
  for (const id of ids) {
    if (opts.length > EPS)      splitByLength(model, id, opts.length);
    else if (opts.parts >= 2)   splitElement(model, id, opts.parts);
  }
  return model.elements.size;
}

/**
 * Une una cadena de elementos colineales en un solo elemento.
 * Requisitos: mismo material y sección, cadena continua y colineal,
 * nodos intermedios sin apoyos, cargas nodales, masas, diafragmas
 * ni otros elementos conectados, y sin rótulas intermedias.
 * Devuelve { ok, reason?, elemId?, removedNodes? }.
 */
export function joinElements(model, elemIds) {
  const elems = elemIds.map(id => model.elements.get(id)).filter(Boolean);
  if (elems.length < 2) return { ok: false, reason: 'Seleccione al menos 2 elementos' };

  const ref = elems[0];
  if (!elems.every(e => e.matId === ref.matId && e.secId === ref.secId)) {
    return { ok: false, reason: 'Los elementos deben tener el mismo material y sección' };
  }

  // Contar ocurrencias de nodos: extremos aparecen 1 vez, intermedios 2
  const count = new Map();
  for (const e of elems) {
    count.set(e.n1, (count.get(e.n1) || 0) + 1);
    count.set(e.n2, (count.get(e.n2) || 0) + 1);
  }
  const endNodes = [...count.entries()].filter(([, c]) => c === 1).map(([id]) => id);
  const midNodes = [...count.entries()].filter(([, c]) => c === 2).map(([id]) => id);
  if (endNodes.length !== 2 || [...count.values()].some(c => c > 2)) {
    return { ok: false, reason: 'Los elementos no forman una cadena simple' };
  }

  // Ordenar la cadena desde un extremo
  const [startId, endId] = endNodes;
  const remaining = new Set(elems.map(e => e.id));
  const ordered = [];   // [{elem, flip}] — flip=true si el elemento apunta contra la cadena
  let cur = startId;
  while (remaining.size) {
    let found = null;
    for (const id of remaining) {
      const e = model.elements.get(id);
      if (e.n1 === cur)      { found = { elem: e, flip: false }; cur = e.n2; break; }
      else if (e.n2 === cur) { found = { elem: e, flip: true  }; cur = e.n1; break; }
    }
    if (!found) return { ok: false, reason: 'Cadena discontinua' };
    remaining.delete(found.elem.id);
    ordered.push(found);
  }
  if (cur !== endId) return { ok: false, reason: 'Cadena discontinua' };

  // Colinealidad: todos los nodos sobre la recta start→end
  const nS = model.nodes.get(startId), nE = model.nodes.get(endId);
  const d  = [nE.x - nS.x, nE.y - nS.y, nE.z - nS.z];
  const Lt = Math.hypot(...d);
  if (Lt < EPS) return { ok: false, reason: 'Longitud nula' };
  for (const mid of midNodes) {
    const n = model.nodes.get(mid);
    const v = [n.x - nS.x, n.y - nS.y, n.z - nS.z];
    const cx = v[1] * d[2] - v[2] * d[1];
    const cy = v[2] * d[0] - v[0] * d[2];
    const cz = v[0] * d[1] - v[1] * d[0];
    if (Math.hypot(cx, cy, cz) / Lt > 1e-6) {
      return { ok: false, reason: 'Los elementos no son colineales' };
    }
  }

  // Nodos intermedios deben estar "limpios"
  for (const mid of midNodes) {
    const n = model.nodes.get(mid);
    if (Object.values(n.restraints || {}).some(v => v)) {
      return { ok: false, reason: `Nodo ${mid} tiene apoyos` };
    }
    const nm = n.nodeMass;
    if (nm && (nm.mx || nm.my || nm.mz)) {
      return { ok: false, reason: `Nodo ${mid} tiene masa nodal` };
    }
    for (const lc of model.loadCases.values()) {
      if (lc.loads.some(l => l.type === 'nodal' && l.nodeId === mid)) {
        return { ok: false, reason: `Nodo ${mid} tiene cargas nodales` };
      }
    }
    for (const dia of model.diaphragms.values()) {
      if (dia.nodes.includes(mid)) {
        return { ok: false, reason: `Nodo ${mid} pertenece a un diafragma` };
      }
    }
    for (const e of model.elements.values()) {
      if (elemIds.includes(e.id)) continue;
      if (e.n1 === mid || e.n2 === mid) {
        return { ok: false, reason: `Nodo ${mid} conecta otros elementos` };
      }
    }
  }

  // Sin rótulas en extremos intermedios (sería una rótula real dentro del nuevo elemento)
  const endRel = (e, atN1) => {
    const off = atN1 ? 0 : 6;
    return (e.releases || []).slice(off, off + 6);
  };
  for (let k = 0; k < ordered.length; k++) {
    const { elem, flip } = ordered[k];
    const innerStart = k > 0;                      // extremo que toca nodo intermedio
    const innerEnd   = k < ordered.length - 1;
    const relStart = endRel(elem, !flip);          // extremo en el lado "inicio de cadena"
    const relEnd   = endRel(elem, flip);
    if ((innerStart && relStart.some(r => r)) || (innerEnd && relEnd.some(r => r))) {
      return { ok: false, reason: 'Hay liberaciones (rótulas) en nodos intermedios' };
    }
  }

  // Cargas distribuidas: unir solo si todos los tramos tienen la MISMA carga por
  // caso (incluido w2: dos trapecios con igual w pero distinto w2 NO se unen).
  const mergedDist = [];   // {lcId, dir, w, w2}
  for (const lc of model.loadCases.values()) {
    const sig = e => {
      const dl = lc.loads.filter(l => l.type === 'dist' && l.elemId === e.id);
      if (dl.length === 0) return 'none';
      if (dl.length > 1) return 'multi';
      return `${dl[0].dir || 'gravity'}|${dl[0].w}|${dl[0].w2 ?? ''}`;
    };
    const sigs = elems.map(sig);
    if (!sigs.every(s => s === sigs[0])) {
      return { ok: false, reason: `Cargas distribuidas distintas entre tramos (caso "${lc.name}")` };
    }
    if (sigs[0] !== 'none' && sigs[0] !== 'multi') {
      const [dir, w, w2] = sigs[0].split('|');
      mergedDist.push({ lcId: lc.id, dir, w: +w, w2: (w2 === '' ? null : +w2) });
    }
  }

  // Liberaciones del elemento unido: extremos exteriores de la cadena
  const relA = endRel(ordered[0].elem, !ordered[0].flip);
  const last = ordered[ordered.length - 1];
  const relB = endRel(last.elem, last.flip);

  // ── Ejecutar la unión ──
  for (const { elem } of ordered) {
    for (const lc of model.loadCases.values()) {
      lc.loads = lc.loads.filter(l => !(l.type === 'dist' && l.elemId === elem.id));
    }
    model.elements.delete(elem.id);
  }
  for (const mid of midNodes) model.nodes.delete(mid);

  const merged = model.addElement(startId, endId, ref.matId, ref.secId);
  for (let i = 0; i < 6; i++) {
    merged.releases[i]     = relA[i] ? 1 : 0;
    merged.releases[6 + i] = relB[i] ? 1 : 0;
  }
  for (const md of mergedDist) {
    const load = { type: 'dist', elemId: merged.id, dir: md.dir, w: md.w };
    if (md.w2 != null) load.w2 = md.w2;
    model.loadCases.get(md.lcId)?.loads.push(load);
  }

  return { ok: true, elemId: merged.id, removedNodes: midNodes };
}
