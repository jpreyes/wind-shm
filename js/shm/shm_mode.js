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

function boot() {
  const container = document.getElementById('viewport-container');
  const toolbar = document.getElementById('toolbar');
  const panel = document.getElementById('panel');
  const vpwrap = document.getElementById('viewport-wrap');
  if (!container || !panel) { console.warn('[shm] shell de PÓRTICO no encontrado'); return; }

  document.body.classList.add('shm');

  const fleet = new FleetView(container);
  fleet.renderer.domElement.classList.add('shm-canvas');
  window.shmFleet = fleet;

  buildToolbar(toolbar, fleet);
  const nameplate = buildNameplate(vpwrap);
  const dash = buildDashboard(panel, fleet);

  document.getElementById('btn-zoomext')?.addEventListener('click', () => fleet.clearSelection());
  document.title = 'ReWind — SHM de torres eólicas';

  // ── DataSource: simulación (Web Worker) o nube (?live=wss://…) ─────────────
  const liveUrl = new URLSearchParams(location.search).get('live');
  const ds = new DataSource(liveUrl ? { liveUrl } : {});
  window.shmData = ds;
  ds.onTick = (msg) => {
    for (const id in msg.summaries)
      for (const se of msg.summaries[id].sensors) fleet.setSensorStatus(id, se.id, se.status);
    dash.onTick(msg);
  };

  // ── Flota + subestación: restaurar el orden guardado o sembrar por defecto ──
  const saved = loadLayout();
  if (saved && saved.turbines?.length) {
    for (const p of saved.turbines) fleet.addTurbine({ pos: p });
    fleet.buildSubstation();
    while (fleet.substation.towers.length < (saved.hv?.length || 2)) fleet.addHVTower();
    fleet.substation.towers.forEach((h, i) => { const p = saved.hv?.[i]; if (p) h.group.position.set(p.x, 0, p.z); });
    fleet.rebuildCables();
  } else {
    for (let i = 0; i < 10; i++) fleet.addTurbine();
    fleet.buildSubstation();
  }

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

  // ── Gemelo digital: f₁ real por el solver modal de PÓRTICO (async) ─────────
  setTimeout(() => {
    const tw = computeTwin();
    window.shmTwin = tw;
    if (tw.turbine) F1_BASE.turbine = tw.turbine;
    if (tw.hv) F1_BASE.hv = tw.hv;
    syncData();           // re-init worker con las f₁ del gemelo
    dash.refresh();
  }, 1400);
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
  el.innerHTML = `<span class="np-dot"></span><span class="np-name">—</span><span class="np-type">—</span>`;
  (vpwrap || document.body).appendChild(el);
  return {
    show(obj) {
      if (!obj) { el.classList.remove('show'); return; }
      el.querySelector('.np-name').textContent = obj.label;
      el.querySelector('.np-type').textContent = obj.type === 'hv' ? 'Torre de alta tensión' : `Aerogenerador · ${obj.power || ''}`;
      el.classList.add('show');
    },
  };
}

// ── Dashboard SHM ────────────────────────────────────────────────────────────
function buildDashboard(panel, fleet) {
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
    </div>
    <div class="shm-listwrap">
      <div class="shm-list-h">Estructuras del parque</div>
      <div class="shm-list" id="shm-list"></div>
    </div>
    <div class="shm-detail" id="shm-detail"><div class="empty">Selecciona una estructura<br>(en la lista o en la vista).</div></div>`;
  panel.appendChild(el);
  const $ = (s) => el.querySelector(s);

  let list = [], current = null, pane = 'datos', sigBuf = {}, sigRAF = null;

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

  function select(obj) {
    current = obj; highlight();
    sigBuf = {};
    if (!obj) { stopSig(); $('#shm-detail').innerHTML = '<div class="empty">Selecciona una estructura<br>(en la lista o en la vista).</div>'; return; }
    renderDetail();
  }

  function renderDetail() {
    const o = current; if (!o) return;
    $('#shm-detail').innerHTML = `
      <div class="shm-tabs">
        <button class="shm-tab" data-p="datos">Datos</button>
        <button class="shm-tab" data-p="senal">Señal</button>
        <button class="shm-tab" data-p="sensores">Sensores</button>
        <button class="shm-tab" data-p="insp">Inspección</button>
      </div>
      <div class="shm-body" id="shm-pane"></div>`;
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
        <div class="row"><span>Estado</span><b><span class="light ${light}" id="d-light"></span><span id="d-state">${light === 'ok' ? 'Sano' : light === 'warn' ? 'Vigilar' : 'Alerta'}</span></b></div>
        <div class="row"><span>Índice de daño</span><b id="d-dmg">${dmg}%</b></div>`;
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
      row.querySelector('.dot').className = 'dot' + (sum.sensors.some(x => x.status === 'fault') ? ' fault' : '');
    }
    // buffers de señal de la estructura enfocada
    if (current && msg.waves[current.id]) {
      for (const w of msg.waves[current.id]) {
        (sigBuf[w.id] || (sigBuf[w.id] = [])).push(...w.samples);
        const buf = sigBuf[w.id]; if (buf.length > 700) buf.splice(0, buf.length - 700);
      }
    }
    if (current) updateDynamic(msg.summaries[current.id]);
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

  return { setStructures, select, onTick, refresh: () => { if (current) renderPane(); } };
}

if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot);
