// ─────────────────────────────────────────────────────────────────────────────
// calidad.js — Frente 5 · fase 5.4 · pestaña «Calidad» (client-side).
//
// Puente de UI entre el motor de datos SACYR (lib + tools, Node+navegador) y
// ReWind: importa el «Log protocolos SACYR.xlsx» en el navegador, lo guarda,
// muestra un dashboard de calidad de obra (KPIs · por área · por estructura ·
// pendientes · ensayos) y re-exporta el Excel (round-trip de información, F5.2).
//
// El núcleo (reader/writer/derived) se trata como librería compartida (imports
// planos, sin ?v=, igual que numeric.js) para poder testearlo en Node; este
// módulo es la capa de navegador y sí se versiona.
// ─────────────────────────────────────────────────────────────────────────────
import { readSacyr } from '../../tools/sacyr_reader.mjs';
import { writeSacyrXlsx } from '../../tools/sacyr_writer.mjs';
import { computeDerived } from '../../tools/sacyr_derived.mjs';
import { t } from './i18n.js?v=278';

const STORE = 'rewind.calidad.v1';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let current = null;   // modelo canónico en memoria

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

// Color rojo→ámbar→verde según fracción [0,1] (para heatmap de completitud).
function heat(x) {
  const h = Math.max(0, Math.min(1, x)) * 120;   // 0=rojo, 120=verde
  return `hsl(${h.toFixed(0)} 62% 42%)`;
}

// ── Persistencia (best-effort; el modelo completo puede rondar 2–4 MB) ────────
function persist(data) {
  try { localStorage.setItem(STORE, JSON.stringify(data)); }
  catch {
    // Sin cupo para _raw: guardar versión ligera (dashboard sí, export necesita re-importar).
    try { const { _raw, ...lite } = data; localStorage.setItem(STORE, JSON.stringify({ ...lite, _rawOmitido: true })); }
    catch { console.warn('[calidad] no se pudo persistir en localStorage'); }
  }
}
function load() {
  if (current) return current;
  try { const s = localStorage.getItem(STORE); if (s) current = JSON.parse(s); } catch { }
  return current;
}
export function hasData() { return !!load(); }

// ── Importar / exportar ──────────────────────────────────────────────────────
function pickXlsx(cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.xlsx';
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0]; if (!f) return;
    try { cb(new Uint8Array(await f.arrayBuffer()), f); }
    catch (e) { alert(t('cal.readErr') + ' ' + e.message); }
  });
  inp.click();
}

export function importXlsx() {
  pickXlsx(async (bytes) => {
    let data;
    try { data = await readSacyr(bytes); }
    catch (e) { alert(t('cal.parseErr') + ' ' + e.message); return; }
    data.meta = { ...(data.meta || {}), importado: new Date().toISOString() };
    current = data; persist(data);
    alert(t('cal.imported', data.protocolos.length));
    showPanel();
  });
}

