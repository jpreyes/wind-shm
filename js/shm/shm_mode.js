// ─────────────────────────────────────────────────────────────────────────────
// shm_mode.js — integra ReWind (parque + monitor SHM) DENTRO del shell de PÓRTICO.
//
// · Monta la flota en el viewport real, agrega botones (Torre, Detener).
// · Lista de estructuras seleccionables en la barra (torres + torres AT).
// · Nameplate (cuadro con el nombre) sobre la vista.
// · Panel específico al seleccionar: datos, sensores (estado), daño, altura,
//   inspecciones y señal temporal EN VIVO desde un Web Worker (DataSource).
// Recortes (modelado) los hace shm.css ocultando, no borrando.
// ─────────────────────────────────────────────────────────────────────────────
import { FleetView } from './fleet_view.js?v=201';
import { DataSource } from './data_source.js?v=201';
import { computeTwin } from './digital_twin.js?v=201';

const F1_BASE = { turbine: 0.283, hv: 1.6 };
const REWIND_VER = 'v201';   // versión visible del build (subir junto al cache-bust)
const LAYOUT_KEY = 'rewind-layout';
const loadLayout = () => { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)); } catch { return null; } };
const FS = 62.5;   // frecuencia de muestreo de la señal (Hz), igual que shm_worker.js
// Clasificador ML de daño (0..4)
const CLS = ['Sin daño', 'Leve', 'Moderado', 'Alto', 'Muy alto'];
const CLS_COL = ['var(--success)', '#9bbb3a', 'var(--warn)', '#fb7185', 'var(--danger)'];
const CLS_HEX = ['#4ade80', '#9bbb3a', '#fbbf24', '#fb7185', '#f87171'];   // para canvas (sin var())

// FFT radix-2 (Cooley-Tukey) de la mayor potencia de 2 ≤ buffer; ventana de Hann.
// Devuelve { mag: amplitud por bin, df: Hz por bin }.
function fftMag(buf) {
  let n = 1; while (n * 2 <= buf.length) n *= 2;
  if (n < 8) return { mag: [], df: FS / Math.max(n, 1) };
  const re = buf.slice(buf.length - n);
  const mean = re.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) re[i] = (re[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  const im = new Array(n).fill(0);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / n;
  return { mag, df: FS / n };
}

async function boot() {
  const container = document.getElementById('viewport-container');
  const toolbar = document.getElementById('toolbar');
  const panel = document.getElementById('panel');
  const vpwrap = document.getElementById('viewport-wrap');
  if (!container || !panel) { console.warn('[shm] shell de PÓRTICO no encontrado'); window.__rewindCloseLanding?.(); return; }

  document.body.classList.add('shm');

  const fleet = new FleetView(container);
  fleet.renderer.domElement.classList.add('shm-canvas');
  window.shmFleet = fleet;

  // Estado de reconocimiento/informe de anomalías + bitácora de mantenimiento
  const ack = new Set(), informed = new Set(), rawAnom = new Set(), maintLog = [];
  const actions = {
    isAnom: (id) => rawAnom.has(id),
    isAck: (id) => ack.has(id),
    isInformed: (id) => informed.has(id),
    log: maintLog,
    dismiss: (id) => { const on = !ack.has(id); on ? ack.add(id) : ack.delete(id); maintLog.push({ t: Date.now(), id, action: on ? 'Anomalía reconocida (descartada)' : 'Alarma reactivada' }); },
    report: (obj) => { informed.add(obj.id); maintLog.push({ t: Date.now(), id: obj.id, action: 'Informe de falla emitido' }); downloadReport(obj); },
  };

  buildToolbar(toolbar, fleet);
  const nameplate = buildNameplate(vpwrap);
  const banner = buildBanner(vpwrap);
  const dash = buildDashboard(panel, fleet, actions);

  document.getElementById('btn-zoomext')?.addEventListener('click', () => fleet.clearSelection());
  document.title = 'ReWind — SHM de torres eólicas';

  // ── DataSource: simulación (Web Worker) o nube (?live=wss://…) ─────────────
  const liveUrl = new URLSearchParams(location.search).get('live');
  const ds = new DataSource(liveUrl ? { liveUrl } : {});
  window.shmData = ds;
  ds.onTick = (msg) => {
    const alarmed = [];
    rawAnom.clear();
    for (const id in msg.summaries) {
      const sum = msg.summaries[id];
      for (const se of sum.sensors) fleet.setSensorStatus(id, se.id, se.status);
      // Anomalía = clasificación ML alta (≥ Alto) o algún sensor en falla
      const anom = (sum.cls || 0) >= 3 || sum.sensors.some(s => s.status === 'fault');
      if (anom) rawAnom.add(id);
      const eff = anom && !ack.has(id);   // reconocida (descartada) → se silencia el titileo
      fleet.setAlarm(id, eff);
      if (eff) alarmed.push(id);
    }
    banner.update(alarmed.map(id => fleet.getStructure(id)?.label || id));
    nameplate.alarm(fleet.selected && alarmed.includes(fleet.selected.id));
    dash.setAlarms(alarmed);
    dash.onTick(msg);
  };

  // ── Carga del parque con barra de progreso en la portada ──────────────────
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const setLoad = (pct, status) => {
    const bar = document.getElementById('load-bar'), st = document.getElementById('load-status'), pc = document.getElementById('load-pct');
    if (bar) bar.style.width = pct + '%';
    if (pc) pc.textContent = Math.round(pct) + '%';
    if (st && status) st.textContent = status;
  };
  const saved = loadLayout();
  const NT = saved?.turbines?.length || 10;
  const NHV = Math.max(2, saved?.hv?.length || 2);

  for (let i = 0; i < NT; i++) {
    fleet.addTurbine(saved ? { pos: saved.turbines[i] } : {});
    setLoad((i + 1) / NT * 70, `Cargando torres eólicas ${i + 1}/${NT}`);
    await delay(30);
  }
  setLoad(72, `Cargando torres de alta tensión 0/${NHV}`); await delay(60);
  fleet.buildSubstation();                               // 2 torres AT
  for (let k = 2; k < NHV; k++) fleet.addHVTower();
  if (saved) fleet.substation.towers.forEach((h, i) => { const p = saved.hv?.[i]; if (p) h.group.position.set(p.x, 0, p.z); });
  fleet.rebuildCables();
  setLoad(84, `Cargando torres de alta tensión ${NHV}/${NHV}`); await delay(120);

  // Fallas y daño de demostración (mientras se conectan los sensores reales)
  const dmgMap = {};
  if (fleet.structures[2]?.sensors[1]) fleet.structures[2].sensors[1].status = 'fault';
  const lastHV = [...fleet.structures].reverse().find(s => s.type === 'hv');
  if (lastHV?.sensors[2]) lastHV.sensors[2].status = 'fault';
  if (fleet.structures[4]) dmgMap[fleet.structures[4].id] = 0.45;

  const buildManifest = () => fleet.structures.map(s => ({
    id: s.id, type: s.type, f1: F1_BASE[s.type] || 0.5, dmg: dmgMap[s.id] || 0,
    sensors: s.sensors.map(se => ({ id: se.id, status: se.status || 'ok' })),
  }));
  const syncData = () => { ds.init(buildManifest()); dash.setStructures(fleet.getStructures()); };
  const saveLayout = () => {
    try {
      const t = fleet.turbines.map(x => ({ x: +x.group.position.x.toFixed(1), z: +x.group.position.z.toFixed(1) }));
      const hv = (fleet.substation?.towers || []).map(x => ({ x: +x.group.position.x.toFixed(1), z: +x.group.position.z.toFixed(1) }));
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ turbines: t, hv }));
    } catch {}
  };

  fleet.onChange = syncData;        // re-sincroniza telemetría al agregar
  fleet.onLayoutChange = saveLayout; // persiste el orden al mover/agregar
  fleet.onSelect = (obj) => { dash.select(obj); nameplate.show(obj); ds.focus(obj ? obj.id : null); };

  syncData();
  fleet.playIntro();

  // ── Gemelo digital: f₁ + diagramas por el solver de PÓRTICO (bloqueante) ───
  setLoad(90, 'Calculando gemelo digital…'); await delay(60);
  const tw = computeTwin();
  window.shmTwin = tw;
  if (tw.turbine) F1_BASE.turbine = tw.turbine;
  if (tw.hv) F1_BASE.hv = tw.hv;
  syncData();           // re-init worker con las f₁ del gemelo
  dash.refresh();

  setLoad(100, 'Listo'); await delay(280);
  window.__rewindCloseLanding?.();
}

