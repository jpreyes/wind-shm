// ──────────────────────────────────────────────────────────────────────────────
// nl_timehistory.js — TIME-HISTORY NO LINEAL (rótulas plásticas) · #48b
//
// El time-history LINEAL (timehistory.js, G12) usa superposición modal con la
// integral de Duhamel por modo, válida sólo mientras el sistema es lineal.  En
// cuanto se forman rótulas plásticas la base modal cambia de paso a paso y la
// superposición deja de ser válida; el procedimiento riguroso es la INTEGRACIÓN
// DIRECTA paso a paso del sistema no lineal:
//
//     M·ü + C·u̇ + r(u) = −M·ι·a_g(t)
//
// donde r(u) es la FUERZA RESISTENTE no lineal (lineal-elástica salvo en las
// rótulas, que siguen una ley histerética).  Se integra con NEWMARK-β (aceleración
// media constante, γ=½, β=¼: incondicionalmente estable, sin disipación numérica)
// y, como r(u) no es lineal, se itera NEWTON–RAPHSON dentro de cada paso con la
// rigidez tangente Kt del estado actual.  El amortiguamiento es de Rayleigh
// C = a₀·M + a₁·K₀ (rigidez inicial), como en SAP2000/ETABS por defecto.
//
// Las rótulas se modelan como RESORTES BILINEALES con endurecimiento cinemático
// (perfectamente plástico si α=0): elásticos hasta la fluencia Fy y con rigidez
// post-fluencia α·k₀ después, con descarga elástica e histéresis cinemática (sin
// degradación) — el modelo histerético estándar de Clough/elastoplástico.
//
// El núcleo es AUTÓNOMO (verificable en Node, sin DOM): recibe M, el modelo
// resistente `resist` (que encapsula su propia historia plástica), el
// acelerograma y el vector de influencia.  Se incluye un constructor para el
// banco de pruebas canónico —el EDIFICIO DE CORTE elastoplástico (interstory
// springs)— contra el cual se valida (test_nl_timehistory.mjs): el límite
// elástico reproduce el SDOF analítico, y el caso elastoplástico coincide con una
// integración independiente por DIFERENCIA CENTRAL (comprobación cruzada).
// ──────────────────────────────────────────────────────────────────────────────

// ── Solver denso pequeño (eliminación gaussiana con pivoteo parcial) ─────────────
// A es Float64Array(n*n) por filas; b Float64Array(n).  Devuelve x (sobrescribe b).
export function denseSolve(A, b, n) {
  const M = A.slice();                     // copia de trabajo
  const x = b.slice();
  for (let k = 0; k < n; k++) {
    // pivoteo parcial
    let p = k, max = Math.abs(M[k * n + k]);
    for (let i = k + 1; i < n; i++) { const v = Math.abs(M[i * n + k]); if (v > max) { max = v; p = i; } }
    if (max < 1e-300) throw new Error('matriz efectiva singular en el paso no lineal');
    if (p !== k) { for (let j = 0; j < n; j++) { const t = M[k * n + j]; M[k * n + j] = M[p * n + j]; M[p * n + j] = t; } const t = x[k]; x[k] = x[p]; x[p] = t; }
    const piv = M[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = M[i * n + k] / piv; if (f === 0) continue;
      for (let j = k; j < n; j++) M[i * n + j] -= f * M[k * n + j];
      x[i] -= f * x[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]; for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j];
    x[i] = s / M[i * n + i];
  }
  return x;
}

