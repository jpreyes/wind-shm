// ─────────────────────────────────────────────────────────────────────────────
// calidad.js — Frente 5 · pestaña «Calidad» (client-side, fases 5.4 + 5.6).
//
// Puente de UI entre el motor de datos de calidad (lib + tools, Node+navegador)
// y ReWind:
//  · IMPORTA un Excel de protocolos (plantilla ReWind o formato de contratista,
//    autodetectado) en el navegador y lo guarda.
//  · CREA de cero sin Excel (dataset vacío) y EDITA/BORRA/RENOMBRA protocolos.
//  · Muestra un dashboard de calidad (KPIs · por área · por estructura ·
//    pendientes · ensayos) y una vista de gestión (formulario + tabla).
//  · EXPORTA a Excel — si el `_raw` original sigue intacto usa la ruta lossless
//    (round-trip F5.2); si los datos se crearon/editaron, serializa el modelo.
//
// El núcleo (reader/writer/derived) se trata como librería compartida (imports
// planos, sin ?v=, igual que numeric.js) para poder testearlo en Node; este
// módulo es la capa de navegador y sí se versiona.
// ─────────────────────────────────────────────────────────────────────────────
import { normEstado, wtgToId, diasHabilesSacyr } from '../../tools/sacyr_reader.mjs';
import { writeSacyrAuto } from '../../tools/sacyr_writer.mjs';
import { readQuality, writeTemplate, blankTemplate } from '../../tools/rewind_template.mjs';
import { computeDerived } from '../../tools/sacyr_derived.mjs';
import { defaultWbs, wbsProgress, partidaForProtocol } from '../../tools/wbs.js';
import { readXlsx } from '../../lib/xlsx_lite.mjs';
import { analyzeWorkbook, proposeMapping, distinctValues, readByProfile, guessCanon, BUILTIN_PROFILES, FIELDS as QP_FIELDS, CANON_STATES } from '../../tools/quality_profile.mjs';
import { FRAMEWORK, STATUS_NORMS, ENSAYO_NORMS, normLabel, normForEnsayo } from '../../tools/norms_catalog.mjs';
import { backendActive, pushQuality, pullQuality, pushWbs, pushProfile, deleteProtocoloRemote, debouncedPush } from './backend_sync.js?v=307';
import { t } from './i18n.js?v=307';

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

