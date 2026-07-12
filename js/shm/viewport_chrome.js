// ─────────────────────────────────────────────────────────────────────────────
// viewport_chrome.js — overlays flotantes sobre el visor 3D de ReWind (extraído
// de shm_mode.js). Cada builder crea su elemento, lo cuelga del viewport y
// devuelve una pequeña API. Sin estado del boot: reciben `fleet`/`vpwrap` y usan
// i18n + globals de window (shmMap). Aligera el módulo principal.
// ─────────────────────────────────────────────────────────────────────────────
import { compassRoseSVG } from './compass.js?v=322';
import { t } from './i18n.js?v=322';

// Control de sombra (Shadow flicker): hora/fecha/escala + animación del día.
export function buildSunControl(fleet) {
  const wrap = document.getElementById('viewport-wrap') || document.body;
  const el = document.createElement('div');
  el.id = 'shm-sun'; el.className = 'shm-sun';
  const isoToday = new Date().toISOString().slice(0, 10);
  el.innerHTML = `
    <div class="sun-head"><span class="sun-title">Shadow · estudio de sombra</span><span class="sun-read" id="sun-read">—</span></div>
    <label class="sun-ctl"><span>Hora</span><input type="range" id="sun-hour" min="0" max="24" step="0.25" value="13"><b id="sun-hh">13:00</b></label>
    <label class="sun-ctl"><span>Fecha</span><input type="date" id="sun-date" value="${isoToday}" min="2015-01-01" max="2040-12-31"></label>
    <label class="sun-real"><input type="checkbox" id="sun-realscale" checked> Escala real <span class="sun-hint">(sombra fiel)</span></label>
    <div class="sun-foot"><button id="sun-play" class="sun-btn" type="button">▶ Animar el día</button></div>
    <div class="sun-foot"><button id="sun-fmap" class="sun-btn js-fmap" type="button">🗺️ Mapa de flicker</button></div>
    <div class="sun-legend"><span><i style="background:#bee678"></i>1–5</span><span><i style="background:#fde047"></i>5–15</span><span><i style="background:#fb923c"></i>15–30</span><span><i style="background:#ef4444"></i>≥30 ✗</span></div>
    <div class="sun-hint" style="margin:7px 0 0">Informes y receptores → pestaña <b>Shadow flicker</b> (panel derecho).</div>`;
  wrap.appendChild(el);
  const hourEl = el.querySelector('#sun-hour'), dateEl = el.querySelector('#sun-date'), realEl = el.querySelector('#sun-realscale');
  const hh = el.querySelector('#sun-hh'), read = el.querySelector('#sun-read'), playBtn = el.querySelector('#sun-play');
  el.querySelector('#sun-fmap').addEventListener('click', () => { window.shmMap?.toggleFlickerMap(); window.shmSyncFlickerBtns?.(); });
  const fmtH = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;
  const apply = () => {
    const hour = +hourEl.value;
    const [Y, M, D] = (dateEl.value || isoToday).split('-').map(Number);
    fleet.setSunTime({ year: Y, month0: M - 1, day: D, hour });
    hh.textContent = fmtH(hour);
    const sp = fleet.getSunInfo();
    read.textContent = sp ? (sp.elevation > 0 ? `alt ${sp.elevation.toFixed(0)}° · az ${sp.azimuth.toFixed(0)}°` : '☾ noche') : '';
    window.shmMap?.setSunShadows(true, sp);   // sincroniza la sombra del mapa 2D
  };
  hourEl.addEventListener('input', apply);
  dateEl.addEventListener('change', apply);
  realEl.addEventListener('change', () => fleet.setRealScale(realEl.checked));
  // Animación del día con setInterval + paso de 0.25 h (alineado al step del slider,
  // así no lo «encaja» de vuelta; el rAF con pasos < step quedaba estancado).
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } playBtn.textContent = '▶ Animar el día'; };
  playBtn.addEventListener('click', () => {
    if (timer) { stop(); return; }
    playBtn.textContent = '⏸ Pausar';
    timer = setInterval(() => { let h = +hourEl.value + 0.25; if (h >= 24) h -= 24; hourEl.value = h.toFixed(2); apply(); }, 90);   // ~día completo en 9 s
  });
  return { setOpen(on) { el.classList.toggle('show', on); if (on) { realEl.checked = fleet.realScale; apply(); } else stop(); } };
}

// Rosa de los vientos (3D): gira con la cámara para indicar el Norte.
export function buildCompass(vpwrap, fleet) {
  const el = document.createElement('div');
  el.id = 'shm-compass'; el.title = 'Rosa de los vientos · Norte';
  el.innerHTML = compassRoseSVG();
  (vpwrap || document.body).appendChild(el);
  const rose = el.querySelector('.cmp-rose'), nlbl = el.querySelector('.cmp-nl');
  return { update() {
    if (!rose) return;
    const rot = fleet.northScreenAngle();
    rose.setAttribute('transform', `rotate(${rot.toFixed(1)})`);
    if (nlbl) nlbl.setAttribute('transform', `rotate(${(-rot).toFixed(1)} 0 -39)`);   // la «N» se mantiene legible
  } };
}

// Nameplate (cuadro con el nombre sobre la vista).
export function buildNameplate(vpwrap) {
  const el = document.createElement('div');
  el.id = 'shm-nameplate';
  el.innerHTML = `<span class="np-dot"></span><span class="np-name">—</span><span class="np-type">—</span><span class="np-alarm">${t('np.anom')}</span>`;
  (vpwrap || document.body).appendChild(el);
  return {
    show(obj) {
      if (!obj) { el.classList.remove('show'); return; }
      el.querySelector('.np-name').textContent = obj.label;
      el.querySelector('.np-type').textContent = obj.type === 'hv' ? t('det.typeHV') : `${t('det.typeTurbine')} · ${obj.power || ''}`;
      el.classList.add('show');
    },
    alarm(on) { el.classList.toggle('alarm', !!on); },
  };
}

// Banner de emergencia (titilante) sobre la vista.
export function buildBanner(vpwrap) {
  const el = document.createElement('div');
  el.id = 'shm-banner';
  el.innerHTML = `<span class="b-ico">⚠</span><span class="b-txt"></span>`;
  (vpwrap || document.body).appendChild(el);
  return {
    update(labels) {
      if (!labels.length) { el.classList.remove('show'); return; }
      const n = labels.length;
      el.querySelector('.b-txt').textContent =
        `${t('banner.anom')} — ${labels.slice(0, 3).join(', ')}${n > 3 ? t('banner.more', n - 3) : ''}`;
      el.classList.add('show');
    },
  };
}

// Redimensiona el panel derecho arrastrando el divisor (#panel-resize-handle).
// Ajusta la variable CSS --panel-w del grid (#main).
export function initPanelResize() {
  const handle = document.getElementById('panel-resize-handle');
  const main = document.getElementById('main');
  if (!handle || !main) return;
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    const w = parseInt(getComputedStyle(main).getPropertyValue('--panel-w')) || document.getElementById('panel')?.offsetWidth || 300;
    drag = { x: e.clientX, w }; handle.classList.add('dragging');
    handle.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const nw = Math.max(240, Math.min(640, drag.w + (drag.x - e.clientX)));   // el panel está a la derecha → arrastrar a la izq agranda
    main.style.setProperty('--panel-w', nw + 'px');
  });
  const end = () => { if (drag) { drag = null; handle.classList.remove('dragging'); } };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