// ── Resorte bilineal con endurecimiento cinemático (rótula 1D) ──────────────────
// Plasticidad J2 unidimensional con back-stress (return mapping):
//   f_tr = k0·(d − ep);  X = H·ep;  φ = |f_tr − X| − Fy
//   φ≤0 → elástico (kt=k0);  φ>0 → Δγ=φ/(k0+H), ep+=Δγ·sgn, kt=α·k0
// con H = α/(1−α)·k0 (α = razón de endurecimiento; α=0 ⇒ perfectamente plástico).
export function makeBilinear(k0, Fy, alpha = 0) {
  const H = alpha >= 1 ? Infinity : alpha / (1 - alpha) * k0;
  return {
    k0, Fy, alpha, ep: 0, _epTrial: 0,
    // Fuerza y tangente para una deformación de prueba (NO confirma el estado).
    eval(d) {
      const ftr = k0 * (d - this.ep);
      const X = (H === Infinity ? 0 : H * this.ep);
      const phi = Math.abs(ftr - X) - this.Fy;
      if (phi <= 0 || k0 === 0) { this._epTrial = this.ep; return { f: ftr, kt: k0 }; }
      const dgam = phi / (k0 + (H === Infinity ? k0 * 1e12 : H));
      const sgn = Math.sign(ftr - X) || 1;
      this._epTrial = this.ep + dgam * sgn;
      const f = k0 * (d - this._epTrial);
      const kt = (H === Infinity) ? k0 : k0 * H / (k0 + H);   // = α·k0
      return { f, kt };
    },
    commit() { this.ep = this._epTrial; },
    yielded() { return Math.abs(this.ep) > 1e-14; },
  };
}

// ── Constructor: EDIFICIO DE CORTE elastoplástico ────────────────────────────────
// Pisos i=0..N−1; el resorte i conecta el GDL i−1 (suelo=0 fijo) con el GDL i.
//   m[i]  masa del piso  ·  k[i] rigidez de entrepiso  ·  Fy[i] corte de fluencia
//   alpha[i] razón de endurecimiento post-fluencia.
// Devuelve { n, M (diag), resist, springs } listo para newmarkNonlinear.
export function shearBuilding({ m, k, Fy, alpha }) {
  const n = m.length;
  const M = Float64Array.from(m);
  const springs = k.map((ki, i) => makeBilinear(ki, (Fy && Fy[i] != null) ? Fy[i] : Infinity, (alpha && alpha[i]) || 0));
  // drift del resorte i = u[i] − u[i−1]   (u[-1] = suelo = 0)
  const resist = {
    springs,
    internal(u) {
      const f = new Float64Array(n);
      const Kt = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        const di = u[i] - (i > 0 ? u[i - 1] : 0);
        const { f: si, kt } = springs[i].eval(di);
        f[i] += si; if (i > 0) f[i - 1] -= si;
        Kt[i * n + i] += kt;
        if (i > 0) { Kt[(i - 1) * n + (i - 1)] += kt; Kt[i * n + (i - 1)] -= kt; Kt[(i - 1) * n + i] -= kt; }
      }
      return { f, Kt };
    },
    commit() { for (const s of springs) s.commit(); },
    // Rigidez inicial (para Rayleigh y el modal de referencia).
    K0() {
      const Kt = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        const kt = springs[i].k0;
        Kt[i * n + i] += kt;
        if (i > 0) { Kt[(i - 1) * n + (i - 1)] += kt; Kt[i * n + (i - 1)] -= kt; Kt[(i - 1) * n + i] -= kt; }
      }
      return Kt;
    },
  };
  return { n, M, resist, springs };
}

// Amortiguamiento de Rayleigh C = a₀·M + a₁·K₀ que da ζ en dos frecuencias.
//   M diag (Float64Array n), K0 Float64Array(n*n).
export function rayleighDamping(M, K0, n, zeta, w1, w2) {
  // a0, a1 de ζ = ½(a0/ω + a1·ω) en ω1, ω2.
  const a1 = (w1 === w2) ? zeta / w1 : 2 * zeta / (w1 + w2);
  const a0 = (w1 === w2) ? zeta * w1 : 2 * zeta * w1 * w2 / (w1 + w2);
  const C = new Float64Array(n * n);
  for (let i = 0; i < n; i++) { C[i * n + i] += a0 * M[i]; for (let j = 0; j < n; j++) C[i * n + j] += a1 * K0[i * n + j]; }
  return { C, a0, a1 };
}