function persist(data, opts = {}) {
  derivedCache = null;
  try { localStorage.setItem(STORE, JSON.stringify(data)); }
  catch {
    // Sin cupo para _raw: guardar versión ligera (dashboard sí, export necesita re-importar).
    try { const { _raw, ...lite } = data; localStorage.setItem(STORE, JSON.stringify({ ...lite, _rawOmitido: true })); }
    catch { console.warn('[calidad] no se pudo persistir en localStorage'); }
  }
  // Avisa a la UI (lista/árbol) que cambió qué estructuras tienen datos de calidad.
  try { window.dispatchEvent(new CustomEvent('calidad-changed')); } catch { /* */ }
  // Backend (Supabase/mock) como fuente de verdad: empuja debounced (salvo que el
  // dato VENGA del backend — opts.remote:false — para no re-empujar en el pull).
  if (opts.remote !== false && backendActive()) debouncedPush('quality', () => pushQuality(data, getOverrides()));
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

// ── WBS de obra (partidas / hitos) — config editable en el HUD (fase B) ───────
// { wbs: { turbine:[{id,nombre,geom,peso,match[]}], hv:[…] }, overrides:{protoId:partidaId} }
const WBS_STORE = 'rewind.wbs.v1';
function loadWbsCfg() { try { return JSON.parse(localStorage.getItem(WBS_STORE)) || {}; } catch { return {}; } }
function saveWbsCfg(c) { try { localStorage.setItem(WBS_STORE, JSON.stringify(c)); } catch (e) { console.warn('[wbs] no se pudo persistir', e); } }
export function getWbs(type = 'turbine') { const c = loadWbsCfg(); return (c.wbs && c.wbs[type]) || defaultWbs(type); }
export function saveWbs(type, list) { const c = loadWbsCfg(); (c.wbs ??= {})[type] = list; saveWbsCfg(c); if (backendActive()) pushWbs(type, list, getOverrides()); }
export function resetWbs(type) { const c = loadWbsCfg(); if (c.wbs) delete c.wbs[type]; saveWbsCfg(c); }
export function getOverrides() { return loadWbsCfg().overrides || {}; }
export function setOverride(protoId, partidaId) {
  const c = loadWbsCfg(); c.overrides ??= {};
  if (partidaId) c.overrides[protoId] = partidaId; else delete c.overrides[protoId];
  saveWbsCfg(c);
}
const wbsUid = () => 'w-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// Geoms (componentes físicos) disponibles por tipo — opciones del select en el HUD.
const GEOMS = {
  turbine: [['fundacion', 'Fundación'], ['fuste', 'Fuste'], ['gondola', 'Góndola'], ['rotor', 'Rotor'], ['cableado', 'Cableado / P.M.']],
  hv: [['fundacion', 'Fundación'], ['celosia', 'Celosía'], ['conductores', 'Conductores'], ['energizacion', 'Energización']],
};

// Áreas/hitos distintos hallados en los datos + a qué partida mapea cada uno hoy
// (para el consolidador de nomenclatura del HUD).
function detectAreas(data, wbs) {
  const seen = new Map();   // literal → {area, total, partida}
  for (const p of (data.protocolos || [])) {
    const key = p.area || '(sin área)';
    if (!seen.has(key)) seen.set(key, { area: p.area || null, total: 0, partida: partidaForProtocol(p, wbs, getOverrides()) });
    seen.get(key).total++;
  }
  return [...seen.values()].sort((a, b) => b.total - a.total);
}

// Avance WBS de UNA estructura (Tnn) — para la ficha de torre / HUD.
export function wbsSummary(id, type = 'turbine') {
  const d = load(); if (!d) return null;
  const ps = d.protocolos.filter((p) => p.estructuraId === id);
  if (!ps.length) return null;
  return wbsProgress(ps, getWbs(type), getOverrides());
}

// ── «Cargar / Actualizar parque» desde la calidad → avance 4D POR PARTIDA ─────
// Cada PARTIDA (hito) se llena con el % de SUS propios protocolos aprobados — no
// un único % por torre. Así, si el Excel solo tiene protocolos de fundación, solo
// la partida Fundación avanza y las demás quedan en 0 (obra sin empezar). Modos:
//   · mode='load'   → REINICIA el parque con la foto del Excel (torres/partidas
//     sin protocolos → 0). Borra el avance anterior.
//   · mode='update' → SÓLO toca las torres que tienen protocolos.
// El nuevo avance se PERSISTE en el parque activo (sobrevive recarga) y deja punto
// de deshacer. Devuelve cuántas estructuras recibieron % del Excel (0 = nada).
export function applyToFleet(mode = 'update', fleet) {
  fleet = fleet || window.shmFleet; if (!fleet) return 0;
  const data = load(); if (!data) return 0;
  const ids = new Set(fleet.structures.map((s) => s.id));
  const overrides = getOverrides();
  // Agrupa los protocolos por estructura viva en la flota.
  const byId = {};
  for (const p of data.protocolos) {
    if (p.estructuraId && ids.has(p.estructuraId)) (byId[p.estructuraId] ??= []).push(p);
  }
  const byStructure = {};
  let applicable = 0;
  for (const [id, ps] of Object.entries(byId)) {
    const type = fleet.getStructure(id)?.type || 'turbine';
    const r = wbsProgress(ps, getWbs(type), overrides);
    byStructure[id] = { pctByGeom: r.pctByGeom, torrePct: r.torrePct };
    applicable++;
  }
  if (!applicable) return 0;
  fleet.applyWbsProgress(byStructure, mode);
  // Persistir el nuevo avance en el parque activo (con snapshot para deshacer).
  try {
    const pm = window.shmParks;
    if (pm) { pm.syncFleetToActive(); pm.save(); pm.render(); }
  } catch (e) { console.warn('[calidad] no se pudo persistir el avance', e); }
  window.shmCalidadAvance = true;
  window.shmSyncAvanceBtns?.();
  return applicable;
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
    try { data = await readQuality(bytes); }   // autodetecta formato (contratista ↔ plantilla)
    catch (e) { alert(t('cal.parseErr') + ' ' + e.message); return; }
    data.meta = { ...(data.meta || {}), importado: new Date().toISOString() };
    current = data; persist(data);
    showApplyChoice();   // 1º elegir cargar/actualizar (antes del panel); luego el panel
  });
}

// ── Asistente de importación CONTRATISTA-AGNÓSTICO (R-41b) ────────────────────
// Importa el Excel de cualquier contratista: elegir hoja → mapear columnas (con
// propuesta por sinónimos) → mapear estados → se guarda como PERFIL reutilizable.
const PROFILES_STORE = 'rewind.profiles.v1';
function loadProfiles() { try { return JSON.parse(localStorage.getItem(PROFILES_STORE)) || []; } catch { return []; } }
function saveProfileCfg(p) {
  const arr = loadProfiles().filter((x) => x.name !== p.name); arr.push(p);
  try { localStorage.setItem(PROFILES_STORE, JSON.stringify(arr)); } catch (e) { console.warn('[profiles]', e); }
  if (backendActive()) pushProfile(p);
}
let wiz = null;   // estado del asistente { wb, sheets, sheet, map, statusMap, elPat, elTpl, name }

export function importWizard() {
  pickXlsx(async (bytes) => {
    let wb;
    try { wb = await readXlsx(bytes); } catch (e) { alert(t('cal.parseErr') + ' ' + e.message); return; }
    const sheets = analyzeWorkbook(wb);
    if (!sheets.length) { alert(t('cal.wiz.empty')); return; }
    const main = [...sheets].sort((a, b) => b.rows - a.rows)[0];
    wiz = { wb, bytes, sheets, sheet: main.name, map: proposeMapping(main.headers), statusMap: {}, elPat: 'WTG\\s*0*(\\d+)', elTpl: 'T$1', name: main.name };
    wizInitStatus();
    wizRender();
  });
}

