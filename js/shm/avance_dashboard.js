// ─────────────────────────────────────────────────────────────────────────────
// avance_dashboard.js — dashboard de avance de obra a nivel PARQUE (Frente 1, R-18).
//
// Agrega las partidas por componente de toda la flota (enrichStages) y produce los
// indicadores «de obra»: % global plan vs real, atraso (slippage), curva-S
// (acumulado plan vs real por mes), % por componente y ranking de torres atrasadas.
// Render en DOM/SVG (verificable) + informe imprimible. Módulo de presentación.
// ─────────────────────────────────────────────────────────────────────────────
import { enrichStages, TURBINE_COMPONENTS } from './parks_data_caman.js?v=309';
import * as CTwin from './construction_twin.js?v=309';
import { t, getLang } from './i18n.js?v=309';

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
  if (n < 2) return `<div class="av-mut">${t('obra.noCurve')}</div>`;
  const W = 300, H = 150, ml = 30, mb = 20, mt = 8, mr = 8;
  const pw = W - ml - mr, ph = H - mt - mb;
  const X = (i) => ml + (i / (n - 1)) * pw;
  const Y = (v) => mt + (1 - v) * ph;
  const path = (arr) => arr.map((v, i) => v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).filter(Boolean).join(' ');
  const grid = [0, 0.25, 0.5, 0.75, 1].map(v => `<line x1="${ml}" y1="${Y(v)}" x2="${W - mr}" y2="${Y(v)}" stroke="var(--border,#28384a)" stroke-width="0.5"/><text x="${ml - 4}" y="${Y(v) + 3}" text-anchor="end" font-size="8" fill="var(--text-muted,#93a6b8)">${v * 100 | 0}</text>`).join('');
  const xlabels = curve.labels.map((l, i) => (i % Math.ceil(n / 6) === 0 || i === n - 1) ? `<text x="${X(i)}" y="${H - 6}" text-anchor="middle" font-size="8" fill="var(--text-muted,#93a6b8)">${l}</text>` : '').join('');
  const todayLine = curve.todayIdx >= 0 ? `<line x1="${X(curve.todayIdx)}" y1="${mt}" x2="${X(curve.todayIdx)}" y2="${mt + ph}" stroke="#ff5e3a" stroke-width="1" stroke-dasharray="3 2"/><text x="${X(curve.todayIdx)}" y="${mt + 7}" text-anchor="middle" font-size="8" fill="#ff5e3a">${t('obra.today')}</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="av-curve" xmlns="http://www.w3.org/2000/svg">
    ${grid}${todayLine}
    <polyline points="${path(curve.plan)}" fill="none" stroke="var(--text-muted,#93a6b8)" stroke-width="1.6" stroke-dasharray="4 3"/>
    <polyline points="${path(curve.real)}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="2.2"/>
    ${xlabels}
  </svg>`;
}