export function exportXlsx() {
  const data = load();
  if (!data) { alert(t('cal.noData')); return; }
  if (data._rawOmitido || !data._raw) { alert(t('cal.exportReimport')); return; }
  const bytes = writeSacyrXlsx(data);
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement('a'); a.href = url; a.download = `Log-protocolos-SACYR-${stamp()}.xlsx`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ── Dashboard (overlay modal) ────────────────────────────────────────────────
export function showPanel() {
  document.getElementById('cal-ov')?.remove();
  const data = load();
  const ov = document.createElement('div'); ov.id = 'cal-ov'; ov.className = 'mb-about cal-ov';

  if (!data) {
    ov.innerHTML = `<div class="mb-about-card cal-card cal-empty" role="dialog">
      <button class="mb-about-x" type="button" aria-label="✕">✕</button>
      <h2>${t('cal.title')}</h2>
      <p>${t('cal.emptyHint')}</p>
      <button class="cal-btn cal-import" type="button">${t('cal.import')}</button>
    </div>`;
  } else {
    ov.innerHTML = dashboardHTML(data);
  }

  const close = () => ov.remove();
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.mb-about-x')) return close();
    if (e.target.closest('.cal-import')) { close(); importXlsx(); }
    if (e.target.closest('.cal-export')) exportXlsx();
    if (e.target.closest('.cal-reimport')) { close(); importXlsx(); }
  });
  addEventListener('keydown', function escFn(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', escFn); } });
  document.body.appendChild(ov);
}

function dashboardHTML(data) {
  const d = computeDerived(data);
  const tot = d.totales;
  const th = d.turnaround;
  const imp = data.meta?.importado ? new Date(data.meta.importado).toLocaleString() : '—';

  // KPIs
  const kpi = (v, label) => `<div class="cal-kpi"><div class="cal-kpi-v">${v}</div><div class="cal-kpi-l">${esc(label)}</div></div>`;
  const kpis = [
    kpi(tot.total, t('cal.k.protocols')),
    kpi(pct(tot.pctAprobado), t('cal.k.approved')),
    kpi(d.pendientes.length, t('cal.k.pending')),
    kpi(th.ciclos, t('cal.k.cycles')),
    kpi(th.diasHabiles.avg ?? '—', t('cal.k.avgDays')),
    kpi(pct(th.pctCiclosConComentarios), t('cal.k.pctComments')),
  ].join('');

  // Por área
  const areaRows = Object.entries(d.porArea).sort((a, b) => b[1].total - a[1].total).map(([a, v]) =>
    `<tr><td>${esc(a)}</td><td>${v.total}</td><td>${v.aprobado}</td><td>${v.conComentarios}</td>
     <td><div class="cal-bar"><span style="width:${pct(v.pctAprobado)};background:${heat(v.pctAprobado)}"></span></div>${pct(v.pctAprobado)}</td></tr>`).join('');

  // Por estructura (heatmap de chips)
  const chips = Object.entries(d.porEstructura).sort((a, b) => a[0].localeCompare(b[0])).map(([id, v]) =>
    `<div class="cal-chip" title="${esc(id)}: ${v.aprobado}/${v.total} ${t('cal.k.approved')}" style="border-color:${heat(v.pctAprobado)}">
       <b>${esc(id)}</b><span style="color:${heat(v.pctAprobado)}">${pct(v.pctAprobado)}</span></div>`).join('');

  // Pendientes (top 12)
  const pend = d.pendientes.slice(0, 12).map(p =>
    `<tr><td>${esc(p.estructuraId || '—')}</td><td>${esc(p.area || '')}</td><td>${esc(p.documento || '')}</td>
     <td><span class="cal-tag cal-tag-warn">${esc(t('est.' + p.estadoActual) || p.estadoActual)}</span></td></tr>`).join('');
  const pendMore = d.pendientes.length > 12 ? `<div class="cal-mut">+${d.pendientes.length - 12} ${t('cal.more')}</div>` : '';

  // Ensayos por grado
  const eg = d.ensayosHormigon.porGrado;
  const egMax = Math.max(1, ...Object.values(eg));
  const ensayos = Object.entries(eg).sort((a, b) => b[1] - a[1]).map(([g, n]) =>
    `<div class="cal-eg"><span class="cal-eg-l">${esc(g)}</span><div class="cal-bar"><span style="width:${(100 * n / egMax).toFixed(0)}%;background:var(--accent)"></span></div><span class="cal-eg-n">${n}</span></div>`).join('');

  const reimport = data._rawOmitido ? `<div class="cal-warn">${t('cal.rawOmitted')} <button class="cal-link cal-reimport" type="button">${t('cal.reimport')}</button></div>` : '';

  return `<div class="mb-about-card cal-card" role="dialog" aria-label="${esc(t('cal.title'))}">
    <button class="mb-about-x" type="button" aria-label="✕">✕</button>
    <div class="cal-head">
      <h2>${t('cal.title')}</h2>
      <div class="cal-actions">
        <button class="cal-btn cal-export" type="button" title="${esc(t('cal.exportTip'))}">${t('cal.export')}</button>
        <button class="cal-btn cal-import" type="button">${t('cal.reimportFile')}</button>
      </div>
    </div>
    <div class="cal-mut">${esc(data.meta?.fuente || 'SACYR')} · ${t('cal.importedAt')} ${esc(imp)}</div>
    ${reimport}
    <div class="cal-kpis">${kpis}</div>

    <h3>${t('cal.byArea')}</h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.col.area')}</th><th>${t('cal.col.total')}</th><th>${t('cal.col.approved')}</th><th>${t('cal.col.comments')}</th><th>${t('cal.col.progress')}</th></tr></thead><tbody>${areaRows}</tbody></table>

    <h3>${t('cal.byStructure')} <span class="cal-mut">(${t('cal.approvedShort')})</span></h3>
    <div class="cal-chips">${chips || '<div class="cal-mut">—</div>'}</div>

    <h3>${t('cal.pending')} <span class="cal-mut">(${d.pendientes.length})</span></h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.col.struct')}</th><th>${t('cal.col.area')}</th><th>${t('cal.col.doc')}</th><th>${t('cal.col.state')}</th></tr></thead><tbody>${pend || `<tr><td colspan="4" class="cal-mut">${t('cal.none')}</td></tr>`}</tbody></table>
    ${pendMore}

    <h3>${t('cal.ensayos')} <span class="cal-mut">(${d.ensayosHormigon.total})</span></h3>
    <div class="cal-ensayos">${ensayos || '<div class="cal-mut">—</div>'}</div>
  </div>`;
}
