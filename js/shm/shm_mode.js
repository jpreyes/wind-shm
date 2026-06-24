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
import { FleetView } from './fleet_view.js?v=199';
import { DataSource } from './data_source.js?v=199';
import { computeTwin } from './digital_twin.js?v=199';

const F1_BASE = { turbine: 0.283, hv: 1.6 };
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

  // Estado de reconocimiento/informe de anomalías
  const ack = new Set(), informed = new Set(), rawAnom = new Set();
  const actions = {
    isAnom: (id) => rawAnom.has(id),
    isAck: (id) => ack.has(id),
    isInformed: (id) => informed.has(id),
    dismiss: (id) => { ack.has(id) ? ack.delete(id) : ack.add(id); },
    report: (obj) => { informed.add(obj.id); downloadReport(obj); },
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
      <div class="shm-title">🌬️ ReWind — SHM</div>
      <div class="shm-sub">Salud estructural del parque en tiempo real</div>
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
      <div class="shm-body" id="shm-pane"></div>`;
    _abKey = '';
    updateAlarmBar();
    el.querySelectorAll('.shm-tab').forEach(t => t.addEventListener('click', () => { pane = t.dataset.p; renderPane(); }));
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

  return { setStructures, select, onTick, setAlarms, refresh: () => { if (current) renderPane(); } };
}

function startBoot() { boot().catch(e => { console.error('[shm] boot', e); window.__rewindCloseLanding?.(); }); }
if (document.readyState === 'complete') startBoot();
else window.addEventListener('load', startBoot);