// ── Gantt por torre (plan + estado por componente) ───────────────────────────
const statusCol = (pct) => pct >= 100 ? '#22c55e' : pct > 0 ? '#f59e0b' : '#94a3b8';
function ganttSVG(structures) {
  const turbs = (structures || []).filter(s => s.type !== 'hv');
  const rows = turbs.map(t => ({ label: t.label || t.id, sts: enrichStages(t.stages, 'turbine', t.id) }));
  let min = Infinity, max = -Infinity;
  rows.forEach(r => r.sts.forEach(s => { min = Math.min(min, Date.parse(s.plannedStart)); max = Math.max(max, Date.parse(s.plannedEnd)); }));
  if (!isFinite(min) || !rows.length) return `<div class="av-mut">${t('obra.noGantt')}</div>`;
  const today = Date.now();
  const labW = 44, W = 280, rh = 12, gap = 2, headH = 16, padR = 6, trackW = W - labW - padR;
  const X = (ms) => labW + (ms - min) / (max - min || 1) * trackW;
  const H = headH + rows.length * (rh + gap) + 4;
  let grid = '';
  const d0 = new Date(min); d0.setDate(1);
  for (let d = new Date(d0); d.getTime() <= max; d.setMonth(d.getMonth() + 1)) {
    const x = X(d.getTime());
    grid += `<line x1="${x.toFixed(1)}" y1="${headH}" x2="${x.toFixed(1)}" y2="${H}" stroke="var(--border,#28384a)" stroke-width="0.4"/>`;
    grid += `<text x="${(x + 1).toFixed(1)}" y="10" font-size="7" fill="var(--text-muted,#93a6b8)">${monKey(d.getTime())}</text>`;
  }
  const tX = X(Math.min(Math.max(today, min), max));
  const todayLine = `<line x1="${tX.toFixed(1)}" y1="${headH - 3}" x2="${tX.toFixed(1)}" y2="${H}" stroke="#ff5e3a" stroke-width="1" stroke-dasharray="3 2"/><text x="${(tX + 1).toFixed(1)}" y="${headH - 4}" font-size="7" fill="#ff5e3a">${t('obra.today')}</text>`;
  let body = '';
  rows.forEach((r, ri) => {
    const y = headH + ri * (rh + gap);
    body += `<text x="2" y="${(y + rh - 2.5).toFixed(1)}" font-size="7.5" fill="var(--text,#e6eef6)">${r.label}</text>`;
    r.sts.forEach(s => {
      const x1 = X(Date.parse(s.plannedStart)), x2 = X(Date.parse(s.plannedEnd)), w = Math.max(1.6, x2 - x1);
      body += `<rect x="${x1.toFixed(1)}" y="${(y + 1).toFixed(1)}" width="${w.toFixed(1)}" height="${rh - 2}" rx="1.4" fill="${statusCol(s.pct)}" opacity="${s.pct > 0 ? 0.95 : 0.3}"/>`;
    });
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;aspect-ratio:${W}/${H};display:block;min-width:280px" xmlns="http://www.w3.org/2000/svg">${grid}${todayLine}${body}</svg>`;
}

// Editor de partidas de la torre seleccionada (se muestra arriba del dashboard).
function towerEditor(selected) {
  if (!selected || selected.type !== 'turbine') return '';
  const sts = enrichStages(selected.stages, 'turbine', selected.id); selected.stages = sts;
  const built = sts.reduce((a, s) => a + (s.pct || 0), 0) / (sts.length * 100);
  const rows = sts.map((s, i) => `
    <div class="avt-row">
      <span class="avt-nm">${s.label || s.name}</span>
      <input type="number" class="avt-pp" data-i="${i}" min="0" max="100" step="5" value="${s.pct || 0}" title="${t('obra.ppTip')}">
      <span class="avt-u">%</span>
      <span class="avt-bar"><i class="${statusCol2(s.pct)}" style="width:${s.pct || 0}%"></i></span>
    </div>`).join('');
  return `<div class="avt-card">
    <div class="avt-h">${selected.label} · ${t('obra.progress')} <b>${Math.round(built * 100)}%</b></div>
    <div class="avt-rows">${rows}</div>
    <div class="av-mut" style="margin-top:4px">${t('obra.tweHint')}</div>
  </div>`;
}
const statusCol2 = (pct) => pct >= 100 ? 'done' : pct > 0 ? 'wip' : 'pend';

// ── Gemelo de construcción (R-31): f₁ predicha vs medida por etapa ────────────
const f1Full = () => (typeof window !== 'undefined' && window.shmTwin?.turbine) || 0.283;
const fmtHz = (f) => f >= 1 ? f.toFixed(2) : f.toFixed(3);

// Gráfico log-y: curva predicha (línea), puntos medidos y banda soft-stiff.
function ctwinSVG(pred, meas, win) {
  const W = 280, Hc = 150, ml = 30, mb = 26, mt = 8, mr = 8, pw = W - ml - mr, ph = Hc - mt - mb;
  const fmin = Math.min(win.lo, ...pred.map(p => p.f1)) * 0.8;
  const fmax = Math.max(win.hi, pred[0].f1) * 1.15;
  const lg = Math.log10, L0 = lg(fmin), L1 = lg(fmax);
  const X = (i) => ml + (i / (pred.length - 1)) * pw;
  const Y = (f) => mt + (1 - (lg(Math.max(f, fmin)) - L0) / (L1 - L0)) * ph;
  const band = `<rect x="${ml}" y="${Y(win.hi).toFixed(1)}" width="${pw}" height="${(Y(win.lo) - Y(win.hi)).toFixed(1)}" fill="#22c55e" opacity="0.12"/>
    <line x1="${ml}" y1="${Y(win.lo).toFixed(1)}" x2="${W - mr}" y2="${Y(win.lo).toFixed(1)}" stroke="#22c55e" stroke-width="0.6" stroke-dasharray="3 3"/>
    <line x1="${ml}" y1="${Y(win.hi).toFixed(1)}" x2="${W - mr}" y2="${Y(win.hi).toFixed(1)}" stroke="#22c55e" stroke-width="0.6" stroke-dasharray="3 3"/>
    <text x="${W - mr}" y="${(Y(win.hi) - 2).toFixed(1)}" text-anchor="end" font-size="7" fill="#22c55e">soft-stiff</text>`;
  const ticks = [0.2, 0.5, 1, 2, 5].filter(v => v >= fmin && v <= fmax).map(v =>
    `<text x="${ml - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" font-size="7" fill="var(--text-muted,#93a6b8)">${v}</text>`).join('');
  const predLine = `<polyline points="${pred.map((p, i) => `${X(i).toFixed(1)},${Y(p.f1).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--text-muted,#93a6b8)" stroke-width="1.6" stroke-dasharray="4 3"/>`;
  const predDots = pred.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.f1).toFixed(1)}" r="1.8" fill="var(--text-muted,#93a6b8)"/>`).join('');
  const measLine = meas.length > 1 ? `<polyline points="${meas.map((p, i) => `${X(i).toFixed(1)},${Y(p.f1).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="2"/>` : '';
  const measDots = meas.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.f1).toFixed(1)}" r="3" fill="${p.below ? '#ef4444' : '#22c55e'}" stroke="#0b1018" stroke-width="0.8"/>`).join('');
  const xlabels = pred.map((p, i) => `<text x="${X(i).toFixed(1)}" y="${Hc - 14}" text-anchor="middle" font-size="6.5" fill="var(--text-muted,#93a6b8)" transform="rotate(20 ${X(i).toFixed(1)} ${Hc - 14})">${p.label}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${Hc}" class="ct-svg" xmlns="http://www.w3.org/2000/svg">${band}${ticks}${predLine}${predDots}${measLine}${measDots}${xlabels}<text x="2" y="11" font-size="7" fill="var(--text-muted,#93a6b8)">f₁ (Hz)</text></svg>`;
}

function constructionTwinCard(selected) {
  if (!selected || selected.type !== 'turbine') return '';
  const f1 = f1Full(), win = CTwin.softStiffWindow(14);
  const { points: pred } = CTwin.predictedCurve(f1);
  const m = CTwin.measuredCurve(f1, selected.stages, selected.id);
  const cur = m.points[m.points.length - 1];
  const bandOk = CTwin.inBand(f1, win);
  const verdict = !cur ? { c: 'mut', t: t('ct.noMeas') }
    : cur.below ? { c: 'bad', t: t('ct.below', cur.label) }
    : { c: 'ok', t: t('ct.inbandT', cur.label) };
  const baseline = m.reached >= 6 ? t('ct.baselineOk', fmtHz(f1)) : t('ct.baselinePending');
  return `<div class="ct-card">
    <div class="ct-h">🛰️ ${t('ct.title')} <span class="ct-sub">${t('ct.sub')}</span></div>
    ${ctwinSVG(pred, m.points, win)}
    <div class="ct-leg"><span><i class="dash"></i>${t('ct.legPred')}</span><span><i class="dot ok"></i>${t('ct.legInband')}</span><span><i class="dot bad"></i>${t('ct.legBelow')}</span><span><i class="band"></i>${t('ct.legBand')}</span></div>
    <div class="ct-verdict ${verdict.c}">${verdict.t}</div>
    <table class="ct-kv">
      <tr><td>${t('ct.kvFull')}</td><td><b>${fmtHz(f1)} Hz</b></td></tr>
      <tr><td>${t('ct.kvWin', win.rpm)}</td><td>${fmtHz(win.lo)}–${fmtHz(win.hi)} Hz · ${bandOk ? `<b class="ok">${t('ct.inbandY')}</b>` : `<b class="bad">${t('ct.inbandN')}</b>`}</td></tr>
      <tr><td>1P · 3P</td><td>${fmtHz(win.p1)} · ${fmtHz(win.p3)} Hz</td></tr>
      <tr><td>${t('ct.kvBaseline')}</td><td>${baseline}</td></tr>
    </table>
    <button id="ct-cert" class="av-btn" type="button">${t('ct.cert')}</button>
  </div>`;
}

export function commissioningReport(selected) {
  const f1 = f1Full(), win = CTwin.softStiffWindow(14);
  const { points: pred } = CTwin.predictedCurve(f1);
  const m = CTwin.measuredCurve(f1, selected.stages, selected.id);
  const bandOk = CTwin.inBand(f1, win);
  const operational = m.reached >= 6;
  const anyBelow = m.points.some(p => p.below);
  const verdict = !operational ? { t: t('crep.vMounting'), c: '#d97706' }
    : (bandOk && !anyBelow) ? { t: t('crep.vApt'), c: '#16a34a' }
    : { t: t('crep.vObs'), c: '#dc2626' };
  const rows = pred.map((p, i) => { const me = m.points[i]; return `<tr><td>${p.label}</td><td style="text-align:right">${fmtHz(p.f1)}</td><td style="text-align:right">${me ? fmtHz(me.f1) : '—'}</td><td style="text-align:right;color:${me && me.below ? '#b91c1c' : '#15803d'}">${me ? (me.below ? t('crep.below') : t('crep.okSt')) : '—'}</td></tr>`; }).join('');
  const lc = getLang() === 'en' ? 'en-GB' : 'es-CL';
  const html = `<!doctype html><html lang="${getLang()}"><meta charset="utf-8"><title>${t('crep.title')} — ${selected.label}</title>
    <style>body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1b2533}.wrap{max-width:780px;margin:0 auto;padding:0 32px 40px}
    .hero{background:linear-gradient(120deg,#0e7490,#155e75);color:#fff;padding:24px 32px;margin-bottom:20px}.hero h1{margin:4px 0;font-size:20px}
    h2{font-size:15px;border-bottom:2px solid #cbd5e1;padding-bottom:5px;margin:22px 0 10px}.mut{color:#64748b;font-size:12px}
    table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #cbd5e1;padding:6px 9px;text-align:left}th{background:#f1f5f9}
    .verd{display:inline-block;font-weight:800;padding:8px 16px;border-radius:10px;color:#fff;background:${verdict.c}}</style>
    <div class="hero"><div class="mut" style="color:#cfe9f1;letter-spacing:2px;text-transform:uppercase">${t('crep.kicker')}</div>
      <h1>${t('crep.title')} — ${selected.label}</h1><div style="opacity:.9;font-size:13px">${t('rep.park')} · ${new Date().toLocaleDateString(lc)}</div></div>
    <div class="wrap">
      <h2>${t('crep.hVerdict')}</h2><p><span class="verd">${verdict.t}</span></p>
      <h2>${t('crep.hF1')}</h2>
      <table><tr><td>${t('crep.f1Full')}</td><td><b>${fmtHz(f1)} Hz</b></td></tr>
        <tr><td>${t('ct.kvWin', win.rpm)}</td><td>${fmtHz(win.lo)}–${fmtHz(win.hi)} Hz · ${bandOk ? t('crep.inband') : t('crep.out')}</td></tr>
        <tr><td>1P / 3P</td><td>${fmtHz(win.p1)} / ${fmtHz(win.p3)} Hz</td></tr>
        <tr><td>${t('crep.baseline')}</td><td>${operational ? t('crep.captured', fmtHz(f1)) : t('crep.pending')}</td></tr></table>
      <h2>${t('crep.hStage')}</h2>
      <table><thead><tr><th>${t('crep.thStage')}</th><th style="text-align:right">${t('crep.thPred')}</th><th style="text-align:right">${t('crep.thMeas')}</th><th style="text-align:right">${t('crep.thState')}</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="mut" style="margin-top:18px">${t('crep.foot')}</p>
    </div></html>`;
  const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); }
}

// Render del dashboard en un host del panel derecho. `selected` (opcional) =
// estructura enfocada → se antepone su editor de partidas. `apply(struct)` aplica
// los cambios (avance 3D + persistencia) y se vuelve a renderizar.
export function renderAvance(host, structures, selected, apply) {
  const d = computeParkAvance(structures);
  const behind = d.planPct - d.realPct;   // + = el parque va atrasado
  const verdict = behind > 0.05 ? { c: 'bad', t: t('obra.behind', Math.round(behind * 100)) }
    : behind < -0.05 ? { c: 'ok', t: t('obra.ahead', Math.round(-behind * 100)) }
    : { c: 'ok', t: t('obra.online') };
  const compBars = d.perComp.map(p => `
    <div class="av-comp"><span class="av-comp-l">${p.label}</span>
      <span class="av-comp-bar"><i style="width:${Math.round(p.pct * 100)}%"></i></span>
      <span class="av-comp-p">${fmtPct(p.pct)}</span></div>`).join('');
  const lateRows = d.late.length ? d.late.map(l => `
    <div class="av-late"><span class="av-late-n">${l.label}</span>
      <span class="av-late-v">${t('obra.wReal')} ${fmtPct(l.real)} · ${t('obra.wPlan')} ${fmtPct(l.plan)} <b class="av-behind">−${Math.round(l.behind * 100)} pts</b></span></div>`).join('')
    : `<div class="av-mut">${t('obra.noLate')}</div>`;

  host.innerHTML = `
    ${towerEditor(selected)}
    ${constructionTwinCard(selected)}
    <div class="av-hdr">${t('obra.hdr')}</div>
    <div class="av-banner ${verdict.c}">${verdict.c === 'ok' ? '✓' : '✗'} ${verdict.t}</div>
    <div class="av-kpis">
      <div class="av-kpi"><div class="k">${t('obra.kReal')}</div><div class="v">${fmtPct(d.realPct)}</div></div>
      <div class="av-kpi"><div class="k">${t('obra.kPlan')}</div><div class="v">${fmtPct(d.planPct)}</div></div>
      <div class="av-kpi"><div class="k">${t('obra.kSlip')}</div><div class="v ${d.slipDays > 0 ? 'late' : ''}">${d.slipDays > 0 ? '+' : ''}${d.slipDays} d</div></div>
      <div class="av-kpi"><div class="k">${t('obra.kOp')}</div><div class="v">${d.nOp}/${d.nTurb}</div></div>
    </div>
    <div class="av-sub">${t('obra.curveS')}</div>
    ${curveSVG(d.curve)}
    <div class="av-leg"><span><i class="dash"></i>${t('obra.legPlan')}</span><span><i class="solid"></i>${t('obra.legReal')}</span><span><i class="today"></i>${t('obra.legToday')}</span></div>
    <div class="av-sub">${t('obra.byComp')}</div>
    <div class="av-comps">${compBars}</div>
    <div class="av-sub">${t('obra.lateH')} <span class="av-mut">${t('obra.lateHint')}</span></div>
    <div class="av-lates">${lateRows}</div>
    <div class="av-sub">${t('obra.ganttH')} <span class="av-mut">${t('obra.ganttHint')}</span></div>
    <div class="av-gantt">${ganttSVG(structures)}</div>
    <div class="av-leg"><span><i class="g-done"></i>${t('obra.gDone')}</span><span><i class="g-wip"></i>${t('obra.gWip')}</span><span><i class="g-pend"></i>${t('obra.gPend')}</span><span><i class="today"></i>${t('obra.legToday')}</span></div>
    <button id="av-report" class="av-btn" type="button">${t('obra.dpr')}</button>`;
  host.querySelector('#av-report')?.addEventListener('click', () => avanceReport(structures));
  host.querySelector('#ct-cert')?.addEventListener('click', () => commissioningReport(selected));
  // Editor de partidas de la torre seleccionada
  if (selected && selected.type === 'turbine') {
    host.querySelectorAll('.avt-pp').forEach(inp => inp.addEventListener('change', () => {
      const i = +inp.dataset.i; selected.stages[i].pct = Math.max(0, Math.min(100, +inp.value || 0));
      const s = selected.stages[i];
      if (s.pct >= 100 && !s.actualEnd) s.actualEnd = new Date().toISOString().slice(0, 10);
      apply?.(selected);
      renderAvance(host, structures, selected, apply);   // re-render (3D + indicadores actualizados)
    }));
  }
}

// ── Informe de avance imprimible (DPR resumido) ──────────────────────────────
export function avanceReport(structures) {
  const d = computeParkAvance(structures);
  const comps = d.perComp.map(p => `<tr><td>${p.label}</td><td style="text-align:right">${fmtPct(p.pct)}</td></tr>`).join('');
  const late = d.late.length ? d.late.map(l => `<tr><td>${l.label}</td><td style="text-align:right">${fmtPct(l.real)}</td><td style="text-align:right">${fmtPct(l.plan)}</td><td style="text-align:right;color:#b91c1c">−${Math.round(l.behind * 100)} pts</td></tr>`).join('') : `<tr><td colspan="4" style="color:#15803d">${t('arep.noLate')}</td></tr>`;
  const state = Math.abs(d.planPct - d.realPct) < 0.05 ? t('arep.online') : (d.planPct > d.realPct ? t('arep.behind', Math.round((d.planPct - d.realPct) * 100)) : t('arep.ahead', Math.round((d.realPct - d.planPct) * 100)));
  const lc = getLang() === 'en' ? 'en-GB' : 'es-CL';
  const html = `<!doctype html><html lang="${getLang()}"><meta charset="utf-8"><title>${t('arep.titleShort')} — ${t('rep.park')}</title>
    <style>body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1b2533}.wrap{max-width:820px;margin:0 auto;padding:0 32px 40px}
    .hero{background:linear-gradient(120deg,#0e7490,#155e75);color:#fff;padding:24px 32px;margin-bottom:22px}.hero h1{margin:4px 0;font-size:22px}
    h2{font-size:15px;border-bottom:2px solid #cbd5e1;padding-bottom:5px;margin:26px 0 10px}.mut{color:#64748b;font-size:12px}
    .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}.kpi{background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:12px}
    .kpi .v{font-size:23px;font-weight:800}.kpi .k{font-size:11px;color:#64748b;text-transform:uppercase}
    table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}th,td{border:1px solid #cbd5e1;padding:6px 9px;text-align:left}th{background:#f1f5f9}</style>
    <div class="hero"><div class="mut" style="color:#cfe9f1;letter-spacing:2px;text-transform:uppercase">${t('arep.kicker')}</div>
      <h1>${t('arep.title')} — ${t('rep.park')}</h1><div style="opacity:.9;font-size:13px">${t('rep.gen')} ${new Date().toLocaleString(lc)}</div></div>
    <div class="wrap">
      <h2>${t('arep.hSummary')}</h2>
      <div class="kpis">
        <div class="kpi"><div class="v">${fmtPct(d.realPct)}</div><div class="k">${t('arep.kReal')}</div></div>
        <div class="kpi"><div class="v">${fmtPct(d.planPct)}</div><div class="k">${t('arep.kPlan')}</div></div>
        <div class="kpi"><div class="v">${d.slipDays > 0 ? '+' : ''}${d.slipDays} d</div><div class="k">${t('arep.kSlip')}</div></div>
        <div class="kpi"><div class="v">${d.nOp}/${d.nTurb}</div><div class="k">${t('arep.kOp')}</div></div>
      </div>
      <p class="mut">${t('arep.statusLine', state, d.nOp, d.nWip, d.nFound)}</p>
      <h2>${t('arep.hByComp')}</h2>
      <table><thead><tr><th>${t('arep.thComp')}</th><th style="text-align:right">${t('arep.thPct')}</th></tr></thead><tbody>${comps}</tbody></table>
      <h2>${t('arep.hLate')}</h2>
      <table><thead><tr><th>${t('arep.thTower')}</th><th style="text-align:right">${t('arep.thReal')}</th><th style="text-align:right">${t('arep.thPlan')}</th><th style="text-align:right">${t('arep.thGap')}</th></tr></thead><tbody>${late}</tbody></table>
      <p class="mut" style="margin-top:18px">${t('arep.foot')}</p>
    </div></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}
