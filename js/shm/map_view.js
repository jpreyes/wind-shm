// ─────────────────────────────────────────────────────────────────────────────
// map_view.js — vista 2D «exacta» del parque (Leaflet) para navegar/ubicar.
//
// Mapa 2D rápido (tiles) con las torres como marcadores desde sus coordenadas
// reales (lat/lon). Basemaps: Esri World Imagery (satélite) + OpenTopoMap (curvas).
// Click en un marcador → conmuta a la vista 3D enfocando esa estructura (onPick).
// Leaflet se carga como global (window.L) desde lib/leaflet/leaflet.js.
// ─────────────────────────────────────────────────────────────────────────────
import { CAMAN_CENTER } from './parks_data_caman.js?v=236';
import { CAMAN_ROADS } from './caman_roads.js?v=236';
import { compassRoseSVG } from './compass.js?v=236';
import { annualFlicker, flickerOK, FLICKER_LIMITS, REAL_CASE_FACTOR, flickerMap, criticalWindow, interTurbineShading } from './shadow_flicker.js?v=236';
import { realCaseWeight, METEO_CAMAN } from './meteo_caman.js?v=236';

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
    L.control.layers({ 'Satélite': sat, 'Topográfico': topo }, null, { position: 'topright' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);   // barra de escala (métrica)
    // Rosa de los vientos (fija, norte-arriba: el mapa no rota).
    const RoseCtl = L.Control.extend({ onAdd() { const d = L.DomUtil.create('div', 'mv-rose'); d.innerHTML = compassRoseSVG(); return d; } });
    this.map.addControl(new RoseCtl({ position: 'bottomleft' }));   // sobre la barra de escala; no choca con la atribución (bottomright)

    // Botón de pantalla completa / restaurar (ventana auxiliar PiP ⇄ completa).
    const self = this;
    const FullBtn = L.Control.extend({ onAdd() {
      const b = L.DomUtil.create('button', 'mv-full'); b.type = 'button'; b.innerHTML = '⤢';
      b.title = 'Pantalla completa / restaurar';
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
  addReceptor(latlng) {
    const L = window.L; if (!L) return;
    const res = annualFlicker(this.fleet.structures, { lat: latlng.lat, lon: latlng.lng }, { stepMin: 2, realWeightFn: REAL_W });
    const ok = flickerOK(res);
    const col = ok ? '#22c55e' : '#ef4444';
    const icon = L.divIcon({ className: 'rcp-icon', iconSize: [22, 22], iconAnchor: [11, 11],
      html: `<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" fill="${col}" stroke="#0b1018" stroke-width="1.5"/><path d="M6 11 L11 6.5 L16 11 M7.5 10 V16 H14.5 V10" fill="none" stroke="#0b1018" stroke-width="1.4" stroke-linejoin="round"/></svg>` });
    const m = L.marker(latlng, { icon }).addTo(this.recepLayer);
    const win = criticalWindow(res.cal);
    this._receptors ||= [];
    const n = this._receptors.length + 1;
    const entry = { n, lat: latlng.lat, lon: latlng.lng, res, ok, win, marker: m };
    this._receptors.push(entry);
    m.bindPopup(
      `<b>Receptor ${n}</b><br>Worst-case: <b>${res.hoursYear.toFixed(1)} h/año</b> · ${res.maxMinDay} min/día<br>` +
      `Real (meteo) ≈ <b>${res.hoursYearReal.toFixed(1)} h/año</b><br>` +
      `${res.daysAffected} días afectados<br>` +
      (win ? `Parada sugerida: <b>${win.months}</b>, <b>${win.hours}</b><br>` : '') +
      `<span style="color:${col}">${ok ? '✓ Cumple' : '✗ Excede'}</span> (≤${FLICKER_LIMITS.hoursYear} h · ≤${FLICKER_LIMITS.minDay} min, worst-case)<br>` +
      `<a href="#" class="rcp-del">Quitar</a>`
    ).openPopup();
    m.on('popupopen', (ev) => { const a = ev.popup.getElement()?.querySelector('.rcp-del'); a && a.addEventListener('click', (x) => { x.preventDefault(); this.recepLayer.removeLayer(m); this._receptors = this._receptors.filter(r => r !== entry); }); });
    return res;
  }

  clearReceptors() { this.recepLayer?.clearLayers(); this._receptors = []; }

  // Mapa de flicker (horas/año) sobre el área — salida estilo WindPRO. Toggle.
  toggleFlickerMap() {
    const L = window.L; if (!L || !this.map) return false;
    if (this._flickerOverlay) { this.map.removeLayer(this._flickerOverlay); this._flickerOverlay = null; this.fleet.clearFlickerSurface?.(); return false; }
    const lats = [], lons = [];
    for (const t of this.fleet.structures) { if (t.type !== 'hv' && t.lat != null && (t.built ?? 1) >= 0.97) { lats.push(t.lat); lons.push(t.lon); } }
    if (!lats.length) { alert('No hay turbinas operativas para el mapa de flicker.'); return false; }
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

  // Informe de cumplimiento de shadow-flicker (todos los receptores) → ventana imprimible.
  flickerReport() {
    const rs = this._receptors || [];
    if (!rs.length) { alert('Agrega receptores (clic en el mapa con el Sol activo) para generar el informe.'); return; }
    const nEx = rs.filter(r => !r.ok).length;
    const rows = rs.map(r =>
      `<tr style="background:${r.ok ? '#eafaf0' : '#fdeaea'}"><td>${r.n}</td><td>${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</td>` +
      `<td style="text-align:right">${r.res.hoursYear.toFixed(1)}</td><td style="text-align:right">${r.res.maxMinDay}</td>` +
      `<td style="text-align:right">${r.res.hoursYearReal.toFixed(1)}</td>` +
      `<td>${r.win ? r.win.months + ' · ' + r.win.hours : '—'}</td>` +
      `<td style="text-align:center;color:${r.ok ? '#15803d' : '#b91c1c'};font-weight:600">${r.ok ? 'Cumple' : 'Excede'}</td></tr>`).join('');
    const html = `<!doctype html><meta charset=utf-8><title>Informe de shadow-flicker — Camán I</title>
      <style>body{font:14px system-ui,sans-serif;margin:32px;color:#1b2533}h1{font-size:19px}table{border-collapse:collapse;width:100%;margin-top:12px;font-size:13px}
      th,td{border:1px solid #cbd5e1;padding:6px 9px}th{background:#f1f5f9;text-align:left}.muted{color:#64748b;font-size:12px;line-height:1.5}</style>
      <h1>Informe de parpadeo de sombra (shadow-flicker) — Camán I</h1>
      <p class="muted">${rs.length} receptor(es) · ${nEx} excede(n) el límite · Generado ${new Date().toLocaleString('es-CL')}<br>
      Worst-case astronómico (norma LAI: sol siempre despejado, rotor siempre girando). Límite: ≤30 h/año y ≤30 min/día.
      «Real (meteo)» = caso esperado ponderando estadística de sol, operación del rotor y rosa de vientos del sitio (${METEO_CAMAN.source}).</p>
      <table><thead><tr><th>#</th><th>Coordenadas (lat, lon)</th><th>h/año (worst)</th><th>min/día (worst)</th><th>h/año (real≈)</th><th>Parada sugerida (mes · hora)</th><th>Cumplimiento</th></tr></thead><tbody>${rows}</tbody></table>`;
    this._openReport(html, 'informe_sombras_caman.html');
  }

  // Informe de sombreado ENTRE turbinas (proxy de pérdida por sombra mutua).
  interTurbineReport() {
    const { perTurbine, total } = interTurbineShading(this.fleet.structures, { stepMin: 10 });
    if (!perTurbine.length) { alert('No hay turbinas operativas para el análisis inter-turbinas.'); return; }
    const rows = perTurbine.map(r => `<tr><td>${r.label}</td><td style="text-align:right">${r.hoursYear.toFixed(1)}</td></tr>`).join('');
    const html = `<!doctype html><meta charset=utf-8><title>Sombreado entre torres — Camán I</title>
      <style>body{font:14px system-ui,sans-serif;margin:32px;color:#1b2533}h1{font-size:19px}table{border-collapse:collapse;width:60%;margin-top:12px;font-size:13px}
      th,td{border:1px solid #cbd5e1;padding:6px 9px}th{background:#f1f5f9;text-align:left}.muted{color:#64748b;font-size:12px;line-height:1.5}</style>
      <h1>Sombreado entre turbinas (worst-case) — Camán I</h1>
      <p class="muted">${perTurbine.length} turbinas operativas · total ${total.toFixed(0)} h/año de sombra mutua · Generado ${new Date().toLocaleString('es-CL')}<br>
      Horas/año en que el rotor de cada turbina cae en la sombra de otra (proxy de pérdida por sombreado; aproxima el buje como receptor a nivel de suelo). La pérdida energética real depende de la curva de potencia y del viento.</p>
      <table><thead><tr><th>Turbina</th><th>h/año en sombra de otras</th></tr></thead><tbody>${rows}</tbody></table>`;
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
    h.className = 'mv-resize'; h.title = 'Arrastra para redimensionar';
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