function wizSheet() { return wiz.sheets.find((s) => s.name === wiz.sheet); }
function wizInitStatus() {
  wiz.statusMap = {}; const col = wiz.map.estado; if (!col) return;
  const meta = wizSheet();
  for (const v of distinctValues(wiz.wb.sheet(wiz.sheet), meta.dataRow, col)) wiz.statusMap[v] = guessCanon(v);
}

function wizRender() {
  document.getElementById('cal-wiz-ov')?.remove();
  const ov = document.createElement('div'); ov.id = 'cal-wiz-ov'; ov.className = 'mb-about cal-ov';
  const meta = wizSheet(); const hdrs = meta.headers;
  const colOpt = (sel) => `<option value="">—</option>` + hdrs.map((h) => `<option value="${esc(h.col)}"${h.col === sel ? ' selected' : ''}>${esc(h.label)} (${h.col})</option>`).join('');
  const fieldRows = QP_FIELDS.map((f) => `<tr><td>${esc(f.label)}${f.req ? ' <span class="wiz-req">*</span>' : ''}</td>
    <td><select class="wiz-in" data-wizcol="${f.key}">${colOpt(wiz.map[f.key])}</select></td></tr>`).join('');

  const estCol = wiz.map.estado;
  let statusRows = '';
  if (estCol) {
    const vals = distinctValues(wiz.wb.sheet(wiz.sheet), meta.dataRow, estCol);
    statusRows = vals.map((v) => `<tr><td>${esc(v)}</td><td><select class="wiz-in" data-wizstatus="${esc(v)}">${CANON_STATES.map((c) => `<option value="${c}"${wiz.statusMap[v] === c ? ' selected' : ''}>${t('est.' + c)}</option>`).join('')}</select></td></tr>`).join('');
  }
  const profiles = loadProfiles();
  const biOpts = BUILTIN_PROFILES.map((p, i) => `<option value="b${i}">${esc(p.name)} — built-in</option>`).join('');
  const cuOpts = profiles.map((p, i) => `<option value="c${i}">${esc(p.name)}</option>`).join('');
  const profileSel = `<label class="wiz-fl"><span>${t('cal.wiz.savedProfile')}</span><select class="wiz-loadprofile"><option value="">${t('cal.wiz.custom')}</option>${biOpts}${cuOpts}</select></label>`;

  ov.innerHTML = `<div class="mb-about-card cal-card cal-wiz-card" role="dialog" aria-label="${esc(t('cal.wiz.title'))}">
    <button class="mb-about-x" type="button" aria-label="✕">✕</button>
    <h2>${t('cal.wiz.title')}</h2>
    <p class="cal-mut">${t('cal.wiz.desc')}</p>
    ${profileSel}
    <label class="wiz-fl"><span>${t('cal.wiz.sheet')}</span><select class="wiz-sheet">${wiz.sheets.map((s) => `<option value="${esc(s.name)}"${s.name === wiz.sheet ? ' selected' : ''}>${esc(s.name)} (${s.rows} ${t('cal.wiz.rows')})</option>`).join('')}</select></label>
    <label class="wiz-fl"><span>${t('cal.wiz.name')}</span><input class="wiz-name" value="${esc(wiz.name)}"></label>

    <h3>${t('cal.wiz.cols')}</h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.wiz.field')}</th><th>${t('cal.wiz.column')}</th></tr></thead><tbody>${fieldRows}</tbody></table>

    <h3>${t('cal.wiz.states')} ${estCol ? '' : `<span class="cal-mut">${t('cal.wiz.pickStatus')}</span>`}</h3>
    ${estCol ? `<table class="cal-tbl"><thead><tr><th>${t('cal.wiz.value')}</th><th>${t('cal.wiz.canon')}</th></tr></thead><tbody>${statusRows}</tbody></table>` : ''}

    <div class="cal-actions" style="margin-top:14px;justify-content:flex-end">
      <button class="cal-btn cal-import-alt wiz-cancel" type="button">${t('cal.f.cancel')}</button>
      <button class="cal-btn wiz-import" type="button">${t('cal.wiz.import')}</button>
    </div>
  </div>`;

  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.mb-about-x') || e.target.closest('.wiz-cancel')) { ov.remove(); wiz = null; return; }
    if (e.target.closest('.wiz-import')) { wizDoImport(); return; }
  });
  ov.addEventListener('change', (e) => {
    if (e.target.matches('.wiz-sheet')) { wiz.sheet = e.target.value; wiz.map = proposeMapping(wizSheet().headers); wizInitStatus(); wizRender(); return; }
    if (e.target.matches('.wiz-loadprofile')) {
      const v = e.target.value; if (!v) return;
      if (v[0] === 'b') { wizImportBuiltin(BUILTIN_PROFILES[+v.slice(1)].builtin); return; }   // perfil built-in (SACYR / plantilla)
      const p = loadProfiles()[+v.slice(1)]; if (p) wizApplyProfile(p);
      return;
    }
    const col = e.target.dataset?.wizcol;
    if (col) { if (e.target.value) wiz.map[col] = e.target.value; else delete wiz.map[col]; if (col === 'estado') wizInitStatus(); wizRender(); return; }
    const st = e.target.dataset?.wizstatus;
    if (st != null) { wiz.statusMap[st] = e.target.value; return; }
  });
  ov.addEventListener('input', (e) => { if (e.target.matches('.wiz-name')) wiz.name = e.target.value; });
  addEventListener('keydown', function escFn(e) { if (e.key === 'Escape') { ov.remove(); wiz = null; removeEventListener('keydown', escFn); } });
  document.body.appendChild(ov);
}

