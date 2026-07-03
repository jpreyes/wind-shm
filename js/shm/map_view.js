// ─────────────────────────────────────────────────────────────────────────────
// map_view.js — vista 2D «exacta» del parque (Leaflet) para navegar/ubicar.
//
// Mapa 2D rápido (tiles) con las torres como marcadores desde sus coordenadas
// reales (lat/lon). Basemaps: Esri World Imagery (satélite) + OpenTopoMap (curvas).
// Click en un marcador → conmuta a la vista 3D enfocando esa estructura (onPick).
// Leaflet se carga como global (window.L) desde lib/leaflet/leaflet.js.
// ─────────────────────────────────────────────────────────────────────────────
import { CAMAN_CENTER } from './parks_data_caman.js?v=299';
import { CAMAN_ROADS } from './caman_roads.js?v=299';
import { compassRoseSVG } from './compass.js?v=299';
import { annualFlicker, flickerOK, FLICKER_LIMITS, REAL_CASE_FACTOR, flickerMap, criticalWindow, interTurbineShading } from './shadow_flicker.js?v=299';
import { realCaseWeight, METEO_CAMAN } from './meteo_caman.js?v=299';
import { parseReceptorFile } from './receptor_import.js?v=299';
import { esc } from './util.js?v=299';
import { t, getLang } from './i18n.js?v=299';

const REAL_W = (month, antiAz) => realCaseWeight(month, antiAz, METEO_CAMAN);   // ponderador meteo del sitio

// Color del marcador según el avance de obra (coherente con el 4D / panel).
function colorFor(st) {
  if (st.alarm) return '#ef4444';
  const b = st.built != null ? st.built : 1;
  if (b >= 0.97) return '#22c55e';     // operativa
  if (b <= 0.02) return '#94a3b8';     // solo fundación
  return '#f59e0b';                    // en montaje
}

// Mini-icono de aerogenerador (fuste + buje + 3 aspas) coloreado por estado.
function turbineIcon(color) {
  return window.L.divIcon({ className: 'wt-icon', iconSize: [26, 34], iconAnchor: [13, 30], tooltipAnchor: [0, -26],
    html: `<svg width="26" height="34" viewBox="0 0 26 34">
      <line x1="13" y1="33" x2="13" y2="13" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
      <g stroke="${color}" stroke-width="2.2" stroke-linecap="round"><line x1="13" y1="12" x2="13" y2="3"/><line x1="13" y1="12" x2="21" y2="16"/><line x1="13" y1="12" x2="5" y2="16"/></g>
      <circle cx="13" cy="12" r="2.4" fill="${color}"/></svg>` });
}
// Mini-icono de torre de alta tensión (celosía).
function atIcon(color) {
  return window.L.divIcon({ className: 'at-icon', iconSize: [24, 32], iconAnchor: [12, 29], tooltipAnchor: [0, -25],
    html: `<svg width="24" height="32" viewBox="0 0 24 32" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round">
      <path d="M6 31 L9.5 4 M18 31 L14.5 4 M9.5 4 H14.5 M7.2 24 H16.8 M8.2 17 H15.8 M9.2 11 H14.8 M3 21 L9.5 13 M21 21 L14.5 13"/></svg>` });
}
const iconFor = (st) => st.type === 'hv' ? atIcon(colorFor(st)) : turbineIcon(colorFor(st));

const M_PER_DEG_LAT = 111320;

