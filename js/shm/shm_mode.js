// ─────────────────────────────────────────────────────────────────────────────
// shm_mode.js — integra ReWind (parque + monitor SHM) y arma su propio shell.
//
// · Monta la flota en el viewport real, agrega botones (Torre, Detener).
// · Lista de estructuras seleccionables en la barra (torres + torres AT).
// · Nameplate (cuadro con el nombre) sobre la vista.
// · Panel específico al seleccionar: datos, sensores (estado), daño, altura,
//   inspecciones y señal temporal EN VIVO desde un Web Worker (DataSource).
// Recortes (modelado) los hace shm.css ocultando, no borrando.
// ─────────────────────────────────────────────────────────────────────────────
import { FleetView } from './fleet_view.js?v=282';
import { DataSource } from './data_source.js?v=282';
import { computeTwin } from './digital_twin.js?v=282';
import { ParkManager, loadParksStore } from './parks.js?v=282';
import { MapView } from './map_view.js?v=282';
import { defaultStages, builtFromStages } from './parks_data_caman.js?v=282';
import { compassRoseSVG } from './compass.js?v=282';
import { buildAvanceHUD } from './avance_hud.js?v=282';
import { renderAvance } from './avance_dashboard.js?v=282';
import * as Insp from './inspection.js?v=282';
import * as Fat from './fatigue.js?v=282';
import * as Instr from './instrumentation.js?v=282';
import * as Calidad from './calidad.js?v=282';
import { t, getLang, setLang } from './i18n.js?v=282';

const F1_BASE = { turbine: 0.283, hv: 1.6 };
const REWIND_VER = 'v282';   // versión visible del build (subir junto al cache-bust)
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
  if (!container || !panel) { console.warn('[shm] shell de ReWind no encontrado'); window.__rewindCloseLanding?.(); return; }

  document.body.classList.add('shm');
  try { document.documentElement.lang = getLang(); } catch {}
  // Portada (textos estáticos del app.html) traducidos según idioma.
  const heroTag = document.querySelector('.hero-tag'); if (heroTag) heroTag.textContent = t('hero.tag');
  const loadStatus = document.getElementById('load-status'); if (loadStatus && /Iniciando/.test(loadStatus.textContent)) loadStatus.textContent = t('load.start');
  if (!matchMedia('(max-width: 820px)').matches) document.body.classList.add('tree-open');   // en móvil el árbol arranca cerrado (es cajón)

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

  let pm = null;                       // ParkManager (árbol lateral) — se crea más abajo
  buildToolbar(toolbar, fleet, () => pm);
  buildMenubar(fleet, () => pm);       // menú superior nativo de ReWind (R-7)
  const nameplate = buildNameplate(vpwrap);
  const banner = buildBanner(vpwrap);
  const dash = buildDashboard(panel, fleet, actions);
  window.shmDash = dash;
  // Sincroniza el estado «activo» de TODOS los botones de mapa de flicker (HUD + panel).
  window.shmSyncFlickerBtns = () => { const on = !!window.shmMap?._flickerOverlay; document.querySelectorAll('.js-fmap').forEach(b => b.classList.toggle('active', on)); };
  initPanelResize();   // redimensionar el panel derecho (antes lo cableaba app.js)

  document.getElementById('btn-zoomext')?.addEventListener('click', () => fleet.clearSelection());
  document.title = 'ReWind — SHM de torres eólicas';

  // ── DataSource: simulación (Web Worker) o nube (?live=wss://…) ─────────────
  const liveUrl = new URLSearchParams(location.search).get('live');
  const ds = new DataSource(liveUrl ? { liveUrl } : {});
  window.shmData = ds;
  const statusBar = buildStatusBar(fleet, { source: liveUrl ? t('src.live') : t('src.sim') });
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
    statusBar.onTick(msg); statusBar.setAlarms(alarmed.length);
  };

  // ── Carga del parque con barra de progreso en la portada ──────────────────
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const setLoad = (pct, status) => {
    const bar = document.getElementById('load-bar'), st = document.getElementById('load-status'), pc = document.getElementById('load-pct');
    if (bar) bar.style.width = pct + '%';
    if (pc) pc.textContent = Math.round(pct) + '%';
    if (st && status) st.textContent = status;
  };
  // ── Multiparque: store de parques (por defecto se siembra el parque real Camán I) ─
  const store = loadParksStore();
  const activePark = store.parks.find(p => p.id === store.activeId) || store.parks[0];
  const fresh = !(activePark.turbines?.length) && !(activePark.hv?.length);
  if (fresh) {
    const NT = 10;                                       // parque por defecto (primera vez)
    for (let i = 0; i < NT; i++) { fleet.addTurbine(); setLoad((i + 1) / NT * 70, `Cargando torres eólicas ${i + 1}/${NT}`); await delay(30); }
    setLoad(72, 'Cargando torres de alta tensión…'); await delay(60);
    fleet.buildSubstation();                             // 2 torres AT
    for (const st of fleet.structures) st.zone = activePark.zones[0].id;   // todo a la zona por defecto
    setLoad(84, 'Subestación lista'); await delay(120);
  } else {
    setLoad(40, `Cargando ${activePark.name}…`); await delay(60);
    fleet.loadPark(activePark);
    setLoad(84, `${activePark.name} cargado`); await delay(120);
  }

  // Sin fallas ni daño de demostración por ahora: el parque arranca todo sano
  // (cuando se conecten los sensores reales, el estado vendrá del gateway).
  const dmgMap = {};

  const buildManifest = () => fleet.structures.map(s => ({
    id: s.id, type: s.type, f1: F1_BASE[s.type] || 0.5, dmg: dmgMap[s.id] || 0,
    sensors: s.sensors.map(se => ({ id: se.id, status: se.status || 'ok' })),
  }));
  let mapView = null;   // vista 2D Leaflet (se crea más abajo)
  const syncData = () => { ds.init(buildManifest()); dash.setStructures(fleet.getStructures()); mapView?.setStructures(); };

  // Vista 2D del parque (Leaflet): click en un marcador → vuelve al 3D enfocando la torre.
  // Intercambia cuál vista es principal (3D ⇄ 2D): la otra queda como PiP en la esquina.
  const vc3d = document.getElementById('viewport-container');
  const swapViews = () => {
    document.body.classList.add('map-pip');                 // el 2D debe estar presente
    const v2 = document.body.classList.toggle('view-2d');
    document.getElementById('shm-map-tool')?.classList.add('active');
    const apply = () => {
      if (!document.body.classList.contains('view-2d') && vc3d) { vc3d.style.width = ''; vc3d.style.height = ''; }   // 3D principal → tamaño completo
      fleet.resize(); mapView.invalidate(); mapView.map?.invalidateSize();
    };
    apply(); setTimeout(apply, 80);                          // síncrono (reflow) + fallback
    return v2;
  };
  mapView = new MapView(document.getElementById('map-container'), fleet, {
    onPick: (id) => fleet.selectById(id),                   // selecciona y centra (no cambia la vista principal)
    onToggleFull: () => swapViews(),                        // ⤢ / doble-clic en el mapa → intercambia principal ⇄ PiP
  });
  window.shmMap = mapView;
  window.shmSwapViews = swapViews;
  mapView.setStructures();
  // Controles del PiP del 3D (cuando el 2D es principal): maximizar (⤢) + redimensionar.
  if (vc3d) {
    const full = document.createElement('button');
    full.type = 'button'; full.className = 'vp-pip-full'; full.title = 'Maximizar el 3D'; full.textContent = '⤢';
    full.addEventListener('click', (e) => { e.stopPropagation(); swapViews(); });
    const h = document.createElement('div'); h.className = 'vp-pip-resize'; h.title = 'Arrastra para redimensionar';
    let s = null;
    const onMove = (e) => { if (!s) return; vc3d.style.width = Math.max(180, s.w + (s.x - e.clientX)) + 'px'; vc3d.style.height = Math.max(140, s.h + (s.y - e.clientY)) + 'px'; fleet.resize(); };
    const onUp = () => { s = null; removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); };
    h.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); const r = vc3d.getBoundingClientRect(); s = { x: e.clientX, y: e.clientY, w: r.width, h: r.height }; addEventListener('pointermove', onMove); addEventListener('pointerup', onUp); });
    vc3d.append(full, h);
    vc3d.addEventListener('dblclick', () => { if (document.body.classList.contains('view-2d')) swapViews(); });   // doble-clic en el PiP → promover el 3D
  }

  // Árbol lateral Parque ▸ Zona ▸ Torre
  pm = new ParkManager({ el: document.getElementById('park-tree'), fleet, store, onSync: syncData });
  window.shmParks = pm;
  pm.syncFleetToActive(); pm.save();     // captura el layout fresco/cargado en el store
  pm.bind(); pm.render();
  statusBar.setParque(pm.active.name, fleet.structures.length);

  const saveLayout = () => { pm.syncFleetToActive(); pm.save(); };
  fleet.onChange = syncData;        // re-sincroniza telemetría al agregar
  fleet.onLayoutChange = saveLayout; // persiste el orden al mover/agregar
  const towerCard = buildTowerCard(vpwrap, fleet, { onShowAvance: () => dash.showObra() });
  const compass = buildCompass(vpwrap, fleet);   // rosa de los vientos (gira con la cámara)
  const avanceHUD = buildAvanceHUD(vpwrap, fleet);   // HUD tipo Stark de avance por componente (Frente 1)
  window.shmAvanceHUD = avanceHUD;
  fleet.onFrame = () => { towerCard.tick(); compass.update(); avanceHUD.tick(); };   // reposiciona ficha + brújula + HUD con el render
  const isMobile = () => matchMedia('(max-width: 820px)').matches;
  fleet.onSelect = (obj) => {
    // En modo Shadow, seleccionar una torre en 3D = colocar un RECEPTOR ahí (igual
    // que hacer clic en el mapa 2D): muestra el informe de parpadeo en la ficha y
    // la barra lateral, sin la ficha/datos de avance. No hace zoom cinemático.
    if (obj && fleet.sunMode) {
      fleet._focusing = false;                       // conserva la vista amplia del estudio (como en 2D)
      nameplate.show(obj); statusBar.setSelected(obj);
      if (obj.lat != null) {
        const entry = mapView?.addReceptor({ lat: obj.lat, lng: obj.lon });   // crea receptor + refresca panel Shadow
        towerCard.setShadow(obj, entry);             // ficha = informe del receptor
        mapView?.focus(obj);
        window.shmDash?.showShadow();                // barra lateral con la info de sombra (como en 2D)
      } else towerCard.setData(null);
      if (isMobile()) { document.body.classList.remove('tree-open'); document.body.classList.add('panel-open'); }
      return;
    }
    dash.select(obj); nameplate.show(obj); statusBar.setSelected(obj); ds.focus(obj ? obj.id : null); if (obj) mapView?.focus(obj);
    // Ruteo de pestaña del panel según el MODO activo:
    //  · Avance (4D) → «Obra»  · (Shadow se maneja arriba)  · ninguno → «Selección»  · sin selección → «Parque»
    if (obj && fleet.constructionMode) dash.showObra();
    // Detalle de torre = HUD de avance (Frente 1): la ficha SHM mini cede ante el HUD,
    // los datos SHM viven en la pestaña «Selección» del panel.
    if (obj) {
      towerCard.setData(null);
      const v = panel.querySelector('.shm-toptab.active')?.dataset.v;
      if (v === 'shadow' || v === 'parque') avanceHUD.hide();
      else avanceHUD.show(obj, v === 'insp' ? 'insp' : v === 'shm' ? 'shm' : 'avance');
    } else { towerCard.setData(null); avanceHUD.hide(); }
    if (obj && isMobile()) { document.body.classList.remove('tree-open'); document.body.classList.add('panel-open'); }   // en móvil: cierra el árbol y abre el panel
  };
  // Cajones móviles: tocar el fondo cierra árbol y panel.
  document.getElementById('drawer-backdrop')?.addEventListener('click', () => {
    document.body.classList.remove('tree-open', 'panel-open');
    document.getElementById('shm-tree-tool')?.classList.remove('active');
    document.getElementById('shm-panel-tool')?.classList.remove('active');
  });

  // Mapa 2D (PiP) visible por defecto (en móvil arranca cerrado: el PiP taparía la vista).
  if (!matchMedia('(max-width: 820px)').matches) {
    document.body.classList.add('map-pip');
    document.getElementById('shm-map-tool')?.classList.add('active');
    mapView.invalidate();
  }

  // ESC: si el 2D está como principal, vuelve al 3D; si no, deselecciona la estructura.
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.body.classList.contains('view-2d')) { swapViews(); return; }
    if (fleet.selected) fleet.clearSelection();
  });

  syncData();
  fleet.playIntro();

  // ── Relieve conceptual del terreno (DEM vendorizado) — encendido por defecto ─
  setLoad(88, 'Cargando relieve…'); await delay(40);
  try {
    await fleet.loadTerrain('data/caman_dem.json?v=282');
    fleet.setTerrainVisible(true);
    document.getElementById('shm-relieve-tool')?.classList.add('active');
  } catch (e) { console.warn('[shm] relieve no disponible', e); }

  // ── Gemelo digital: f₁ + diagramas por el solver FEM (bloqueante) ───
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

