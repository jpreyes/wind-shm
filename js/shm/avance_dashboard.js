// ─────────────────────────────────────────────────────────────────────────────
// avance_dashboard.js — dashboard de avance de obra a nivel PARQUE (Frente 1, R-18).
//
// Agrega las partidas por componente de toda la flota (enrichStages) y produce los
// indicadores «de obra»: % global plan vs real, atraso (slippage), curva-S
// (acumulado plan vs real por mes), % por componente y ranking de torres atrasadas.
// Render en DOM/SVG (verificable) + informe imprimible. Módulo de presentación.
// ─────────────────────────────────────────────────────────────────────────────
import { enrichStages, TURBINE_COMPONENTS } from './parks_data_caman.js?v=249';

const DAY = 864e5;
const fmtPct = (x) => `${Math.round(x * 100)}%`;
const monKey = (ms) => { const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`; };

// Calcula los indicadores de avance del parque desde la flota viva.
export function computeParkAvance(structures) {
  const comps = TURBINE_COMPONENTS, nC = comps.length;
  const turbs = (structures || []).filter(s => s.type !== 'hv');
  const today = Date.now();
  const perComp = comps.map(c => ({ component: c.component, label: c.label, sum: 0, n: 0 }));
  const all = [];           // {plannedEnd, actualEnd, pct}
  const late = [];
  let realUnits = 0, planUnits = 0, units = 0, slipSum = 0, slipN = 0;
  let minMs = Infinity, maxMs = -Infinity;

  for (const t of turbs) {
    const sts = enrichStages(t.stages, 'turbine', t.id);
    t.stages = sts;
    let real = 0, planByToday = 0;
    sts.forEach((s, i) => {
      const pe = Date.parse(s.plannedEnd), ps = Date.parse(s.plannedStart);
      const ae = s.actualEnd ? Date.parse(s.actualEnd) : null;
      real += s.pct / 100; units++; realUnits += s.pct / 100;
      if (pe <= today) { planUnits += 1; planByToday += 1; }
      if (ae) { slipSum += Math.round((ae - pe) / DAY); slipN++; }
      perComp[i].sum += s.pct; perComp[i].n++;
      all.push({ pe, ps, ae, pct: s.pct });
      minMs = Math.min(minMs, ps); maxMs = Math.max(maxMs, pe, ae || -Infinity);
    });
    real /= nC; planByToday /= nC;
    late.push({ id: t.id, label: t.label, real, plan: planByToday, behind: planByToday - real });
  }

  const realPct = units ? realUnits / units : 0;
  const planPct = units ? planUnits / units : 0;
  const nOp = turbs.filter(t => (t.built ?? 1) >= 0.97).length;
  const nFound = turbs.filter(t => (t.built ?? 0) <= 0.02).length;
  const nWip = turbs.length - nOp - nFound;

  // Curva-S: acumulado plan vs real por mes (real sólo hasta hoy).
  const curve = { labels: [], plan: [], real: [], todayIdx: -1 };
  if (isFinite(minMs) && isFinite(maxMs) && all.length) {
    const start = new Date(minMs); start.setDate(1);
    const end = new Date(maxMs);
    for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) {
      const bEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();   // fin de mes
      curve.labels.push(monKey(d.getTime()));
      curve.plan.push(all.filter(a => a.pe <= bEnd).length / all.length);
      if (bEnd <= today) {
        // real histórico: partidas terminadas a esa fecha
        curve.real.push(all.filter(a => a.ae && a.ae <= bEnd).length / all.length);
        curve.todayIdx = curve.labels.length - 1;
      } else curve.real.push(null);   // futuro: sin dato real
    }
    // ancla el real de hoy al % real vigente (incluye parciales)
    if (curve.todayIdx >= 0) curve.real[curve.todayIdx] = realPct;
  }

  perComp.forEach(p => { p.pct = p.n ? p.sum / (p.n * 100) : 0; });
  late.sort((a, b) => b.behind - a.behind);
  return {
    realPct, planPct, slipDays: slipN ? Math.round(slipSum / slipN) : 0,
    nTurb: turbs.length, nOp, nWip, nFound, perComp, curve,
    late: late.filter(l => l.behind > 0.02).slice(0, 8),
  };
}

// ── SVG de la curva-S (plan vs real) ─────────────────────────────────────────
function curveSVG(curve) {
  const n = curve.labels.length;
  if (n < 2) return '<div class="av-mut">Sin cronograma suficiente para la curva-S.</div>';
  const W = 300, H = 150, ml = 30, mb = 20, mt = 8, mr = 8;
  const pw = W - ml - mr, ph = H - mt - mb;
  const X = (i) => ml + (i / (n - 1)) * pw;
  const Y = (v) => mt + (1 - v) * ph;
  const path = (arr) => arr.map((v, i) => v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).filter(Boolean).join(' ');
  const grid = [0, 0.25, 0.5, 0.75, 1].map(v => `<line x1="${ml}" y1="${Y(v)}" x2="${W - mr}" y2="${Y(v)}" stroke="var(--border,#28384a)" stroke-width="0.5"/><text x="${ml - 4}" y="${Y(v) + 3}" text-anchor="end" font-size="8" fill="var(--text-muted,#93a6b8)">${v * 100 | 0}</text>`).join('');
  const xlabels = curve.labels.map((l, i) => (i % Math.ceil(n / 6) === 0 || i === n - 1) ? `<text x="${X(i)}" y="${H - 6}" text-anchor="middle" font-size="8" fill="var(--text-muted,#93a6b8)">${l}</text>` : '').join('');
  const todayLine = curve.todayIdx >= 0 ? `<line x1="${X(curve.todayIdx)}" y1="${mt}" x2="${X(curve.todayIdx)}" y2="${mt + ph}" stroke="#ff5e3a" stroke-width="1" stroke-dasharray="3 2"/><text x="${X(curve.todayIdx)}" y="${mt + 7}" text-anchor="middle" font-size="8" fill="#ff5e3a">hoy</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="av-curve" xmlns="http://www.w3.org/2000/svg">
    ${grid}${todayLine}
    <polyline points="${path(curve.plan)}" fill="none" stroke="var(--text-muted,#93a6b8)" stroke-width="1.6" stroke-dasharray="4 3"/>
    <polyline points="${path(curve.real)}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="2.2"/>
    ${xlabels}
  </svg>`;
}

// Render del dashboard en un host del panel derecho.
export function renderAvance(host, structures) {
  const d = computeParkAvance(structures);
  const behind = d.planPct - d.realPct;   // + = el parque va atrasado
  const verdict = behind > 0.05 ? { c: 'bad', t: `Atrasado ${Math.round(behind * 100)} pts vs plan` }
    : behind < -0.05 ? { c: 'ok', t: `Adelantado ${Math.round(-behind * 100)} pts` }
    : { c: 'ok', t: 'En línea con el plan' };
  const compBars = d.perComp.map(p => `
    <div class="av-comp"><span class="av-comp-l">${p.label}</span>
      <span class="av-comp-bar"><i style="width:${Math.round(p.pct * 100)}%"></i></span>
      <span class="av-comp-p">${fmtPct(p.pct)}</span></div>`).join('');
  const lateRows = d.late.length ? d.late.map(l => `
    <div class="av-late"><span class="av-late-n">${l.label}</span>
      <span class="av-late-v">real ${fmtPct(l.real)} · plan ${fmtPct(l.plan)} <b class="av-behind">−${Math.round(l.behind * 100)} pts</b></span></div>`).join('')
    : '<div class="av-mut">Ninguna torre atrasada respecto al plan. 👍</div>';

  host.innerHTML = `
    <div class="av-hdr">Avance de obra · Camán I</div>
    <div class="av-banner ${verdict.c}">${verdict.c === 'ok' ? '✓' : '✗'} ${verdict.t}</div>
    <div class="av-kpis">
      <div class="av-kpi"><div class="k">Real</div><div class="v">${fmtPct(d.realPct)}</div></div>
      <div class="av-kpi"><div class="k">Plan a hoy</div><div class="v">${fmtPct(d.planPct)}</div></div>
      <div class="av-kpi"><div class="k">Atraso medio</div><div class="v ${d.slipDays > 0 ? 'late' : ''}">${d.slipDays > 0 ? '+' : ''}${d.slipDays} d</div></div>
      <div class="av-kpi"><div class="k">Operativas</div><div class="v">${d.nOp}/${d.nTurb}</div></div>
    </div>
    <div class="av-sub">Curva-S — acumulado plan vs real</div>
    ${curveSVG(d.curve)}
    <div class="av-leg"><span><i class="dash"></i>Plan</span><span><i class="solid"></i>Real</span><span><i class="today"></i>Hoy</span></div>
    <div class="av-sub">Avance por componente (parque)</div>
    <div class="av-comps">${compBars}</div>
    <div class="av-sub">Torres atrasadas <span class="av-mut">(real &lt; plan)</span></div>
    <div class="av-lates">${lateRows}</div>
    <button id="av-report" class="av-btn" type="button">📄 Informe de avance (DPR)</button>`;
  host.querySelector('#av-report')?.addEventListener('click', () => avanceReport(structures));
}

// ── Informe de avance imprimible (DPR resumido) ──────────────────────────────
export function avanceReport(structures) {
  const d = computeParkAvance(structures);
  const comps = d.perComp.map(p => `<tr><td>${p.label}</td><td style="text-align:right">${fmtPct(p.pct)}</td></tr>`).join('');
  const late = d.late.length ? d.late.map(l => `<tr><td>${l.label}</td><td style="text-align:right">${fmtPct(l.real)}</td><td style="text-align:right">${fmtPct(l.plan)}</td><td style="text-align:right;color:#b91c1c">−${Math.round(l.behind * 100)} pts</td></tr>`).join('') : '<tr><td colspan="4" style="color:#15803d">Ninguna torre atrasada.</td></tr>';
  const html = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Informe de avance — Parque Camán I</title>
    <style>body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1b2533}.wrap{max-width:820px;margin:0 auto;padding:0 32px 40px}
    .hero{background:linear-gradient(120deg,#0e7490,#155e75);color:#fff;padding:24px 32px;margin-bottom:22px}.hero h1{margin:4px 0;font-size:22px}
    h2{font-size:15px;border-bottom:2px solid #cbd5e1;padding-bottom:5px;margin:26px 0 10px}.mut{color:#64748b;font-size:12px}
    .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}.kpi{background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:12px}
    .kpi .v{font-size:23px;font-weight:800}.kpi .k{font-size:11px;color:#64748b;text-transform:uppercase}
    table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}th,td{border:1px solid #cbd5e1;padding:6px 9px;text-align:left}th{background:#f1f5f9}</style>
    <div class="hero"><div class="mut" style="color:#cfe9f1;letter-spacing:2px;text-transform:uppercase">ReWind · Avance de obra</div>
      <h1>Informe de avance (DPR) — Parque Camán I</h1><div style="opacity:.9;font-size:13px">Generado ${new Date().toLocaleString('es-CL')}</div></div>
    <div class="wrap">
      <h2>Resumen</h2>
      <div class="kpis">
        <div class="kpi"><div class="v">${fmtPct(d.realPct)}</div><div class="k">Avance real</div></div>
        <div class="kpi"><div class="v">${fmtPct(d.planPct)}</div><div class="k">Plan a hoy</div></div>
        <div class="kpi"><div class="v">${d.slipDays > 0 ? '+' : ''}${d.slipDays} d</div><div class="k">Atraso medio</div></div>
        <div class="kpi"><div class="v">${d.nOp}/${d.nTurb}</div><div class="k">Operativas</div></div>
      </div>
      <p class="mut">Estado vs plan: el parque va ${Math.abs(d.planPct - d.realPct) < 0.05 ? 'en línea con el plan' : (d.planPct > d.realPct ? `atrasado ${Math.round((d.planPct - d.realPct) * 100)} puntos` : `adelantado ${Math.round((d.realPct - d.planPct) * 100)} puntos`)}. ${d.nOp} operativas · ${d.nWip} en montaje · ${d.nFound} en fundación.</p>
      <h2>Avance por componente</h2>
      <table><thead><tr><th>Componente</th><th style="text-align:right">% parque</th></tr></thead><tbody>${comps}</tbody></table>
      <h2>Torres atrasadas</h2>
      <table><thead><tr><th>Torre</th><th style="text-align:right">Real</th><th style="text-align:right">Plan a hoy</th><th style="text-align:right">Brecha</th></tr></thead><tbody>${late}</tbody></table>
      <p class="mut" style="margin-top:18px">Cronograma sintético/editable. El avance real definitivo provendrá de la captura en obra (DataSource / R-10).</p>
    </div></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}