/**
 * Integración directa NEWMARK-β no lineal (Newton–Raphson por paso).
 *
 * @param {object} o
 *   M       Float64Array(n)        masa concentrada (diagonal).
 *   resist  { internal(u)->{f,Kt}, commit() }   modelo resistente no lineal.
 *   C       Float64Array(n*n)|null amortiguamiento (Rayleigh); null = 0.
 *   ag      Float64Array           acelerograma a_g(t) (m/s²), Δt uniforme.
 *   dt      number                 paso de tiempo (s).
 *   infl    Float64Array(n)|null   vector de influencia ι (def. 1 en todos).
 *   gamma,beta  Newmark (def. ½, ¼).
 *   tol     tolerancia de residuo (def. 1e-8 relativa a |p|).
 *   maxIter Newton (def. 30).
 *   u0,v0   estado inicial (def. reposo).
 *   store   'full' guarda u por paso (def.) | 'monitor' sólo monitorDof.
 *   monitorDof  índice de GDL a registrar si store='monitor'.
 * @returns { n, nSteps, dt, U?:Float64Array[], mon?:Float64Array, peak, peakStep,
 *            residual:Float64Array(n), driftMax, anyYield }
 */
export function newmarkNonlinear(o) {
  const { M, resist, ag, dt } = o;
  const n = M.length;
  const C = o.C || null;
  const infl = o.infl || Float64Array.from({ length: n }, () => 1);
  const gamma = o.gamma ?? 0.5, beta = o.beta ?? 0.25;
  const tol = o.tol ?? 1e-8, maxIter = o.maxIter ?? 30;
  const nSteps = ag.length;

  let u = o.u0 ? Float64Array.from(o.u0) : new Float64Array(n);
  let v = o.v0 ? Float64Array.from(o.v0) : new Float64Array(n);
  // Aceleración inicial: a0 = M⁻¹(p0 − C·v0 − r(u0))
  const a = new Float64Array(n);
  {
    const { f } = resist.internal(u);
    for (let i = 0; i < n; i++) {
      let cv = 0; if (C) for (let j = 0; j < n; j++) cv += C[i * n + j] * v[j];
      a[i] = (-M[i] * infl[i] * ag[0] - cv - f[i]) / M[i];
    }
  }

  const store = o.store || 'full';
  const U = store === 'full' ? [Float64Array.from(u)] : null;
  const mon = store === 'monitor' ? new Float64Array(nSteps) : null;
  const monDof = o.monitorDof || 0;
  if (mon) mon[0] = u[monDof];

  const c1 = 1 / (beta * dt * dt), c2 = gamma / (beta * dt);
  const c3 = 1 / (beta * dt), c4 = 1 / (2 * beta) - 1;
  const c5 = dt * (1 - gamma), c6 = dt * gamma;

  let peak = Math.abs(u[monDof]), peakStep = 0, driftMax = 0, anyYield = false;
  const un = new Float64Array(n), an = new Float64Array(n), vn = new Float64Array(n);
  const R = new Float64Array(n), Keff = new Float64Array(n * n);
  let lastResidual = new Float64Array(n);

  for (let k = 1; k < nSteps; k++) {
    const agk = ag[k];
    // Predictor: u_{k+1} = u_k (Newton parte del último estado convergido).
    for (let i = 0; i < n; i++) un[i] = u[i];
    let it = 0, conv = false;
    let pnorm = 0; for (let i = 0; i < n; i++) pnorm += (M[i] * infl[i] * agk) ** 2; pnorm = Math.sqrt(pnorm) || 1;
    for (; it < maxIter; it++) {
      // Cinemática Newmark en función de un.
      for (let i = 0; i < n; i++) {
        an[i] = c1 * (un[i] - u[i]) - c3 * v[i] - c4 * a[i];
        vn[i] = v[i] + c5 * a[i] + c6 * an[i];
      }
      const { f, Kt } = resist.internal(un);
      // Residuo R = p − M·a − C·v − f
      for (let i = 0; i < n; i++) {
        let cv = 0; if (C) for (let j = 0; j < n; j++) cv += C[i * n + j] * vn[j];
        R[i] = -M[i] * infl[i] * agk - M[i] * an[i] - cv - f[i];
      }
      let rnorm = 0; for (let i = 0; i < n; i++) rnorm += R[i] * R[i]; rnorm = Math.sqrt(rnorm);
      if (rnorm <= tol * pnorm && it > 0) { conv = true; break; }
      // Keff = Kt + c2·C + c1·M
      for (let i = 0; i < n * n; i++) Keff[i] = Kt[i] + (C ? c2 * C[i] : 0);
      for (let i = 0; i < n; i++) Keff[i * n + i] += c1 * M[i];
      const du = denseSolve(Keff, R, n);
      for (let i = 0; i < n; i++) un[i] += du[i];
      if (it === 0) {
        // segundo chequeo: si Δu es minúsculo, ya está
        let dn = 0; for (let i = 0; i < n; i++) dn += du[i] * du[i];
        if (Math.sqrt(dn) < 1e-14) { conv = true; }
      }
    }
    if (!conv && it >= maxIter) {
      // Recalcula cinemática/residuo del último un para reportar.
      for (let i = 0; i < n; i++) { an[i] = c1 * (un[i] - u[i]) - c3 * v[i] - c4 * a[i]; vn[i] = v[i] + c5 * a[i] + c6 * an[i]; }
    }
    // Confirma el estado plástico del paso convergido y avanza.
    resist.internal(un); resist.commit();
    for (let i = 0; i < n; i++) { u[i] = un[i]; v[i] = vn[i]; a[i] = an[i]; lastResidual[i] = R[i]; }
    if (U) U.push(Float64Array.from(u));
    if (mon) mon[k] = u[monDof];
    const am = Math.abs(u[monDof]); if (am > peak) { peak = am; peakStep = k; }
    // drift máximo (entrepiso) si el resist expone springs.
    if (resist.springs) for (let i = 0; i < n; i++) { const d = Math.abs(u[i] - (i > 0 ? u[i - 1] : 0)); if (d > driftMax) driftMax = d; }
  }
  if (resist.springs) anyYield = resist.springs.some(s => s.yielded());

  return { n, nSteps, dt, U, mon, peak, peakStep, residual: lastResidual, driftMax, anyYield };
}

