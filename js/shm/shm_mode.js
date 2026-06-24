// ─────────────────────────────────────────────────────────────────────────────
// shm_mode.js — integra el parque eólico (wind-shm) DENTRO del shell de PÓRTICO.
//
// Reutiliza el chrome de PÓRTICO (toolbar, panel, menú, tema) y, bajo `body.shm`:
//   · monta la flota Three.js en el #viewport-container real (oculta el canvas FE),
//   · agrega el botón «Agregar torre» al toolbar,
//   · convierte el panel derecho en el dashboard SHM (Señal·Datos·Estado·Movimiento·Avanzado).
// Los recortes (modelado) los hace shm.css ocultando, no borrando (reversible).
//
// NOTA: el dashboard usa datos de muestra/sintéticos por ahora; el enganche al
// DataSource real (gateway/nube) y a los análisis del gemelo digital viene después.
// ─────────────────────────────────────────────────────────────────────────────
import { FleetView } from './fleet_view.js?v=199';

const F1_REF = 0.283;   // f₁ modelada del macromodelo `turbine` (Hz), línea base SHM

function boot() {
  const container = document.getElementById('viewport-container');
  const toolbar = document.getElementById('toolbar');
  const panel = document.getElementById('panel');
  if (!container || !panel) { console.warn('[shm] shell de PÓRTICO no encontrado'); return; }

  document.body.classList.add('shm');

  // ── Flota en el viewport real de PÓRTICO ──────────────────────────────────
  const fleet = new FleetView(container);
  fleet.renderer.domElement.classList.add('shm-canvas');
  window.shmFleet = fleet;

  // ── Botón «Agregar torre» en el toolbar (estilo .tool) ────────────────────
  if (toolbar) {
    const sep = document.createElement('div'); sep.className = 'tool-sep';
    const btn = document.createElement('button');
    btn.id = 'shm-add-tool'; btn.className = 'tool tool-action';
    btn.title = 'Agregar torre al parque';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg><span>Torre</span>`;
    btn.addEventListener('click', () => fleet.addTurbine());

    // Toggle: detener / reanudar la animación de las aspas
    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'shm-pause-tool'; pauseBtn.className = 'tool tool-action';
    const paintPause = () => {
      pauseBtn.title = fleet.paused ? 'Reanudar animación de aspas' : 'Detener animación de aspas';
      pauseBtn.innerHTML = fleet.paused
        ? `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg><span>Animar</span>`
        : `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span>Detener</span>`;
    };
    pauseBtn.addEventListener('click', () => { fleet.setPaused(!fleet.paused); paintPause(); });
    paintPause();
    toolbar.append(sep, btn, pauseBtn);
  }

  // Zoom-extensión existente → vista general de la flota
  document.getElementById('btn-zoomext')?.addEventListener('click', () => fleet.clearSelection());

  // ── Dashboard SHM en el panel derecho ─────────────────────────────────────
  const dash = buildDashboard(panel);
  fleet.onChange = (n) => dash.setCount(n);
  fleet.onSelect = (t) => dash.select(t);

  // ── 10 torres por defecto para probar todo ────────────────────────────────
  for (let i = 0; i < 10; i++) fleet.addTurbine();
  dash.setCount(fleet.turbines.length);

  // Subestación (torres de alta tensión) + cables de conexión.
  fleet.buildSubstation();

  // Animación de entrada: barrido aéreo que desciende sobre el parque.
  fleet.playIntro();
}

// ── Construcción del dashboard (DOM con tema de PÓRTICO vía variables CSS) ────
function buildDashboard(panel) {
  const el = document.createElement('aside');
  el.id = 'shm-panel';
  el.innerHTML = `
    <div class="shm-head">
      <div class="shm-title">🌬️ Parque eólico — SHM</div>
      <div class="shm-sub">Monitoreo de salud estructural en tiempo real</div>
    </div>
    <div class="shm-fleet">
      <div class="shm-stat"><div class="k">Torres</div><div class="v" id="shm-count">0</div></div>
      <div class="shm-stat"><div class="k">Sensores</div><div class="v" id="shm-sensors">0</div></div>
      <div class="shm-stat"><div class="k">En línea</div><div class="v" style="color:var(--success)" id="shm-online">0</div></div>
    </div>
    <div class="shm-tabs" id="shm-tabs" style="display:none">
      <button class="shm-tab active" data-pane="datos">Datos</button>
      <button class="shm-tab" data-pane="senal">Señal</button>
      <button class="shm-tab" data-pane="estado">Estado</button>
      <button class="shm-tab" data-pane="mov">Movimiento</button>
      <button class="shm-tab" data-pane="avz">Avanzado</button>
    </div>
    <div class="shm-body" id="shm-body">
      <div class="empty">Selecciona una torre en el parque<br>para ver su estado estructural.</div>
    </div>`;
  panel.appendChild(el);

  const $ = (id) => el.querySelector(id);
  let current = null, sigRAF = null;

  // Conmutación de pestañas
  el.querySelectorAll('.shm-tab').forEach(tab => tab.addEventListener('click', () => {
    el.querySelectorAll('.shm-tab').forEach(t => t.classList.toggle('active', t === tab));
    render(tab.dataset.pane);
  }));

  function setCount(n) {
    $('#shm-count').textContent = n;
    $('#shm-sensors').textContent = n * 2;
    $('#shm-online').textContent = n;   // todas en línea (sim)
  }

  function select(t) {
    current = t;
    $('#shm-tabs').style.display = t ? 'flex' : 'none';
    if (!t) { stopSig(); $('#shm-body').innerHTML = '<div class="empty">Selecciona una torre en el parque<br>para ver su estado estructural.</div>'; return; }
    const active = el.querySelector('.shm-tab.active');
    render(active ? active.dataset.pane : 'datos');
  }

  function render(pane) {
    stopSig();
    const t = current; if (!t) return;
    const rpm = (t.spin * 60 / (2 * Math.PI)).toFixed(1);
    const body = $('#shm-body');
    if (pane === 'datos') {
      body.innerHTML = `
        <div class="row"><span>Torre</span><b>${t.id}</b></div>
        <div class="row"><span>Modelo</span><b>~3 MW (ref.)</b></div>
        <div class="row"><span>Rotor</span><b>${rpm} rpm</b></div>
        <div class="row"><span>Viento (sim)</span><b>${(6 + Math.random() * 6).toFixed(1)} m/s</b></div>
        <div class="row"><span>f₁ modelada</span><b>${F1_REF.toFixed(3)} Hz</b></div>
        <div class="row"><span>Enlace gateway</span><b style="color:var(--success)"><span class="light ok"></span>en línea</b></div>
        <div class="note">Datos de muestra. Próximo: enganche al DataSource (gateway/nube) y a la f₁ del gemelo digital.</div>`;
    } else if (pane === 'senal') {
      body.innerHTML = `
        <div class="row" style="border:0"><span>Acelerómetro superior</span><b style="color:#33ff88">acc-top</b></div>
        <canvas class="sig" id="sig-top"></canvas>
        <div class="row" style="border:0"><span>Acelerómetro central</span><b style="color:#33ff88">acc-mid</b></div>
        <canvas class="sig" id="sig-mid"></canvas>
        <div class="note">Forma de onda sintética (2 MEMS). Real-time desde la nube: próximo hito.</div>`;
      startSig();
    } else if (pane === 'estado') {
      const f = (F1_REF * (0.985 + Math.random() * 0.02)).toFixed(3);
      body.innerHTML = `
        <div class="row"><span>Estado estructural</span><b><span class="light ok"></span>Sano</b></div>
        <div class="row"><span>f₁ actual</span><b>${f} Hz</b></div>
        <div class="row"><span>f₁ línea base</span><b>${F1_REF.toFixed(3)} Hz</b></div>
        <div class="row"><span>Desviación</span><b>${(((f - F1_REF) / F1_REF) * 100).toFixed(2)} %</b></div>
        <div class="note">Semáforo por desviación de frecuencia (verde &lt;2% · ámbar 2–5% · rojo &gt;5%). ML poblacional: próximo.</div>`;
    } else if (pane === 'mov') {
      body.innerHTML = `
        <div class="row"><span>Despl. punta (sim)</span><b>${(20 + Math.random() * 30).toFixed(0)} mm</b></div>
        <div class="row"><span>Modo dominante</span><b>1ª flexión fore-aft</b></div>
        <div class="row"><span>RMS aceleración</span><b>${(0.02 + Math.random() * 0.03).toFixed(3)} g</b></div>
        <div class="note">Movimiento estimado de la torre. Se alimentará del time-history del gemelo digital.</div>`;
    } else {
      body.innerHTML = `
        <div class="note" style="font-size:13px;color:var(--text)">Vista avanzada (gemelo digital):</div>
        <ul style="margin:8px 0 0 16px;font-size:12px;color:var(--text-muted);line-height:1.9">
          <li>FFT / PSD de cada sensor</li>
          <li>Seguimiento de frecuencias naturales</li>
          <li>Diagramas N/V/M de la torre</li>
          <li>Análisis no lineal de daño (rótulas, p–y)</li>
          <li>Conteo de fatiga (rainflow)</li>
        </ul>
        <div class="note">Se enganchará al solver de PÓRTICO (modal, time-history, P-Δ) que conservamos.</div>`;
    }
  }

  // Sparklines sintéticas de los 2 acelerómetros
  function startSig() {
    const cTop = $('#sig-top'), cMid = $('#sig-mid');
    if (!cTop || !cMid) return;
    const draw = (cv, freqHz, amp, phase, t) => {
      const dpr = Math.min(devicePixelRatio, 2);
      const w = cv.clientWidth, h = cv.clientHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      const g = cv.getContext('2d'); g.scale(dpr, dpr);
      g.clearRect(0, 0, w, h);
      g.strokeStyle = '#33ff88'; g.lineWidth = 1.5; g.beginPath();
      for (let x = 0; x < w; x++) {
        const tt = t + x / w * 2;
        const y = h / 2 + amp * h * 0.35 * (Math.sin(tt * freqHz * 6.28 + phase) + 0.4 * Math.sin(tt * freqHz * 18 + phase) + 0.3 * (Math.random() - 0.5));
        x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    };
    const loop = () => {
      const t = performance.now() / 1000;
      draw(cTop, F1_REF, 1.0, 0, t);
      draw(cMid, F1_REF, 0.55, 1.7, t);   // el central oscila menos que la punta
      sigRAF = requestAnimationFrame(loop);
    };
    loop();
  }
  function stopSig() { if (sigRAF) { cancelAnimationFrame(sigRAF); sigRAF = null; } }

  return { setCount, select };
}

// Arrancar cuando el shell de PÓRTICO ya está montado.
if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot);