// Importa con un perfil BUILT-IN (SACYR / plantilla ReWind): usa el reader
// especializado (`readQuality` autodetecta), no el mapeo genérico.
async function wizImportBuiltin(kind) {
  let data;
  try { data = await readQuality(wiz.bytes); }
  catch (e) { alert(t('cal.parseErr') + ' ' + e.message); return; }
  if (kind === 'sacyr' && data.meta?.formato !== 'sacyr') { if (!confirm(t('cal.wiz.notSacyr'))) return; }
  data.meta = { ...(data.meta || {}), importado: new Date().toISOString() };
  current = data; persist(data);
  document.getElementById('cal-wiz-ov')?.remove(); wiz = null;
  showApplyChoice();
}

function wizApplyProfile(p) {
  if (p.sheet && wiz.sheets.some((s) => s.name === p.sheet)) wiz.sheet = p.sheet;
  wiz.map = { ...(p.columns || {}) }; wiz.statusMap = { ...(p.statusMap || {}) }; wiz.name = p.name;
  if (p.element) { wiz.elPat = p.element.pattern; wiz.elTpl = p.element.template; }
  wizRender();
}

function wizDoImport() {
  if (!wiz.map.elemento || !wiz.map.estado) { alert(t('cal.wiz.needReq')); return; }
  const meta = wizSheet();
  const profile = {
    name: wiz.name || wiz.sheet, sheet: wiz.sheet, headerRow: meta.headerRow, dataRow: meta.dataRow,
    columns: wiz.map, statusMap: wiz.statusMap, element: { pattern: wiz.elPat, template: wiz.elTpl },
  };
  let data;
  try { data = readByProfile(wiz.wb, profile); } catch (e) { alert(t('cal.parseErr') + ' ' + e.message); return; }
  if (!data.protocolos.length) { alert(t('cal.wiz.noRows')); return; }
  data.meta = { ...data.meta, importado: new Date().toISOString() };
  saveProfileCfg(profile);
  current = data; persist(data);
  document.getElementById('cal-wiz-ov')?.remove(); wiz = null;
  showApplyChoice();
}

// Paso de decisión que aparece al importar (y desde el panel): elegir cómo se
// refleja el Excel en el avance 4D — CARGAR parque (reinicia) o ACTUALIZAR.
export function showApplyChoice() {
  const d = load(); if (!d) { showPanel(); return; }
  document.getElementById('cal-apply-ov')?.remove();
  const ov = document.createElement('div'); ov.id = 'cal-apply-ov'; ov.className = 'mb-about cal-ov';
  const n = d.protocolos?.length || 0;
  const opt = (cls, head, desc) => `<button class="cal-apply-btn ${cls}" type="button">
    <span class="cal-apply-h">${head}</span><span class="cal-apply-d">${esc(desc)}</span></button>`;
  ov.innerHTML = `<div class="mb-about-card cal-card cal-apply" role="dialog" aria-label="${esc(t('cal.apply.title'))}">
    <button class="mb-about-x" type="button" aria-label="✕">✕</button>
    <h2>${t('cal.apply.title')}</h2>
    <p class="cal-mut">${t('cal.apply.sub', n)}</p>
    <div class="cal-apply-opts">
      ${opt('cal-apply-load', t('cal.avanceLoad'), t('cal.avanceLoadTip'))}
      ${opt('cal-apply-update', t('cal.avanceUpdate'), t('cal.avanceUpdateTip'))}
    </div>
    <button class="cal-link cal-apply-skip" type="button">${t('cal.apply.skip')}</button>
  </div>`;
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.mb-about-x') || e.target.closest('.cal-apply-skip')) { close(); showPanel(); return; }
    const isLoad = e.target.closest('.cal-apply-load'), isUpd = e.target.closest('.cal-apply-update');
    if (isLoad || isUpd) {
      const applied = applyToFleet(isLoad ? 'load' : 'update');
      close();
      if (!applied) alert(t('cal.avanceNone'));
      showPanel();
    }
  });
  addEventListener('keydown', function escFn(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', escFn); } });
  document.body.appendChild(ov);
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
  // Archivo importado en su formato original (sin editar) → se devuelve tal cual,
  // sin pérdida (round-trip F5.2). Todo lo demás (editado / creado / plantilla) →
  // se exporta en el formato estándar ReWind.
  const pristineOriginal = data.meta?.formato === 'sacyr' && data._raw && !data._dirty && !data._rawOmitido;
  const bytes = pristineOriginal ? writeSacyrAuto(data) : writeTemplate(data);
  const name = pristineOriginal ? `Log-protocolos-original-${stamp()}.xlsx` : `Calidad-ReWind-${stamp()}.xlsx`;
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
    markDirty(data);
    return id;
  }
  const newId = uid();
  data.protocolos.push({
    id: newId, item: nextItem(data),
    codigoDocumento: fields.codigoDocumento || null, codigoSharepoint: null, hyperlink: null,
    area: fields.area || null, elemento: fields.elemento || null, estructuraId,
    descripcion: fields.descripcion || null, documento: fields.documento || null,
    especialidad: fields.especialidad || null, hitoPago: fields.hitoPago || null,
    fechaDocumento: fields.fechaDocumento || null, correlativo: null, cicloDocumento: null,
    estadoActual: normEstado(estadoActualRaw), estadoActualRaw,
    ciclos: [], _origen: { hoja: 'ReWind', fila: null },
  });
  markDirty(data);
  return newId;
}

