// ─────────────────────────────────────────────────────────────────────────────
// map_view.js — vista 2D «exacta» del parque (Leaflet) para navegar/ubicar.
//
// Mapa 2D rápido (tiles) con las torres como marcadores desde sus coordenadas
// reales (lat/lon). Basemaps: Esri World Imagery (satélite) + OpenTopoMap (curvas).
// Click en un marcador → conmuta a la vista 3D enfocando esa estructura (onPick).
// Leaflet se carga como global (window.L) desde lib/leaflet/leaflet.js.
// ─────────────────────────────────────────────────────────────────────────────
import { CAMAN_CENTER } from './parks_data_caman.js?v=221';
import { CAMAN_ROADS } from './caman_roads.js?v=221';

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