// ── Integrador independiente de DIFERENCIA CENTRAL (sólo para verificación) ──────
// Explícito: u_{k+1} de M̂·u_{k+1} = p_k − (K_secante via resist)·… — aquí se evalúa
// la fuerza resistente con el estado actual (sin iterar), por eso requiere Δt fino.
// Sirve de comprobación cruzada del Newmark no lineal (otro esquema temporal).
export function centralDifferenceNonlinear(o) {
  const { M, resist, ag, dt } = o;
  const n = M.length;
  const C = o.C || null;
  const infl = o.infl || Float64Array.from({ length: n }, () => 1);
  const nSteps = ag.length;
  let u = new Float64Array(n), uPrev = new Float64Array(n), v = new Float64Array(n);
  // a0
  const a0 = new Float64Array(n);
  { const { f } = resist.internal(u); resist.commit(); for (let i = 0; i < n; i++) a0[i] = (-M[i] * infl[i] * ag[0] - f[i]) / M[i]; }
  for (let i = 0; i < n; i++) uPrev[i] = u[i] - dt * v[i] + 0.5 * dt * dt * a0[i];
  const monDof = o.monitorDof || 0;
  const mon = new Float64Array(nSteps); mon[0] = u[monDof];
  let peak = Math.abs(u[monDof]), peakStep = 0;
  const uNext = new Float64Array(n);
  for (let k = 1; k < nSteps; k++) {
    const { f } = resist.internal(u); resist.commit();
    for (let i = 0; i < n; i++) {
      // velocidad central para el amortiguamiento
      let cv = 0; if (C) for (let j = 0; j < n; j++) cv += C[i * n + j] * (u[j] - uPrev[j]) / (2 * dt);
      const p = -M[i] * infl[i] * ag[k];
      // M (u_{k+1} − 2u_k + u_{k−1})/dt² = p − C·v − f
      uNext[i] = (p - cv - f[i]) * dt * dt / M[i] + 2 * u[i] - uPrev[i];
    }
    for (let i = 0; i < n; i++) { uPrev[i] = u[i]; u[i] = uNext[i]; }
    mon[k] = u[monDof];
    const am = Math.abs(u[monDof]); if (am > peak) { peak = am; peakStep = k; }
  }
  return { mon, peak, peakStep };
}