export function deleteProtocolo(id) {
  const data = load(); if (!data) return;
  data.protocolos = data.protocolos.filter((p) => p.id !== id);
  if (backendActive()) deleteProtocoloRemote(id);
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

// ── Overlay (dashboard ↔ gestión ↔ WBS) ──────────────────────────────────────
let view = 'dash';        // 'dash' | 'manage' | 'wbs'
let editingId = null;     // id del protocolo en edición (o null = nuevo)
let wbsType = 'turbine';  // tipo de estructura en edición en el HUD de partidas
let wbsDraft = null;      // copia de trabajo del WBS ({turbine:[], hv:[]}) mientras se edita
let presetPartida = null; // partida preseleccionada al crear un protocolo desde el HUD

const normLit = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

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
          <button class="cal-btn cal-import-alt cal-wizard" type="button" title="${esc(t('cal.wiz.btnTip'))}">${t('cal.wiz.btn')}</button>
          <button class="cal-btn cal-import-alt cal-new" type="button">${t('cal.createEmpty')}</button>
          <button class="cal-btn cal-import-alt cal-template" type="button">${t('cal.template')}</button>
        </div>
        <p class="cal-mut" style="margin-top:10px">${t('cal.templateHint')}</p>
      </div>`;
    } else {
      ov.innerHTML = view === 'norms' ? normsHTML() : view === 'wbs' ? wbsHTML(data) : view === 'manage' ? manageHTML(data) : dashboardHTML(data);
    }
  };
  paint();

  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.mb-about-x')) return close();
    if (e.target.closest('.cal-template')) { downloadTemplate(); return; }
    if (e.target.closest('.cal-import')) { close(); importXlsx(); return; }
    if (e.target.closest('.cal-wizard')) { close(); importWizard(); return; }
    if (e.target.closest('.cal-new')) { crearVacio(); return; }        // recrea overlay
    if (e.target.closest('.cal-export')) return exportXlsx();
    if (e.target.closest('.cal-apply4d')) {
      close();   // cerrar el panel para ver el 4D tras elegir
      showApplyChoice();
      return;
    }
    if (e.target.closest('.cal-manage')) { view = 'manage'; editingId = null; paint(); return; }
    if (e.target.closest('.cal-wbs')) { wbsDraft = { turbine: getWbs('turbine'), hv: getWbs('hv') }; view = 'wbs'; paint(); return; }
    if (e.target.closest('.cal-norms')) { view = 'norms'; paint(); return; }
    if (e.target.closest('.cal-back')) { view = 'dash'; paint(); return; }
    // ── HUD de partidas (WBS) ──
    if (e.target.closest('.wbs-add')) { wbsDraft[wbsType].push({ id: wbsUid(), nombre: t('cal.wbs.newPartida'), geom: '', peso: 1, match: [] }); paint(); return; }
    const wDel = e.target.closest('.wbs-del');
    if (wDel) { wbsDraft[wbsType] = wbsDraft[wbsType].filter((p) => p.id !== wDel.dataset.pid); paint(); return; }
    const wUp = e.target.closest('.wbs-up'), wDn = e.target.closest('.wbs-down');
    if (wUp || wDn) {
      const arr = wbsDraft[wbsType]; const pid = (wUp || wDn).dataset.pid;
      const i = arr.findIndex((p) => p.id === pid); const j = wUp ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]]; paint(); }
      return;
    }
    if (e.target.closest('.wbs-save')) {
      saveWbs('turbine', wbsDraft.turbine); saveWbs('hv', wbsDraft.hv);
      const applied = window.shmCalidadAvance ? applyToFleet('update') : 0;   // refleja si el 4D ya estaba cargado
      alert(t('cal.wbs.saved') + (applied ? ' ' + t('cal.wbs.reapplied', applied) : ''));
      view = 'dash'; paint(); window.dispatchEvent(new CustomEvent('calidad-changed'));
      return;
    }
    if (e.target.closest('.wbs-reset')) {
      if (confirm(t('cal.wbs.confirmReset'))) { wbsDraft[wbsType] = defaultWbs(wbsType); paint(); }
      return;
    }
    const addProto = e.target.closest('.wbs-addproto');
    if (addProto) {   // crear un protocolo YA asignado a esta partida (sin Excel)
      saveWbs('turbine', wbsDraft.turbine); saveWbs('hv', wbsDraft.hv);   // persistir el WBS antes de saltar
      presetPartida = addProto.dataset.pid; editingId = null; view = 'manage'; paint(); focusForm(ov);
      return;
    }
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
    const savedId = saveProtocolo(f, editingId || null);
    if (savedId && 'partidaOverride' in f) setOverride(savedId, f.partidaOverride || null);   // asignar a partida (crear o editar)
    editingId = null; presetPartida = null; paint();
  });

  // Edición en vivo del HUD de partidas (inputs/selects) sin re-pintar en cada tecla.
  ov.addEventListener('change', (e) => {
    if (view !== 'wbs' || !wbsDraft) return;
    const wbs = wbsDraft[wbsType];
    // Selector de tipo (torre / AT).
    if (e.target.matches('.wbs-type')) { wbsType = e.target.value; paint(); return; }
    // Campos de una partida (nombre / peso / geom).
    const field = e.target.dataset?.wbs;
    if (field) {
      const p = wbs.find((x) => x.id === e.target.dataset.pid); if (!p) return;
      if (field === 'peso') p.peso = Math.max(0, +e.target.value || 0);
      else p[field] = e.target.value;
      return;   // no re-pintar (no perder foco)
    }
    // Consolidador: mapear un área/hito a una partida (escribe en partida.match).
    if (e.target.dataset?.areamap != null) {
      const area = e.target.dataset.areamap, pid = e.target.value;
      for (const p of wbs) p.match = (p.match || []).filter((m) => normLit(m) !== normLit(area));
      if (pid) { const p = wbs.find((x) => x.id === pid); if (p) (p.match ??= []).push(area); }
      paint();
    }
  });

  addEventListener('keydown', function escFn(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', escFn); } });
  document.body.appendChild(ov);

  // Backend configurado y sin datos locales → traer del backend y re-pintar.
  if (backendActive() && !load()) {
    pullQuality().then((m) => { if (m && !load()) { current = m; persist(m, { remote: false }); paint(); } })
      .catch((e) => console.warn('[calidad] pull backend falló', e));
  }
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

  // Por PARTIDA (hito) — mapeo protocolo→partida sobre el WBS de torre (fase A).
  const wp = wbsProgress(data.protocolos, getWbs('turbine'), getOverrides());
  const partidaRows = Object.values(wp.porPartida).map((b) =>
    `<tr><td>${esc(b.nombre)}</td><td>${b.total}</td><td>${b.aprobado}</td>
     <td><div class="cal-bar"><span style="width:${pct(b.pct)};background:${heat(b.pct)}"></span></div>${pct(b.pct)}</td></tr>`).join('');
  const sinAsignar = wp.sinAsignar.length
    ? `<div class="cal-mut" style="margin-top:6px">${t('cal.wbs.unassigned', wp.sinAsignar.length)}</div>` : '';

  const reimport = data._rawOmitido ? `<div class="cal-warn">${t('cal.rawOmitted')} <button class="cal-link cal-reimport" type="button">${t('cal.reimport')}</button></div>` : '';

  return `<div class="mb-about-card cal-card" role="dialog" aria-label="${esc(t('cal.title'))}">
    <button class="mb-about-x" type="button" aria-label="✕">✕</button>
    <div class="cal-head">
      <h2>${t('cal.title')}</h2>
      <div class="cal-actions">
        <button class="cal-btn cal-apply4d ${window.shmCalidadAvance ? 'cal-on' : 'cal-import-alt'}" type="button" title="${esc(t('cal.apply.tip'))}">${t('cal.apply.btn')}</button>
        <button class="cal-btn cal-import-alt cal-wbs" type="button" title="${esc(t('cal.wbs.tip'))}">${t('cal.wbs.btn')}</button>
        <button class="cal-btn cal-import-alt cal-norms" type="button" title="${esc(t('cal.norms.tip'))}">${t('cal.norms.btn')}</button>
        <button class="cal-btn cal-import-alt cal-manage" type="button">${t('cal.manage')}</button>
        <button class="cal-btn cal-export" type="button" title="${esc(t('cal.exportTip'))}">${t('cal.export')}</button>
        <button class="cal-btn cal-import-alt cal-template" type="button" title="${esc(t('cal.templateHint'))}">${t('cal.template')}</button>
        <button class="cal-btn cal-import-alt cal-import" type="button">${t('cal.reimportFile')}</button>
        <button class="cal-btn cal-import-alt cal-wizard" type="button" title="${esc(t('cal.wiz.btnTip'))}">${t('cal.wiz.btn')}</button>
      </div>
    </div>
    <div class="cal-mut">${esc(data.meta?.fuente || 'ReWind')} · ${t('cal.importedAt')} ${esc(imp)}</div>
    ${reimport}
    <div class="cal-kpis">${kpis}</div>

    <h3>${t('cal.wbs.byPartida')} <span class="cal-mut">${t('cal.wbs.hint')}</span></h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.wbs.partida')}</th><th>${t('cal.col.total')}</th><th>${t('cal.col.approved')}</th><th>${t('cal.col.progress')}</th></tr></thead><tbody>${partidaRows}</tbody></table>
    ${sinAsignar}

    <h3>${t('cal.byArea')}</h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.col.area')}</th><th>${t('cal.col.total')}</th><th>${t('cal.col.approved')}</th><th>${t('cal.col.comments')}</th><th>${t('cal.col.progress')}</th></tr></thead><tbody>${areaRows}</tbody></table>

    <h3>${t('cal.byStructure')} <span class="cal-mut">(${t('cal.approvedShort')})</span></h3>
    <div class="cal-chips">${chips || '<div class="cal-mut">—</div>'}</div>

    <h3>${t('cal.pending')} <span class="cal-mut">(${d.pendientes.length})</span></h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.col.struct')}</th><th>${t('cal.col.area')}</th><th>${t('cal.col.doc')}</th><th>${t('cal.col.state')}</th></tr></thead><tbody>${pend || `<tr><td colspan="4" class="cal-mut">${t('cal.none')}</td></tr>`}</tbody></table>
    ${pendMore}

    <h3>${t('cal.ensayos')} <span class="cal-mut">(${d.ensayosHormigon.total})</span></h3>
    <div class="cal-ensayos">${ensayos || '<div class="cal-mut">—</div>'}</div>
    <div class="cal-mut" style="margin-top:6px">${t('cal.norms.perEnsayo')} <span class="norm-chip">${esc(normLabel(normForEnsayo('compresión hormigón')))}</span> · <button class="cal-link cal-norms" type="button">${t('cal.norms.see')}</button></div>
  </div>`;
}

// ── Referencia «⚖ Normas»: el fundamento normativo del módulo de calidad ──────
function normsHTML() {
  const fw = FRAMEWORK.map((f) => `<tr><td>${esc(f.area)}</td><td><b>${esc(f.norma)}</b></td><td class="cal-mut">${esc(f.detalle)}</td></tr>`).join('');
  const st = STATUS_NORMS.map((s) => `<tr><td><span class="cal-tag ${s.canon === 'aprobado' ? 'cal-tag-ok' : 'cal-tag-warn'}">${esc(t('est.' + s.canon))}</span></td><td>${esc(s.iso)}</td><td class="cal-mut">${esc(s.literals.join(' · '))}</td></tr>`).join('');
  const en = ENSAYO_NORMS.map((e) => `<tr><td>${esc(e.tipo)}</td><td class="cal-mut">${esc(e.param)}</td><td><span class="norm-chip">${esc(normLabel(e))}</span></td></tr>`).join('');
  return `<div class="mb-about-card cal-card" role="dialog" aria-label="${esc(t('cal.norms.title'))}">
    <button class="mb-about-x" type="button" aria-label="✕">✕</button>
    <div class="cal-head">
      <h2>${t('cal.norms.title')}</h2>
      <div class="cal-actions"><button class="cal-btn cal-import-alt cal-back" type="button">${t('cal.back')}</button></div>
    </div>
    <p class="cal-mut">${t('cal.norms.desc')}</p>

    <h3>${t('cal.norms.framework')}</h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.norms.layer')}</th><th>${t('cal.norms.norm')}</th><th>${t('cal.norms.detail')}</th></tr></thead><tbody>${fw}</tbody></table>

    <h3>${t('cal.norms.states')} <span class="cal-mut">(ISO 19650)</span></h3>
    <table class="cal-tbl"><thead><tr><th>ReWind</th><th>ISO 19650</th><th>${t('cal.norms.literals')}</th></tr></thead><tbody>${st}</tbody></table>

    <h3>${t('cal.norms.tests')} <span class="cal-mut">(NCh ≈ ASTM ≈ EN)</span></h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.norms.test')}</th><th>${t('cal.norms.param')}</th><th>${t('cal.norms.standard')}</th></tr></thead><tbody>${en}</tbody></table>
    <div class="cal-mut" style="margin-top:8px">${t('cal.norms.foot')}</div>
  </div>`;
}

// ── HUD de partidas (WBS): crear/editar hitos + consolidar áreas → partida ────
function wbsHTML(data) {
  const wbs = wbsDraft[wbsType];
  const geomOpts = (sel) => GEOMS[wbsType].map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('') + `<option value=""${!sel ? ' selected' : ''}>—</option>`;
  const partOpts = (sel) => `<option value=""${!sel ? ' selected' : ''}>— sin asignar —</option>` + wbs.map((p) => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.nombre)}</option>`).join('');

  // Conteo de protocolos que hoy caen en cada partida (regla + override).
  const countByPid = {};
  for (const p of (data.protocolos || [])) { const pid = partidaForProtocol(p, wbs, getOverrides()); if (pid) countByPid[pid] = (countByPid[pid] || 0) + 1; }

  const rows = wbs.map((p, i) => {
    const chips = (p.match || []).map((m) => `<span class="wbs-chip">${esc(m)}</span>`).join('') || '<span class="cal-mut">—</span>';
    const n = countByPid[p.id] || 0;
    return `<tr data-pid="${p.id}">
      <td class="wbs-ord"><button class="wbs-up" data-pid="${p.id}" title="Subir"${i === 0 ? ' disabled' : ''}>▲</button><button class="wbs-down" data-pid="${p.id}" title="Bajar"${i === wbs.length - 1 ? ' disabled' : ''}>▼</button></td>
      <td><input class="wbs-in" data-wbs="nombre" data-pid="${p.id}" value="${esc(p.nombre)}"></td>
      <td><input class="wbs-in wbs-peso" data-wbs="peso" data-pid="${p.id}" type="number" min="0" step="0.5" value="${p.peso ?? 1}"></td>
      <td><select class="wbs-in" data-wbs="geom" data-pid="${p.id}">${geomOpts(p.geom)}</select></td>
      <td class="wbs-match">${chips}</td>
      <td class="wbs-protos"><span class="wbs-n" title="${esc(t('cal.wbs.protos', n))}">${n}</span><button class="wbs-addproto cal-icon-btn" data-pid="${p.id}" title="${esc(t('cal.wbs.addProto'))}">＋</button></td>
      <td><button class="wbs-del cal-icon-btn" data-pid="${p.id}" title="${esc(t('cal.del'))}">🗑</button></td>
    </tr>`;
  }).join('');

  // Consolidador de nomenclatura: cada área/hito de los datos → una partida.
  const areas = detectAreas(data, wbs);
  const areaMapRows = areas.map((a) => {
    if (!a.area) return `<tr><td class="cal-mut">(sin área)</td><td>${a.total}</td><td class="cal-mut">— (usar override por protocolo)</td></tr>`;
    const cls = a.partida ? '' : ' wbs-unmapped';
    return `<tr class="${cls}"><td>${esc(a.area)}</td><td>${a.total}</td>
      <td><select class="wbs-in" data-areamap="${esc(a.area)}">${partOpts(a.partida)}</select></td></tr>`;
  }).join('');

  return `<div class="mb-about-card cal-card cal-wbs-card" role="dialog" aria-label="${esc(t('cal.wbs.title'))}">
    <button class="mb-about-x" type="button" aria-label="✕">✕</button>
    <div class="cal-head">
      <h2>${t('cal.wbs.title')}</h2>
      <div class="cal-actions">
        <button class="cal-btn cal-import-alt cal-back" type="button">${t('cal.back')}</button>
        <button class="cal-btn cal-import-alt wbs-reset" type="button" title="${esc(t('cal.wbs.confirmReset'))}">${t('cal.wbs.reset')}</button>
        <button class="cal-btn wbs-save" type="button">${t('cal.wbs.save')}</button>
      </div>
    </div>
    <p class="cal-mut">${t('cal.wbs.desc')}</p>
    <label class="wbs-typesel">${t('cal.wbs.type')}
      <select class="wbs-type">
        <option value="turbine"${wbsType === 'turbine' ? ' selected' : ''}>${t('cal.wbs.turbine')}</option>
        <option value="hv"${wbsType === 'hv' ? ' selected' : ''}>${t('cal.wbs.hv')}</option>
      </select>
    </label>

    <h3>${t('cal.wbs.partidas')} <span class="cal-mut">(${wbs.length})</span></h3>
    <table class="cal-tbl wbs-tbl"><thead><tr>
      <th></th><th>${t('cal.wbs.partida')}</th><th>${t('cal.wbs.weight')}</th><th>${t('cal.wbs.geom')}</th><th>${t('cal.wbs.areas')}</th><th>${t('cal.wbs.protosCol')}</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>
    <button class="cal-btn cal-import-alt wbs-add" type="button">${t('cal.wbs.add')}</button>

    <h3>${t('cal.wbs.consolidate')} <span class="cal-mut">${t('cal.wbs.consolidateHint')}</span></h3>
    <table class="cal-tbl"><thead><tr><th>${t('cal.col.area')}</th><th>${t('cal.col.total')}</th><th>${t('cal.wbs.partida')}</th></tr></thead>
      <tbody>${areaMapRows || `<tr><td colspan="3" class="cal-mut">${t('cal.none')}</td></tr>`}</tbody></table>
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
      <label class="cal-fl"><span>${t('cal.wbs.assign')}</span><select name="partidaOverride"><option value="">${editing ? '— auto —' : t('cal.wbs.assignAuto')}</option>${getWbs('turbine').map((wp) => { const sel = editing ? getOverrides()[editing.id] === wp.id : presetPartida === wp.id; return `<option value="${esc(wp.id)}"${sel ? ' selected' : ''}>${esc(wp.nombre)}</option>`; }).join('')}</select></label>
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
