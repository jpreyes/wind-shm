// ─────────────────────────────────────────────────────────────────────────────
// calidad.js — Frente 5 · pestaña «Calidad» (client-side, fases 5.4 + 5.6).
//
// Puente de UI entre el motor de datos SACYR (lib + tools, Node+navegador) y
// ReWind:
//  · IMPORTA el «Log protocolos SACYR.xlsx» en el navegador y lo guarda.
//  · CREA de cero sin Excel (dataset vacío) y EDITA/BORRA/RENOMBRA protocolos.
//  · Muestra un dashboard de calidad (KPIs · por área · por estructura ·
//    pendientes · ensayos) y una vista de gestión (formulario + tabla).
//  · EXPORTA a Excel — vía `writeSacyrAuto`: si el `_raw` sigue intacto usa la
//    ruta lossless (F5.2); si los datos se crearon/editaron, serializa el modelo.
//
// El núcleo (reader/writer/derived) se trata como librería compartida (imports
// planos, sin ?v=, igual que numeric.js) para poder testearlo en Node; este
// módulo es la capa de navegador y sí se versiona.
// ─────────────────────────────────────────────────────────────────────────────
import { normEstado, wtgToId, diasHabilesSacyr } from '../../tools/sacyr_reader.mjs';
import { writeSacyrAuto } from '../../tools/sacyr_writer.mjs';
import { readQuality, writeTemplate, blankTemplate } from '../../tools/rewind_template.mjs';
import { computeDerived } from '../../tools/sacyr_derived.mjs';
import { t } from './i18n.js?v=289';

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
let derivedCache = null;   // computeDerived memoizado; se invalida en cada persist/import

function persist(data) {
  derivedCache = null;
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
function getDerived() { const d = load(); if (!d) return null; return (derivedCache ??= computeDerived(d)); }
export function hasData() { return !!load(); }

// Resumen de calidad de UNA estructura (Tnn) para la ficha de torre / integración
// con Obra. Devuelve null si no hay datos o la estructura no tiene protocolos.
export function structureSummary(id) {
  const d = getDerived(); if (!d) return null;
  const q = d.porEstructura?.[id]; if (!q) return null;
  return { total: q.total, aprobado: q.aprobado, pctAprobado: q.pctAprobado, pendientes: q.total - q.aprobado - q.informativo - q.nulo };
}

// ── Integración con el 4D: «avance real» desde la calidad (opt-in) ────────────
// on=true  → cada torre se «llena» según su % de protocolos aprobados (col P);
// on=false → restaura el avance previo (etapas manuales). Guarda un backup por id.
export function applyToFleet(on, fleet) {
  fleet = fleet || window.shmFleet; if (!fleet) return false;
  if (on) {
    const d = getDerived(); if (!d) return false;
    fleet._calidadBackup = fleet._calidadBackup || {};
    let n = 0;
    for (const st of fleet.structures) {
      const q = d.porEstructura?.[st.id]; if (!q) continue;
      if (!(st.id in fleet._calidadBackup)) fleet._calidadBackup[st.id] = st.built ?? null;
      fleet.setProgress(st.id, q.pctAprobado); n++;
    }
    if (n && !fleet.constructionMode) fleet.setConstructionMode(true);
    window.shmCalidadAvance = n > 0;
    return n > 0;
  }
  const bk = fleet._calidadBackup || {};
  for (const id in bk) if (bk[id] != null) fleet.setProgress(id, bk[id]);
  fleet._calidadBackup = null;
  window.shmCalidadAvance = false;
  return true;
}

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
    try { data = await readQuality(bytes); }   // autodetecta: Log SACYR ↔ plantilla ReWind
    catch (e) { alert(t('cal.parseErr') + ' ' + e.message); return; }
    data.meta = { ...(data.meta || {}), importado: new Date().toISOString() };
    current = data; persist(data);
    alert(t('cal.imported', data.protocolos.length));
    showPanel();
  });
}