// ── Toolbar: Torre · Torre AT · Detener · Editar ─────────────────────────────
function buildToolbar(toolbar, fleet) {
  if (!toolbar) return;
  const mk = (id, title, svg, label, onclick) => {
    const b = document.createElement('button');
    b.id = id; b.className = 'tool tool-action'; b.title = title;
    b.innerHTML = `${svg}<span>${label}</span>`;
    b.addEventListener('click', () => onclick(b));
    return b;
  };
  const sep = document.createElement('div'); sep.className = 'tool-sep';
  const add = mk('shm-add-tool', 'Agregar aerogenerador',
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    'Torre', () => fleet.addTurbine());
  const hv = mk('shm-hv-tool', 'Agregar torre de alta tensión',
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3 L5 21 M12 3 L19 21 M7 9 H17 M6 13 H18 M5.5 17 H18.5"/></svg>`,
    'Torre AT', () => fleet.addHVTower());
  const pause = mk('shm-pause-tool', '', '', '', () => { fleet.setPaused(!fleet.paused); paint(); });
  const paint = () => {
    pause.title = fleet.paused ? 'Reanudar animación de aspas' : 'Detener animación de aspas';
    pause.innerHTML = fleet.paused
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg><span>Animar</span>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span>Detener</span>`;
  };
  paint();
  const edit = mk('shm-edit-tool', 'Modo edición: arrastra las estructuras para reubicarlas',
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20 L4 16 L15 5 L19 9 L8 20 Z"/><line x1="13" y1="7" x2="17" y2="11"/></svg>`,
    'Editar', (b) => { fleet.setEditMode(!fleet.editMode); b.classList.toggle('active', fleet.editMode); });
  toolbar.append(sep, add, hv, pause, edit);
}

// ── Nameplate (cuadro con el nombre sobre la vista) ──────────────────────────
function buildNameplate(vpwrap) {
  const el = document.createElement('div');
  el.id = 'shm-nameplate';
  el.innerHTML = `<span class="np-dot"></span><span class="np-name">—</span><span class="np-type">—</span><span class="np-alarm">⚠ Anomalía detectada</span>`;
  (vpwrap || document.body).appendChild(el);
  return {
    show(obj) {
      if (!obj) { el.classList.remove('show'); return; }
      el.querySelector('.np-name').textContent = obj.label;
      el.querySelector('.np-type').textContent = obj.type === 'hv' ? 'Torre de alta tensión' : `Aerogenerador · ${obj.power || ''}`;
      el.classList.add('show');
    },
    alarm(on) { el.classList.toggle('alarm', !!on); },
  };
}

// ── Banner de emergencia (titilante) sobre la vista ──────────────────────────
function buildBanner(vpwrap) {
  const el = document.createElement('div');
  el.id = 'shm-banner';
  el.innerHTML = `<span class="b-ico">⚠</span><span class="b-txt"></span>`;
  (vpwrap || document.body).appendChild(el);
  return {
    update(labels) {
      if (!labels.length) { el.classList.remove('show'); return; }
      const n = labels.length;
      el.querySelector('.b-txt').textContent =
        `ANOMALÍA DETECTADA — ${labels.slice(0, 3).join(', ')}${n > 3 ? ` y ${n - 3} más` : ''}`;
      el.classList.add('show');
    },
  };
}