// ── Toolbar: Árbol · Torre · Torre AT · Detener · Editar ─────────────────────
function buildToolbar(toolbar, fleet, getPM = () => null) {
  if (!toolbar) return;
  const mk = (id, title, svg, label, onclick) => {
    const b = document.createElement('button');
    b.id = id; b.className = 'tool tool-action'; b.title = title;
    b.innerHTML = `${svg}<span>${label}</span>`;
    b.addEventListener('click', () => onclick(b));
    return b;
  };
  // Interruptor del árbol lateral (Parque ▸ Zona ▸ Torre).
  const tree = mk('shm-tree-tool', t('tool.tree.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 4 v16 M5 8 h6 M5 14 h6"/><rect x="11" y="5" width="8" height="6" rx="1"/><rect x="11" y="13" width="8" height="6" rx="1"/></svg>`,
    t('tool.tree'), () => { const on = document.body.classList.toggle('tree-open'); tree.classList.toggle('active', on); });
  const add = mk('shm-add-tool', t('tool.tower.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    t('tool.tower'), () => { const o = fleet.addTurbine(); getPM()?.onAddStructure(o); });
  const hv = mk('shm-hv-tool', t('tool.hv.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3 L5 21 M12 3 L19 21 M7 9 H17 M6 13 H18 M5.5 17 H18.5"/></svg>`,
    t('tool.hv'), () => { const o = fleet.addHVTower(); getPM()?.onAddStructure(o); });
  const pause = mk('shm-pause-tool', '', '', '', () => { fleet.setPaused(!fleet.paused); paint(); });
  const paint = () => {
    pause.title = fleet.paused ? t('tool.play.tip') : t('tool.pause.tip');
    pause.innerHTML = fleet.paused
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg><span>${t('tool.play')}</span>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span>${t('tool.pause')}</span>`;
  };
  paint();
  const del = mk('shm-del-tool', t('tool.del.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13"/></svg>`,
    t('tool.del'), () => { if (fleet.selected) fleet.removeStructure(fleet.selected.id); });
  // Avance de obra (4D): conmuta el «llenado» de las torres (sólido erigido + silueta de lo que falta).
  const avance = mk('shm-avance-tool', t('tool.avance.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 21V11h4v10M10 21V7h4v14M15 21V3h4v18"/></svg>`,
    t('tool.avance'), () => { const on = !fleet.constructionMode; fleet.setConstructionMode(on); avance.classList.toggle('active', on); });
  if (fleet.constructionMode) avance.classList.add('active');
  // Sincroniza el estado del botón cuando el 4D se activa desde otro lado
  // (p.ej. «avance real» de Calidad enciende constructionMode).
  window.shmSyncAvanceBtns = () => avance.classList.toggle('active', fleet.constructionMode);
  // Relieve conceptual del terreno (curvas de nivel + tinte hipsométrico).
  const relieve = mk('shm-relieve-tool', t('tool.relieve.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 20 L9 8 L13 15 L16 10 L21 20 Z"/></svg>`,
    t('tool.relieve'), () => { const on = !fleet.terrainOn; fleet.setTerrainVisible(on); relieve.classList.toggle('active', on); });
  // Sol y sombras (análisis de sombra según hora/día — Frente 2).
  const sunCtl = buildSunControl(fleet);
  const sol = mk('shm-sun-tool', t('tool.shadow.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>`,
    t('tool.shadow'), () => { const on = !fleet.sunMode; fleet.setSunEnabled(on); sol.classList.toggle('active', on); sunCtl.setOpen(on); window.shmMap?.setSunShadows(on, on ? fleet.getSunInfo() : null); if (on) window.shmDash?.showShadow(); else window.shmDash?.refreshShadow(); avance.classList.toggle('active', fleet.constructionMode); });
  // Accesos a las pestañas del panel derecho (igual que «Avance» abre Obra).
  const openPanel = () => { if (matchMedia('(max-width: 820px)').matches) { document.body.classList.add('panel-open'); document.body.classList.remove('tree-open'); } };
  const pInsp = mk('shm-pinsp-tool', t('tool.pInsp.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9.5 4 V3 h5 v1 M9 11 h6 M9 15 h6 M9 18.5 h4"/></svg>`,
    t('tool.pInsp'), () => { window.shmDash?.showInsp?.(); openPanel(); });
  const pShm = mk('shm-pshm-tool', t('tool.pShm.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l2-6 4 14 3-10 2 4h4"/></svg>`,
    t('tool.pShm'), () => { window.shmDash?.showSHM?.(); openPanel(); });
  // El botón «Editar» es el interruptor maestro del modo edición: con él activo se
  // pueden crear, borrar y mover estructuras; apagado, sólo se monitorea.
  // TODO(perfiles): condicionar la visibilidad de «Editar» al rol del usuario.
  const setEditing = (on) => {
    if (on && fleet.panMode) { fleet.setPanMode(false); pan.classList.remove('active'); }   // PAN y Editar son excluyentes
    fleet.setEditMode(on);
    edit.classList.toggle('active', on);
    document.body.classList.toggle('shm-editing', on);
  };
  const edit = mk('shm-edit-tool', t('tool.edit.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20 L4 16 L15 5 L19 9 L8 20 Z"/><line x1="13" y1="7" x2="17" y2="11"/></svg>`,
    t('tool.edit'), () => setEditing(!fleet.editMode));
  // PAN (manito): arrastrar con la izquierda mueve la vista (igual que en structweb3d).
  const pan = mk('shm-pan-tool', t('tool.pan.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11M12 10.5V4.5a1.5 1.5 0 0 1 3 0V11M15 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L5 16c-1-1.2-.6-2.4.6-2.9.8-.3 1.6 0 2.1.6L9 15V6.5a1.5 1.5 0 0 1 3 0"/></svg>`,
    t('tool.pan'), () => { const on = !fleet.panMode; if (on && fleet.editMode) setEditing(false); fleet.setPanMode(on); pan.classList.toggle('active', on); });
  // Conmutador de vista: mapa 2D (Leaflet) ⇄ parque 3D.
  const mapBtn = mk('shm-map-tool', t('tool.map.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 4 L3 6 V20 L9 18 L15 20 L21 18 V4 L15 6 L9 4 Z"/><path d="M9 4 V18 M15 6 V20"/></svg>`,
    t('tool.map'), () => {
      const on = document.body.classList.toggle('map-pip');
      if (!on) document.body.classList.remove('view-2d');     // al cerrar el mapa, vuelve el 3D a principal
      mapBtn.classList.toggle('active', on);
      const apply = () => {
        if (!document.body.classList.contains('view-2d')) { const vc = document.getElementById('viewport-container'); if (vc) { vc.style.width = ''; vc.style.height = ''; } }
        fleet.resize(); if (on) { window.shmMap?.invalidate(); window.shmMap?.refresh(); }
      };
      apply(); setTimeout(apply, 80);
    });
  // Botón «Datos»: abre/cierra el panel derecho como cajón (sólo visible en móvil).
  const panelTool = mk('shm-panel-tool', t('tool.data.tip'),
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16M17 9h1M17 13h1"/></svg>`,
    t('tool.data'), () => { const on = document.body.classList.toggle('panel-open'); if (on) document.body.classList.remove('tree-open'); panelTool.classList.toggle('active', on); });
  // Barra organizada en SECCIONES (separadas por divisores):
  //  · Vista: Árbol · Mapa · Relieve · Datos   (Relieve pertenece a la sección del mapa)
  //  · Interacción: Detener · Mover · Editar
  //  · Modos/análisis: Avance · Shadow
  //  · Crear: Torre · Torre AT · Borrar
  const sepEl = () => { const d = document.createElement('div'); d.className = 'tool-sep'; return d; };
  toolbar.append(
    tree, mapBtn, relieve, panelTool, sepEl(),
    pause, pan, edit, sepEl(),
    avance, sol, pInsp, pShm, sepEl(),
    add, hv, del,
  );
  if (document.body.classList.contains('tree-open')) tree.classList.add('active');

  // Supr/Delete borra la estructura seleccionada (sólo en modo edición).
  addEventListener('keydown', (e) => {
    if (!fleet.editMode || !fleet.selected) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    e.preventDefault();
    fleet.removeStructure(fleet.selected.id);
  });
}

// ── Menú superior nativo de ReWind (R-7) ─────────────────────────────────────
// Menús desplegables (Parque · Datos · Informe) en el #menubar. Centraliza
// acciones de SHM que antes estaban dispersas o no existían en la barra superior.
function buildMenubar(fleet, getPM = () => null) {
  const bar = document.getElementById('menubar');
  if (!bar) return;
  const right = bar.querySelector('.menubar-right');

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const downloadJSON = (name, obj) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const pickFile = (accept, cb) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept;
    inp.addEventListener('change', async () => { const f = inp.files?.[0]; if (f) cb(await f.text(), f); });
    inp.click();
  };

  // ── Acciones ──
  const newTurbine = () => { const o = fleet.addTurbine(); getPM()?.onAddStructure?.(o); };
  const newHV = () => { const o = fleet.addHVTower(); getPM()?.onAddStructure?.(o); };
  const exportPark = () => {
    try { const s = localStorage.getItem('rewind-parks'); if (!s) throw 0; downloadJSON(`rewind-parque-${stamp()}.json`, JSON.parse(s)); }
    catch { alert(t('alert.noPark')); }
  };
  const importPark = () => pickFile('.json,application/json', (txt) => {
    try { const o = JSON.parse(txt); if (!o || !Array.isArray(o.parks)) throw 0; localStorage.setItem('rewind-parks', txt); alert(t('alert.parkImported')); location.reload(); }
    catch { alert(t('alert.badPark')); }
  });
  const exportTelemetry = () => downloadJSON(`rewind-telemetria-${stamp()}.json`,
    { generado: new Date().toISOString(), fuente: window.shmData?.mode || 'sim', estructuras: window.shmData?.latest || {} });
  const exportInsp = () => { try { downloadJSON(`rewind-inspecciones-${stamp()}.json`, JSON.parse(Insp.exportJSON())); } catch { alert(t('alert.exportFail')); } };
  const importInsp = () => pickFile('.json,application/json', (txt) => {
    try { const n = Insp.importJSON(txt, false); alert(t('alert.inspImported', n)); location.reload(); }
    catch { alert(t('alert.badInsp')); }
  });
  const parkReport = () => window.shmDash?.buildReport?.(null);
  const selReport = () => { const s = fleet.selected; if (s) window.shmDash?.buildReport?.(s); else alert(t('alert.selectFirst')); };

  // ── Definición de menús ──
  const menus = [
    { label: t('menu.park'), items: [
      { label: t('mi.newTower'), fn: newTurbine },
      { label: t('mi.newHV'), fn: newHV },
      { sep: 1 },
      { label: t('mi.exportPark'), fn: exportPark },
      { label: t('mi.importPark'), fn: importPark },
    ] },
    { label: t('menu.data'), items: [
      { label: () => t('mi.source') + (window.shmData?.mode === 'live' ? t('src.live') : t('src.sim')), info: 1 },
      { label: t('mi.exportTelem'), fn: exportTelemetry },
      { sep: 1 },
      { label: t('mi.exportInsp'), fn: exportInsp },
      { label: t('mi.importInsp'), fn: importInsp },
    ] },
    { label: t('menu.quality'), items: [
      { label: t('mi.calPanel'), fn: () => Calidad.showPanel() },
      { label: t('mi.calNew'), fn: () => Calidad.crearVacio() },
      { sep: 1 },
      { label: t('mi.calTemplate'), fn: () => Calidad.downloadTemplate() },
      { label: t('mi.calImport'), fn: () => Calidad.importXlsx() },
      { label: t('mi.calExport'), fn: () => Calidad.exportXlsx() },
    ] },
    { label: t('menu.report'), items: [
      { label: t('mi.parkReport'), fn: parkReport },
      { label: t('mi.selReport'), fn: selReport },
      { sep: 1 },
      { label: t('mi.about'), fn: showAbout },
    ] },
  ];

  const nav = document.createElement('nav'); nav.className = 'mb-menus';
  const closeAll = () => nav.querySelectorAll('.mb-menu.open').forEach(m => m.classList.remove('open'));
  for (const def of menus) {
    const m = document.createElement('div'); m.className = 'mb-menu';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'mb-top'; btn.textContent = def.label;
    const dd = document.createElement('div'); dd.className = 'mb-dd';
    const refreshers = [];
    for (const it of def.items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'mb-sep'; dd.appendChild(s); continue; }
      const mi = document.createElement('button'); mi.type = 'button'; mi.className = 'mb-item';
      const set = () => { mi.textContent = typeof it.label === 'function' ? it.label() : it.label; };
      set();
      if (it.info) { mi.disabled = true; mi.classList.add('mb-info'); refreshers.push(set); }
      else mi.addEventListener('click', () => { closeAll(); it.fn(); });
      dd.appendChild(mi);
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains('open'); closeAll();
      if (!wasOpen) {
        refreshers.forEach(f => f());
        m.classList.add('open');
        // El .mb-dd es position:fixed → posicionarlo bajo el botón (y clamp al viewport).
        const r = btn.getBoundingClientRect();
        dd.style.top = r.bottom + 'px';
        dd.style.left = Math.max(4, Math.min(r.left, innerWidth - dd.offsetWidth - 4)) + 'px';
      }
    });
    m.append(btn, dd); nav.appendChild(m);
  }
  document.addEventListener('click', closeAll);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  if (right) bar.insertBefore(nav, right); else bar.appendChild(nav);

  // Conmutador de idioma ES/EN (recarga la app para rehacer los render).
  const langBtn = document.createElement('button');
  langBtn.id = 'btn-lang'; langBtn.type = 'button'; langBtn.title = t('lang.tip');
  langBtn.textContent = getLang() === 'es' ? 'EN' : 'ES';
  langBtn.addEventListener('click', () => { setLang(getLang() === 'es' ? 'en' : 'es'); location.reload(); });
  if (right) right.insertBefore(langBtn, right.firstChild); else bar.appendChild(langBtn);
}

// «Acerca de ReWind» — tarjeta modal ligera (versión + crédito + fuente).
function showAbout() {
  document.getElementById('mb-about')?.remove();
  const ov = document.createElement('div'); ov.id = 'mb-about'; ov.className = 'mb-about';
  ov.innerHTML = `<div class="mb-about-card" role="dialog" aria-label="Acerca de ReWind">
    <button class="mb-about-x" type="button" aria-label="Cerrar">✕</button>
    <h2>ReWind <span>${REWIND_VER}</span></h2>
    <p>${t('about.desc')}</p>
    <p class="mb-about-mut">${t('about.credit')}</p>
  </div>`;
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.mb-about-x')) close(); });
  addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', esc); } });
  document.body.appendChild(ov);
}

// ── Control de Sol/sombras (hora + día + animación) ──────────────────────────
function buildSunControl(fleet) {
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

// ── Rosa de los vientos (3D): gira con la cámara para indicar el Norte ────────
function buildCompass(vpwrap, fleet) {
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

// ── Nameplate (cuadro con el nombre sobre la vista) ──────────────────────────
function buildNameplate(vpwrap) {
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
        `${t('banner.anom')} — ${labels.slice(0, 3).join(', ')}${n > 3 ? t('banner.more', n - 3) : ''}`;
      el.classList.add('show');
    },
  };
}

// Redimensiona el panel derecho arrastrando el divisor (#panel-resize-handle).
// Ajusta la variable CSS --panel-w del grid (#main); antes lo hacía app.js.
function initPanelResize() {
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

// Barra de estado inferior propia de ReWind (reemplaza la de modelado FEM).
function buildStatusBar(fleet, o = {}) {
  const bar = document.getElementById('statusbar');
  if (!bar) return { onTick() {}, setSelected() {}, setParque() {}, setAlarms() {} };
  const wrap = document.createElement('div'); wrap.className = 'shm-sb-wrap';
  wrap.innerHTML = `
    <span class="shm-sb" id="sb-parque">${t('sb.park')}: <b>—</b></span>
    <span class="shm-sb" id="sb-struct">${t('sb.struct')}: —</span>
    <span class="shm-sb" id="sb-avance">${t('sb.avance')}: —</span>
    <span class="shm-sb" id="sb-sens">${t('sb.sens')}: —</span>
    <span class="shm-sb" id="sb-alarm">${t('sb.alarm')}: 0</span>
    <span class="shm-sb" id="sb-wind">${t('sb.wind')}: —</span>
    <span class="shm-sb" id="sb-source">${t('sb.source')}: ${o.source || '—'}</span>
    <span class="shm-sb shm-sb-grow" id="sb-selstruct">${t('sb.nosel')}</span>
    <span class="shm-sb" id="sb-clock">--:--:--</span>`;
  bar.appendChild(wrap);
  const $ = (id) => wrap.querySelector('#' + id);
  const locale = getLang() === 'en' ? 'en-GB' : 'es-CL';
  const clock = () => { $('sb-clock').textContent = new Date().toLocaleTimeString(locale); };
  clock(); setInterval(clock, 1000);
  return {
    setParque(name, count) { $('sb-parque').querySelector('b').textContent = name || '—'; if (count != null) $('sb-struct').textContent = `${t('sb.struct')}: ${count}`; },
    setSelected(obj) {
      let txt = obj ? `${t('sb.sel')}: ${obj.label}` : t('sb.nosel');
      if (obj) { const q = Calidad.structureSummary?.(obj.id); if (q) txt += ` · ${t('cal.tc.quality')} ${Math.round(q.pctAprobado * 100)}% (${q.pendientes} ${t('cal.tc.pend')})`; }
      $('sb-selstruct').textContent = txt;
    },
    setAlarms(n) { const e = $('sb-alarm'); e.textContent = `${t('sb.alarm')}: ${n}`; e.classList.toggle('on', n > 0); },
    onTick(msg) {
      let ok = 0, fault = 0, wsum = 0, wn = 0;
      for (const id in msg.summaries) { const s = msg.summaries[id]; for (const se of s.sensors) (se.status === 'fault' ? fault++ : ok++); if (s.wind != null) { wsum += s.wind; wn++; } }
      $('sb-sens').textContent = `${t('sb.sens')}: ${ok} ${t('sb.ok')} · ${fault} ${t('sb.fault')}`;
      $('sb-wind').textContent = `${t('sb.wind')}: ${wn ? (wsum / wn).toFixed(1) : '—'} m/s`;
      const bs = fleet.structures.map(s => s.built).filter(b => b != null);
      $('sb-avance').textContent = `${t('sb.avance')}: ${bs.length ? Math.round(bs.reduce((a, b) => a + b, 0) / bs.length * 100) : 0}%`;
    },
  };
}

// Ficha flotante junto a la torre seleccionada: datos generales + avance de obra.
function buildTowerCard(vpwrap, fleet, o = {}) {
  const onShowAvance = o.onShowAvance || (() => {});
  const el = document.createElement('div');
  el.id = 'shm-towercard'; el.style.display = 'none';
  (vpwrap || document.body).appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target.closest('.tc-x')) { dismissed = true; el.style.display = 'none'; return; }
    if (!e.target.closest('.tc-btn') || !cur) return;
    if (shadowEntry) window.shmMap?.flickerReport();   // modo sombra: botón → informe completo
    else onShowAvance(cur.id);
  });
  let cur = null, lastT = 0, dismissed = false, shadowEntry = null;
  // Ficha en modo Shadow: la torre seleccionada actúa como RECEPTOR → muestra su
  // parpadeo de sombra (como el popup del 2D) + acceso al informe completo.
  const renderShadow = () => {
    const r = shadowEntry, res = r.res;
    el.innerHTML = `
      <div class="tc-h">☀️ Receptor · ${cur.label}<button class="tc-x" type="button" title="Cerrar">✕</button></div>
      <div class="tc-r"><span>Parpadeo (worst)</span><b class="${res.hoursYear > 30 ? 'bad' : ''}">${res.hoursYear.toFixed(1)} h/año</b></div>
      <div class="tc-r"><span>Máx por día</span><b class="${res.maxMinDay > 30 ? 'bad' : ''}">${res.maxMinDay} min</b></div>
      <div class="tc-r"><span>Días afectados</span><b>${res.daysAffected}</b></div>
      <div class="tc-r"><span>Real (meteo)</span><b>${res.hoursYearReal.toFixed(1)} h/año</b></div>
      <div class="tc-r"><span>Cumplimiento</span><b class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ Cumple' : '✗ Excede'}</b></div>
      <div class="tc-stage">${r.win ? '⏸ Parada sugerida: ' + r.win.months + ' · ' + r.win.hours : 'Sin ventana crítica'}</div>
      <button class="tc-btn" type="button">📄 Informe completo ›</button>`;
  };
  const render = () => {
    if (!cur) return;
    if (shadowEntry) { renderShadow(); return; }
    const sum = window.shmData?.get(cur.id);
    const pct = Math.round((cur.built != null ? cur.built : 1) * 100);
    const sp = (s) => s.pct != null ? s.pct : (s.done ? 100 : 0);
    const doneN = cur.stages ? cur.stages.filter(s => sp(s) >= 100).length : 0;
    const etapa = cur.stages ? (pct >= 100 ? 'Obra completa' : `${doneN}/${cur.stages.length} etapas`) : '';
    el.innerHTML = `
      <div class="tc-h">${cur.label}<button class="tc-x" type="button" title="Cerrar">✕</button></div>
      <div class="tc-r"><span>${cur.type === 'hv' ? 'Torre AT' : 'Aerogenerador'}</span><b>${cur.height} m</b></div>
      ${sum ? `<div class="tc-r"><span>f₁</span><b>${sum.f1.toFixed(3)} Hz</b></div>` : ''}
      ${sum ? `<div class="tc-r"><span>Viento</span><b>${sum.wind != null ? sum.wind.toFixed(1) + ' m/s' : '—'}</b></div>` : ''}
      ${sum ? `<div class="tc-r"><span>Temp.</span><b>${sum.temp.toFixed(1)} °C</b></div>` : ''}
      <div class="tc-r"><span>Avance</span><b>${pct}%</b></div>
      <div class="tc-bar"><i style="width:${pct}%"></i></div>
      <div class="tc-stage">${etapa}</div>
      <button class="tc-btn" type="button">Ver avance ›</button>`;
  };
  const tick = () => {                    // llamado por fleet.onFrame (bucle de render)
    if (!cur || dismissed) return;
    const a = fleet.anchorScreen(cur);
    if (a && !a.behind) {
      const wr = (vpwrap || document.body).getBoundingClientRect();
      el.style.display = 'block';
      // Clamp al viewport: en modo Shadow la cámara no hace zoom a la torre (vista
      // amplia), así que la torre puede quedar fuera de pantalla → fija la ficha al
      // borde para que el informe del receptor siempre se vea (transform: translateY(-50%)).
      const cw = el.offsetWidth || 190, chh = el.offsetHeight || 130;
      const x = Math.max(8, Math.min(a.x - wr.left + 16, wr.width - cw - 8));
      const y = Math.max(8 + chh / 2, Math.min(a.y - wr.top, wr.height - chh / 2 - 8));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    } else el.style.display = 'none';
    const now = performance.now();
    if (now - lastT > 500) { lastT = now; render(); }
  };
  return {
    tick,
    setData(st) { shadowEntry = null; cur = st; dismissed = false; if (!st) { el.style.display = 'none'; return; } render(); },
    // Modo Shadow: la torre seleccionada es el receptor (entry = {res, ok, win, …}).
    setShadow(st, entry) { cur = st; shadowEntry = entry; dismissed = false; if (!st || !entry) { el.style.display = 'none'; return; } render(); },
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
        <div class="shm-sub">${t('dash.sub')} · <span style="opacity:.7">${REWIND_VER}</span></div>
      </div>
      <button id="shm-report-btn" title="${t('dash.reportBtn.tip')}">${t('dash.reportBtn')}</button>
    </div>
    <div class="shm-main">
    <div class="shm-toptabs">
      <button class="shm-toptab active" data-v="parque">${t('tab.parque')}</button>
      <button class="shm-toptab" data-v="seleccion">${t('tab.seleccion')}</button>
      <button class="shm-toptab" data-v="obra">${t('tab.obra')}</button>
      <button class="shm-toptab" data-v="insp">${t('tab.insp')}</button>
      <button class="shm-toptab" data-v="shm">${t('tab.shm')}</button>
      <button class="shm-toptab" data-v="shadow">${t('tab.shadow')}</button>
    </div>
    <div class="shm-views">
    <div class="shm-view" id="view-obra" style="display:none"><div class="shm-avance" id="shm-avance"></div></div>
    <div class="shm-view" id="view-insp" style="display:none"><div class="shm-detail" id="shm-insp"></div></div>
    <div class="shm-view" id="view-shm" style="display:none"><div class="shm-detail" id="shm-shm"></div></div>
    <div class="shm-view" id="view-shadow" style="display:none"><div class="shm-shadow" id="shm-shadow"></div></div>
    <div class="shm-view" id="view-parque">
      <div class="shm-fleet">
        <div class="shm-stat"><div class="k">${t('sb.struct')}</div><div class="v" id="shm-count">0</div></div>
        <div class="shm-stat"><div class="k">${t('sh.sensOk')}</div><div class="v" style="color:var(--success)" id="shm-ok">0</div></div>
        <div class="shm-stat"><div class="k">${t('pq.faults')}</div><div class="v" style="color:var(--danger)" id="shm-fault">0</div></div>
        <div class="shm-stat"><div class="k">${t('sb.alarm')}</div><div class="v" style="color:var(--danger)" id="shm-alarm-count">0</div></div>
      </div>
      <div class="shm-parkprog" id="shm-parkprog"></div>
      <div class="shm-venc" id="shm-venc"></div>
      <div class="shm-listwrap">
        <div class="shm-list-h">${t('pq.listH')}</div>
        <div class="shm-list" id="shm-list"></div>
      </div>
    </div>
    <div class="shm-view" id="view-seleccion" style="display:none">
      <div class="shm-detail" id="shm-detail"><div class="empty">${t('empty.select')}</div></div>
    </div>
    </div>
    </div>`;
  panel.appendChild(el);
  const $ = (s) => el.querySelector(s);
  el.querySelector('#shm-report-btn').addEventListener('click', () => buildReport(null));   // compilado del parque

  // Pestañas de nivel superior: Parque (flota) ⇄ Selección (estructura) ⇄ Shadow flicker.
  function setTopView(v) {
    for (const w of ['parque', 'seleccion', 'obra', 'insp', 'shm', 'shadow']) $('#view-' + w).style.display = v === w ? '' : 'none';
    el.querySelectorAll('.shm-toptab').forEach(t => t.classList.toggle('active', t.dataset.v === v));
    // Sincroniza el estado activo de los accesos del toolbar a las pestañas del panel.
    const PANEL_TOOLS = { insp: 'shm-pinsp-tool', shm: 'shm-pshm-tool' };
    for (const [view, id] of Object.entries(PANEL_TOOLS)) document.getElementById(id)?.classList.toggle('active', v === view);
    if (v === 'shadow') renderShadow();
    if (v === 'obra') {
      try {
        renderAvance($('#shm-avance'), fleet.structures, current, (st) => {
          st.built = builtFromStages(st.stages);
          fleet.setProgress(st.id, st.built);
          fleet.onLayoutChange?.();
          updateParkProgress(); window.shmMap?.refresh?.();
        });
      } catch (e) { console.warn('[shm] avance', e); }
    }
    if (v === 'insp') renderInsp();        // siembra la inspección si no existe
    if (v === 'shm') renderSHM();
    if (v === 'parque') updateRollup();
    // El HUD flotante (callouts por componente) sigue a la pestaña — DESPUÉS de
    // renderInsp (que siembra), para que el modo insp vea los hallazgos.
    const _hud = window.shmAvanceHUD;
    if (_hud && current && (current.type === 'turbine' || current.type === 'hv')) {
      if (['obra', 'seleccion', 'insp', 'shm'].includes(v)) _hud.show(current, v === 'insp' ? 'insp' : v === 'shm' ? 'shm' : 'avance');
      else if (v === 'parque') _hud.hide();
    }
  }
  el.querySelectorAll('.shm-toptab').forEach(t => t.addEventListener('click', () => setTopView(t.dataset.v)));

  // ── Pestaña «Shadow flicker»: análisis de sombras en el panel derecho ────────
  // Los controles de hora/fecha viven en el HUD flotante (sobre el visor); aquí van
  // los ANÁLISIS: mapa de flicker, informes y la lista de receptores (viviendas).
  function renderShadow() {
    const host = $('#shm-shadow'); if (!host) return;
    const mv = window.shmMap;
    if (!fleet.sunMode) {
      host.innerHTML = `<div class="ssh-off">${t('ssh.off')}<br><br>${t('ssh.offHint')}</div>`;
      return;
    }
    const rcp = (mv?._receptors) || [];
    const nEx = rcp.filter(r => !r.ok).length;
    const nOk = rcp.length - nEx;
    const opTurb = fleet.structures.filter(s => s.type !== 'hv' && (s.built ?? 1) >= 0.97).length;
    const worst = rcp.reduce((a, r) => r.res.hoursYear > (a?.res.hoursYear ?? -1) ? r : a, null);
    const sp = fleet.getSunInfo?.();
    const stime = fleet._sunTime || {};
    const dateStr = (stime.year != null) ? `${String(stime.day).padStart(2, '0')}/${String((stime.month0 ?? 0) + 1).padStart(2, '0')}/${stime.year}` : '—';
    const hourStr = (stime.hour != null) ? `${String(Math.floor(stime.hour)).padStart(2, '0')}:${String(Math.round((stime.hour % 1) * 60) % 60).padStart(2, '0')}` : '—';
    const sunStr = sp ? (sp.elevation > 0 ? `${sp.elevation.toFixed(0)}° alt · ${sp.azimuth.toFixed(0)}° az` : t('ssh.night')) : '—';
    const compliance = !rcp.length ? { txt: t('ssh.cNone'), cls: 'na' }
      : nEx ? { txt: t('ssh.cBad', nEx, rcp.length), cls: 'bad' }
      : { txt: t('ssh.cOk', rcp.length), cls: 'ok' };

    const rows = rcp.length ? rcp.map(r => `
      <div class="ssh-rcp ${r.ok ? 'ok' : 'bad'}">
        <span class="ssh-n" title="${r.name || t('ssh.rcpName', r.n)}">${r.name ? r.name : '#' + r.n}</span>
        <span class="ssh-v">
          <b>${r.res.hoursYear.toFixed(1)}</b> ${t('ssh.hYear')}<span class="ssh-sub"> (real≈${r.res.hoursYearReal.toFixed(1)})</span><br>
          <span class="ssh-st">${t('ssh.minDay', r.res.maxMinDay)} · ${t('ssh.days', r.res.daysAffected)} · ${r.ok ? t('ssh.comply') : t('ssh.exceed')}</span>
          ${r.win ? `<span class="ssh-st">${t('ssh.stop', r.win.months, r.win.hours)}</span>` : ''}
        </span>
        <button class="ssh-del" data-n="${r.n}" title="${t('ssh.delTip')}">✕</button>
      </div>`).join('') : `<div class="ssh-empty">${t('ssh.empty')}</div>`;

    host.innerHTML = `
      <div class="ssh-hdr">${t('ssh.hdr')}</div>
      <div class="ssh-banner ${compliance.cls}">${compliance.cls === 'ok' ? '✓' : compliance.cls === 'bad' ? '✗' : 'ℹ'} ${compliance.txt}
        <span class="ssh-banner-sub">${t('ssh.limit')}</span></div>
      <div class="ssh-kpis">
        <div class="ssh-kpi"><div class="k">${t('ssh.kTurb')}</div><div class="v">${opTurb}</div></div>
        <div class="ssh-kpi"><div class="k">${t('ssh.kRcp')}</div><div class="v">${rcp.length}</div></div>
        <div class="ssh-kpi"><div class="k">${t('ssh.kOk')}</div><div class="v" style="color:var(--success,#22c55e)">${nOk}</div></div>
        <div class="ssh-kpi"><div class="k">${t('ssh.kEx')}</div><div class="v" style="color:var(--danger,#ef4444)">${nEx}</div></div>
        <div class="ssh-kpi wide"><div class="k">${t('ssh.kWorst')}</div><div class="v">${worst ? `#${worst.n} · ${worst.res.hoursYear.toFixed(1)} ${t('ssh.hYear')}` : '—'}</div></div>
      </div>
      <div class="ssh-params">
        <div class="ssh-prow"><span>${t('ssh.sunNow')}</span><b>${sunStr}</b></div>
        <div class="ssh-prow"><span>${t('ssh.dateHour')}</span><b>${dateStr} · ${hourStr}</b></div>
        <div class="ssh-prow"><span>${t('ssh.hubRotor')}</span><b>90 m · Ø84 m</b></div>
        <div class="ssh-prow"><span>${t('ssh.method')}</span><b>${t('ssh.methodV')}</b></div>
      </div>
      <div class="ssh-actions">
        <button id="ssh-fmap" class="sun-btn js-fmap ${mv?._flickerOverlay ? 'active' : ''}" type="button">${t('ssh.fmap')}</button>
        <div class="sun-legend"><span><i style="background:#bee678"></i>1–5</span><span><i style="background:#fde047"></i>5–15</span><span><i style="background:#fb923c"></i>15–30</span><span><i style="background:#ef4444"></i>≥30 ✗</span></div>
        <button id="ssh-report" class="sun-btn" type="button">${t('ssh.reportAll')}</button>
        <button id="ssh-inter" class="sun-btn" type="button">${t('ssh.inter')}</button>
      </div>
      <div class="ssh-rcp-h">${t('ssh.rcpH')} · ${rcp.length}${rcp.length ? ` · ${t('ssh.exceedN', nEx)}` : ''}
        <span class="ssh-rcp-act">
          <input type="file" id="ssh-file" accept=".csv,.txt,.kml,.kmz,.geojson,.json,.shp" style="display:none">
          <button id="ssh-import" class="ssh-mini" type="button" title="${t('ssh.importTip')}">${t('ssh.import')}</button>
          ${rcp.length ? `<button id="ssh-clear" class="ssh-mini" type="button" title="${t('ssh.clearTip')}">${t('ssh.clear')}</button>` : ''}
        </span>
      </div>
      <div class="ssh-list">${rows}</div>
      <div class="ssh-foot">${t('ssh.foot')}</div>`;
    host.querySelector('#ssh-fmap')?.addEventListener('click', () => { window.shmMap?.toggleFlickerMap(); window.shmSyncFlickerBtns?.(); });
    host.querySelector('#ssh-report')?.addEventListener('click', () => window.shmMap?.flickerReport());
    host.querySelector('#ssh-inter')?.addEventListener('click', () => window.shmMap?.interTurbineReport());
    host.querySelectorAll('.ssh-del').forEach(b => b.addEventListener('click', () => window.shmMap?.removeReceptor(+b.dataset.n)));
    const fileInp = host.querySelector('#ssh-file');
    host.querySelector('#ssh-import')?.addEventListener('click', () => fileInp?.click());
    fileInp?.addEventListener('change', async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await window.shmMap?.importReceptors(f); });
    host.querySelector('#ssh-clear')?.addEventListener('click', () => { if (confirm(t('ssh.clearConfirm'))) window.shmMap?.clearReceptors(); });
  }
  function showShadow() { setTopView('shadow'); }

  let list = [], current = null, pane = 'datos', sigBuf = {}, sigRAF = null, freqHist = {};
  let inspSel = null;   // id de la inspección abierta en la pestaña Inspección
  let specOff = null, specLast = 0;                 // espectrograma (offscreen + scroll)
  const clsHist = {}, clsEvents = {}; let lastHistT = 0;   // histórico de clasificación ML
  const SPEC_W = 170, SPEC_BINS = 48, SPEC_FMAX = 6;
  const heat = (t) => {
    t = Math.max(0, Math.min(1, t));
    const s = [[12, 16, 32], [22, 90, 190], [30, 200, 200], [240, 220, 60], [232, 50, 40]];
    const x = t * (s.length - 1), i = Math.floor(x), f = x - i, a = s[i], b = s[Math.min(i + 1, s.length - 1)];
    return `rgb(${a[0] + (b[0] - a[0]) * f | 0},${a[1] + (b[1] - a[1]) * f | 0},${a[2] + (b[2] - a[2]) * f | 0})`;
  };

  // Color del punto por AVANCE de obra (mismo criterio que el mapa 2D).
  function progColor(st) {
    if (!st) return 'var(--text-muted)';
    if (st.alarm) return '#ef4444';
    const b = st.built != null ? st.built : 1;
    if (b >= 0.97) return '#22c55e';   // operativa
    if (b <= 0.02) return '#94a3b8';   // solo fundación
    return '#f59e0b';                  // en montaje
  }
  function setStructures(structs) {
    list = structs;
    $('#shm-count').textContent = structs.length;
    const lc = $('#shm-list'); lc.innerHTML = '';
    for (const s of structs) {
      const row = document.createElement('button');
      row.className = 'shm-row'; row.dataset.id = s.id;
      const c = progColor(fleet.getStructure(s.id));
      row.innerHTML = `<span class="dot" style="background:${c};box-shadow:0 0 6px ${c}"></span><span class="nm">${s.label}</span><span class="ty">${s.type === 'hv' ? 'AT' : 'T'}</span>`;
      row.addEventListener('click', () => fleet.selectById(s.id));
      lc.appendChild(row);
    }
    highlight();
    updateParkProgress();
    updateRollup();
  }
  function highlight() {
    el.querySelectorAll('.shm-row').forEach(r => r.classList.toggle('active', current && r.dataset.id === current.id));
  }
  // Resumen de avance de obra del parque (barra + conteo por etapa) en la cabecera.
  function updateParkProgress() {
    const box = $('#shm-parkprog'); if (!box) return;
    const bs = fleet.structures.map(s => s.built).filter(b => b != null);
    if (!bs.length) { box.innerHTML = ''; return; }
    const avg = Math.round(bs.reduce((a, b) => a + b, 0) / bs.length * 100);
    const done = bs.filter(b => b >= 0.999).length, found = bs.filter(b => b <= 0.02).length;
    box.innerHTML = `<div class="pp-top"><span>${t('pp.parkProg')}</span><b>${avg}%</b></div>
      <div class="pp-bar"><i style="width:${avg}%"></i></div>
      <div class="pp-sub">${t('pp.sub', done, bs.length - done - found, found)}</div>`;
  }
  // Rollup de vencimientos de inspección a nivel PARQUE (bandeja en la pestaña Parque).
  function updateRollup() {
    const box = $('#shm-venc'); if (!box) return;
    let vOverdue = 0, vSoon = 0, woOpen = 0, woOverdue = 0;
    const items = [];
    for (const st of fleet.structures) {
      const insps = Insp.getInspections(st.id); if (!insps.length) continue;
      const latest = insps[0], due = Insp.dueState(latest.nextDate);
      let open = 0, odue = 0;
      for (const ins of insps) for (const w of (ins.workOrders || [])) if (w.status !== 'cerrado') { open++; if (Insp.dueState(w.due).overdue) odue++; }
      if (due.overdue) vOverdue++; else if (due.soon) vSoon++;
      woOpen += open; woOverdue += odue;
      if (due.overdue || due.soon || open) items.push({ id: st.id, label: st.label, due, open, odue });
    }
    items.sort((a, b) => (b.due.overdue - a.due.overdue) || (b.odue - a.odue) || (b.open - a.open));
    const acts = `<span class="venc-acts">
      <input type="file" id="venc-file" accept=".json,application/json" style="display:none">
      <button id="venc-export" class="venc-mini" title="${t('venc.exportTip')}">${t('venc.export')}</button>
      <button id="venc-import" class="venc-mini" title="${t('venc.importTip')}">${t('venc.import')}</button></span>`;
    if (!items.length) {
      box.innerHTML = `<div class="venc-h">${t('venc.h')} ${acts}</div><div class="venc-ok">${t('venc.ok')}</div>`;
    } else {
      const rows = items.slice(0, 8).map(it => `
        <button class="venc-row" data-venc="${it.id}">
          <span class="venc-dot ${it.due.overdue ? 'bad' : it.due.soon ? 'warn' : 'ok'}"></span>
          <span class="venc-nm">${it.label}</span>
          <span class="venc-badges">${it.due.overdue ? `<i class="b bad">${t('venc.overdue')}</i>` : it.due.soon ? `<i class="b warn">${t('venc.soon')}</i>` : ''}${it.open ? `<i class="b ${it.odue ? 'bad' : ''}">${it.open} OT${it.odue ? ` · ${it.odue}⚠` : ''}</i>` : ''}</span>
        </button>`).join('');
      box.innerHTML = `
        <div class="venc-h">${t('venc.h')} <span class="venc-sum">${t('venc.sum', vOverdue, vSoon, woOpen, woOverdue)}</span> ${acts}</div>
        <div class="venc-list">${rows}</div>`;
    }
    box.querySelectorAll('[data-venc]').forEach(b => b.addEventListener('click', () => { fleet.selectById(b.dataset.venc); window.shmDash?.showInsp?.(); }));
    box.querySelector('#venc-export').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([Insp.exportJSON()], { type: 'application/json' }));
      a.download = `rewind_inspecciones_${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    const vf = box.querySelector('#venc-file');
    box.querySelector('#venc-import').addEventListener('click', () => vf.click());
    vf.addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
      const merge = confirm(t('venc.confirm'));
      try { const n = Insp.importJSON(await f.text(), !merge); updateRollup(); if (current) renderInsp(); alert(t('venc.imported', n)); }
      catch (err) { alert(t('venc.importFail', err.message || err)); }
    });
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
    sigBuf = {}; freqHist = {}; specOff = null; inspSel = null;
    if (!obj) {
      stopSig();
      $('#shm-detail').innerHTML = `<div class="empty">${t('empty.select')}</div>`;
      ['#shm-insp', '#shm-shm'].forEach(s => { const n = $(s); if (n) n.innerHTML = ''; });
      setTopView('parque'); return;
    }
    renderDetail();              // Selección = identidad
    setTopView('seleccion');     // por defecto; fleet.onSelect lo redirige a Obra/Shadow según el modo
  }

  // Selección: IDENTIDAD de la estructura + condiciones actuales + orientación.
  // (Estado por sensores → SHM · evaluación/inspección → Inspección · avance → Obra.)
  function renderDetail() {
    const o = current; if (!o) return;
    const sum = (window.shmData && window.shmData.get(o.id)) || null;
    const twin = window.shmTwin?.[o.type];
    $('#shm-detail').innerHTML = `
      <div id="shm-alarmbar" style="display:none"></div>
      <div class="shm-body">
        <div class="row"><span>${t('det.structure')}</span><b>${o.label}</b></div>
        <div class="row"><span>${t('det.type')}</span><b>${o.type === 'hv' ? t('det.typeHV') : t('det.typeTurbine')}</b></div>
        <div class="row"><span>${t('det.height')}</span><b>${o.height} m</b></div>
        ${o.type === 'turbine' ? `<div class="row"><span>${t('det.power')}</span><b>~3 MW</b></div>` : ''}
        <div class="row"><span>${t('det.sensors')}</span><b id="d-ns">—</b></div>
        <div class="row"><span>${t('det.f1twin')}</span><b>${twin ? twin.toFixed(3) + ' Hz' : t('det.calc')}</b></div>
        <div class="row"><span>${t('det.f1now')}</span><b id="d-f1">—</b></div>
        <div class="row"><span>${t('det.wind')}</span><b id="d-wind">—</b></div>
        <div class="row"><span>${t('det.temp')}</span><b id="d-temp">—</b></div>
        <div class="yaw-ctrl">
          <label>${t('det.orient')} <b id="yaw-val"></b></label>
          <input type="range" id="yaw-slider" min="0" max="359" step="1">
        </div>
        <div class="note" style="font-size:10px">${t('det.note')}</div>
      </div>
      <div class="shm-detail-foot"><button id="shm-tower-report">${t('det.report')}</button></div>`;
    _abKey = ''; updateAlarmBar();
    const sl = $('#yaw-slider'), vv = $('#yaw-val');
    const deg0 = Math.round(((fleet.getYaw(o.id) * 180 / Math.PI) % 360 + 360) % 360);
    sl.value = deg0; vv.textContent = deg0 + '°';
    sl.addEventListener('input', () => { vv.textContent = sl.value + '°'; fleet.setYaw(o.id, sl.value * Math.PI / 180); fleet.onLayoutChange?.(); });
    $('#shm-tower-report').addEventListener('click', () => buildReport(current));
    updateDynamic(sum);
  }

  // ── Pestaña SHM: estado por sensores + señal + sensores + avanzado ───────────
  function renderSHM() {
    const o = current; if (!o) { const h = $('#shm-shm'); if (h) h.innerHTML = `<div class="empty">${t('empty.select')}</div>`; return; }
    if (!['estado', 'senal', 'sensores', 'avz', 'fatiga'].includes(pane)) pane = 'estado';
    $('#shm-shm').innerHTML = `
      <div class="shm-tabs">
        <button class="shm-tab" data-p="estado">${t('tab.estado')}</button>
        <button class="shm-tab" data-p="senal">${t('tab.senal')}</button>
        <button class="shm-tab" data-p="sensores">${t('tab.sensores')}</button>
        <button class="shm-tab" data-p="fatiga">${t('tab.fatiga')}</button>
        <button class="shm-tab" data-p="avz">${t('tab.avz')}</button>
      </div>
      <div class="shm-body" id="shm-pane"></div>`;
    el.querySelectorAll('#shm-shm .shm-tab').forEach(t => t.addEventListener('click', () => { pane = t.dataset.p; renderSHMPane(); }));
    renderSHMPane();
  }

  function renderSHMPane() {
    stopSig();
    el.querySelectorAll('#shm-shm .shm-tab').forEach(t => t.classList.toggle('active', t.dataset.p === pane));
    const o = current, body = el.querySelector('#shm-shm #shm-pane'); if (!o || !body) return;
    const sum = (window.shmData && window.shmData.get(o.id)) || null;
    if (pane === 'estado') {
      const dmg = sum ? Math.round((sum.dmg || 0) * 100) : 0;
      body.innerHTML = `
        <div class="row"><span>${t('sh.cls')}</span><b id="sh-cls">…</b></div>
        <div class="row"><span>${t('sh.dmg')}</span><b id="sh-dmg">${dmg}%</b></div>
        <div class="row"><span>${t('sh.sensOk')}</span><b id="sh-ns">—</b></div>
        <div class="row"><span>${t('sh.f1now')}</span><b id="sh-f1">—</b></div>
        <div class="note" style="font-size:10px">${t('sh.note')}</div>`;
    } else if (pane === 'senal') {
      body.innerHTML = `<div class="note" style="margin-top:0">${t('sig.note')}</div><div id="sig-wrap"></div>`;
      const wrap = body.querySelector('#sig-wrap');
      for (const se of o.sensors) {
        const lab = document.createElement('div'); lab.className = 'row'; lab.style.border = '0';
        lab.innerHTML = `<span>${se.id}</span><b class="sig-st">…</b>`;
        const cv = document.createElement('canvas'); cv.className = 'sig'; cv.dataset.sid = se.id;
        wrap.append(lab, cv);
      }
      startSig();
    } else if (pane === 'sensores') {
      const gwRow = o.gateway?.mesh
        ? `<div class="shm-sensor"><span class="dot ok"></span><span style="flex:1">📶 ${t('ahud.gateway')} <span class="ins-mut" style="font-size:10px">(${t('ahud.gwRoleV')})</span></span><b style="color:var(--success)">${t('ahud.gwOnline')}</b></div>`
        : '';
      const custom = Instr.getSensors(o.id);
      const customRows = custom.map(cs =>
        `<div class="shm-sensor"><span class="dot ok"></span><span style="flex:1">${Instr.typeIcon(cs.type)} ${cs.label || Instr.typeLabel(cs.type)} <span class="ins-mut" style="font-size:10px">· ${Math.round((cs.yFrac || 0) * 100)}%</span></span><b class="s-custom" data-cs-id="${cs.id}" data-cs-type="${cs.type}">—</b><button class="ins-x cs-del" data-csd="${cs.id}" title="${t('instr.remove')}">✕</button></div>`
      ).join('');
      const typeOpts = Instr.SENSOR_TYPES.map(ty => `<option value="${ty.key}">${Instr.typeLabel(ty.key)}</option>`).join('');
      body.innerHTML = o.sensors.map(se =>
        `<div class="shm-sensor"><span class="dot ${se.status}"></span><span style="flex:1">${se.id}</span><b class="s-rms" data-sid="${se.id}">—</b></div>`
      ).join('') + gwRow
        + (custom.length ? `<div class="shm-sub2">${t('instr.custom')} · ${custom.length}</div>${customRows}` : '')
        + `<div class="instr-add">
             <select id="cs-type">${typeOpts}</select>
             <input type="text" id="cs-label" placeholder="${t('instr.labelPh')}">
             <label class="cs-h">${t('instr.height')} <input type="range" id="cs-yfrac" min="0" max="100" step="5" value="60"><b id="cs-yv">60%</b></label>
             <button id="cs-add" class="ins-btn">${t('instr.add')}</button>
           </div>`
        + `<div class="note">${t('sens.note')} ${t('instr.note')}</div>`;
      const yf = body.querySelector('#cs-yfrac'), yv = body.querySelector('#cs-yv');
      yf?.addEventListener('input', () => yv.textContent = yf.value + '%');
      body.querySelector('#cs-add')?.addEventListener('click', () => {
        Instr.addSensor(o.id, { type: body.querySelector('#cs-type').value, label: body.querySelector('#cs-label').value, yFrac: (+yf.value || 0) / 100 });
        if (window.shmAvanceHUD && current === o) window.shmAvanceHUD.show(o, 'shm');   // refleja en el HUD
        renderSHMPane();
      });
      body.querySelectorAll('.cs-del').forEach(b => b.addEventListener('click', () => {
        Instr.removeSensor(o.id, b.dataset.csd);
        if (window.shmAvanceHUD && current === o) window.shmAvanceHUD.show(o, 'shm');
        renderSHMPane();
      }));
    } else if (pane === 'fatiga') {
      const a = assessFatigueFor(o, sum);
      const st = Fat.fatigueState(a.Delapsed);
      const yr = t('units.years');
      const rulLab = !isFinite(a.rul) ? '∞' : a.rul <= 0 ? `0 ${yr} ⚠` : `${a.rul.toFixed(0)} ${yr}`;
      const lifeLab = !isFinite(a.lifeYears) ? '∞' : `${a.lifeYears.toFixed(0)} ${yr}`;
      body.innerHTML = `
        <div class="fat-kpis">
          <div class="fat-kpi"><div class="k">${t('fat.lifeUsed')}</div><div class="v ${st.key}">${(a.Delapsed * 100).toFixed(0)}%</div></div>
          <div class="fat-kpi"><div class="k">${t('fat.rul')}</div><div class="v ${a.rul <= 2 ? 'critica' : ''}">${rulLab}</div></div>
          <div class="fat-kpi"><div class="k">${t('fat.dmgYear')}</div><div class="v">${a.Dyear.toExponential(1)}</div></div>
          <div class="fat-kpi"><div class="k">DEL (m=3)</div><div class="v">${a.del3.toFixed(0)}<small> MPa</small></div></div>
        </div>
        <div class="row"><span>${t('fat.state')}</span><b class="${st.key}">${t('fat.state.' + st.key)}</b></div>
        <div class="row"><span>${t('fat.designLife')}</span><b>${lifeLab}</b></div>
        <div class="row"><span>${t('fat.yis')}</span><b>${a.yearsInService} ${yr}</b></div>
        <div class="row" style="border:0"><span>${t('fat.detail')}</span><b>EN 1993-1-9 · ΔσC ${a.detail}</b></div>
        <div class="shm-sub2">${t('fat.spectrum')}</div>
        ${fatigueSpectrumSVG(a)}
        <div class="note" style="font-size:10px">${t('fat.note')}</div>`;
    } else if (pane === 'avz') {
      const nvm = o.type === 'turbine'
        ? `<div class="note">${t('avz.nvmNote')}</div>
           <div id="nvm-wrap" style="display:flex;gap:6px">
             <canvas class="sig nvm" data-k="N" style="height:130px;flex:1"></canvas>
             <canvas class="sig nvm" data-k="V" style="height:130px;flex:1"></canvas>
             <canvas class="sig nvm" data-k="M" style="height:130px;flex:1"></canvas>
           </div>
           <div class="row" style="border:0"><span>N · V · M (base)</span><b id="nvm-info">…</b></div>`
        : `<div class="note">${t('avz.axialNote')}</div>
           <div class="row"><span>${t('avz.axialT')}</span><b id="hv-t">…</b></div>
           <div class="row"><span>${t('avz.axialC')}</span><b id="hv-c">…</b></div>`;
      body.innerHTML = `
        <div class="note" style="margin-top:0">${t('avz.fftNote')}</div>
        <canvas class="sig" id="fft-canvas" style="height:110px"></canvas>
        <div class="row" style="border:0"><span>${t('avz.fftPeak')}</span><b id="fft-peak">—</b></div>
        <div class="note">${t('avz.specNote')}</div>
        <canvas class="sig" id="spec-canvas" style="height:90px"></canvas>
        <div class="note">${t('avz.freqNote')}</div>
        <canvas class="sig" id="freq-canvas" style="height:80px"></canvas>
        ${nvm}
        <div class="note">${t('avz.note')}</div>`;
      if (o.type === 'hv') {
        const ax = window.shmTwin?.hvAxial;
        if (ax) { $('#hv-t').textContent = `${ax.tMax.toFixed(0)} kN`; $('#hv-c').textContent = `${ax.cMax.toFixed(0)} kN`; }
      }
      startAvz();
    }
    updateDynamic(sum);
  }

  // ── Pestaña Inspección: micro-sistema de gestión (R-32) ──────────────────────
  // Inspecciones por estructura con hallazgos catalogados → score determinista
  // 0–100 (port de structapp-base), ensayos, documentos, histórico de evaluación
  // e informe. La «evaluación de inspección» es distinta del estado por sensores (SHM).
  const ihash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

  // Entradas de fatiga por estructura (R-22): viento medio del sitio estable por
  // torre, índice de daño del live, años en servicio determinista, armónicos
  // 1P/3P solo en aerogeneradores (la torre AT fatiga por bataneo de viento).
  function assessFatigueFor(o, sum) {
    const h = ihash(o.id), turbine = o.type === 'turbine';
    return Fat.assessFatigue({
      id: o.id,
      vMean: 7.5 + (h % 5) * 0.4,                 // viento medio del sitio (estable)
      dmgIndex: sum ? (sum.dmg || 0) : 0,
      detail: turbine ? 80 : 71,                   // categoría de detalle EN 1993-1-9
      harmonics: turbine,
      yearsInService: 3 + (h % 7),                 // 3..9 años (sim. hasta tener fecha real)
    });
  }

  // Espectro de carga (rainflow): barras ciclos/año vs rango de tensión (log-y),
  // con los umbrales S-N ΔσD (m1→m2) y ΔσL (corte).
  function fatigueSpectrumSVG(a) {
    const sp = a.spectrum.filter(b => b.perYear > 0);
    if (!sp.length) return '<div class="ins-mut">Sin ciclos de fatiga.</div>';
    const W = 300, H = 140, ml = 36, mb = 24, mt = 10, mr = 8, pw = W - ml - mr, ph = H - mt - mb;
    const maxR = Math.max(...sp.map(b => b.range), a.limits.dsD * 1.05);
    const ys = sp.map(b => b.perYear), ymax = Math.max(...ys), ymin = Math.min(...ys);
    const lMax = Math.log10(ymax), lMin = Math.log10(Math.max(ymin, 1)), span = (lMax - lMin) || 1;
    const Y = v => mt + (1 - (Math.log10(Math.max(v, 1)) - lMin) / span) * ph;
    const X = r => ml + (r / maxR) * pw;
    const bw = Math.max(2, pw / sp.length - 2);
    const { dsD, dsL } = a.limits;
    const col = r => r >= dsD ? '#ef4444' : r >= dsL ? '#f59e0b' : '#64748b';
    const bars = sp.map(b => { const x = X(b.range) - bw / 2, y = Y(b.perYear); return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(mt + ph - y).toFixed(1)}" fill="${col(b.range)}" opacity="0.85"/>`; }).join('');
    const vline = (r, lab, c) => r <= maxR ? `<line x1="${X(r).toFixed(1)}" y1="${mt}" x2="${X(r).toFixed(1)}" y2="${mt + ph}" stroke="${c}" stroke-width="1" stroke-dasharray="3 3"/><text x="${X(r).toFixed(1)}" y="${mt + 7}" font-size="7" fill="${c}" text-anchor="middle">${lab}</text>` : '';
    const yticks = [ymin, Math.sqrt(ymin * ymax), ymax].map(v => `<text x="${ml - 4}" y="${(Y(v) + 3).toFixed(1)}" font-size="7" fill="var(--text-muted,#93a6b8)" text-anchor="end">${v >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : v.toFixed(0)}</text>`).join('');
    const xticks = [0, maxR / 2, maxR].map(r => `<text x="${X(r).toFixed(1)}" y="${(mt + ph + 11).toFixed(1)}" font-size="7" fill="var(--text-muted,#93a6b8)" text-anchor="middle">${r.toFixed(0)}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;aspect-ratio:${W}/${H};display:block;background:var(--bg3);border:1px solid var(--border);border-radius:6px">
      ${bars}${vline(dsL, 'ΔσL', '#94a3b8')}${vline(dsD, 'ΔσD', '#f59e0b')}
      <line x1="${ml}" y1="${mt + ph}" x2="${ml + pw}" y2="${mt + ph}" stroke="var(--border,#28384a)" stroke-width="0.7"/>
      ${yticks}${xticks}
      <text x="${ml + pw / 2}" y="${H - 3}" font-size="8" fill="var(--text-muted,#93a6b8)" text-anchor="middle">${t('fat.xaxis')}</text>
      <text x="9" y="${mt + ph / 2}" font-size="8" fill="var(--text-muted,#93a6b8)" text-anchor="middle" transform="rotate(-90 9 ${mt + ph / 2})">${t('fat.yaxis')}</text>
    </svg>`;
  }

  function seedInspection(o) {
    const h = ihash(o.id), fault = o.sensors.some(s => s.status === 'fault');
    const insp = Insp.addInspection(o.id, {
      inspector: ['J. Pérez', 'M. Soto', 'C. Vidal'][h % 3],
      date: new Date(Date.now() - (18 + h % 140) * 864e5).toISOString().slice(0, 10),
      location: 'Fuste / fundación', summary: 'Inspección visual de rutina (ejemplo).',
    });
    const nD = fault ? 2 : (h % 3 === 0 ? 1 : 0);
    for (let k = 0; k < nD; k++) insp.damages.push({
      id: Insp.uid(), location: ['Fundación', 'Fuste (medio)', 'Brida', 'Base'][(h + k) % 4],
      damage_type: Insp.DAMAGE_TYPES[(h + k * 7) % Insp.DAMAGE_TYPES.length],
      damage_cause: Insp.DAMAGE_CAUSES[(h + k * 5) % Insp.DAMAGE_CAUSES.length],
      severity: Insp.SEVERITIES[fault ? (k === 0 ? 2 : 1) : (h % 2)],
      extent: (5 + (h % 45)) + '%', comments: '',
    });
    insp.condition = Insp.conditionFromScore(Insp.inspectionScore(insp.damages));
    Insp.updateInspection(o.id, insp);
  }

  // Mini-gráfico de evolución del score de inspección (histórico de evaluación).
  function evalHistorySVG(hist) {
    if (hist.length < 2) return `<div class="ins-mut">${t('ins.histSingle')}</div>`;
    const W = 280, H = 70, ml = 22, mb = 14, mt = 6, pw = W - ml - 8, ph = H - mt - mb;
    const X = (i) => ml + (i / (hist.length - 1)) * pw, Y = (v) => mt + (1 - v / 100) * ph;
    const pts = hist.map((p, i) => `${X(i).toFixed(1)},${Y(p.score).toFixed(1)}`).join(' ');
    const dots = hist.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.score).toFixed(1)}" r="2.6" fill="${Insp.scoreBand(p.score).cls === 'critica' ? '#ef4444' : Insp.scoreBand(p.score).cls === 'observacion' ? '#f59e0b' : '#22c55e'}"/>`).join('');
    const grid = [0, 50, 100].map(v => `<line x1="${ml}" y1="${Y(v)}" x2="${W - 8}" y2="${Y(v)}" stroke="var(--border,#28384a)" stroke-width="0.5"/><text x="${ml - 4}" y="${Y(v) + 3}" text-anchor="end" font-size="7" fill="var(--text-muted,#93a6b8)">${v}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;aspect-ratio:${W}/${H};display:block;background:var(--bg3);border:1px solid var(--border);border-radius:6px">
      ${grid}<polyline points="${pts}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="2"/>${dots}</svg>`;
  }

  function renderInsp() {
    const host = $('#shm-insp'); const o = current;
    if (!host) return;
    if (!o) { host.innerHTML = `<div class="empty">${t('empty.select')}</div>`; return; }
    let inspections = Insp.getInspections(o.id);
    if (!inspections.length) { seedInspection(o); inspections = Insp.getInspections(o.id); }
    if (!inspSel || !inspections.some(i => i.id === inspSel)) inspSel = inspections[0].id;
    const sel = inspections.find(i => i.id === inspSel);
    const score = Insp.inspectionScore(sel.damages), band = Insp.scoreBand(score);
    const latest = inspections[0];
    const hist = inspections.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(i => ({ date: i.date, score: Insp.inspectionScore(i.damages) }));
    const opt = (arr, v) => arr.map(x => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('');
    const condOpt = Insp.CONDITIONS.map(c => `<option value="${c.key}" ${c.key === sel.condition ? 'selected' : ''}>${c.label}</option>`).join('');

    const dmgRows = sel.damages.length ? sel.damages.map(d => {
      const sc = Insp.scoreDamage(d), b = Insp.scoreBand(sc);
      const np = (d.photos || []).length;
      const strip = np ? `<div class="ins-dmg-photos">${d.photos.map(p => `<div class="ins-dphoto" data-d="${d.id}" data-p="${p.id}" style="background-image:url('${p.url}')"><button class="ins-px" data-del-dmgphoto title="${t('ins.rmPhoto')}">✕</button></div>`).join('')}</div>` : '';
      return `<div class="ins-dmg-wrap">
        <div class="ins-dmg">
          <span class="ins-dmg-sc ${b.cls}">${sc.toFixed(0)}</span>
          <span class="ins-dmg-v"><b>${d.damage_type}</b><br><span class="ins-mut">${d.severity} · ${d.damage_cause}${d.extent ? ' · ' + d.extent : ''}${d.location ? ' · ' + d.location : ''}</span></span>
          <button class="ins-dmg-cam" data-dmg-addphoto="${d.id}" title="${t('ins.addPhotoFinding')}">📷${np ? ' ' + np : ''}</button>
          <button class="ins-ot" data-ot="${d.id}" title="${t('ins.otTip')}">→ OT</button>
          <button class="ins-x" data-del-dmg="${d.id}" title="${t('ins.rmFinding')}">✕</button>
        </div>${strip}</div>`;
    }).join('') : `<div class="ins-mut">${t('ins.noFindings')}</div>`;

    const listRows = inspections.map(i => {
      const sc = Insp.inspectionScore(i.damages), b = Insp.scoreBand(sc);
      return `<button class="ins-row ${i.id === inspSel ? 'active' : ''}" data-insp="${i.id}">
        <span class="ins-dot ${Insp.conditionFromScore(sc)}"></span>
        <span class="ins-row-d">${i.date}</span><span class="ins-row-i">${i.inspector}</span>
        <span class="ins-row-h" title="hallazgos">${i.damages.length}⚐</span>
        <span class="ins-row-s ${b.cls}">${sc.toFixed(0)}</span></button>`;
    }).join('');

    host.innerHTML = `
      <div class="shm-body ins-body">
        <div class="ins-head">Inspección · ${o.label}
          <span class="ins-cond ${sel.condition}">${Insp.conditionLabel(sel.condition)}</span></div>
        <div class="ins-kpis">
          <div class="ins-kpi"><div class="k">${t('ins.kInsp')}</div><div class="v">${inspections.length}</div></div>
          <div class="ins-kpi"><div class="k">${t('ins.kScore')}</div><div class="v ${band.cls}">${score.toFixed(0)}</div></div>
          <div class="ins-kpi"><div class="k">${t('ins.kFindings')}</div><div class="v">${sel.damages.length}</div></div>
          <div class="ins-kpi"><div class="k">${t('ins.kTests')}</div><div class="v">${sel.tests.length}</div></div>
        </div>
        ${(() => {
          const due = Insp.dueState(sel.nextDate), ow = (sel.workOrders || []).filter(w => w.status !== 'cerrado'), odw = ow.filter(w => Insp.dueState(w.due).overdue).length;
          const m = [];
          if (due.overdue) m.push(t('ins.aOverdue')); else if (due.soon) m.push(t('ins.aSoon'));
          if (odw) m.push(t('ins.aWoOverdue', odw)); if (ow.length) m.push(t('ins.aWoOpen', ow.length));
          return m.length ? `<div class="ins-alert ${due.overdue || odw ? 'bad' : 'warn'}">⚠ ${m.join(' · ')}</div>` : '';
        })()}
        <div class="shm-sub2">${t('ins.hist')}</div>
        ${evalHistorySVG(hist)}
        <div class="ins-actrow"><button id="ins-new" class="ins-btn">${t('ins.new')}</button></div>
        <div class="shm-sub2">${t('ins.listH')}</div>
        <div class="ins-list">${listRows}</div>
        <div class="ins-card">
          <div class="ins-card-h">${sel.date} · <b>${sel.inspector}</b>
            <span class="ins-score ${band.cls}" title="${t('ins.scoreTitle')}">${score.toFixed(0)} <small>${band.label}</small></span></div>
          <div class="ins-meta">
            <label>${t('ins.fDate')}<input type="date" id="ins-date" value="${sel.date}"></label>
            <label>${t('ins.fInsp')}<input type="text" id="ins-insp" value="${sel.inspector}"></label>
            <label>${t('ins.fCond')}<select id="ins-cond">${condOpt}</select></label>
            <label>${t('ins.fLoc')}<input type="text" id="ins-loc" value="${sel.location || ''}"></label>
            <label>${t('ins.fNext')}<input type="date" id="ins-next" value="${sel.nextDate || ''}"></label>
          </div>
          <label class="ins-sumlbl">${t('ins.summary')}<textarea id="ins-sum" rows="2">${sel.summary || ''}</textarea></label>

          <div class="shm-sub2">${t('ins.photos')} · ${(sel.photos || []).length}</div>
          <div class="ins-photos">${(sel.photos || []).map(p => `<div class="ins-photo" data-photo="${p.id}" style="background-image:url('${p.url}')"><button class="ins-px" data-del-photo="${p.id}" title="${t('ins.rmPhoto')}">✕</button></div>`).join('') || `<div class="ins-mut">${t('ins.noPhotos')}</div>`}</div>
          <input type="file" id="ins-photo-file" accept="image/*" style="display:none">
          <button id="ins-addphoto" class="ins-mini-btn">${t('ins.addPhoto')}</button>

          <div class="shm-sub2">${t('ins.findings')}</div>
          <div class="ins-dmgs">${dmgRows}</div>
          <input type="file" id="nd-photo-file" accept="image/*" style="display:none">
          <div class="ins-addform">
            <select id="nd-type">${opt(Insp.DAMAGE_TYPES, '')}</select>
            <select id="nd-cause">${opt(Insp.DAMAGE_CAUSES, '')}</select>
            <div class="ins-add3">
              <select id="nd-sev">${opt(Insp.SEVERITIES, 'Media')}</select>
              <input type="text" id="nd-ext" placeholder="${t('ins.extent')}" >
              <input type="text" id="nd-loc" placeholder="${t('ins.loc')}">
            </div>
            <button id="nd-add" class="ins-btn">${t('ins.addFinding')}</button>
          </div>

          <div class="shm-sub2">${t('ins.tests')} · ${sel.tests.length}</div>
          <div class="ins-mini">${sel.tests.map(t2 => { const c = Insp.classifyTest(t2.test_type); return `<div class="ins-li"><span class="ins-tbadge ${c.ndt ? 'ndt' : ''}">${c.label}</span> <b>${t2.test_type}</b> — ${t2.result_summary || '—'} <button class="ins-x" data-del-test="${t2.id}">✕</button></div>`; }).join('') || `<div class="ins-mut">${t('ins.noTests')}</div>`}</div>
          <button id="ins-addtest" class="ins-mini-btn">${t('ins.addTest')}</button>

          <div class="shm-sub2">${t('ins.docs')} · ${sel.documents.length}</div>
          <div class="ins-mini">${sel.documents.map(dc => `<div class="ins-li">📎 <b>${dc.title}</b> <span class="ins-mut">(${dc.category})</span> <button class="ins-x" data-del-doc="${dc.id}">✕</button></div>`).join('') || `<div class="ins-mut">${t('ins.noDocs')}</div>`}</div>
          <button id="ins-adddoc" class="ins-mini-btn">${t('ins.addDoc')}</button>

          <div class="shm-sub2">${t('ins.wos')} · ${(sel.workOrders || []).length}</div>
          <div class="ins-mini">${(sel.workOrders || []).map(w => { const dd = Insp.dueState(w.due); return `<div class="ins-wo">
            <button class="ins-wost s-${w.status.replace(/ /g, '')}" data-wo="${w.id}" title="${t('ins.woStateTip')}">${w.status}</button>
            <span class="ins-wo-v"><b>${w.title}</b><br><span class="ins-mut">${w.assignee || t('ins.unassigned')} · ${t('ins.prio')} ${w.priority}${w.due ? ` · ${t('ins.dueWord')} ${w.due}${dd.overdue ? ' ⚠' : ''}` : ''}</span></span>
            <button class="ins-x" data-del-wo="${w.id}">✕</button></div>`; }).join('') || `<div class="ins-mut">${t('ins.noWos')}</div>`}</div>
          <button id="ins-addwo" class="ins-mini-btn">${t('ins.addWo')}</button>

          <div class="ins-foot"><button id="ins-report" class="ins-btn">${t('ins.report')}</button>
            <button id="ins-del" class="ins-del">${t('ins.del')}</button></div>
        </div>
        <div class="note" style="font-size:10px">${t('ins.note')}</div>
      </div>`;

    const save = (re = true) => { Insp.updateInspection(o.id, sel); updateRollup(); if (re) renderInsp(); };
    host.querySelectorAll('[data-insp]').forEach(b => b.addEventListener('click', () => { inspSel = b.dataset.insp; renderInsp(); }));
    host.querySelector('#ins-new').addEventListener('click', () => { const ni = Insp.addInspection(o.id, { inspector: latest.inspector }); inspSel = ni.id; renderInsp(); });
    host.querySelector('#ins-del').addEventListener('click', () => { if (confirm(t('ins.delConfirm'))) { Insp.removeInspection(o.id, sel.id); inspSel = null; renderInsp(); } });
    host.querySelector('#ins-date').addEventListener('change', (e) => { sel.date = e.target.value; save(); });
    host.querySelector('#ins-insp').addEventListener('change', (e) => { sel.inspector = e.target.value; save(false); });
    host.querySelector('#ins-loc').addEventListener('change', (e) => { sel.location = e.target.value; save(false); });
    host.querySelector('#ins-sum').addEventListener('change', (e) => { sel.summary = e.target.value; save(false); });
    host.querySelector('#ins-cond').addEventListener('change', (e) => { sel.condition = e.target.value; save(); });
    host.querySelector('#ins-next').addEventListener('change', (e) => { sel.nextDate = e.target.value; save(); });
    host.querySelectorAll('[data-del-dmg]').forEach(b => b.addEventListener('click', () => { sel.damages = sel.damages.filter(d => d.id !== b.dataset.delDmg); sel.condition = Insp.conditionFromScore(Insp.inspectionScore(sel.damages)); save(); }));
    host.querySelector('#nd-add').addEventListener('click', () => {
      sel.damages.push({ id: Insp.uid(), damage_type: $('#nd-type').value, damage_cause: $('#nd-cause').value, severity: $('#nd-sev').value, extent: $('#nd-ext').value.trim(), location: $('#nd-loc').value.trim(), comments: '' });
      sel.condition = Insp.conditionFromScore(Insp.inspectionScore(sel.damages)); save();
    });
    host.querySelector('#ins-addtest').addEventListener('click', () => { const tt = (prompt(t('ins.pTestType'), '') || '').trim(); if (!tt) return; const r = (prompt(t('ins.pTestResult'), '') || '').trim(); sel.tests.push({ id: Insp.uid(), test_type: tt, result_summary: r, executed_at: new Date().toISOString().slice(0, 10) }); save(); });
    host.querySelector('#ins-adddoc').addEventListener('click', () => { const tt = (prompt(t('ins.pDocTitle'), '') || '').trim(); if (!tt) return; const c = (prompt(t('ins.pDocCat'), 'informe') || 'otro').trim(); sel.documents.push({ id: Insp.uid(), title: tt, category: c, issued_at: new Date().toISOString().slice(0, 10) }); save(); });
    host.querySelectorAll('[data-del-test]').forEach(b => b.addEventListener('click', () => { sel.tests = sel.tests.filter(t => t.id !== b.dataset.delTest); save(); }));
    host.querySelectorAll('[data-del-doc]').forEach(b => b.addEventListener('click', () => { sel.documents = sel.documents.filter(d => d.id !== b.dataset.delDoc); save(); }));
    // Órdenes de trabajo
    host.querySelector('#ins-addwo').addEventListener('click', () => {
      const title = (prompt(t('ins.pWoTitle'), '') || '').trim(); if (!title) return;
      const assignee = (prompt(t('ins.pWoAssignee'), '') || '').trim();
      const priority = (prompt(t('ins.pWoPrio'), 'media') || 'media').trim().toLowerCase();
      (sel.workOrders ||= []).push({ id: Insp.uid(), title, assignee, priority: Insp.WO_PRIORITY.includes(priority) ? priority : 'media', status: 'abierto', due: sel.nextDate || '' });
      save();
    });
    host.querySelectorAll('[data-wo]').forEach(b => b.addEventListener('click', () => { const w = (sel.workOrders || []).find(x => x.id === b.dataset.wo); if (w) { w.status = Insp.WO_STATUS[(Insp.WO_STATUS.indexOf(w.status) + 1) % Insp.WO_STATUS.length]; save(); } }));
    host.querySelectorAll('[data-del-wo]').forEach(b => b.addEventListener('click', () => { sel.workOrders = (sel.workOrders || []).filter(w => w.id !== b.dataset.delWo); save(); }));
    host.querySelectorAll('[data-ot]').forEach(b => b.addEventListener('click', () => {
      const d = sel.damages.find(x => x.id === b.dataset.ot); if (!d) return;
      (sel.workOrders ||= []).push({ id: Insp.uid(), title: 'Reparar: ' + d.damage_type, assignee: '', priority: Insp.priorityFromSeverity(d.severity), status: 'abierto', due: sel.nextDate || '', damageId: d.id });
      save();
    }));
    host.querySelector('#ins-report').addEventListener('click', () => inspectionReport(o, sel, score));
    // Fotos
    const pf = host.querySelector('#ins-photo-file');
    host.querySelector('#ins-addphoto').addEventListener('click', () => pf.click());
    pf.addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
      try { const url = await Insp.imageToThumb(f); (sel.photos ||= []).push({ id: Insp.uid(), url }); save(); }
      catch (err) { alert(t('ins.photoFail', err?.message || err)); }
    });
    host.querySelectorAll('[data-del-photo]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); sel.photos = (sel.photos || []).filter(p => p.id !== b.dataset.delPhoto); save(); }));
    host.querySelectorAll('.ins-photo').forEach(d => d.addEventListener('click', (e) => { if (e.target.closest('.ins-px')) return; const p = (sel.photos || []).find(x => x.id === d.dataset.photo); if (p) { const w = window.open('', '_blank'); if (w) w.document.write(`<img src="${p.url}" style="max-width:100%">`); } }));
    // Fotos por hallazgo (input oculto compartido + objetivo recordado)
    let dmgPhotoTarget = null;
    const dpf = host.querySelector('#nd-photo-file');
    host.querySelectorAll('[data-dmg-addphoto]').forEach(b => b.addEventListener('click', () => { dmgPhotoTarget = b.dataset.dmgAddphoto; dpf.click(); }));
    dpf.addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; e.target.value = ''; const tid = dmgPhotoTarget; dmgPhotoTarget = null;
      if (!f || !tid) return;
      const d = sel.damages.find(x => x.id === tid); if (!d) return;
      try { const url = await Insp.imageToThumb(f); (d.photos ||= []).push({ id: Insp.uid(), url }); save(); }
      catch (err) { alert(t('ins.photoFail', err?.message || err)); }
    });
    host.querySelectorAll('[data-del-dmgphoto]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrap = b.closest('.ins-dphoto'); if (!wrap) return;
      const d = sel.damages.find(x => x.id === wrap.dataset.d); if (!d) return;
      d.photos = (d.photos || []).filter(p => p.id !== wrap.dataset.p); save();
    }));
    host.querySelectorAll('.ins-dphoto').forEach(elp => elp.addEventListener('click', (e) => {
      if (e.target.closest('.ins-px')) return;
      const d = sel.damages.find(x => x.id === elp.dataset.d); const p = d && (d.photos || []).find(x => x.id === elp.dataset.p);
      if (p) { const w = window.open('', '_blank'); if (w) w.document.write(`<img src="${p.url}" style="max-width:100%">`); }
    }));
  }

  // Informe de inspección imprimible.
  function inspectionReport(o, insp, score) {
    const band = Insp.scoreBand(score);
    const rows = insp.damages.map(d => `<tr><td>${d.damage_type}</td><td>${d.severity}</td><td>${d.damage_cause}</td><td>${d.extent || '—'}</td><td>${d.location || '—'}</td><td style="text-align:right">${Insp.scoreDamage(d).toFixed(0)}</td></tr>`).join('') || `<tr><td colspan="6" style="color:#15803d">${t('irep.noFindings')}</td></tr>`;
    const tests = insp.tests.map(tt => `<tr><td>${Insp.classifyTest(tt.test_type).label}</td><td>${tt.test_type}</td><td>${tt.result_summary || '—'}</td><td>${tt.executed_at || '—'}</td></tr>`).join('') || `<tr><td colspan="4" style="color:#64748b">${t('irep.noTests')}</td></tr>`;
    const wos = (insp.workOrders || []).map(w => `<tr><td>${w.title}</td><td>${w.assignee || '—'}</td><td>${w.priority}</td><td>${w.status}</td><td>${w.due || '—'}</td></tr>`).join('') || `<tr><td colspan="5" style="color:#64748b">${t('irep.noWos')}</td></tr>`;
    const dmgPhotos = insp.damages.filter(d => (d.photos || []).length).map(d =>
      `<div class="dphoto-grp"><div class="mut"><b>${d.damage_type}</b> · ${d.severity}${d.location ? ' · ' + d.location : ''}</div>
        <div class="dphoto-row">${d.photos.map(p => `<img src="${p.url}" alt="${d.damage_type}">`).join('')}</div></div>`).join('');
    const lc = getLang() === 'en' ? 'en-GB' : 'es-CL';
    const html = `<!doctype html><html lang="${getLang()}"><meta charset="utf-8"><title>${t('irep.titleDoc')} — ${o.label}</title>
      <style>body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1b2533}.wrap{max-width:820px;margin:0 auto;padding:0 32px 40px}
      .hero{background:linear-gradient(120deg,#0e7490,#155e75);color:#fff;padding:24px 32px;margin-bottom:22px}.hero h1{margin:4px 0;font-size:21px}
      h2{font-size:15px;border-bottom:2px solid #cbd5e1;padding-bottom:5px;margin:24px 0 10px}.mut{color:#64748b;font-size:12px}
      table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}th,td{border:1px solid #cbd5e1;padding:6px 9px;text-align:left}th{background:#f1f5f9}
      .score{display:inline-block;font-size:30px;font-weight:800;padding:6px 16px;border-radius:10px;color:#fff;background:${band.cls === 'critica' ? '#dc2626' : band.cls === 'observacion' ? '#d97706' : '#16a34a'}}
      .dphoto-grp{margin:10px 0}.dphoto-row{display:flex;flex-wrap:wrap;gap:7px;margin-top:4px}.dphoto-row img{width:170px;height:128px;object-fit:cover;border:1px solid #cbd5e1;border-radius:6px}</style>
      <div class="hero"><div class="mut" style="color:#cfe9f1;letter-spacing:2px;text-transform:uppercase">${t('irep.kicker')}</div>
        <h1>${t('irep.title')} — ${o.label}</h1><div style="opacity:.9;font-size:13px">${insp.date} · ${insp.inspector} · ${Insp.conditionLabel(insp.condition)}</div></div>
      <div class="wrap">
        <h2>${t('irep.hEval')}</h2>
        <p><span class="score">${score.toFixed(0)}</span> <span class="mut">/100 · ${band.label} ${t('irep.evalSub')}</span></p>
        <p>${insp.summary || `<span class="mut">${t('irep.noSummary')}</span>`}</p>
        <h2>${t('irep.hFindings')} (${insp.damages.length})</h2>
        <table><thead><tr><th>${t('irep.thType')}</th><th>${t('irep.thSev')}</th><th>${t('irep.thCause')}</th><th>${t('irep.thExtent')}</th><th>${t('irep.thLoc')}</th><th style="text-align:right">${t('irep.thScore')}</th></tr></thead><tbody>${rows}</tbody></table>
        ${dmgPhotos ? `<h2>${t('irep.hPhotos')}</h2>${dmgPhotos}` : ''}
        <h2>${t('irep.hTests')} (${insp.tests.length})</h2>
        <table><thead><tr><th>${t('irep.thClass')}</th><th>${t('irep.thTest')}</th><th>${t('irep.thResult')}</th><th>${t('irep.thDate')}</th></tr></thead><tbody>${tests}</tbody></table>
        <h2>${t('irep.hWos')} (${(insp.workOrders || []).length})</h2>
        <table><thead><tr><th>${t('irep.thOrder')}</th><th>${t('irep.thAssignee')}</th><th>${t('irep.thPrio')}</th><th>${t('irep.thStatus')}</th><th>${t('irep.thDue')}</th></tr></thead><tbody>${wos}</tbody></table>
        <p class="mut" style="margin-top:18px">${t('irep.nextLabel')}: <b>${insp.nextDate || '—'}</b> · ${t('rep.gen')} ${new Date().toLocaleString(lc)} · ReWind. ${t('irep.footTail')}</p>
      </div></html>`;
    const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); }
  }

  // Actualiza los números dinámicos del panel abierto (sólo toca lo que EXISTE en
  // la vista visible → seguro aunque Selección/SHM no estén montadas a la vez).
  function updateDynamic(sum) {
    if (!current || !sum) return;
    const ns = sum.sensors.length, ok = sum.sensors.filter(s => s.status === 'ok').length;
    const set = (id, v, col) => { const n = $('#' + id); if (n) { n.textContent = v; if (col !== undefined) n.style.color = col; } };
    // Selección (identidad + ambiente)
    set('d-ns', `${ok}/${ns} OK`); set('d-f1', `${sum.f1.toFixed(3)} Hz`);
    set('d-wind', sum.wind != null ? `${sum.wind.toFixed(1)} m/s` : '—'); set('d-temp', `${sum.temp.toFixed(1)} °C`);
    // SHM · Estado (por sensores)
    set('sh-ns', `${ok}/${ns} OK`); set('sh-f1', `${sum.f1.toFixed(3)} Hz`); set('sh-dmg', `${Math.round((sum.dmg || 0) * 100)} %`);
    set('sh-cls', t('cls.' + (sum.cls || 0)), CLS_COL[sum.cls || 0]);
    // SHM · Sensores (lista + RMS)
    for (const se of sum.sensors) {
      const n = el.querySelector(`.s-rms[data-sid="${se.id}"]`);
      if (n) {
        n.textContent = se.status === 'fault' ? 'FALLA' : `${(se.rms * 1000).toFixed(1)} mg`;
        n.style.color = se.status === 'fault' ? 'var(--danger)' : '';
        const dot = n.parentElement.querySelector('.dot'); if (dot) dot.className = `dot ${se.status}`;
      }
    }
    // SHM · Señal (estado por sensor)
    for (const se of sum.sensors) { const b = [...el.querySelectorAll('#sig-wrap .row')].find(r => r.firstChild.textContent === se.id)?.querySelector('.sig-st'); if (b) { b.textContent = se.status === 'fault' ? 'falla' : 'ok'; b.style.color = se.status === 'fault' ? 'var(--danger)' : 'var(--success)'; } }
    // SHM · Sensores agregados por el usuario (R-33): valor sintético en vivo.
    const _tSec = performance.now() / 1000;
    el.querySelectorAll('.s-custom').forEach(n => { n.textContent = Instr.fmtLive({ id: n.dataset.csId, type: n.dataset.csType }, _tSec); });
  }

  function onTick(msg) {
    // contadores de flota
    let ok = 0, fault = 0;
    for (const id in msg.summaries) for (const se of msg.summaries[id].sensors) (se.status === 'fault' ? fault++ : ok++);
    $('#shm-ok').textContent = ok; $('#shm-fault').textContent = fault;
    // puntos de la lista: color por AVANCE de obra (igual que el mapa 2D)
    for (const s of list) {
      const row = el.querySelector(`.shm-row[data-id="${s.id}"]`); if (!row) continue;
      const dot = row.querySelector('.dot'), c = progColor(fleet.getStructure(s.id));
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
      if (current && $('#cls-band')) drawHist();   // histórico de evaluación (pestaña Inspección)
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
    const coverImg = new URL('images/example.jpg', location.href).href;   // ruta absoluta (la pestaña nueva no tiene base)
    const _lc = getLang() === 'en' ? 'en-GB' : 'es-CL';
    const fmtT = (ms) => new Date(ms).toLocaleString(_lc);
    const esc = (s) => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

    // — utilidades de imagen (lienzo blanco, tinta oscura; los dibujos sí llevan color) —
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2; const g = c.getContext('2d'); g.scale(2, 2); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); return { c, g, w, h }; };
    const fAxis = (g, w, h, fMax) => { g.fillStyle = '#888'; g.font = '9px sans-serif'; for (let f = 0; f <= fMax; f += 2) { const x = f / fMax * w; g.fillText(f + ' Hz', Math.min(x, w - 22), h - 2); } };
    const topSid = () => (o.sensors.find(s => /top|s1/.test(s.id)) || o.sensors[0])?.id;

    const imgSignal = (buf) => { const { c, g, w, h } = mk(560, 150); const b = buf || []; g.strokeStyle = '#cfd6dd'; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); g.strokeStyle = '#1f6feb'; g.lineWidth = 1; g.beginPath(); for (let i = 0; i < b.length; i++) { const x = i / 700 * w, y = h / 2 - b[i] * h * 0.4; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); return c.toDataURL('image/png'); };
    const imgFFT = (buf) => { const { c, g, w, h } = mk(560, 150); const { mag, df } = fftMag(buf || []); const fMax = 8, bins = Math.min(mag.length, Math.floor(fMax / (df || 1))); let mx = 1e-9; for (let i = 1; i < bins; i++) mx = Math.max(mx, mag[i]); g.fillStyle = '#1f6feb'; for (let i = 1; i < bins; i++) { const x = i / bins * w, bh = mag[i] / mx * (h - 18); g.fillRect(x, h - 12 - bh, Math.max(1, w / bins - 1), bh); } fAxis(g, w, h, fMax); return c.toDataURL('image/png'); };
    const imgPSD = (buf) => { const { c, g, w, h } = mk(560, 150); const { mag, df } = fftMag(buf || []); const fMax = 8, bins = Math.min(mag.length, Math.floor(fMax / (df || 1))); const dB = []; let lo = 1e9, hi = -1e9; for (let i = 1; i < bins; i++) { const v = 10 * Math.log10(mag[i] * mag[i] + 1e-12); dB[i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); } const rng = (hi - lo) || 1; g.strokeStyle = '#0d9488'; g.lineWidth = 1.2; g.beginPath(); for (let i = 1; i < bins; i++) { const x = i / bins * w, y = (h - 14) - ((dB[i] - lo) / rng) * (h - 22); i === 1 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); fAxis(g, w, h, fMax); return c.toDataURL('image/png'); };
    const imgWavelet = (buf) => {
      const { c, g, w, h } = mk(560, 170);
      const raw = buf || []; const N = 256, x = raw.slice(-N);
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
      g.fillStyle = '#888'; g.font = '9px sans-serif'; g.fillText('8 Hz', 2, 10); g.fillText('0.2 Hz', 2, h - 16); g.fillText(t('brep.time'), w - 50, h - 2);
      return c.toDataURL('image/png');
    };

    // — deformada de la torre (silueta suave coloreada por desplazamiento) + barra mm —
    // `marks` = puntos de medición de los sensores {z, disp} (opcional) para señalarlos.
    const imgDeformed = (prof, type, marks = []) => {
      const W = 300, H = 350, { c, g } = mk(W, H);
      if (!prof || !prof.length) return c.toDataURL('image/png');
      g.textBaseline = 'alphabetic';
      const zMax = prof[prof.length - 1].z || 1, dMax = Math.max(...prof.map(p => p.disp), 1e-9);
      const plotW = 196, cx = 60, amp = 58, baseY = H - 30, topY = 34;       // exagera la deformada (moderado)
      const Y = (z) => baseY - (z / zMax) * (baseY - topY), Xc = (d) => cx + (d / dMax) * amp;
      const hw0 = type === 'hv' ? 20 : 11, hw1 = type === 'hv' ? 5 : 4;       // semiancho base/punta
      const hwAt = (z) => hw0 + (hw1 - hw0) * (z / zMax);

      // rejilla horizontal tenue por altura
      g.strokeStyle = '#eef1f5'; g.lineWidth = 1;
      for (let k = 0; k <= 4; k++) { const yy = baseY - k / 4 * (baseY - topY); g.beginPath(); g.moveTo(20, yy); g.lineTo(cx + amp + hw1 + 8, yy); g.stroke(); }
      // ejes de altura (m) a la izquierda
      g.fillStyle = '#94a0ad'; g.font = '9px Inter, sans-serif'; g.textAlign = 'right';
      for (let k = 0; k <= 4; k++) { const z = zMax * k / 4; g.fillText(z.toFixed(0), 17, Y(z) + 3); }
      g.save(); g.translate(9, (topY + baseY) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillStyle = '#aab3bd'; g.fillText(t('brep.height'), 0, 0); g.restore();

      // silueta SIN deformar (referencia): tronco gris claro centrado en cx
      g.fillStyle = 'rgba(150,160,172,.16)';
      g.beginPath(); g.moveTo(cx - hw0, baseY); g.lineTo(cx - hw1, topY); g.lineTo(cx + hw1, topY); g.lineTo(cx + hw0, baseY); g.closePath(); g.fill();
      g.strokeStyle = '#cdd4dc'; g.setLineDash([3, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(cx, baseY); g.lineTo(cx, topY); g.stroke(); g.setLineDash([]);

      // silueta DEFORMADA: relleno con degradado vertical mapeado por desplazamiento
      const grad = g.createLinearGradient(0, baseY, 0, topY);
      for (let i = 0; i < prof.length; i++) grad.addColorStop(i / (prof.length - 1), heat(prof[i].disp / dMax));
      const left = prof.map(p => [Xc(p.disp) - hwAt(p.z), Y(p.z)]);
      const right = prof.map(p => [Xc(p.disp) + hwAt(p.z), Y(p.z)]);
      g.beginPath(); g.moveTo(left[0][0], left[0][1]);
      for (let i = 1; i < left.length; i++) g.lineTo(left[i][0], left[i][1]);
      for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
      g.closePath(); g.fillStyle = grad; g.fill();
      g.strokeStyle = 'rgba(40,52,66,.55)'; g.lineWidth = 1.1; g.stroke();

      const tip = prof[prof.length - 1], xt = Xc(tip.disp), yt = Y(zMax);
      const slope = Math.atan2((xt - Xc(prof[Math.max(0, prof.length - 4)].disp)), -(yt - Y(prof[Math.max(0, prof.length - 4)].z))) || 0;
      if (type === 'hv') {                                   // crucetas (torre AT)
        g.strokeStyle = '#5b6b7a'; g.lineWidth = 2; g.lineCap = 'round';
        for (const yy of [yt + 8, yt + 22]) { g.beginPath(); g.moveTo(xt - 22, yy); g.lineTo(xt + 22, yy); g.stroke(); }
      } else {                                               // góndola + rotor (aerogenerador)
        g.save(); g.translate(xt, yt); g.rotate(slope);
        g.fillStyle = '#aebfce'; if (g.roundRect) { g.beginPath(); g.roundRect(-7, -5, 18, 9, 2); g.fill(); } else g.fillRect(-7, -5, 18, 9);
        g.strokeStyle = '#7f93a6'; g.lineWidth = 2.4; g.lineCap = 'round';
        for (const ang of [-Math.PI / 2, Math.PI / 6, 5 * Math.PI / 6]) { g.beginPath(); g.moveTo(5, 0); g.lineTo(5 + 24 * Math.cos(ang), 24 * Math.sin(ang)); g.stroke(); }
        g.fillStyle = '#5b6b7a'; g.beginPath(); g.arc(5, 0, 2.6, 0, 7); g.fill();
        g.restore();
      }

      // puntos de medición (sensores)
      for (const m of marks) {
        const mx = Xc(m.disp), my = Y(m.z);
        g.fillStyle = '#16a34a'; g.strokeStyle = '#fff'; g.lineWidth = 1.4;
        g.beginPath(); g.arc(mx, my, 3.4, 0, 7); g.fill(); g.stroke();
      }
      // base empotrada (rayado)
      g.fillStyle = '#9aa6b3'; g.fillRect(cx - hw0 - 4, baseY, hw0 * 2 + 8, 3);
      g.strokeStyle = '#b6bfc9'; g.lineWidth = 1;
      for (let x = cx - hw0 - 4; x <= cx + hw0 + 4; x += 5) { g.beginPath(); g.moveTo(x, baseY + 3); g.lineTo(x - 4, baseY + 8); g.stroke(); }

      // barra de color (desplazamiento, mm)
      const bx = W - 46, bw = 13, bTop = topY, bBot = baseY;
      for (let py = bTop; py <= bBot; py++) { g.fillStyle = heat((bBot - py) / (bBot - bTop)); g.fillRect(bx, py, bw, 1); }
      g.strokeStyle = '#cbd2da'; g.lineWidth = 0.8; g.strokeRect(bx, bTop, bw, bBot - bTop);
      const mm = dMax * 1000; g.fillStyle = '#5a6470'; g.font = '9px Inter, sans-serif'; g.textAlign = 'left';
      for (let k = 0; k <= 4; k++) { const yy = bBot - k / 4 * (bBot - bTop); g.fillText((mm * k / 4).toFixed(mm < 5 ? 1 : 0), bx + bw + 4, yy + 3); }
      g.fillStyle = '#8b95a1'; g.textAlign = 'center'; g.fillText('mm', bx + bw / 2, bTop - 8);
      return c.toDataURL('image/png');
    };

    // — dibujo esquemático de la estructura (SVG limpio, con sensores resaltados) —
    const schematic = (st) => {
      // marcador de sensor: punto verde con halo (capa de vida)
      const sensor = (x, y) => `<circle cx="${x}" cy="${y}" r="6" fill="#16a34a" opacity=".18"/><circle cx="${x}" cy="${y}" r="3" fill="#16a34a" stroke="#fff" stroke-width="1"/>`;
      if (st.type === 'hv') {
        return `<svg viewBox="0 0 140 220" width="140" height="220" font-family="Inter,sans-serif">
  <defs><linearGradient id="hvg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0d9488"/></linearGradient></defs>
  <ellipse cx="70" cy="206" rx="40" ry="5" fill="#000" opacity=".06"/>
  <g fill="none" stroke="url(#hvg)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M44 204 L62 26 M96 204 L78 26"/>
    <path d="M50 165 H90 M54 124 H86 M58 86 H82 M62 52 H78"/>
    <path d="M44 204 L86 165 M96 204 L54 165 M50 165 L82 124 M90 165 L58 124 M54 124 L78 86 M86 124 L62 86 M58 86 L74 52 M82 86 L66 52"/>
  </g>
  <g fill="none" stroke="#5b6b7a" stroke-width="2.6" stroke-linecap="round"><path d="M26 60 H114 M32 40 H108"/></g>
  <g stroke="#94a3b2" stroke-width="1.4"><line x1="34" y1="60" x2="34" y2="70"/><line x1="106" y1="60" x2="106" y2="70"/><line x1="44" y1="40" x2="44" y2="50"/><line x1="96" y1="40" x2="96" y2="50"/></g>
  ${sensor(70, 30)}${sensor(34, 60)}${sensor(70, 124)}${sensor(70, 204)}
</svg>`;
      }
      return `<svg viewBox="0 0 140 220" width="140" height="220" font-family="Inter,sans-serif">
  <defs>
    <linearGradient id="twg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7fb8e6"/><stop offset=".5" stop-color="#bfe0f7"/><stop offset="1" stop-color="#7fb8e6"/></linearGradient>
    <linearGradient id="blg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4fbff"/><stop offset="1" stop-color="#d6ebfb"/></linearGradient>
  </defs>
  <ellipse cx="66" cy="206" rx="40" ry="5" fill="#000" opacity=".06"/>
  <ellipse cx="66" cy="202" rx="26" ry="6" fill="#d6dde5"/>
  <polygon points="60,200 72,200 69,52 63,52" fill="url(#twg)"/>
  <g transform="translate(66,50)">
    <g fill="url(#blg)" stroke="#9cc6ea" stroke-width=".8">
      <path d="M0 0 Q4 -34 1.6 -64 Q-1.4 -36 0 0Z" transform="rotate(0)"/>
      <path d="M0 0 Q4 -34 1.6 -64 Q-1.4 -36 0 0Z" transform="rotate(120)"/>
      <path d="M0 0 Q4 -34 1.6 -64 Q-1.4 -36 0 0Z" transform="rotate(240)"/>
    </g>
    <rect x="-4" y="-6" width="20" height="11" rx="4" fill="#aecbe6"/>
    <circle cx="0" cy="0" r="4.5" fill="#7fa6c7"/>
  </g>
  ${sensor(69, 60)}${sensor(69, 126)}
  <rect x="78" y="190" width="9" height="7" rx="2" fill="#0a0a0a"/><circle cx="82.5" cy="193.5" r="2" fill="#47b6ff"/>
</svg>`;
    };

    // — velocímetro del estado estructural (arco verde→rojo + aguja) —
    // cls 0..4 (Sin daño … Muy alto). La aguja apunta de «sano» (izq) a «dañado» (der).
    const imgGauge = (cls, dmg) => {
      const cx = 130, cy = 132, R = 96, sw = 22;
      const seg = ['#22c55e', '#84cc16', '#f59e0b', '#f97316', '#ef4444'];   // 5 zonas, verde→rojo
      const pol = (deg, r) => [cx + r * Math.cos(deg * Math.PI / 180), cy - r * Math.sin(deg * Math.PI / 180)];
      const ang = (f) => 180 - 180 * f;                                       // f∈[0,1] → 180°(izq)…0°(der)
      let arcs = '';
      for (let i = 0; i < 5; i++) {
        const [x1, y1] = pol(ang(i / 5), R), [x2, y2] = pol(ang((i + 1) / 5), R);
        arcs += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${seg[i]}" stroke-width="${sw}"/>`;
      }
      let ticks = '';
      for (let i = 0; i <= 5; i++) { const [x1, y1] = pol(ang(i / 5), R - sw / 2 - 2), [x2, y2] = pol(ang(i / 5), R + sw / 2 + 2); ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#fff" stroke-width="2"/>`; }
      const v = Math.max(0, Math.min(1, (cls + 0.5) / 5));                    // aguja al centro de la zona
      const [nx, ny] = pol(ang(v), R - 6), [bx1, by1] = pol(ang(v) + 90, 7), [bx2, by2] = pol(ang(v) - 90, 7);
      const col = seg[Math.max(0, Math.min(4, cls))];
      return `<svg viewBox="0 0 260 188" width="260" height="188" font-family="Inter,sans-serif">
  ${arcs}${ticks}
  <polygon points="${bx1.toFixed(1)},${by1.toFixed(1)} ${nx.toFixed(1)},${ny.toFixed(1)} ${bx2.toFixed(1)},${by2.toFixed(1)}" fill="#243040"/>
  <circle cx="${cx}" cy="${cy}" r="9" fill="#243040"/><circle cx="${cx}" cy="${cy}" r="4" fill="#fff"/>
  <text x="${cx - R}" y="${cy + 18}" font-size="11" fill="#16a34a" text-anchor="middle">${t('brep.healthy')}</text>
  <text x="${cx + R}" y="${cy + 18}" font-size="11" fill="#dc2626" text-anchor="middle">${t('brep.critical')}</text>
  <text x="${cx}" y="${cy + 30}" font-size="20" font-weight="700" fill="${col}" text-anchor="middle">${t('cls.' + cls)}</text>
  <text x="${cx}" y="${cy + 48}" font-size="11" fill="#6b7785" text-anchor="middle">${t('brep.dmgIndex', Math.round((dmg || 0) * 100))}</text>
</svg>`;
    };

    // — tabla resumen de la flota —
    const rowsHtml = list.map(s => {
      const d = window.shmData?.get(s.id) || {};
      const cls = d.cls || 0, fault = (d.sensors || []).some(x => x.status === 'fault');
      const alerta = cls >= 3 || fault;
      const clsCell = cls >= 3 ? `<span class="warn">${t('cls.' + cls)}</span>` : t('cls.' + cls);
      return `<tr><td>${esc(s.label)}</td><td>${s.type === 'hv' ? t('brep.typeHV') : t('brep.typeTurbine')}</td><td>${s.height} m</td><td>${(d.sensors || s.sensors).length}</td><td>${clsCell}</td><td>${alerta ? `<span class="warn">${t('brep.alert')}</span>` : t('brep.operational')}</td></tr>`;
    }).join('');

    let detalle = '';
    if (o) {
      const d = window.shmData?.get(o.id) || {}; const sid = topSid();
      const cls = d.cls || 0;
      const sensRows = (d.sensors || o.sensors).map((se, i) => `<tr><td>${se.id}</td><td>${t('brep.sMems')}</td><td>${o.type === 'hv' ? t('brep.sNode', i + 1) : (se.id.includes('mid') ? t('brep.sMid') : t('brep.sTop'))}</td><td>${se.status === 'fault' ? `<span class="warn">${t('brep.sFault')}</span>` : t('brep.sOp')}</td><td>${se.rms != null ? (se.rms * 1000).toFixed(1) + ' mg' : '—'}</td></tr>`).join('');
      const evRows = (clsEvents[o.id] || []).slice(-12).reverse().map(e => `<tr><td>${fmtT(e.t)}</td><td>${t('cls.' + e.from)} → ${e.to >= 3 ? `<span class="warn">${t('cls.' + e.to)}</span>` : t('cls.' + e.to)}</td></tr>`).join('') || `<tr><td colspan="2">${t('brep.noChanges')}</td></tr>`;
      const mRows = (actions.log || []).filter(m => m.id === o.id).slice(-12).reverse().map(m => `<tr><td>${fmtT(m.t)}</td><td>${esc(m.action)}</td></tr>`).join('') || `<tr><td colspan="2">${t('brep.noMaint')}</td></tr>`;
      // Buffer sintético para el gateway (nodo de enlace en la base de la torre).
      const gwBuf = []; for (let i = 0; i < 300; i++) gwBuf.push(0.22 * Math.sin(2 * Math.PI * 0.283 * i / FS) + 0.08 * (Math.random() - 0.5));
      const vibBlock = (label, buf, fault) => `
        <h3>${esc(label)}${fault ? ` · <span class="warn">${t('brep.vibFault')}</span>` : ''}</h3>
        <div class="plot"><div class="cap">${t('brep.vibSignal')}</div><img src="${imgSignal(buf)}"></div>
        <div class="vib2"><div class="plot"><div class="cap">FFT</div><img src="${imgFFT(buf)}"></div><div class="plot"><div class="cap">PSD</div><img src="${imgPSD(buf)}"></div></div>
        <div class="plot"><div class="cap">${t('brep.vibWavelet')}</div><img src="${imgWavelet(buf)}"></div>`;
      const vibSensores = (o.sensors).map(se => vibBlock(t('brep.sensorLabel', se.id), sigBuf[se.id], se.status === 'fault')).join('');
      const vibGateway = o.type === 'turbine' ? vibBlock(t('brep.gateway'), gwBuf, false) : '';
      // Estado estructural: deformada a partir de lo que MIDEN los sensores (no de una carga).
      // Desplazamiento ≈ aceleración_RMS / (2π·f₁)²  en cada sensor (a su altura) + base = 0.
      const f1m = (window.shmTwin?.[o.type]) || (o.type === 'hv' ? 1.6 : 0.283);
      const w2 = Math.pow(2 * Math.PI * f1m, 2) || 1;
      const ctrl = [{ z: 0, disp: 0 }];
      for (const se of o.sensors) {
        const tel = (d.sensors || []).find(s => s.id === se.id);
        if (!tel || tel.status === 'fault') continue;     // ignora sensores en falla
        ctrl.push({ z: se.mesh?.position?.y ?? 0, disp: (tel.rms || 0) * 9.81 / w2 });
      }
      ctrl.sort((a, b) => a.z - b.z);
      const sensMarks = ctrl.filter(p => p.z > 0).map(p => ({ z: p.z, disp: p.disp }));   // sensores (antes de extrapolar)
      const measProf = [];
      if (ctrl.length >= 2) {
        const top = ctrl[ctrl.length - 1];
        if (top.z < o.height - 1) ctrl.push({ z: o.height, disp: top.disp * (o.height / Math.max(top.z, 1)) });  // extrapola a la punta
        const zMax = ctrl[ctrl.length - 1].z, N = 48;
        // Deformada CÚBICA de voladizo (empotrada en la base: w(0)=0, w'(0)=0):
        //   w(ζ) = c₂·ζ² + c₃·ζ³ ,  ζ = z/zMax — ajustada por mínimos cuadrados a lo MEDIDO.
        let s4 = 0, s5 = 0, s6 = 0, b2 = 0, b3 = 0;
        for (const p of ctrl) { if (p.z <= 0) continue; const z = p.z / zMax, z2 = z * z, z3 = z2 * z; s4 += z2 * z2; s5 += z2 * z3; s6 += z3 * z3; b2 += z2 * p.disp; b3 += z3 * p.disp; }
        const det = s4 * s6 - s5 * s5 || 1, c2 = (b2 * s6 - b3 * s5) / det, c3 = (s4 * b3 - s5 * b2) / det;
        for (let i = 0; i <= N; i++) { const z = zMax * i / N, zr = z / zMax; measProf.push({ z, disp: Math.max(0, c2 * zr * zr + c3 * zr * zr * zr) }); }
      }
      let estado = '';
      if (measProf.length) {
        const maxD = Math.max(...measProf.map(p => p.disp), 1e-9);
        estado = `
          <h3>${t('brep.hEstado')}</h3>
          <div class="cols">
            <div class="draw"><img src="${imgDeformed(measProf, o.type, sensMarks)}" style="width:230px;border:1px solid #e8ebef;border-radius:8px"></div>
            <table class="ficha">
              <tr><th>${t('brep.fDateTime')}</th><td>${fmtT(Date.now())}</td></tr>
              <tr><th>${t('brep.fMaxDisp')}</th><td>${(maxD * 1000).toFixed(1)} mm</td></tr>
              <tr><th>${t('brep.fDrift')}</th><td>${t('brep.driftUnit', (maxD / o.height * 100).toFixed(3))}</td></tr>
              <tr><th>${t('brep.fSource')}</th><td>${t('brep.srcMeas')}</td></tr>
              ${o.type === 'hv' && window.shmTwin?.hvAxial ? `<tr><th>${t('brep.fAxial')}</th><td>${window.shmTwin.hvAxial.tMax.toFixed(0)} / ${window.shmTwin.hvAxial.cMax.toFixed(0)} kN</td></tr>` : ''}
            </table>
          </div>
          <div class="note">${t('brep.defNote')}</div>`;
      }
      detalle = `
        <h2>2 · ${t('brep.struct')} ${esc(o.label)}</h2>
        <div style="text-align:center;margin:6px 0 14px">${imgGauge(cls, d.dmg)}</div>
        <div class="cols">
          <div class="draw">${schematic(o)}</div>
          <table class="ficha">
            <tr><th>${t('brep.fType')}</th><td>${o.type === 'hv' ? t('det.typeHV') : t('det.typeTurbine')}</td></tr>
            <tr><th>${t('brep.fHeight')}</th><td>${o.height} m</td></tr>
            ${o.type === 'turbine' ? `<tr><th>${t('brep.fPower')}</th><td>~3 MW</td></tr>` : ''}
            <tr><th>${t('brep.fF1twin')}</th><td>${window.shmTwin?.[o.type] ? window.shmTwin[o.type].toFixed(3) + ' Hz' : '—'}</td></tr>
            <tr><th>${t('brep.fF1now')}</th><td>${d.f1 != null ? d.f1.toFixed(3) + ' Hz' : '—'}</td></tr>
            <tr><th>${t('brep.fTemp')}</th><td>${d.temp != null ? d.temp.toFixed(1) + ' °C' : '—'}</td></tr>
            <tr><th>${t('brep.fDmg')}</th><td>${Math.round((d.dmg || 0) * 100)} %</td></tr>
            <tr><th>${t('brep.fClsML')}</th><td>${cls >= 3 ? `<span class="warn">${t('cls.' + cls)}</span>` : t('cls.' + cls)}</td></tr>
          </table>
        </div>
        ${estado}
        <h3>${t('brep.hSensors')}</h3>
        <table><thead><tr><th>${t('brep.thID')}</th><th>${t('brep.thType')}</th><th>${t('brep.thLoc')}</th><th>${t('brep.thStatus')}</th><th>${t('brep.thRMS')}</th></tr></thead><tbody>${sensRows}</tbody></table>
        <h3>${t('brep.hAnom')}</h3>
        <table><thead><tr><th>${t('brep.fDateTime')}</th><th>${t('brep.thChange')}</th></tr></thead><tbody>${evRows}</tbody></table>
        <h3>${t('brep.hMaint')}</h3>
        <table><thead><tr><th>${t('brep.fDateTime')}</th><th>${t('brep.thAction')}</th></tr></thead><tbody>${mRows}</tbody></table>
        <h2>${t('brep.h2Vib')}</h2>
        ${vibSensores}${vibGateway}`;
    }

    // Compilado del parque (cuando no hay torre objetivo): historial y mantenimiento de toda la flota.
    let compilado = '';
    if (!o) {
      const allEv = [];
      for (const id in clsEvents) for (const e of clsEvents[id]) allEv.push({ ...e, id });
      allEv.sort((a, b) => b.t - a.t);
      const evRows = allEv.slice(0, 20).map(e => `<tr><td>${fmtT(e.t)}</td><td>${esc(fleet.getStructure(e.id)?.label || e.id)}</td><td>${t('cls.' + e.from)} → ${e.to >= 3 ? `<span class="warn">${t('cls.' + e.to)}</span>` : t('cls.' + e.to)}</td></tr>`).join('') || `<tr><td colspan="3">${t('brep.noChanges')}</td></tr>`;
      const mRows = (actions.log || []).slice(-20).reverse().map(m => `<tr><td>${fmtT(m.t)}</td><td>${esc(fleet.getStructure(m.id)?.label || m.id)}</td><td>${esc(m.action)}</td></tr>`).join('') || `<tr><td colspan="3">${t('brep.noActions')}</td></tr>`;
      compilado = `
        <h2>${t('brep.h2AnomAll')}</h2>
        <table><thead><tr><th>${t('brep.fDateTime')}</th><th>${t('brep.thStructure')}</th><th>${t('brep.thChange')}</th></tr></thead><tbody>${evRows}</tbody></table>
        <h2>${t('brep.h2Maint')}</h2>
        <table><thead><tr><th>${t('brep.fDateTime')}</th><th>${t('brep.thStructure')}</th><th>${t('brep.thAction')}</th></tr></thead><tbody>${mRows}</tbody></table>`;
    }
    const nAlarm = list.filter(s => { const d = window.shmData?.get(s.id) || {}; return (d.cls || 0) >= 3 || (d.sensors || []).some(x => x.status === 'fault'); }).length;
    const html = `<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8">
<title>${t('brep.docTitle')}</title>
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
  .vib2 { display: flex; gap: 14px; } .vib2 .plot { flex: 1; min-width: 0; }
  .cls-big { display: inline-block; font-size: 19px; margin: 8px 0 16px; padding: 10px 18px; border: 1.5px solid #ccc; border-radius: 10px; }
  .cls-big b { font-weight: 700; }
  footer { margin-top: 40px; border-top: 1px solid #ccc; padding-top: 10px; color: #777; font-size: 11px; }
  .noprint { position: fixed; top: 14px; right: 14px; }
  .noprint button { font: inherit; padding: 9px 16px; border: 0; border-radius: 8px; background: #0d9488; color: #fff; cursor: pointer; }
  .cover { position: relative; height: 94vh; min-height: 560px; margin: -32px -24px 30px; overflow: hidden; display: flex; align-items: flex-end; border-radius: 0; }
  .cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .cover .veil { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(8,16,28,.12) 0%, rgba(8,16,28,.28) 45%, rgba(8,16,28,.82) 100%); }
  .cover .ct { position: relative; padding: 0 46px 56px; color: #fff; }
  .cover .kicker { letter-spacing: .34em; font-size: 12px; text-transform: uppercase; opacity: .92; display: flex; align-items: center; gap: 10px; }
  .cover h1.big { font-family: Georgia, serif; font-weight: 700; font-size: 56px; line-height: 1.02; margin: 12px 0 16px; text-shadow: 0 2px 22px rgba(0,0,0,.45); }
  .cover .meta2 { font-size: 14px; opacity: .94; border-top: 2px solid rgba(255,255,255,.55); padding-top: 12px; display: inline-block; }
  @media print { .noprint { display: none; } body { margin: 0; } .cover { height: 246mm; page-break-after: always; } }
</style></head><body>
<section class="cover">
  <img src="${coverImg}" alt="Parque eólico">
  <div class="veil"></div>
  <div class="ct">
    <div class="kicker"><svg width="20" height="24" viewBox="0 0 24 24"><line x1="12" y1="23" x2="12" y2="12" stroke="#fff" stroke-width="2" stroke-linecap="round"/><g stroke="#fff" stroke-width="2" stroke-linecap="round"><line x1="12" y1="11" x2="12" y2="3"/><line x1="12" y1="11" x2="19" y2="15"/><line x1="12" y1="11" x2="5" y2="15"/></g></svg> ${t('brep.coverKicker')}</div>
    <h1 class="big">${t('brep.coverH1')}</h1>
    <div class="meta2">${fmtT(Date.now())} &nbsp;·&nbsp; ${list.length} ${t('brep.structuresWord')} &nbsp;·&nbsp; ${o ? esc(o.label) : t('brep.compiledWord')} &nbsp;·&nbsp; ${REWIND_VER}</div>
  </div>
</section>
<header>
  <svg width="34" height="40" viewBox="0 0 24 24"><line x1="12" y1="23" x2="12" y2="12" stroke="#0d9488" stroke-width="2" stroke-linecap="round"/><g stroke="#0d9488" stroke-width="2" stroke-linecap="round"><line x1="12" y1="11" x2="12" y2="3"/><line x1="12" y1="11" x2="19" y2="15"/><line x1="12" y1="11" x2="5" y2="15"/></g><circle cx="12" cy="11" r="1.7" fill="#0d9488"/></svg>
  <div class="htxt"><h1>${t('brep.headerH1')}</h1><div class="meta">ReWind ${REWIND_VER} · ${o ? esc(o.label) : t('brep.headerCompiled')} · ${fmtT(Date.now())}</div></div>
</header>
<h2>${t('brep.h2Fleet')}</h2>
<p class="lead">${t('brep.lead', list.length)} · ${nAlarm ? `<span class="warn">${t('brep.alertN', nAlarm)}</span>` : t('brep.noAlerts')}.</p>
<table><thead><tr><th>${t('brep.thStructure')}</th><th>${t('brep.thType')}</th><th>${t('brep.thHeight')}</th><th>${t('brep.thSensors')}</th><th>${t('brep.thClsML')}</th><th>${t('brep.thState')}</th></tr></thead><tbody>${rowsHtml}</tbody></table>
${detalle}${compilado}
<footer>${t('brep.footer')}</footer>
<div class="noprint"><button onclick="window.print()">${t('brep.print')}</button></div>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) { alert(t('brep.popup')); return; }
    win.document.open(); win.document.write(html); win.document.close();
  }

  // Abre una sub-pestaña de la estructura seleccionada (p. ej. desde la ficha flotante).
  const showObra = () => setTopView('obra');
  // refresca la vista per-torre visible (p. ej. tras calcular f₁ del gemelo).
  function refresh() {
    if (!current) return;
    renderDetail();
    const v = el.querySelector('.shm-toptab.active')?.dataset.v;
    if (v === 'shm') renderSHM(); else if (v === 'insp') renderInsp(); else if (v === 'obra') showObra();
  }
  return { setStructures, select, onTick, setAlarms, showShadow, showObra, showInsp: () => setTopView('insp'), showSHM: () => setTopView('shm'), showSeleccion: () => setTopView('seleccion'), showParque: () => setTopView('parque'), refreshShadow: renderShadow, refresh, buildReport };
}

function startBoot() { boot().catch(e => { console.error('[shm] boot', e); window.__rewindCloseLanding?.(); }); }
if (document.readyState === 'complete') startBoot();
else window.addEventListener('load', startBoot);