// Descarga la plantilla estándar ReWind (vacía) para que el contratista la llene.
export function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([blankTemplate()], { type: XLSX_MIME }));
  const a = document.createElement('a'); a.href = url; a.download = 'Plantilla-calidad-ReWind.xlsx'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function exportXlsx() {
  const data = load();
  if (!data) { alert(t('cal.noData')); return; }
  // SACYR prístino (sin editar) → se devuelve en SU formato, sin pérdida (round-trip F5.2).
  // Todo lo demás (editado / creado / plantilla) → se exporta en el formato estándar ReWind.
  const pristineSacyr = data.meta?.formato === 'sacyr' && data._raw && !data._dirty && !data._rawOmitido;
  const bytes = pristineSacyr ? writeSacyrAuto(data) : writeTemplate(data);
  const name = pristineSacyr ? `Log-protocolos-SACYR-${stamp()}.xlsx` : `Calidad-ReWind-${stamp()}.xlsx`;
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ── Crear / editar sin Excel ──────────────────────────────────────────────────
const DEFAULT_AREAS = ['Fundación', 'Plataforma', 'Vial', 'LAT', 'Subestación Camán', 'Subestación Huichahue'];
const DEFAULT_ESTADOS = ['Sin Comentarios', 'Con comentarios', 'En Revisión', 'Nulo', 'Informativo'];
const DEFAULT_ESPEC = ['Topografía', 'Civil', 'Eléctrico', 'Calidad', 'Registro', 'Informativo'];

function markDirty(data) { data._dirty = true; persist(data); }
function nextItem(data) { return data.protocolos.reduce((m, p) => Math.max(m, +p.item || 0), 0) + 1; }
function uid() { return 'rw-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export function crearVacio() {
  current = {
    meta: { fuente: 'ReWind', importado: new Date().toISOString() },
    protocolos: [], ensayosHormigon: [], resumen: [],
    catalogos: { areasTrabajo: [...DEFAULT_AREAS], estados: [...DEFAULT_ESTADOS], areas: [] },
    _dirty: true,
  };
  persist(current); showPanel();
}

// Crea (id nulo) o actualiza (id existente) un protocolo desde campos de formulario.
export function saveProtocolo(fields, id) {
  const data = load(); if (!data) return;
  const estructuraId = wtgToId(fields.elemento);
  const estadoActualRaw = fields.estadoActualRaw || null;
  if (id) {
    const p = data.protocolos.find((x) => x.id === id); if (!p) return;
    Object.assign(p, {
      codigoDocumento: fields.codigoDocumento || null, area: fields.area || null,
      elemento: fields.elemento || null, estructuraId, descripcion: fields.descripcion || null,
      documento: fields.documento || null, especialidad: fields.especialidad || null,
      hitoPago: fields.hitoPago || null, estadoActualRaw, estadoActual: normEstado(estadoActualRaw),
    });
  } else {
    data.protocolos.push({
      id: uid(), item: nextItem(data),
      codigoDocumento: fields.codigoDocumento || null, codigoSharepoint: null, hyperlink: null,
      area: fields.area || null, elemento: fields.elemento || null, estructuraId,
      descripcion: fields.descripcion || null, documento: fields.documento || null,
      especialidad: fields.especialidad || null, hitoPago: fields.hitoPago || null,
      fechaDocumento: fields.fechaDocumento || null, correlativo: null, cicloDocumento: null,
      estadoActual: normEstado(estadoActualRaw), estadoActualRaw,
      ciclos: [], _origen: { hoja: 'ReWind', fila: null },
    });
  }
  markDirty(data);
}

export function deleteProtocolo(id) {
  const data = load(); if (!data) return;
  data.protocolos = data.protocolos.filter((p) => p.id !== id);
  markDirty(data);
}

// Agrega un ciclo de revisión y sincroniza el estado actual (col P) del protocolo.
export function addCiclo(id, { estadoRaw, fechaEnvio, fechaRetorno, comentarios, tmlEnvio, tmlRetorno }) {
  const data = load(); if (!data) return;
  const p = data.protocolos.find((x) => x.id === id); if (!p) return;
  const dh = (fechaEnvio && fechaRetorno) ? diasHabilesSacyr(new Date(fechaEnvio + 'T00:00:00Z'), new Date(fechaRetorno + 'T00:00:00Z')) : null;
  p.ciclos.push({
    n: p.ciclos.length + 1, tmlEnvio: tmlEnvio || null, fechaEnvio: fechaEnvio || null,
    estado: normEstado(estadoRaw), estadoRaw: estadoRaw || null, tmlRetorno: tmlRetorno || null,
    item: null, fechaRetorno: fechaRetorno || null, comentarios: comentarios || null,
    diasCorridos: null, diasHabiles: dh, diasHabilesCalc: dh,
  });
  p.estadoActualRaw = estadoRaw || null; p.estadoActual = normEstado(estadoRaw);
  p.cicloDocumento = ['1er', '2da', '3ero', '4to', '5to'][p.ciclos.length - 1] || null;
  markDirty(data);
}

// ── Overlay (dashboard ↔ gestión) ────────────────────────────────────────────
let view = 'dash';        // 'dash' | 'manage'
let editingId = null;     // id del protocolo en edición (o null = nuevo)

export function showPanel() {
  document.getElementById('cal-ov')?.remove();
  view = 'dash'; editingId = null;
  const ov = document.createElement('div'); ov.id = 'cal-ov'; ov.className = 'mb-about cal-ov';
  const close = () => ov.remove();

  const paint = () => {
    const data = load();
    if (!data) {
      ov.innerHTML = `<div class="mb-about-card cal-card cal-empty" role="dialog">
        <button class="mb-about-x" type="button" aria-label="✕">✕</button>
        <h2>${t('cal.title')}</h2>
        <p>${t('cal.emptyHint')}</p>
        <div class="cal-actions" style="justify-content:center;margin-top:14px;flex-wrap:wrap">
          <button class="cal-btn cal-import" type="button">${t('cal.import')}</button>
          <button class="cal-btn cal-import-alt cal-new" type="button">${t('cal.createEmpty')}</button>
          <button class="cal-btn cal-import-alt cal-template" type="button">${t('cal.template')}</button>
        </div>
        <p class="cal-mut" style="margin-top:10px">${t('cal.templateHint')}</p>
      </div>`;
    } else {
      ov.innerHTML = view === 'manage' ? manageHTML(data) : dashboardHTML(data);
    }
  };
  paint();

  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.mb-about-x')) return close();
    if (e.target.closest('.cal-template')) { downloadTemplate(); return; }
    if (e.target.closest('.cal-import')) { close(); importXlsx(); return; }
    if (e.target.closest('.cal-new')) { crearVacio(); return; }        // recrea overlay
    if (e.target.closest('.cal-export')) return exportXlsx();
    if (e.target.closest('.cal-avance')) {
      const ok = applyToFleet(!window.shmCalidadAvance);
      if (!ok && !window.shmCalidadAvance) { alert(t('cal.avanceNone')); return; }
      close();   // cerrar el overlay para ver el 4D actualizado
      window.shmSyncAvanceBtns?.();
      return;
    }
    if (e.target.closest('.cal-manage')) { view = 'manage'; editingId = null; paint(); return; }
    if (e.target.closest('.cal-back')) { view = 'dash'; paint(); return; }
    if (e.target.closest('.cal-add')) { editingId = null; view = 'manage'; paint(); focusForm(ov); return; }
    const editBtn = e.target.closest('.cal-edit');
    if (editBtn) { editingId = editBtn.dataset.id; view = 'manage'; paint(); focusForm(ov); return; }
    const delBtn = e.target.closest('.cal-del');
    if (delBtn) { if (confirm(t('cal.confirmDel'))) { deleteProtocolo(delBtn.dataset.id); editingId = null; paint(); } return; }
    if (e.target.closest('.cal-form-cancel')) { editingId = null; paint(); return; }
  });

  ov.addEventListener('submit', (e) => {
    const form = e.target.closest('.cal-form'); if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form).entries());
    saveProtocolo(f, editingId || null);
    editingId = null; paint();
  });

  addEventListener('keydown', function escFn(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', escFn); } });
  document.body.appendChild(ov);
}

function focusForm(ov) { setTimeout(() => ov.querySelector('.cal-form [name="codigoDocumento"]')?.focus(), 30); }

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
        <button class="cal-btn cal-avance ${window.shmCalidadAvance ? 'cal-on' : 'cal-import-alt'}" type="button" title="${esc(t('cal.avanceTip'))}">${window.shmCalidadAvance ? t('cal.avanceOff') : t('cal.avanceOn')}</button>
        <button class="cal-btn cal-import-alt cal-manage" type="button">${t('cal.manage')}</button>
        <button class="cal-btn cal-export" type="button" title="${esc(t('cal.exportTip'))}">${t('cal.export')}</button>
        <button class="cal-btn cal-import-alt cal-template" type="button" title="${esc(t('cal.templateHint'))}">${t('cal.template')}</button>
        <button class="cal-btn cal-import-alt cal-import" type="button">${t('cal.reimportFile')}</button>
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

// ── Vista de gestión: formulario crear/editar + tabla con editar/borrar ──────
function manageHTML(data) {
  const cat = data.catalogos || {};
  const areas = cat.areasTrabajo?.length ? cat.areasTrabajo : DEFAULT_AREAS;
  const estados = cat.estados?.length ? cat.estados : DEFAULT_ESTADOS;
  const editing = editingId ? data.protocolos.find((p) => p.id === editingId) : null;
  const v = (x) => esc(x ?? '');

  const opts = (arr, sel) => arr.map((o) => `<option value="${esc(o)}"${(sel || '') === o ? ' selected' : ''}>${esc(o)}</option>`).join('');
  const field = (name, label, val, extra = '') => `<label class="cal-fl"><span>${esc(label)}</span><input name="${name}" value="${v(val)}" ${extra}></label>`;
  const form = `<form class="cal-form">
    <div class="cal-form-grid">
      ${field('codigoDocumento', t('cal.f.code'), editing?.codigoDocumento, 'placeholder="CL19-…"')}
      ${field('documento', t('cal.f.doc'), editing?.documento)}
      <label class="cal-fl"><span>${t('cal.f.area')}</span><select name="area"><option value=""></option>${opts(areas, editing?.area)}</select></label>
      ${field('elemento', t('cal.f.element'), editing?.elemento, 'placeholder="WTG 05"')}
      <label class="cal-fl"><span>${t('cal.f.spec')}</span><select name="especialidad"><option value=""></option>${opts(DEFAULT_ESPEC, editing?.especialidad)}</select></label>
      ${field('hitoPago', t('cal.f.milestone'), editing?.hitoPago, 'placeholder="1er"')}
      <label class="cal-fl"><span>${t('cal.f.state')}</span><select name="estadoActualRaw"><option value=""></option>${opts(estados, editing?.estadoActualRaw)}</select></label>
      ${field('descripcion', t('cal.f.desc'), editing?.descripcion)}
    </div>
    <div class="cal-form-actions">
      <button class="cal-btn" type="submit">${editing ? t('cal.f.saveEdit') : t('cal.f.create')}</button>
      ${editing ? `<button class="cal-btn cal-import-alt cal-form-cancel" type="button">${t('cal.f.cancel')}</button>` : ''}
    </div>
  </form>`;

  const rows = data.protocolos.map((p) => `<tr>
    <td>${v(p.item)}</td><td>${v(p.codigoDocumento || p.documento)}</td><td>${v(p.area)}</td>
    <td>${v(p.elemento)}</td><td><span class="cal-tag ${p.estadoActual === 'aprobado' ? 'cal-tag-ok' : 'cal-tag-warn'}">${esc(t('est.' + p.estadoActual) || p.estadoActual || '—')}</span></td>
    <td class="cal-row-act"><button class="cal-iconbtn cal-edit" data-id="${p.id}" title="${esc(t('cal.edit'))}" type="button">✎</button>
    <button class="cal-iconbtn cal-del" data-id="${p.id}" title="${esc(t('cal.del'))}" type="button">🗑</button></td></tr>`).join('');

  return `<div class="mb-about-card cal-card" role="dialog" aria-label="${esc(t('cal.mng'))}">
    <button class="mb-about-x" type="button" aria-label="✕">✕</button>
    <div class="cal-head">
      <h2>${t('cal.mng')} <span class="cal-mut">(${data.protocolos.length})</span></h2>
      <div class="cal-actions">
        <button class="cal-btn cal-import-alt cal-back" type="button">${t('cal.back')}</button>
        <button class="cal-btn cal-export" type="button">${t('cal.export')}</button>
      </div>
    </div>
    <h3>${editing ? t('cal.editProto') : t('cal.newProto')}</h3>
    ${form}
    <h3>${t('cal.list')}</h3>
    <table class="cal-tbl cal-mng-tbl"><thead><tr><th>#</th><th>${t('cal.col.doc')}</th><th>${t('cal.col.area')}</th><th>${t('cal.col.struct')}</th><th>${t('cal.col.state')}</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="cal-mut">${t('cal.emptyList')}</td></tr>`}</tbody></table>
  </div>`;
}