// Genera y descarga un informe de falla (.txt) de la estructura.
function downloadReport(obj) {
  const sum = window.shmData?.get(obj.id) || {};
  const sensors = sum.sensors || obj.sensors || [];
  const lines = [
    'ReWind — Informe de falla',
    `Fecha: ${new Date().toLocaleString('es-CL')}`,
    `Estructura: ${obj.label} (${obj.id})`,
    `Tipo: ${obj.type === 'hv' ? 'Torre de alta tensión' : 'Aerogenerador'}`,
    `Altura: ${obj.height} m`,
    `f₁ actual: ${sum.f1 != null ? sum.f1.toFixed(3) + ' Hz' : '—'}`,
    `Índice de daño: ${Math.round((sum.dmg || 0) * 100)} %`,
    `Temperatura: ${sum.temp != null ? sum.temp.toFixed(1) + ' °C' : '—'}`,
    '', 'Sensores:',
    ...sensors.map(s => `  - ${s.id}: ${s.status === 'fault' ? 'FALLA' : 'OK'}${s.rms != null ? ` (RMS ${(s.rms * 1000).toFixed(1)} mg)` : ''}`),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `ReWind_falla_${obj.id}.txt`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}

// ── Dashboard SHM ────────────────────────────────────────────────────────────
function buildDashboard(panel, fleet, actions) {
  const el = document.createElement('aside');
  el.id = 'shm-panel';
  el.innerHTML = `
    <div class="shm-head">
      <div style="flex:1">
        <div class="shm-title">🌬️ ReWind — SHM</div>
        <div class="shm-sub">Salud estructural en tiempo real · <span style="opacity:.7">${REWIND_VER}</span></div>
      </div>
      <button id="shm-report-btn" title="Informe compilado de todo el parque">📄 Parque</button>
    </div>
    <div class="shm-fleet">
      <div class="shm-stat"><div class="k">Estructuras</div><div class="v" id="shm-count">0</div></div>
      <div class="shm-stat"><div class="k">Sensores OK</div><div class="v" style="color:var(--success)" id="shm-ok">0</div></div>
      <div class="shm-stat"><div class="k">Fallas</div><div class="v" style="color:var(--danger)" id="shm-fault">0</div></div>
      <div class="shm-stat"><div class="k">Alarmas</div><div class="v" style="color:var(--danger)" id="shm-alarm-count">0</div></div>
    </div>
    <div class="shm-listwrap">
      <div class="shm-list-h">Estructuras del parque</div>
      <div class="shm-list" id="shm-list"></div>
    </div>
    <div class="shm-detail" id="shm-detail"><div class="empty">Selecciona una estructura<br>(en la lista o en la vista).</div></div>`;
  panel.appendChild(el);
  const $ = (s) => el.querySelector(s);
  el.querySelector('#shm-report-btn').addEventListener('click', () => buildReport(null));   // compilado del parque

  let list = [], current = null, pane = 'datos', sigBuf = {}, sigRAF = null, freqHist = {};
  let specOff = null, specLast = 0;                 // espectrograma (offscreen + scroll)
  const clsHist = {}, clsEvents = {}; let lastHistT = 0;   // histórico de clasificación ML
  const SPEC_W = 170, SPEC_BINS = 48, SPEC_FMAX = 6;
  const heat = (t) => {
    t = Math.max(0, Math.min(1, t));
    const s = [[12, 16, 32], [22, 90, 190], [30, 200, 200], [240, 220, 60], [232, 50, 40]];
    const x = t * (s.length - 1), i = Math.floor(x), f = x - i, a = s[i], b = s[Math.min(i + 1, s.length - 1)];
    return `rgb(${a[0] + (b[0] - a[0]) * f | 0},${a[1] + (b[1] - a[1]) * f | 0},${a[2] + (b[2] - a[2]) * f | 0})`;
  };

  function setStructures(structs) {
    list = structs;
    $('#shm-count').textContent = structs.length;
    const lc = $('#shm-list'); lc.innerHTML = '';
    for (const s of structs) {
      const row = document.createElement('button');
      row.className = 'shm-row'; row.dataset.id = s.id;
      row.innerHTML = `<span class="dot"></span><span class="nm">${s.label}</span><span class="ty">${s.type === 'hv' ? 'AT' : 'T'}</span>`;
      row.addEventListener('click', () => fleet.selectById(s.id));
      lc.appendChild(row);
    }
    highlight();
  }
  function highlight() {
    el.querySelectorAll('.shm-row').forEach(r => r.classList.toggle('active', current && r.dataset.id === current.id));
  }
  function setAlarms(ids) {
    const set = new Set(ids);
    el.querySelectorAll('.shm-row').forEach(r => r.classList.toggle('alarm', set.has(r.dataset.id)));
    const n = $('#shm-alarm-count'); if (n) n.textContent = ids.length;
  }
  // Barra de acción sobre la falla (Descartar / Informar). Sólo se re-renderiza al
  // cambiar el estado — si se reconstruyera cada tick, se perderían los clics.
  let _abKey = '';
  function updateAlarmBar() {
    const bar = $('#shm-alarmbar'); if (!bar || !current || !actions) return;
    if (!actions.isAnom(current.id)) { if (_abKey !== 'none') { bar.style.display = 'none'; bar.innerHTML = ''; _abKey = 'none'; } return; }
    const acked = actions.isAck(current.id), inf = actions.isInformed(current.id);
    const key = `${current.id}|${acked}|${inf}`;
    if (key === _abKey) return;            // sin cambios → no tocar el DOM (no romper clics)
    _abKey = key;
    bar.style.display = 'block'; bar.classList.toggle('acked', acked);
    bar.innerHTML = `
      <div class="ab-head"><span class="ab-ico">⚠</span> <b>${acked ? 'Anomalía reconocida' : 'Anomalía detectada'}</b>${inf ? ' · informada' : ''}</div>
      <div class="ab-actions">
        <button class="ab-btn ab-dismiss">${acked ? 'Reactivar alarma' : 'Descartar'}</button>
        <button class="ab-btn ab-report">Informar</button>
      </div>`;
    bar.querySelector('.ab-dismiss').addEventListener('click', () => { actions.dismiss(current.id); updateAlarmBar(); });
    bar.querySelector('.ab-report').addEventListener('click', () => { actions.report(current); updateAlarmBar(); });
  }

  function select(obj) {
    current = obj; highlight();
    sigBuf = {}; freqHist = {}; specOff = null;
    if (!obj) { stopSig(); $('#shm-detail').innerHTML = '<div class="empty">Selecciona una estructura<br>(en la lista o en la vista).</div>'; return; }
    renderDetail();
  }

  function renderDetail() {
    const o = current; if (!o) return;
    $('#shm-detail').innerHTML = `
      <div id="shm-alarmbar" style="display:none"></div>
      <div class="shm-tabs">
        <button class="shm-tab" data-p="datos">Datos</button>
        <button class="shm-tab" data-p="senal">Señal</button>
        <button class="shm-tab" data-p="sensores">Sensores</button>
        <button class="shm-tab" data-p="hist">Histórico</button>
        <button class="shm-tab" data-p="avz">Avanzado</button>
        <button class="shm-tab" data-p="insp">Inspección</button>
      </div>
      <div class="shm-body" id="shm-pane"></div>
      <div class="shm-detail-foot"><button id="shm-tower-report">📄 Informe de esta torre</button></div>`;
    _abKey = '';
    updateAlarmBar();
    el.querySelectorAll('.shm-tab').forEach(t => t.addEventListener('click', () => { pane = t.dataset.p; renderPane(); }));
    el.querySelector('#shm-tower-report').addEventListener('click', () => buildReport(current));
    renderPane();
  }

  function renderPane() {
    stopSig();
    el.querySelectorAll('.shm-tab').forEach(t => t.classList.toggle('active', t.dataset.p === pane));
    const o = current, body = $('#shm-pane'); if (!o || !body) return;
    const sum = (window.shmData && window.shmData.get(o.id)) || null;
    if (pane === 'datos') {
      const dmg = sum ? Math.round((sum.dmg || 0) * 100) : 0;
      const light = dmg < 8 ? 'ok' : dmg < 25 ? 'warn' : 'bad';
      body.innerHTML = `
        <div class="row"><span>Estructura</span><b>${o.label}</b></div>
        <div class="row"><span>Tipo</span><b>${o.type === 'hv' ? 'Torre de alta tensión' : 'Aerogenerador'}</b></div>
        <div class="row"><span>Altura</span><b>${o.height} m</b></div>
        ${o.type === 'turbine' ? `<div class="row"><span>Potencia</span><b>~3 MW</b></div>` : ''}
        <div class="row"><span>Sensores</span><b id="d-ns">—</b></div>
        <div class="row"><span>f₁ gemelo digital</span><b>${window.shmTwin?.[o.type] ? window.shmTwin[o.type].toFixed(3) + ' Hz' : '… calculando'}</b></div>
        <div class="row"><span>f₁ actual</span><b id="d-f1">—</b></div>
        <div class="row"><span>Temperatura</span><b id="d-temp">—</b></div>
        <div class="row"><span>Clasificación ML</span><b id="d-cls">…</b></div>
        <div class="row"><span>Índice de daño</span><b id="d-dmg">${dmg}%</b></div>
        <div class="note" style="font-size:10px">Clasificación entregada por el servicio ML que vigila todos los sensores.</div>`;
    } else if (pane === 'senal') {
      body.innerHTML = `<div class="note" style="margin-top:0">Señal de aceleración en vivo (se mueve en tiempo real):</div><div id="sig-wrap"></div>`;
      const wrap = body.querySelector('#sig-wrap');
      for (const se of o.sensors) {
        const lab = document.createElement('div'); lab.className = 'row'; lab.style.border = '0';
        lab.innerHTML = `<span>${se.id}</span><b class="sig-st">…</b>`;
        const cv = document.createElement('canvas'); cv.className = 'sig'; cv.dataset.sid = se.id;
        wrap.append(lab, cv);
      }
      startSig();
    } else if (pane === 'sensores') {
      body.innerHTML = o.sensors.map(se =>
        `<div class="shm-sensor"><span class="dot ${se.status}"></span><span style="flex:1">${se.id}</span><b class="s-rms" data-sid="${se.id}">—</b></div>`
      ).join('') + `<div class="note">Verde = operativo · Rojo = en falla. Estado y RMS en vivo desde el gateway (sim).</div>`;
    } else if (pane === 'hist') {
      body.innerHTML = `
        <div class="note" style="margin-top:0">Histórico de clasificación ML (línea de tiempo):</div>
        <canvas class="sig" id="cls-band" style="height:34px"></canvas>
        <div id="cls-legend" style="display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 10px;font-size:10px;color:var(--text-muted)">
          ${CLS.map((n, i) => `<span><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${CLS_COL[i]};margin-right:4px"></span>${n}</span>`).join('')}
        </div>
        <div class="note">Cambios de nivel:</div>
        <div id="cls-events"></div>`;
      drawHist();
    } else if (pane === 'avz') {
      const nvm = o.type === 'turbine'
        ? `<div class="note">Diagramas del gemelo digital — fuste bajo viento + peso propio:</div>
           <div id="nvm-wrap" style="display:flex;gap:6px">
             <canvas class="sig nvm" data-k="N" style="height:130px;flex:1"></canvas>
             <canvas class="sig nvm" data-k="V" style="height:130px;flex:1"></canvas>
             <canvas class="sig nvm" data-k="M" style="height:130px;flex:1"></canvas>
           </div>
           <div class="row" style="border:0"><span>N · V · M (base)</span><b id="nvm-info">…</b></div>`
        : `<div class="note">Esfuerzo axial del reticulado (gemelo, bajo viento):</div>
           <div class="row"><span>Axial máx · tracción</span><b id="hv-t">…</b></div>
           <div class="row"><span>Axial máx · compresión</span><b id="hv-c">…</b></div>`;
      body.innerHTML = `
        <div class="note" style="margin-top:0">Espectro de frecuencias (FFT) del acelerómetro superior:</div>
        <canvas class="sig" id="fft-canvas" style="height:110px"></canvas>
        <div class="row" style="border:0"><span>Pico dominante</span><b id="fft-peak">—</b></div>
        <div class="note">Espectrograma (frecuencia–tiempo) del acelerómetro superior:</div>
        <canvas class="sig" id="spec-canvas" style="height:90px"></canvas>
        <div class="note">Seguimiento de la frecuencia natural f₁ (vs. línea base del gemelo):</div>
        <canvas class="sig" id="freq-canvas" style="height:80px"></canvas>
        ${nvm}
        <div class="note">f₁ a la baja = pérdida de rigidez (daño). Diagramas del solver de PÓRTICO.</div>`;
      if (o.type === 'hv') {
        const ax = window.shmTwin?.hvAxial;
        if (ax) { $('#hv-t').textContent = `${ax.tMax.toFixed(0)} kN`; $('#hv-c').textContent = `${ax.cMax.toFixed(0)} kN`; }
      }
      startAvz();
    } else {
      const seed = o.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
      const days = 30 + (seed % 120);
      const last = new Date(Date.now() - days * 864e5).toLocaleDateString('es-CL');
      const next = new Date(Date.now() + (180 - days % 180) * 864e5).toLocaleDateString('es-CL');
      const fault = o.sensors.some(s => s.status === 'fault');
      body.innerHTML = `
        <div class="row"><span>Última inspección</span><b>${last}</b></div>
        <div class="row"><span>Próxima inspección</span><b>${next}</b></div>
        <div class="row"><span>Sensores instalados</span><b>${o.sensors.length}</b></div>
        <div class="row"><span>Observación</span><b style="color:${fault ? 'var(--danger)' : 'var(--success)'}">${fault ? 'Revisar sensor en falla' : 'Sin novedades'}</b></div>
        <div class="note">Historial de inspecciones (datos de muestra). Se integrará con el registro de mantenimiento.</div>`;
    }
    updateDynamic(sum);
  }

  // Actualiza los números dinámicos del panel abierto.
  function updateDynamic(sum) {
    if (!current || !sum) return;
    if (pane === 'datos') {
      const ns = sum.sensors.length, ok = sum.sensors.filter(s => s.status === 'ok').length;
      const set = (id, v) => { const n = $('#' + id); if (n) n.textContent = v; };
      set('d-ns', `${ok}/${ns} OK`);
      set('d-f1', `${sum.f1.toFixed(3)} Hz`);
      set('d-temp', `${sum.temp.toFixed(1)} °C`);
      set('d-dmg', `${Math.round((sum.dmg || 0) * 100)} %`);
      const cls = sum.cls || 0, cn = $('#d-cls');
      if (cn) { cn.textContent = CLS[cls]; cn.style.color = CLS_COL[cls]; }
    } else if (pane === 'sensores') {
      for (const se of sum.sensors) {
        const n = el.querySelector(`.s-rms[data-sid="${se.id}"]`);
        if (n) { n.textContent = se.status === 'fault' ? 'FALLA' : `${(se.rms * 1000).toFixed(1)} mg`; n.style.color = se.status === 'fault' ? 'var(--danger)' : ''; }
        const dot = n && n.parentElement.querySelector('.dot'); if (dot) dot.className = `dot ${se.status}`;
      }
    } else if (pane === 'senal') {
      for (const se of sum.sensors) { const b = [...el.querySelectorAll('#sig-wrap .row')].find(r => r.firstChild.textContent === se.id)?.querySelector('.sig-st'); if (b) { b.textContent = se.status === 'fault' ? 'falla' : 'ok'; b.style.color = se.status === 'fault' ? 'var(--danger)' : 'var(--success)'; } }
    }
  }

  function onTick(msg) {
    // contadores de flota
    let ok = 0, fault = 0;
    for (const id in msg.summaries) for (const se of msg.summaries[id].sensors) (se.status === 'fault' ? fault++ : ok++);
    $('#shm-ok').textContent = ok; $('#shm-fault').textContent = fault;
    // puntos de la lista
    for (const s of list) {
      const sum = msg.summaries[s.id]; if (!sum) continue;
      const row = el.querySelector(`.shm-row[data-id="${s.id}"]`); if (!row) continue;
      const dot = row.querySelector('.dot'), c = CLS_COL[sum.cls || 0];
      if (row.classList.contains('alarm')) { dot.style.background = ''; dot.style.boxShadow = ''; }  // CSS maneja el rojo titilante
      else { dot.style.background = c; dot.style.boxShadow = `0 0 6px ${c}`; }
    }
    // buffers de señal de la estructura enfocada
    if (current && msg.waves[current.id]) {
      for (const w of msg.waves[current.id]) {
        (sigBuf[w.id] || (sigBuf[w.id] = [])).push(...w.samples);
        const buf = sigBuf[w.id]; if (buf.length > 700) buf.splice(0, buf.length - 700);
      }
    }
    // historial de f₁ para el seguimiento (pestaña Avanzado)
    if (current && msg.summaries[current.id]) {
      const h = (freqHist[current.id] || (freqHist[current.id] = []));
      h.push(msg.summaries[current.id].f1); if (h.length > 160) h.shift();
    }
    // Histórico de clasificación ML (muestreo ~1 s, todas las estructuras)
    const now = Date.now();
    if (now - lastHistT > 1000) {
      lastHistT = now;
      for (const id in msg.summaries) {
        const cls = msg.summaries[id].cls || 0;
        const h = (clsHist[id] || (clsHist[id] = []));
        const prev = h.length ? h[h.length - 1].cls : null;
        h.push({ t: now, cls }); if (h.length > 240) h.shift();
        if (prev !== null && prev !== cls) {
          const ev = (clsEvents[id] || (clsEvents[id] = []));
          ev.push({ t: now, from: prev, to: cls }); if (ev.length > 40) ev.shift();
        }
      }
      if (current && pane === 'hist') drawHist();
    }

    if (current) { updateDynamic(msg.summaries[current.id]); updateAlarmBar(); }
  }

  // Dibujo de la señal en vivo desde los buffers.
  function startSig() {
    const draw = () => {
      const cvs = el.querySelectorAll('#sig-wrap canvas.sig');
      cvs.forEach(cv => {
        const sid = cv.dataset.sid, buf = sigBuf[sid] || [];
        const dpr = Math.min(devicePixelRatio, 2), w = cv.clientWidth, h = cv.clientHeight || 80;
        cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
        g.clearRect(0, 0, w, h);
        const fault = current?.sensors.find(s => s.id === sid)?.status === 'fault';
        g.strokeStyle = fault ? '#ff3b3b' : '#2bff77'; g.lineWidth = 1.5; g.beginPath();
        const n = Math.max(buf.length, 1), step = w / 700;
        for (let i = 0; i < buf.length; i++) {
          const x = i * step, y = h / 2 - buf[i] * h * 0.4;
          i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
      });
      sigRAF = requestAnimationFrame(draw);
    };
    draw();
  }
  function stopSig() { if (sigRAF) { cancelAnimationFrame(sigRAF); sigRAF = null; } }

  // Pestaña Avanzado: espectro FFT + seguimiento de f₁.
  function startAvz() {
    const draw = () => {
      const o = current;
      const fc = el.querySelector('#fft-canvas'), qc = el.querySelector('#freq-canvas');
      if (o && fc) {
        // FFT del acelerómetro superior (o el primero disponible)
        const sid = (o.sensors.find(s => /top|s1/.test(s.id)) || o.sensors[0])?.id;
        const { mag, df } = fftMag(sigBuf[sid] || []);
        const dpr = Math.min(devicePixelRatio, 2), w = fc.clientWidth, h = fc.clientHeight || 110;
        fc.width = w * dpr; fc.height = h * dpr; const g = fc.getContext('2d'); g.scale(dpr, dpr);
        g.clearRect(0, 0, w, h);
        const fMax = 6;                               // Hz mostrados (modos de torre, bajos)
        const bins = Math.max(1, Math.min(mag.length, Math.floor(fMax / (df || 1))));
        let mx = 1e-9, peak = 0;
        for (let i = 1; i < bins; i++) if (mag[i] > mx) { mx = mag[i]; peak = i; }
        g.fillStyle = '#38bdf8';
        for (let i = 1; i < bins; i++) {
          const x = (i / bins) * w, bh = (mag[i] / mx) * (h - 14);
          g.fillRect(x, h - bh, Math.max(1, w / bins - 1), bh);
        }
        g.fillStyle = '#2dd4bf';                      // marca del pico
        const px = (peak / bins) * w; g.fillRect(px - 1, 0, 2, h);
        const pk = el.querySelector('#fft-peak'); if (pk) pk.textContent = `${(peak * df).toFixed(3)} Hz`;
      }
      if (o && qc) {
        const hist = freqHist[o.id] || [], base = window.shmTwin?.[o.type];
        const dpr = Math.min(devicePixelRatio, 2), w = qc.clientWidth, h = qc.clientHeight || 80;
        qc.width = w * dpr; qc.height = h * dpr; const g = qc.getContext('2d'); g.scale(dpr, dpr);
        g.clearRect(0, 0, w, h);
        const vals = base ? [base, ...hist] : hist;
        if (vals.length) {
          const lo = Math.min(...vals) * 0.999, hi = Math.max(...vals) * 1.001, rng = (hi - lo) || 1;
          const Y = (v) => h - 6 - ((v - lo) / rng) * (h - 12);
          if (base != null) { g.strokeStyle = 'rgba(150,160,170,0.6)'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(0, Y(base)); g.lineTo(w, Y(base)); g.stroke(); g.setLineDash([]); }
          g.strokeStyle = '#38bdf8'; g.lineWidth = 1.5; g.beginPath();
          hist.forEach((v, i) => { const x = (i / Math.max(hist.length - 1, 1)) * w; i ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)); });
          g.stroke();
        }
      }
      // Espectrograma (frecuencia–tiempo) del acelerómetro superior
      const sc = el.querySelector('#spec-canvas');
      if (o && sc) {
        if (!specOff) { specOff = document.createElement('canvas'); specOff.width = SPEC_W; specOff.height = SPEC_BINS; specOff.getContext('2d').fillRect(0, 0, SPEC_W, SPEC_BINS); }
        const now = performance.now();
        if (now - specLast > 110) {
          specLast = now;
          const sid = (o.sensors.find(s => /top|s1/.test(s.id)) || o.sensors[0])?.id;
          const { mag, df } = fftMag(sigBuf[sid] || []);
          const og = specOff.getContext('2d');
          og.drawImage(specOff, -1, 0);                 // desplaza a la izquierda
          let mx = 1e-9; for (let i = 1; i < mag.length; i++) if (mag[i] > mx) mx = mag[i];
          for (let y = 0; y < SPEC_BINS; y++) {
            const bi = Math.round(((y / SPEC_BINS) * SPEC_FMAX) / (df || 1));
            og.fillStyle = heat((mag[bi] || 0) / mx);
            og.fillRect(SPEC_W - 1, SPEC_BINS - 1 - y, 1, 1);   // baja frecuencia abajo
          }
        }
        const dpr = Math.min(devicePixelRatio, 2), w = sc.clientWidth, h = sc.clientHeight || 90;
        sc.width = w * dpr; sc.height = h * dpr; const g = sc.getContext('2d'); g.scale(dpr, dpr);
        g.imageSmoothingEnabled = false; g.clearRect(0, 0, w, h); g.drawImage(specOff, 0, 0, w, h);
      }

      // Diagramas N/V/M del fuste (turbina)
      const prof = window.shmTwin?.turbineProfile;
      const nvmCanvases = el.querySelectorAll('#nvm-wrap canvas.nvm');
      if (o && o.type === 'turbine' && prof && nvmCanvases.length) {
        nvmCanvases.forEach(cv => drawNVM(cv, prof, cv.dataset.k));
        const base = prof[0] || {};
        const info = $('#nvm-info'); if (info) info.textContent = `${(base.N || 0).toFixed(0)} kN · ${(base.V || 0).toFixed(0)} kN · ${(base.M || 0).toFixed(0)} kN·m`;
      }
      sigRAF = requestAnimationFrame(draw);
    };
    draw();
  }

  // Histórico de clasificación: franja temporal coloreada + lista de cambios.
  function drawHist() {
    const o = current; if (!o) return;
    const cv = el.querySelector('#cls-band');
    if (cv) {
      const hist = clsHist[o.id] || [];
      const dpr = Math.min(devicePixelRatio, 2), w = cv.clientWidth, h = cv.clientHeight || 34;
      cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
      g.clearRect(0, 0, w, h);
      if (hist.length) {
        const n = hist.length, cw = w / n;
        for (let i = 0; i < n; i++) { g.fillStyle = CLS_HEX[hist[i].cls] || '#888'; g.fillRect(i * cw, 0, Math.ceil(cw), h); }
      } else { g.fillStyle = '#7e8da0'; g.font = '11px Inter, sans-serif'; g.fillText('Acumulando histórico…', 6, h / 2 + 4); }
    }
    const evEl = el.querySelector('#cls-events');
    if (evEl) {
      const events = (clsEvents[o.id] || []).slice(-8).reverse();
      evEl.innerHTML = events.length ? events.map(e => {
        const tm = new Date(e.t).toLocaleTimeString('es-CL');
        return `<div class="row" style="font-size:12px"><span>${tm}</span><b><span style="color:${CLS_COL[e.from]}">${CLS[e.from]}</span> → <span style="color:${CLS_COL[e.to]}">${CLS[e.to]}</span></b></div>`;
      }).join('') : `<div class="note">Sin cambios registrados en esta sesión.</div>`;
    }
  }

  // Dibuja un diagrama (N|V|M) vs altura del fuste.
  const NVM_COL = { N: '#a78bfa', V: '#fb923c', M: '#38bdf8' };
  function drawNVM(cv, prof, key) {
    const dpr = Math.min(devicePixelRatio, 2), w = cv.clientWidth, h = cv.clientHeight || 130;
    cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const zMax = prof[prof.length - 1].z || 1, vMax = Math.max(...prof.map(p => p[key]), 1e-9);
    const X = (v) => 4 + (v / vMax) * (w - 8), Y = (z) => h - 4 - (z / zMax) * (h - 16);
    g.strokeStyle = 'rgba(127,140,160,0.5)'; g.beginPath(); g.moveTo(4, Y(0)); g.lineTo(4, Y(zMax)); g.stroke();
    g.fillStyle = NVM_COL[key] + '55'; g.strokeStyle = NVM_COL[key]; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(4, Y(0));
    for (const p of prof) g.lineTo(X(p[key]), Y(p.z));
    g.lineTo(4, Y(zMax)); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#7e8da0'; g.font = '10px Inter, sans-serif'; g.fillText(key, w - 12, 11);
  }

  // ── Informe imprimible (abre en pestaña nueva, listo para PDF) ────────────
  //  target = estructura → informe de esa torre · target = null → compilado del parque
  function buildReport(target) {
    const o = target;
    const fmtT = (t) => new Date(t).toLocaleString('es-CL');
    const esc = (s) => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

    // — utilidades de imagen (lienzo blanco, tinta oscura; los dibujos sí llevan color) —
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2; const g = c.getContext('2d'); g.scale(2, 2); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); return { c, g, w, h }; };
    const fAxis = (g, w, h, fMax) => { g.fillStyle = '#888'; g.font = '9px sans-serif'; for (let f = 0; f <= fMax; f += 2) { const x = f / fMax * w; g.fillText(f + ' Hz', Math.min(x, w - 22), h - 2); } };
    const topSid = () => (o.sensors.find(s => /top|s1/.test(s.id)) || o.sensors[0])?.id;

    const imgSignal = (sid) => { const { c, g, w, h } = mk(560, 150); const b = sigBuf[sid] || []; g.strokeStyle = '#cfd6dd'; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); g.strokeStyle = '#1f6feb'; g.lineWidth = 1; g.beginPath(); for (let i = 0; i < b.length; i++) { const x = i / 700 * w, y = h / 2 - b[i] * h * 0.4; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); return c.toDataURL('image/png'); };
    const imgFFT = (sid) => { const { c, g, w, h } = mk(560, 150); const { mag, df } = fftMag(sigBuf[sid] || []); const fMax = 8, bins = Math.min(mag.length, Math.floor(fMax / (df || 1))); let mx = 1e-9; for (let i = 1; i < bins; i++) mx = Math.max(mx, mag[i]); g.fillStyle = '#1f6feb'; for (let i = 1; i < bins; i++) { const x = i / bins * w, bh = mag[i] / mx * (h - 18); g.fillRect(x, h - 12 - bh, Math.max(1, w / bins - 1), bh); } fAxis(g, w, h, fMax); return c.toDataURL('image/png'); };
    const imgPSD = (sid) => { const { c, g, w, h } = mk(560, 150); const { mag, df } = fftMag(sigBuf[sid] || []); const fMax = 8, bins = Math.min(mag.length, Math.floor(fMax / (df || 1))); const dB = []; let lo = 1e9, hi = -1e9; for (let i = 1; i < bins; i++) { const v = 10 * Math.log10(mag[i] * mag[i] + 1e-12); dB[i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); } const rng = (hi - lo) || 1; g.strokeStyle = '#0d9488'; g.lineWidth = 1.2; g.beginPath(); for (let i = 1; i < bins; i++) { const x = i / bins * w, y = (h - 14) - ((dB[i] - lo) / rng) * (h - 22); i === 1 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); fAxis(g, w, h, fMax); return c.toDataURL('image/png'); };
    const imgWavelet = (sid) => {
      const { c, g, w, h } = mk(560, 170);
      const raw = sigBuf[sid] || []; const N = 256, x = raw.slice(-N);
      if (x.length > 16) {
        const m = x.reduce((a, b) => a + b, 0) / x.length; for (let i = 0; i < x.length; i++) x[i] -= m;
        const fs = FS, nf = 30, freqs = []; for (let i = 0; i < nf; i++) freqs.push(0.2 * Math.pow(8 / 0.2, i / (nf - 1)));
        const cols = 140, rows = [];
        let gmax = 1e-9;
        for (const f of freqs) {
          const s = (6 / (2 * Math.PI * f)) * fs, half = Math.min(x.length, Math.ceil(s * 3)), row = new Float32Array(cols);
          for (let cI = 0; cI < cols; cI++) {
            const t = Math.floor(cI / cols * x.length); let re = 0, im = 0;
            for (let k = -half; k <= half; k++) { const i = t + k; if (i < 0 || i >= x.length) continue; const tt = k / s, env = Math.exp(-0.5 * tt * tt), a = 6 * tt; re += x[i] * env * Math.cos(a); im += x[i] * env * Math.sin(a); }
            const v = Math.hypot(re, im) / Math.sqrt(s); row[cI] = v; if (v > gmax) gmax = v;
          }
          rows.push(row);
        }
        const cw = w / cols, rh = (h - 14) / rows.length;
        for (let r = 0; r < rows.length; r++) for (let cI = 0; cI < cols; cI++) { g.fillStyle = heat(rows[rows.length - 1 - r][cI] / gmax); g.fillRect(cI * cw, r * rh, Math.ceil(cw), Math.ceil(rh)); }
      }
      g.fillStyle = '#888'; g.font = '9px sans-serif'; g.fillText('8 Hz', 2, 10); g.fillText('0.2 Hz', 2, h - 16); g.fillText('tiempo →', w - 50, h - 2);
      return c.toDataURL('image/png');
    };

    // — dibujo esquemático de la estructura —
    const schematic = (st) => {
      if (st.type === 'hv') return `<svg viewBox="0 0 120 200" width="120" height="200"><g fill="none" stroke="#0d9488" stroke-width="1.5"><path d="M40 190 L58 20 L62 20 L80 190"/><path d="M44 150 H76 M48 110 H72 M52 70 H68"/><path d="M40 190 L72 150 M80 190 L48 150 M44 150 L68 110 M76 150 L52 110"/><path d="M30 70 H90 M34 50 H86"/></g><circle cx="60" cy="22" r="3" fill="#16a34a"/><circle cx="58" cy="110" r="3" fill="#16a34a"/><circle cx="32" cy="70" r="3" fill="#16a34a"/><circle cx="60" cy="150" r="3" fill="#16a34a"/></svg>`;
      return `<svg viewBox="0 0 120 200" width="120" height="200"><line x1="60" y1="195" x2="60" y2="50" stroke="#5aa9e6" stroke-width="6" stroke-linecap="round"/><ellipse cx="60" cy="195" rx="22" ry="4" fill="#d6dde5"/><rect x="52" y="40" width="22" height="10" rx="3" fill="#9bc6ea"/><g stroke="#5aa9e6" stroke-width="4" stroke-linecap="round"><line x1="58" y1="44" x2="58" y2="14"/><line x1="58" y1="44" x2="84" y2="58"/><line x1="58" y1="44" x2="32" y2="58"/></g><circle cx="58" cy="44" r="3.5" fill="#2dd4bf"/><circle cx="63" cy="60" r="3.5" fill="#16a34a"/><circle cx="63" cy="125" r="3.5" fill="#16a34a"/></svg>`;
    };

    // — tabla resumen de la flota —
    const rowsHtml = list.map(s => {
      const d = window.shmData?.get(s.id) || {};
      const cls = d.cls || 0, fault = (d.sensors || []).some(x => x.status === 'fault');
      const alerta = cls >= 3 || fault;
      const clsCell = cls >= 3 ? `<span class="warn">${CLS[cls]}</span>` : CLS[cls];
      return `<tr><td>${esc(s.label)}</td><td>${s.type === 'hv' ? 'Torre AT' : 'Aerogenerador'}</td><td>${s.height} m</td><td>${(d.sensors || s.sensors).length}</td><td>${clsCell}</td><td>${alerta ? '<span class="warn">Alerta</span>' : 'Operativa'}</td></tr>`;
    }).join('');

    let detalle = '';
    if (o) {
      const d = window.shmData?.get(o.id) || {}; const sid = topSid();
      const cls = d.cls || 0;
      const sensRows = (d.sensors || o.sensors).map((se, i) => `<tr><td>${se.id}</td><td>MEMS · acelerómetro</td><td>${o.type === 'hv' ? 'nodo ' + (i + 1) : (se.id.includes('mid') ? 'centro del fuste' : 'tope del fuste')}</td><td>${se.status === 'fault' ? '<span class="warn">FALLA</span>' : 'Operativo'}</td><td>${se.rms != null ? (se.rms * 1000).toFixed(1) + ' mg' : '—'}</td></tr>`).join('');
      const evRows = (clsEvents[o.id] || []).slice(-12).reverse().map(e => `<tr><td>${fmtT(e.t)}</td><td>${CLS[e.from]} → ${e.to >= 3 ? `<span class="warn">${CLS[e.to]}</span>` : CLS[e.to]}</td></tr>`).join('') || '<tr><td colspan="2">Sin cambios registrados.</td></tr>';
      const mRows = (actions.log || []).filter(m => m.id === o.id).slice(-12).reverse().map(m => `<tr><td>${fmtT(m.t)}</td><td>${esc(m.action)}</td></tr>`).join('') || '<tr><td colspan="2">Sin acciones de mantenimiento.</td></tr>';
      detalle = `
        <h2>2 · Estructura ${esc(o.label)}</h2>
        <div class="cols">
          <div class="draw">${schematic(o)}</div>
          <table class="ficha">
            <tr><th>Tipo</th><td>${o.type === 'hv' ? 'Torre de alta tensión' : 'Aerogenerador'}</td></tr>
            <tr><th>Altura</th><td>${o.height} m</td></tr>
            ${o.type === 'turbine' ? '<tr><th>Potencia</th><td>~3 MW</td></tr>' : ''}
            <tr><th>f₁ gemelo digital</th><td>${window.shmTwin?.[o.type] ? window.shmTwin[o.type].toFixed(3) + ' Hz' : '—'}</td></tr>
            <tr><th>f₁ actual</th><td>${d.f1 != null ? d.f1.toFixed(3) + ' Hz' : '—'}</td></tr>
            <tr><th>Temperatura</th><td>${d.temp != null ? d.temp.toFixed(1) + ' °C' : '—'}</td></tr>
            <tr><th>Índice de daño</th><td>${Math.round((d.dmg || 0) * 100)} %</td></tr>
            <tr><th>Clasificación ML</th><td>${cls >= 3 ? `<span class="warn">${CLS[cls]}</span>` : CLS[cls]}</td></tr>
          </table>
        </div>
        <h3>Sensores</h3>
        <table><thead><tr><th>ID</th><th>Tipo</th><th>Ubicación</th><th>Estado</th><th>RMS</th></tr></thead><tbody>${sensRows}</tbody></table>
        <h3>Análisis de vibración (acelerómetro superior)</h3>
        <div class="plot"><div class="cap">Señal temporal</div><img src="${imgSignal(sid)}"></div>
        <div class="plot"><div class="cap">Espectro FFT</div><img src="${imgFFT(sid)}"></div>
        <div class="plot"><div class="cap">Densidad espectral de potencia (PSD)</div><img src="${imgPSD(sid)}"></div>
        <div class="plot"><div class="cap">Escalograma wavelet (Morlet)</div><img src="${imgWavelet(sid)}"></div>
        <h3>Historial de anomalías y advertencias</h3>
        <table><thead><tr><th>Fecha y hora</th><th>Cambio de nivel</th></tr></thead><tbody>${evRows}</tbody></table>
        <h3>Acciones de mantenimiento</h3>
        <table><thead><tr><th>Fecha y hora</th><th>Acción</th></tr></thead><tbody>${mRows}</tbody></table>`;
    }

    // Compilado del parque (cuando no hay torre objetivo): historial y mantenimiento de toda la flota.
    let compilado = '';
    if (!o) {
      const allEv = [];
      for (const id in clsEvents) for (const e of clsEvents[id]) allEv.push({ ...e, id });
      allEv.sort((a, b) => b.t - a.t);
      const evRows = allEv.slice(0, 20).map(e => `<tr><td>${fmtT(e.t)}</td><td>${esc(fleet.getStructure(e.id)?.label || e.id)}</td><td>${CLS[e.from]} → ${e.to >= 3 ? `<span class="warn">${CLS[e.to]}</span>` : CLS[e.to]}</td></tr>`).join('') || '<tr><td colspan="3">Sin cambios registrados.</td></tr>';
      const mRows = (actions.log || []).slice(-20).reverse().map(m => `<tr><td>${fmtT(m.t)}</td><td>${esc(fleet.getStructure(m.id)?.label || m.id)}</td><td>${esc(m.action)}</td></tr>`).join('') || '<tr><td colspan="3">Sin acciones registradas.</td></tr>';
      compilado = `
        <h2>2 · Historial de anomalías y advertencias</h2>
        <table><thead><tr><th>Fecha y hora</th><th>Estructura</th><th>Cambio de nivel</th></tr></thead><tbody>${evRows}</tbody></table>
        <h2>3 · Bitácora de mantenimiento</h2>
        <table><thead><tr><th>Fecha y hora</th><th>Estructura</th><th>Acción</th></tr></thead><tbody>${mRows}</tbody></table>`;
    }
    const nAlarm = list.filter(s => { const d = window.shmData?.get(s.id) || {}; return (d.cls || 0) >= 3 || (d.sensors || []).some(x => x.status === 'fault'); }).length;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Informe ReWind — Salud estructural</title>
<style>
  @page { margin: 18mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; line-height: 1.55; margin: 32px auto; max-width: 820px; padding: 0 24px; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #1a1a1a; padding-bottom: 14px; }
  header svg { flex: none; }
  .htxt h1 { font-family: Georgia, serif; font-size: 24px; margin: 0; letter-spacing: .3px; }
  .htxt .meta { color: #666; font-size: 12px; margin-top: 3px; }
  h2 { font-family: Georgia, serif; font-size: 18px; margin: 34px 0 4px; padding-bottom: 5px; border-bottom: 1px solid #0d9488; }
  h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #444; margin: 22px 0 6px; }
  p.lead { color: #444; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 4px 0 6px; }
  th, td { border: 0; border-bottom: 1px solid #d8d8d8; padding: 6px 8px; text-align: left; vertical-align: top; }
  thead th { border-bottom: 1.5px solid #333; font-weight: 600; }
  table.ficha th { width: 42%; font-weight: 600; border-bottom: 1px solid #eee; }
  table.ficha td { border-bottom: 1px solid #eee; }
  .warn { color: #c0271f; font-weight: 700; }
  .cols { display: flex; gap: 22px; align-items: flex-start; }
  .draw { flex: none; }
  .plot { margin: 8px 0 14px; }
  .plot .cap { font-size: 11px; color: #555; margin-bottom: 3px; }
  .plot img { width: 100%; border: 1px solid #e2e2e2; border-radius: 4px; }
  footer { margin-top: 40px; border-top: 1px solid #ccc; padding-top: 10px; color: #777; font-size: 11px; }
  .noprint { position: fixed; top: 14px; right: 14px; }
  .noprint button { font: inherit; padding: 9px 16px; border: 0; border-radius: 8px; background: #0d9488; color: #fff; cursor: pointer; }
  @media print { .noprint { display: none; } body { margin: 0; } }
</style></head><body>
<header>
  <svg width="34" height="40" viewBox="0 0 24 24"><line x1="12" y1="23" x2="12" y2="12" stroke="#0d9488" stroke-width="2" stroke-linecap="round"/><g stroke="#0d9488" stroke-width="2" stroke-linecap="round"><line x1="12" y1="11" x2="12" y2="3"/><line x1="12" y1="11" x2="19" y2="15"/><line x1="12" y1="11" x2="5" y2="15"/></g><circle cx="12" cy="11" r="1.7" fill="#0d9488"/></svg>
  <div class="htxt"><h1>Informe de salud estructural</h1><div class="meta">ReWind ${REWIND_VER} · ${o ? esc(o.label) : 'Informe compilado del parque'} · ${fmtT(Date.now())}</div></div>
</header>
<h2>1 · Resumen de la flota</h2>
<p class="lead">${list.length} estructuras monitoreadas · ${nAlarm ? `<span class="warn">${nAlarm} en alerta</span>` : 'sin alertas activas'}.</p>
<table><thead><tr><th>Estructura</th><th>Tipo</th><th>Altura</th><th>Sensores</th><th>Clasificación ML</th><th>Estado</th></tr></thead><tbody>${rowsHtml}</tbody></table>
${detalle}${compilado}
<footer>Generado por ReWind — plataforma de monitoreo de salud estructural (SHM). Clasificación de daño por servicio ML sobre la telemetría de los acelerómetros MEMS. Documento de carácter informativo.</footer>
<div class="noprint"><button onclick="window.print()">🖨 Imprimir / Guardar PDF</button></div>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) { alert('Permite las ventanas emergentes para ver el informe.'); return; }
    win.document.open(); win.document.write(html); win.document.close();
  }

  return { setStructures, select, onTick, setAlarms, refresh: () => { if (current) renderPane(); } };
}

function startBoot() { boot().catch(e => { console.error('[shm] boot', e); window.__rewindCloseLanding?.(); }); }
if (document.readyState === 'complete') startBoot();
else window.addEventListener('load', startBoot);