// Calendario de parpadeo mes×hora (la gráfica «de facto» del software del rubro):
// celdas coloreadas por minutos/año de sombra → revela la ventana crítica del receptor.
// Tema claro (el informe se abre en ventana blanca imprimible).
function shadowCalendarSVG(cal) {
  let h0 = 24, h1 = -1;
  for (let mo = 0; mo < 12; mo++) for (let h = 0; h < 24; h++) { if (cal[mo * 24 + h] > 0) { if (h < h0) h0 = h; if (h > h1) h1 = h; } }
  if (h1 < 0) return `<p class="muted">${t('mv.calNone')}</p>`;
  h0 = Math.max(0, h0 - 1); h1 = Math.min(23, h1 + 1);
  const cw = 30, chh = 15, mx = 42, my = 22, rows = h1 - h0 + 1, W = mx + 12 * cw + 8, H = my + rows * chh + 8;
  const color = (v) => v <= 0 ? '#eef2f7' : v >= 300 ? '#ef4444' : v >= 120 ? '#fb923c' : v >= 30 ? '#fde047' : '#bee678';
  let s = '';
  const MES = t('months.ini');
  for (let mo = 0; mo < 12; mo++) s += `<text x="${mx + mo * cw + cw / 2}" y="${my - 6}" text-anchor="middle" font-size="10" fill="#64748b">${MES[mo]}</text>`;
  for (let h = h0; h <= h1; h++) {
    const y = my + (h - h0) * chh;
    s += `<text x="${mx - 7}" y="${y + chh - 4}" text-anchor="end" font-size="9" fill="#64748b">${String(h).padStart(2, '0')}h</text>`;
    for (let mo = 0; mo < 12; mo++) s += `<rect x="${mx + mo * cw}" y="${y}" width="${cw - 1.5}" height="${chh - 1.5}" rx="1.5" fill="${color(cal[mo * 24 + h])}"/>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">${s}</svg>`;
}

export class MapView {
  /** @param {HTMLElement} el  @param {object} fleet  @param {object} o {onPick} */
  constructor(el, fleet, o = {}) {
    this.el = el; this.fleet = fleet; this.onPick = o.onPick || (() => {});
    this.onToggleFull = o.onToggleFull || (() => {});
    this.markers = new Map();
    this._build();
  }

  _build() {
    const L = window.L;
    if (!L) { console.warn('[shm] Leaflet no disponible'); return; }
    // maxNativeZoom evita los tiles «no image»: más allá del nivel nativo, Leaflet
    // re-escala el último tile disponible en vez de mostrar el hueco gris.
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 17, maxZoom: 20, attribution: 'Imagery © Esri' });   // 17 = última cota con imagen en la zona (evita «Map data not yet available»)
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      { maxNativeZoom: 17, maxZoom: 20, attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap' });
    this.map = L.map(this.el, { center: [CAMAN_CENTER.lat, CAMAN_CENTER.lon], zoom: 12, layers: [sat], zoomControl: true, maxZoom: 20 });
    L.control.layers({ [t('mv.satellite')]: sat, [t('mv.topo')]: topo }, null, { position: 'topright' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);   // barra de escala (métrica)
    // Rosa de los vientos (fija, norte-arriba: el mapa no rota).
    const RoseCtl = L.Control.extend({ onAdd() { const d = L.DomUtil.create('div', 'mv-rose'); d.innerHTML = compassRoseSVG(); return d; } });
    this.map.addControl(new RoseCtl({ position: 'bottomleft' }));   // sobre la barra de escala; no choca con la atribución (bottomright)

    // Botón de pantalla completa / restaurar (ventana auxiliar PiP ⇄ completa).
    const self = this;
    const FullBtn = L.Control.extend({ onAdd() {
      const b = L.DomUtil.create('button', 'mv-full'); b.type = 'button'; b.innerHTML = '⤢';
      b.title = t('mv.fullscreen');
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); self.onToggleFull(); });
      return b;
    } });
    this.map.addControl(new FullBtn({ position: 'topleft' }));

    // Doble-click maximiza / restaura (en vez del zoom por doble-click de Leaflet).
    this.map.doubleClickZoom.disable();
    this.map.on('dblclick', () => this.onToggleFull());

    // Recalcular tamaño del mapa cuando cambia el contenedor.
    if (window.ResizeObserver) { this._ro = new ResizeObserver(() => this.map && this.map.invalidateSize()); this._ro.observe(this.el); }
    this._addResizeHandle();
    // Caminos primero (debajo de los marcadores).
    this.roadsLayer = L.layerGroup().addTo(this.map);
    for (const seg of CAMAN_ROADS) {
      L.polyline(seg.map(([lo, la]) => [la, lo]), { color: '#f4d58d', weight: 3, opacity: 0.85 }).addTo(this.roadsLayer);
      L.polyline(seg.map(([lo, la]) => [la, lo]), { color: '#6b5836', weight: 5, opacity: 0.35 }).addTo(this.roadsLayer).bringToBack();
    }
    this.markersLayer = L.layerGroup().addTo(this.map);
    this.recepLayer = L.layerGroup().addTo(this.map);          // receptores del estudio de sombra
    // En modo Sol, clic en el mapa coloca un receptor (vivienda) y calcula su flicker.
    this.map.on('click', (e) => { if (this.sunMode) this.addReceptor(e.latlng); });
  }

  // Agrega un receptor (vivienda) y calcula su parpadeo de sombra anual worst-case.
  // opts: {name, silent (no abre popup ni refresca — para importación en lote), stepMin}
  addReceptor(latlng, opts = {}) {
    const L = window.L; if (!L) return;
    const res = annualFlicker(this.fleet.structures, { lat: latlng.lat, lon: latlng.lng }, { stepMin: opts.stepMin ?? 2, realWeightFn: REAL_W });
    const ok = flickerOK(res);
    const col = ok ? '#22c55e' : '#ef4444';
    const icon = L.divIcon({ className: 'rcp-icon', iconSize: [22, 22], iconAnchor: [11, 11],
      html: `<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" fill="${col}" stroke="#0b1018" stroke-width="1.5"/><path d="M6 11 L11 6.5 L16 11 M7.5 10 V16 H14.5 V10" fill="none" stroke="#0b1018" stroke-width="1.4" stroke-linejoin="round"/></svg>` });
    const m = L.marker(latlng, { icon }).addTo(this.recepLayer);
    const win = criticalWindow(res.cal);
    this._receptors ||= [];
    const n = (this._recSeq = (this._recSeq || 0) + 1);   // contador monótono (estable ante borrados)
    const name = (opts.name || '').trim();
    const entry = { n, name, lat: latlng.lat, lon: latlng.lng, res, ok, win, marker: m };
    this._receptors.push(entry);
    if (name) m.bindTooltip(esc(name), { direction: 'top' });
    m.bindPopup(
      `<b>${name ? esc(name) : t('ssh.rcpName', n)}</b><br>${t('mv.worst')}: <b>${res.hoursYear.toFixed(1)} ${t('ssh.hYear')}</b> · ${t('ssh.minDay', res.maxMinDay)}<br>` +
      `${t('mv.popReal', res.hoursYearReal.toFixed(1))}<br>` +
      `${t('mv.popDays', res.daysAffected)}<br>` +
      (win ? `${t('mv.popShutdown', win.months, win.hours)}<br>` : '') +
      `<span style="color:${col}">${ok ? t('frep.badgeOk') : t('frep.badgeBad')}</span>${t('mv.popLimit', FLICKER_LIMITS.hoursYear, FLICKER_LIMITS.minDay)}<br>` +
      `<a href="#" class="rcp-del">${t('mv.popRemove')}</a>`
    );
    if (!opts.silent) m.openPopup();
    m.on('popupopen', (ev) => { const a = ev.popup.getElement()?.querySelector('.rcp-del'); a && a.addEventListener('click', (x) => { x.preventDefault(); this.recepLayer.removeLayer(m); this._receptors = this._receptors.filter(r => r !== entry); window.shmDash?.refreshShadow?.(); }); });
    if (!opts.silent) window.shmDash?.refreshShadow?.();   // refresca la lista de la pestaña Shadow flicker
    return entry;                         // {n, name, lat, lon, res, ok, win, marker} — usado por la ficha 3D / importación
  }

  // Importa receptores desde un archivo (CSV/KML/KMZ/GeoJSON/SHP) y los calcula en lote.
  async importReceptors(file) {
    let pts;
    try { pts = await parseReceptorFile(file); }
    catch (err) { alert(t('mv.impFail', err.message || err)); return 0; }
    if (!pts.length) { alert(t('mv.impNone', file.name)); return 0; }
    if (!this.sunMode) this.sunMode = true;   // permite importar aunque el clic-receptor esté inactivo
    for (const p of pts) this.addReceptor({ lat: p.lat, lng: p.lon }, { name: p.name, silent: true, stepMin: 5 });
    if (this._receptors?.length) { try { this.map.fitBounds(this._receptors.map(r => [r.lat, r.lon]), { padding: [40, 40] }); } catch {} }
    window.shmDash?.refreshShadow?.();
    alert(t('mv.impOk', pts.length, file.name));
    return pts.length;
  }

  // Quita un receptor por su número (desde la pestaña Shadow flicker del panel).
  removeReceptor(n) {
    const e = (this._receptors || []).find(r => r.n === n);
    if (!e) return;
    this.recepLayer.removeLayer(e.marker);
    this._receptors = this._receptors.filter(r => r !== e);
    window.shmDash?.refreshShadow?.();
  }

  clearReceptors() { this.recepLayer?.clearLayers(); this._receptors = []; window.shmDash?.refreshShadow?.(); }

  // Mapa de flicker (horas/año) sobre el área — salida estilo software del rubro. Toggle.
  toggleFlickerMap() {
    const L = window.L; if (!L || !this.map) return false;
    if (this._flickerOverlay) { this.map.removeLayer(this._flickerOverlay); this._flickerOverlay = null; this.fleet.clearFlickerSurface?.(); return false; }
    const lats = [], lons = [];
    for (const t of this.fleet.structures) { if (t.type !== 'hv' && t.lat != null && (t.built ?? 1) >= 0.97) { lats.push(t.lat); lons.push(t.lon); } }
    if (!lats.length) { alert(t('mv.noTurbMap')); return false; }
    const pad = 0.018;
    const bbox = { lat0: Math.min(...lats) - pad, lat1: Math.max(...lats) + pad, lon0: Math.min(...lons) - pad, lon1: Math.max(...lons) + pad };
    const map = flickerMap(this.fleet.structures, bbox, { nx: 160, ny: 110, stepMin: 15 });
    const cv = document.createElement('canvas'); cv.width = map.nx; cv.height = map.ny;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(map.nx, map.ny);
    for (let i = 0; i < map.hours.length; i++) {
      const h = map.hours[i]; let r = 0, g = 0, b = 0, a = 0;
      if (h >= 30) { r = 239; g = 68; b = 68; a = 165; }        // excede el límite (rojo)
      else if (h >= 15) { r = 251; g = 146; b = 60; a = 140; }   // alto (naranja)
      else if (h >= 5) { r = 253; g = 224; b = 71; a = 120; }    // moderado (amarillo)
      else if (h >= 1) { r = 190; g = 230; b = 120; a = 90; }    // bajo (verde)
      const k = i * 4; img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    const bounds = [[bbox.lat0, bbox.lon0], [bbox.lat1, bbox.lon1]];
    this._flickerOverlay = L.imageOverlay(cv.toDataURL(), bounds, { opacity: 0.6, interactive: false }).addTo(this.map);
    this.map.fitBounds(bounds);
    this.fleet.setFlickerSurface?.(cv, bbox);     // también drapeado sobre el relieve en 3D
    return true;
  }
  clearFlickerMap() { if (this._flickerOverlay) { this.map.removeLayer(this._flickerOverlay); this._flickerOverlay = null; } this.fleet.clearFlickerSurface?.(); }

  // Mapa de iso-sombra del parque (heatmap h/año + turbinas + receptores + N + escala)
  // como PNG dataURL para incrustar en el informe — la lámina típica del rubro.
  _siteMapDataURL(receptors) {
    const lats = [], lons = [];
    for (const t of this.fleet.structures) { if (t.lat != null && t.type !== 'hv') { lats.push(t.lat); lons.push(t.lon); } }
    for (const r of receptors) { lats.push(r.lat); lons.push(r.lon); }
    if (!lats.length) return null;
    const pad = 0.012;
    const bbox = { lat0: Math.min(...lats) - pad, lat1: Math.max(...lats) + pad, lon0: Math.min(...lons) - pad, lon1: Math.max(...lons) + pad };
    let fm = null;
    try { fm = flickerMap(this.fleet.structures, bbox, { nx: 150, ny: 105, stepMin: 20 }); } catch (e) { console.warn('[shm] flickerMap para informe falló', e); }
    const latC = (bbox.lat0 + bbox.lat1) / 2, mLon = M_PER_DEG_LAT * Math.cos(latC * Math.PI / 180);
    const W = 780, hM = (bbox.lat1 - bbox.lat0) * M_PER_DEG_LAT, wM = (bbox.lon1 - bbox.lon0) * mLon;
    const Hc = Math.max(220, Math.round(W * hM / wM));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = Hc;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#eef3f8'; ctx.fillRect(0, 0, W, Hc);
    if (fm) {
      const off = document.createElement('canvas'); off.width = fm.nx; off.height = fm.ny;
      const octx = off.getContext('2d'), img = octx.createImageData(fm.nx, fm.ny);
      for (let i = 0; i < fm.hours.length; i++) {
        const h = fm.hours[i]; let r = 0, g = 0, b = 0, a = 0;
        if (h >= 30) { r = 239; g = 68; b = 68; a = 200; } else if (h >= 15) { r = 251; g = 146; b = 60; a = 170; }
        else if (h >= 5) { r = 253; g = 224; b = 71; a = 145; } else if (h >= 1) { r = 190; g = 230; b = 120; a = 115; }
        const k = i * 4; img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = a;
      }
      octx.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, W, Hc);
    }
    const px = (lat, lon) => [(lon - bbox.lon0) / (bbox.lon1 - bbox.lon0) * W, (bbox.lat1 - lat) / (bbox.lat1 - bbox.lat0) * Hc];
    // Caminos (tenues)
    ctx.strokeStyle = 'rgba(120,90,40,.35)'; ctx.lineWidth = 2;
    for (const seg of CAMAN_ROADS) { ctx.beginPath(); seg.forEach(([lo, la], i) => { const [x, y] = px(la, lo); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
    // Turbinas (triángulo, color por avance)
    for (const t of this.fleet.structures) {
      if (t.lat == null || t.type === 'hv') continue;
      const [x, y] = px(t.lat, t.lon), b = t.built ?? 1;
      ctx.fillStyle = b >= 0.97 ? '#15803d' : b <= 0.02 ? '#64748b' : '#d97706'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y + 4); ctx.lineTo(x + 5, y + 4); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // Receptores (círculo verde/rojo + etiqueta)
    ctx.font = 'bold 12px system-ui, sans-serif';
    for (const r of receptors) {
      const [x, y] = px(r.lat, r.lon);
      ctx.fillStyle = r.ok ? '#16a34a' : '#dc2626'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText('#' + r.n, x + 8, y + 4);
      ctx.fillStyle = '#0b1018'; ctx.fillText('#' + r.n, x + 8, y + 4);
    }
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, W - 1, Hc - 1);
    // Norte
    ctx.save(); ctx.translate(W - 28, 36); ctx.fillStyle = '#1b2533';
    ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(6, 8); ctx.lineTo(0, 2); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill();
    ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center'; ctx.fillText('N', 0, -19); ctx.restore();
    // Barra de escala
    const mPerPx = wM / W, nice = [100, 200, 500, 1000, 2000, 5000];
    const targetM = nice.reduce((a, b) => Math.abs(b / mPerPx - 110) < Math.abs(a / mPerPx - 110) ? b : a, nice[0]);
    const barPx = targetM / mPerPx;
    ctx.fillStyle = 'rgba(255,255,255,.82)'; ctx.fillRect(12, Hc - 32, barPx + 16, 24);
    ctx.strokeStyle = '#1b2533'; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(20, Hc - 13); ctx.lineTo(20 + barPx, Hc - 13); ctx.moveTo(20, Hc - 17); ctx.lineTo(20, Hc - 9); ctx.moveTo(20 + barPx, Hc - 17); ctx.lineTo(20 + barPx, Hc - 9); ctx.stroke();
    ctx.fillStyle = '#1b2533'; ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(targetM >= 1000 ? (targetM / 1000) + ' km' : targetM + ' m', 24, Hc - 19);
    return cv.toDataURL('image/png');
  }

  // Informe COMPLETO de shadow-flicker estilo software de la industria:
  // resumen ejecutivo, parámetros, mapa de iso-sombra, ficha por receptor con
  // calendario mes×hora, tabla de cumplimiento y programa de turbinas → imprimible.
  flickerReport() {
    const rs = this._receptors || [];
    if (!rs.length) { alert(t('mv.addRcpFirst')); return; }
    const nEx = rs.filter(r => !r.ok).length, nOk = rs.length - nEx;
    const verdict = nEx ? { t: t('frep.verdNo', nEx, rs.length), c: 'bad' }
                        : { t: t('frep.verdOk', rs.length), c: 'ok' };
    const turbs = this.fleet.structures.filter(s => s.lat != null && s.type !== 'hv');
    const nOp = turbs.filter(s => (s.built ?? 1) >= 0.97).length;
    const labelById = new Map(this.fleet.structures.map(s => [s.id, s.label || s.id]));
    const gen = new Date().toLocaleString(getLang() === 'en' ? 'en-GB' : 'es-CL');
    const siteImg = this._siteMapDataURL(rs);

    const badge = (ok) => `<span class="badge ${ok ? 'ok' : 'bad'}">${ok ? t('frep.badgeOk') : t('frep.badgeBad')}</span>`;
    const calLegend = `<div class="leg"><span><i style="background:#bee678"></i>&lt;30</span><span><i style="background:#fde047"></i>30–120</span><span><i style="background:#fb923c"></i>120–300</span><span><i style="background:#ef4444"></i>≥300 ${t('frep.calLegUnit')}</span></div>`;

    // Ficha por receptor (la sección rica del informe)
    const cards = rs.map(r => {
      const top = [...r.res.byTurbine.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([id, min]) => `${labelById.get(id)} (${(min / 60).toFixed(1)} h)`).join(', ') || '—';
      const win = r.win ? `${r.win.months} · ${r.win.hours} (${t('frep.peak')} ${r.win.peak.month} ${r.win.peak.hour})` : '—';
      return `<div class="card">
        <div class="card-h"><b>${r.name ? r.name + ' (#' + r.n + ')' : t('ssh.rcpName', r.n)}</b> ${badge(r.ok)}<span class="muted">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</span></div>
        <div class="stats">
          <div class="stat"><div class="sv ${r.res.hoursYear > 30 ? 'over' : ''}">${r.res.hoursYear.toFixed(1)}</div><div class="sk">${t('frep.svWorst')}</div></div>
          <div class="stat"><div class="sv ${r.res.maxMinDay > 30 ? 'over' : ''}">${r.res.maxMinDay}</div><div class="sk">${t('frep.svMaxDay')}</div></div>
          <div class="stat"><div class="sv">${r.res.daysAffected}</div><div class="sk">${t('frep.svDays')}</div></div>
          <div class="stat"><div class="sv">${r.res.hoursYearReal.toFixed(1)}</div><div class="sk">${t('frep.svReal')}</div></div>
        </div>
        <div class="cal-wrap"><div class="cal-t">${t('frep.calT')}</div>${shadowCalendarSVG(r.res.cal)}${calLegend}</div>
        <table class="kv"><tr><td>${t('frep.kvWin')}</td><td>${win}</td></tr>
          <tr><td>${t('frep.kvTop')}</td><td>${top}</td></tr></table>
      </div>`;
    }).join('');

    const sumRows = rs.map(r =>
      `<tr class="${r.ok ? 'rok' : 'rbad'}"><td>${r.name ? r.name + ' (#' + r.n + ')' : '#' + r.n}</td><td>${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</td>` +
      `<td class="num">${r.res.hoursYear.toFixed(1)}</td><td class="num">${r.res.maxMinDay}</td>` +
      `<td class="num">${r.res.daysAffected}</td><td class="num">${r.res.hoursYearReal.toFixed(1)}</td>` +
      `<td>${r.win ? r.win.months + ' · ' + r.win.hours : '—'}</td>` +
      `<td class="ctr">${badge(r.ok)}</td></tr>`).join('');

    const schedRows = turbs.map(tb => {
      const b = tb.built ?? 1, st = b >= 0.97 ? t('frep.stOp') : b <= 0.02 ? t('frep.stFound') : t('frep.stMount', (b * 100) | 0);
      return `<tr><td>${tb.label || tb.id}</td><td class="num">${tb.lat.toFixed(5)}</td><td class="num">${tb.lon.toFixed(5)}</td><td>${st}</td></tr>`;
    }).join('');

    const html = `<!doctype html><html lang="${getLang()}"><meta charset="utf-8">
      <title>${t('frep.title')}</title>
      <style>
        :root{--ink:#1b2533;--mut:#64748b;--line:#cbd5e1;--bg:#f8fafc;--ok:#15803d;--bad:#b91c1c}
        *{box-sizing:border-box}
        body{font:14px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;margin:0;color:var(--ink);background:#fff}
        .wrap{max-width:900px;margin:0 auto;padding:0 34px 48px}
        .hero{background:linear-gradient(120deg,#0e7490,#155e75);color:#fff;padding:26px 34px;margin-bottom:24px}
        .hero .brand{font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:.85}
        .hero h1{font-size:25px;margin:6px 0 4px}
        .hero .sub{opacity:.9;font-size:13px}
        h2{font-size:16px;border-bottom:2px solid var(--line);padding-bottom:5px;margin:30px 0 12px}
        .muted{color:var(--mut);font-size:12px}
        .verdict{padding:13px 16px;border-radius:8px;font-weight:700;font-size:15px;margin:6px 0 4px;border:1px solid}
        .verdict.ok{background:#eafaf0;color:var(--ok);border-color:#a7e3bf}
        .verdict.bad{background:#fdeaea;color:var(--bad);border-color:#f3b4b4}
        .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}
        .kpi{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
        .kpi .v{font-size:24px;font-weight:800}.kpi .k{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.4px}
        table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px}
        th,td{border:1px solid var(--line);padding:6px 9px;text-align:left}th{background:#f1f5f9}
        td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}td.ctr{text-align:center}
        tr.rbad{background:#fdeaea}tr.rok{background:#f3fbf6}
        .params{display:grid;grid-template-columns:1fr 1fr;gap:8px 26px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px 18px}
        .params div{display:flex;justify-content:space-between;border-bottom:1px dashed #d8e0ea;padding:4px 0;font-size:13px}
        .params b{font-weight:600}
        figure{margin:10px 0 0}figure img{width:100%;border:1px solid var(--line);border-radius:8px;display:block}
        figcaption{font-size:11.5px;color:var(--mut);margin-top:6px}
        .maplegend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:11.5px;color:var(--mut);margin-top:8px}
        .maplegend span{display:flex;align-items:center;gap:5px}.maplegend i{width:14px;height:10px;border-radius:2px;display:inline-block}
        .card{border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0;page-break-inside:avoid}
        .card-h{display:flex;align-items:center;gap:10px;font-size:15px;margin-bottom:10px}
        .card-h .muted{margin-left:auto}
        .badge{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px}
        .badge.ok{background:#dcfce7;color:var(--ok)}.badge.bad{background:#fee2e2;color:var(--bad)}
        .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
        .stat{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 10px;text-align:center}
        .stat .sv{font-size:20px;font-weight:800}.stat .sv.over{color:var(--bad)}.stat .sk{font-size:10.5px;color:var(--mut)}
        .cal-wrap{margin:6px 0 10px}.cal-t{font-size:12px;color:var(--mut);margin-bottom:6px}
        .leg{display:flex;flex-wrap:wrap;gap:7px 14px;font-size:11px;color:var(--mut);margin-top:7px}
        .leg span{display:flex;align-items:center;gap:5px}.leg i{width:13px;height:11px;border-radius:2px;display:inline-block}
        table.kv td:first-child{color:var(--mut);width:42%}
        footer{margin-top:34px;border-top:1px solid var(--line);padding-top:14px;font-size:11.5px;color:var(--mut);line-height:1.6}
        footer a{color:#0e7490}
        @media print{.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}.card{break-inside:avoid}}
      </style>
      <div class="hero"><div class="brand">${t('frep.brand')}</div>
        <h1>${t('frep.h1')}</h1>
        <div class="sub">${t('rep.park')} · ${t('rep.gen')} ${gen}</div></div>
      <div class="wrap">
        <h2>${t('frep.h1Exec')}</h2>
        <div class="verdict ${verdict.c}">${verdict.c === 'ok' ? '✓' : '✗'} ${verdict.t}</div>
        <p class="muted">${t('frep.execNote')}</p>
        <div class="kpis">
          <div class="kpi"><div class="v">${nOp}</div><div class="k">${t('frep.kTurbOp')}</div></div>
          <div class="kpi"><div class="v">${rs.length}</div><div class="k">${t('frep.kRcpEval')}</div></div>
          <div class="kpi"><div class="v" style="color:var(--ok)">${nOk}</div><div class="k">${t('frep.kComply')}</div></div>
          <div class="kpi"><div class="v" style="color:var(--bad)">${nEx}</div><div class="k">${t('frep.kExceed')}</div></div>
        </div>

        <h2>${t('frep.h2Params')}</h2>
        <div class="params">
          <div><span>${t('frep.pHub')}</span><b>90 m</b></div>
          <div><span>${t('frep.pRotor')}</span><b>84 m (R = 42 m)</b></div>
          <div><span>${t('frep.pLimitH')}</span><b>30 h</b></div>
          <div><span>${t('frep.pLimitD')}</span><b>30 min</b></div>
          <div><span>${t('frep.pSunMin')}</span><b>3°</b></div>
          <div><span>${t('frep.pReach')}</span><b>1.500 m</b></div>
          <div><span>${t('frep.pStep')}</span><b>${t('frep.pStepV')}</b></div>
          <div><span>${t('frep.pEph')}</span><b>${t('frep.pEphV')}</b></div>
          <div><span>${t('frep.pReal')}</span><b>${t('frep.pRealV')}</b></div>
          <div><span>${t('frep.pMeteo')}</span><b>${METEO_CAMAN.source}</b></div>
        </div>

        <h2>${t('frep.h3Map')}</h2>
        ${siteImg ? `<figure><img src="${siteImg}" alt="${t('frep.mapAlt')}">
          <figcaption>${t('frep.mapCap')}</figcaption></figure>
          <div class="maplegend"><span><i style="background:#bee678"></i>1–5</span><span><i style="background:#fde047"></i>5–15</span><span><i style="background:#fb923c"></i>15–30</span><span><i style="background:#ef4444"></i>${t('frep.mapLegExceed')}</span></div>`
          : `<p class="muted">${t('frep.mapNA')}</p>`}

        <h2>${t('frep.h4ByRcp')}</h2>
        ${cards}

        <h2>${t('frep.h5Compliance')}</h2>
        <table><thead><tr><th>${t('frep.thRcp')}</th><th>${t('frep.thCoords')}</th><th class="num">${t('frep.thHrsWorst')}</th><th class="num">${t('frep.thMinDay')}</th><th class="num">${t('frep.thDays')}</th><th class="num">${t('frep.thHrsReal')}</th><th>${t('frep.thShutdown')}</th><th class="ctr">${t('frep.thStatus')}</th></tr></thead><tbody>${sumRows}</tbody></table>

        <h2>${t('frep.h6Schedule')}</h2>
        <table><thead><tr><th>${t('frep.thTurbine')}</th><th class="num">${t('frep.thLat')}</th><th class="num">${t('frep.thLon')}</th><th>${t('frep.thBuildState')}</th></tr></thead><tbody>${schedRows}</tbody></table>

        <footer>
          ${t('frep.footMethod', METEO_CAMAN.source)}<br><br>
          ${t('frep.footScope')}
        </footer>
      </div></html>`;
    this._openReport(html, 'informe_shadow_flicker_caman.html');
  }

  // Informe de sombreado ENTRE turbinas (proxy de pérdida por sombra mutua).
  interTurbineReport() {
    const { perTurbine, total } = interTurbineShading(this.fleet.structures, { stepMin: 10 });
    if (!perTurbine.length) { alert(t('mv.noTurbInter')); return; }
    const rows = perTurbine.map(r => `<tr><td>${r.label}</td><td style="text-align:right">${r.hoursYear.toFixed(1)}</td></tr>`).join('');
    const gen = new Date().toLocaleString(getLang() === 'en' ? 'en-GB' : 'es-CL');
    const html = `<!doctype html><html lang="${getLang()}"><meta charset=utf-8><title>${t('iter.title')}</title>
      <style>body{font:14px system-ui,sans-serif;margin:32px;color:#1b2533}h1{font-size:19px}table{border-collapse:collapse;width:60%;margin-top:12px;font-size:13px}
      th,td{border:1px solid #cbd5e1;padding:6px 9px}th{background:#f1f5f9;text-align:left}.muted{color:#64748b;font-size:12px;line-height:1.5}</style>
      <h1>${t('iter.h1')}</h1>
      <p class="muted">${t('iter.sub', perTurbine.length, total.toFixed(0), gen)}<br>
      ${t('iter.note')}</p>
      <table><thead><tr><th>${t('iter.thTurbine')}</th><th>${t('iter.thHrs')}</th></tr></thead><tbody>${rows}</tbody></table>`;
    this._openReport(html, 'sombreado_entre_torres_caman.html');
  }

  _openReport(html, filename) {
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); a.download = filename; a.click(); }
  }

  // (Re)crea los marcadores desde la flota viva (lat/lon por estructura).
  setStructures() {
    const L = window.L; if (!L || !this.map) return;
    this.markersLayer.clearLayers(); this.markers.clear();
    const pts = [];
    for (const st of this.fleet.structures) {
      if (st.lat == null || st.lon == null) continue;
      const m = L.marker([st.lat, st.lon], { icon: iconFor(st) });
      m.bindTooltip(st.label, { direction: 'top' });
      m.on('click', () => this.onPick(st.id));
      m.addTo(this.markersLayer);
      this.markers.set(st.id, m);
      pts.push([st.lat, st.lon]);
    }
    this._bounds = pts;     // se encuadra al mostrar el mapa (cuando el contenedor ya tiene tamaño)
  }

  // Refresca el color/estado de los marcadores (avance/alarma) sin recrearlos.
  refresh() {
    for (const st of this.fleet.structures) {
      const m = this.markers.get(st.id);
      if (m) m.setIcon(iconFor(st));
    }
  }

  // ── Estudio de sol en 2D: sombra real en planta (Frente 2) ───────────────────
  // Dibuja la sombra de cada torre proyectada en planta (línea del fuste en la
  // dirección anti-solar, largo = altura/tan(elevación), + disco del rotor). Es
  // físicamente 1:1 (metros reales). En modo Sol atenúa el basemap y oculta los
  // iconos (taparían la sombra). `sun` = {elevation, azimuth} de fleet.getSunInfo().
  setSunShadows(on, sun) {
    const L = window.L; if (!L || !this.map) return;
    this.sunMode = !!on;
    this.el.classList.toggle('mv-sun', this.sunMode);                          // atenúa el basemap (CSS)
    if (!this.sunMode) { this.clearReceptors(); this.clearFlickerMap(); }      // todo el estudio de sombra es del modo Shadow
    if (this.markersLayer) { this.sunMode ? this.map.removeLayer(this.markersLayer) : this.markersLayer.addTo(this.map); }
    if (!this.shadowLayer) this.shadowLayer = L.layerGroup();
    this.sunMode ? this.shadowLayer.addTo(this.map) : this.map.removeLayer(this.shadowLayer);
    this.shadowLayer.clearLayers();
    if (!this.sunMode || !sun || sun.elevation <= 0.5) return;                  // sin sol útil (noche) → sin sombra
    // Colores de alto contraste con el verde: sombra VIOLETA, torre AMARILLA.
    const SH = '#6d28d9', TW = '#fde047', TWE = '#1a1300';
    const bearing = (sun.azimuth + 180) * Math.PI / 180;                        // hacia donde cae la sombra
    const tan = Math.tan(sun.elevation * Math.PI / 180), cb = Math.cos(bearing), sb = Math.sin(bearing);
    for (const st of this.fleet.structures) {
      if (st.lat == null || st.lon == null) continue;
      const frac = st.built ?? 1;
      if (frac <= 0.02) continue;                                               // sólo fundación → no proyecta torre
      const H = (st.height || (st.type === 'hv' ? 40 : 90)) * frac;             // altura erigida (m)
      const Lm = Math.min(H / tan, 3000);                                       // largo de sombra (cap a 3 km con sol muy bajo)
      const dlat = (Lm * cb) / 111320, dlon = (Lm * sb) / (111320 * Math.cos(st.lat * Math.PI / 180));
      const base = [st.lat, st.lon], tip = [st.lat + dlat, st.lon + dlon];
      L.polyline([base, tip], { color: SH, weight: 4, opacity: 0.9 }).addTo(this.shadowLayer);
      if (st.type !== 'hv' && frac >= 0.97)                                     // disco del rotor sólo si está montado
        L.circle(tip, { radius: 42, stroke: false, fillColor: SH, fillOpacity: 0.5 }).addTo(this.shadowLayer);
      L.circleMarker(base, { radius: 3.6, color: TWE, weight: 1, fillColor: TW, fillOpacity: 1 }).addTo(this.shadowLayer);   // torre (punto)
    }
  }

  // Centra/acerca el mapa sobre una estructura (al seleccionarla en el árbol o 3D).
  focus(obj) {
    if (!obj || obj.lat == null || obj.lon == null || !this.map) return;
    const z = Math.max(this.map.getZoom(), 14);
    this.map.setView([obj.lat, obj.lon], z, { animate: false });
  }

  // Tirador propio para redimensionar el PiP con el ratón (el `resize` nativo del
  // CSS queda tapado por el mapa). Va en la esquina superior-izquierda porque el
  // PiP está anclado abajo-derecha → se arrastra hacia adentro para agrandar.
  _addResizeHandle() {
    const h = document.createElement('div');
    h.className = 'mv-resize'; h.title = t('mv.resize');
    this.el.appendChild(h);
    let s = null;
    const onMove = (e) => {
      if (!s) return;
      this.el.style.width = Math.max(180, s.w + (s.x - e.clientX)) + 'px';
      this.el.style.height = Math.max(140, s.h + (s.y - e.clientY)) + 'px';
      this.map && this.map.invalidateSize();
    };
    const onUp = () => { s = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = this.el.getBoundingClientRect();
      s = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
      window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
    });
  }

  // Leaflet necesita recalcular tamaño cuando su contenedor estaba oculto; al
  // mostrarlo por primera vez, encuadra todo el parque (vista por defecto útil).
  invalidate() {
    if (!this.map) return;
    setTimeout(() => {
      this.map.invalidateSize();
      if (!this._fitted && this._bounds && this._bounds.length) { this.map.fitBounds(this._bounds, { padding: [40, 40] }); this._fitted = true; }
    }, 0);
  }
}
