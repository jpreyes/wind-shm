// ──────────────────────────────────────────────────────────────────────────────
// App — main orchestrator
// ──────────────────────────────────────────────────────────────────────────────
import { Model }           from './model/model.js?v=101';
import { Serializer }      from './model/serializer.js?v=101';
import { Viewport }        from './ui/viewport.js?v=101';
import { PropertiesPanel } from './ui/properties.js?v=101';
import { MenuBar }         from './ui/menu.js?v=101';
import { UndoStack }       from './utils/undo.js?v=101';
import { StaticSolver, ensureDefaultLC }   from './solver/static_solver.js?v=101';
import { Results }                         from './solver/postprocess.js?v=101';
import { ModalSolver }                     from './solver/modal_solver.js?v=101';
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './solver/assembler.js?v=101';
import { assembleSparseGlobal, extractFreeCSR } from './solver/sparse.js?v=101';
import { solveNonlinear, solveNonlinearDC } from './solver/nl_lite.js?v=101';
import { assembleKg } from './solver/geometric.js?v=101';
import { denseFactor, triForward, triBackward, makeFactor } from './solver/linsolve.js?v=101';
import { formFind } from './solver/formfind.js?v=101';
import { ModalResults }                    from './solver/modal_results.js?v=101';
import { SpectrumSolver }                  from './solver/spectrum_solver.js?v=101';
import { autoDetectDiaphragms, computeFloorCR } from './solver/diaphragm.js?v=101';
import { splitElement, splitByLength, discretizeAll, joinElements, intersectarElementos } from './model/discretize.js?v=101';
import { localAxes, stiffnessMatrix, massMatrix, transformMatrix, globalStiffness, applyReleases } from './solver/timoshenko.js?v=101';
import { bilinearGrid, blockCells, cornerGridIndices } from './model/mesher.js?v=101';

class App {
  constructor() {
    this.model      = new Model();
    this.serializer = new Serializer();
    this.undoStack  = new UndoStack(60);

    this._dirty           = false;
    this._fileHandle      = null;
    this._filePath        = null;   // Electron: native file path (string)
    this._results         = null;   // static / spectral Results object (viewport)
    this._modalResults    = null;   // ModalResults object
    this._spectrumResults = new Map(); // 'espX'|'espY'|'espZ' → {result, params}
    this._modalMode       = 0;      // currently displayed mode index (0-based)
    this._modalPlaying    = false;  // animation running?
    this._activeLcId      = null;   // active load case ID
    this._config          = this._loadConfig();   // configuración de la app (memoria, visual, modificadores)

    // UI components
    this.viewport = new Viewport(
      document.getElementById('viewport-container'), this
    );
    this.panel = new PropertiesPanel(
      document.getElementById('panel'), this
    );
    this.menu = new MenuBar(
      document.getElementById('menubar'), this
    );

    // Toast container
    const tc = document.createElement('div');
    tc.id = 'toast-container';
    document.body.appendChild(tc);

    this._bindKeys();
    this._bindModal();
    this._bindElectronMenu();

    // Initial render
    this.viewport.renderModel(this.model);
    this._updateStats();
    this._updateTitle();

    // Load case UI
    this._initLoadCaseUI();
    this.refreshLoads();
    this._initResizeHandle();

    // Analysis button → abre el centro de análisis (ventana flotante)
    document.getElementById('btn-run')?.addEventListener('click', () => this.openAnalysisHub());
    document.getElementById('btn-clear-results')?.addEventListener('click', () => this.clearResults());

    // Results type/scale changes.
    // El control de escala es un FACTOR RELATIVO (1 = ajuste automático
    // normalizado). Al cambiar el tipo de resultado se RE-NORMALIZA siempre
    // (autoScale=true) para que cada diagrama nazca bien dimensionado y no
    // herede una escala absurda del tipo anterior.
    document.getElementById('result-type')?.addEventListener('change', () => this._refreshResultView(true));
    document.getElementById('result-scale')?.addEventListener('change', () => {
      this._refreshResultView();
      // Sync range slider (factor → log10)
      const f = parseFloat(document.getElementById('result-scale')?.value) || 1;
      const logV = Math.log10(Math.max(f, 1e-3));
      const rangeEl = document.getElementById('result-scale-range');
      if (rangeEl) rangeEl.value = Math.max(-1.5, Math.min(1.5, logV));
    });
    document.getElementById('result-scale-range')?.addEventListener('input', e => {
      const factor = Math.pow(10, parseFloat(e.target.value));
      const numEl = document.getElementById('result-scale');
      if (numEl) numEl.value = +factor.toPrecision(3);
      if (this._results) this._refreshResultView();
    });
    // Doble clic en el control → vuelve al ajuste automático (factor 1).
    document.getElementById('result-scale')?.addEventListener('dblclick', () => {
      const numEl = document.getElementById('result-scale');
      const rangeEl = document.getElementById('result-scale-range');
      if (numEl) numEl.value = 1;
      if (rangeEl) rangeEl.value = 0;
      this._refreshResultView(true);
    });

    // Toolbar extras
    // Selector de elevaciones (vista 2D real de un eje estructural, solo en 3D)
    document.getElementById('elev-select')?.addEventListener('change', e => {
      const v = e.target.value;
      if (!v) { this.viewport.setElevation(null); return; }
      const [axis, coordS] = v.split(':');
      const coord = parseFloat(coordS);
      const opt = e.target.selectedOptions[0];
      this.viewport.setElevation({ axis, coord, name: opt ? opt.textContent : v });
    });
    document.getElementById('btn-toggle-ids')?.addEventListener('click', () => this.viewport.toggleIds());
    document.getElementById('btn-config')?.addEventListener('click', () => this.configDialog());
    document.getElementById('btn-toggle-extrude')?.addEventListener('click', () => this.viewport.toggleExtruded());
    document.getElementById('btn-export-img')?.addEventListener('click', () => this.exportViewportPNG());

    // Reacciones en apoyos (toggle)
    document.getElementById('btn-show-reactions')?.addEventListener('click', () => {
      this._showReactions = !this._showReactions;
      document.getElementById('btn-show-reactions')?.classList.toggle('active', this._showReactions);
      if (this._showReactions && this._results) this.viewport.showReactions(this._results);
      else this.viewport.clearReactions();
    });

    this._initHelp();
    this._initTheme();
    this._initPro();

    // F1 / F5 / F6 / F7 / F8 shortcuts
    document.addEventListener('keydown', e => {
      if (e.key === 'F1') { e.preventDefault(); this.openHelp('guia');       }
      if (e.key === 'F5') { e.preventDefault(); this.runAnalysis();          }
      if (e.key === 'F6') { e.preventDefault(); this.runModal();             }
      if (e.key === 'F7') { e.preventDefault(); this.runSpectrum();          }
      if (e.key === 'F8') { e.preventDefault(); this.openCombosTab(); }
      const resKeys = { '1':'deformed','2':'N','3':'Vy','4':'Vz','5':'T','6':'My','7':'Mz' };
      const inInput = ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName);
      if (resKeys[e.key] && !inInput) this.setResultType(resKeys[e.key]);
    });

    // Autoguardado al cerrar/recargar la página
    window.addEventListener('beforeunload', () => this._autosaveNow());

    // Recuperar autoguardado o cargar ejemplo
    this._restoreOrLoadExample();
  }

  // ── Model mutations (all go through here for undo tracking) ───────────────

  snapshot() {
    this.undoStack.push(this.serializer.toJSON(this.model));
  }

  addNode(x, y, z) {
    this.snapshot();
    if (this.model.mode === '2D') y = 0;   // pórtico plano X–Z
    const node = this.model.addNode(x, y, z);
    this.viewport.addNodeMesh(node);
    this.panel.showNode(node);
    this.markDirty();
    this._updateStats();
    return node;
  }

  addElement(n1id, n2id) {
    this.snapshot();
    const elem = this.model.addElement(n1id, n2id);
    if (!elem) {
      this.toast('No se pudo crear el elemento (nodos inválidos)', 'warn');
      return null;
    }
    this.viewport.addElemLine(elem);
    this.panel.showElement(elem);
    this.markDirty();
    this._updateStats();
    return elem;
  }

  deleteNode(id) {
    this.snapshot();
    const node = this.model.nodes.get(id);
    if (!node) return;
    // Delete connected elements from viewport first
    for (const [eid, el] of this.model.elements) {
      if (el.n1 === id || el.n2 === id) this.viewport.removeElemLine(eid);
    }
    for (const aid of this._areasDeNodo(id)) { this.viewport.removeAreaMesh(aid); this.model.removeArea(aid); }
    this.viewport.removeNodeMesh(id);
    this.model.removeNode(id);
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`Nodo #${id} eliminado`, 'ok');
  }

  deleteElement(id) {
    this.snapshot();
    this.viewport.removeElemLine(id);
    this.model.removeElement(id);
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`Elemento #${id} eliminado`, 'ok');
  }

  deleteArea(id) {
    this.snapshot();
    this.viewport.removeAreaMesh(id);
    this.model.removeArea(id);
    this.panel.showNothing();
    this.markDirty();
    this._updateStats?.();
    this.toast(`Elemento de área #${id} eliminado`, 'ok');
  }

  // Áreas que tocan un nodo dado (para limpiarlas al borrar el nodo).
  _areasDeNodo(nodeId) {
    const out = [];
    for (const [aid, a] of this.model.areas) if (a.nodes.includes(nodeId)) out.push(aid);
    return out;
  }

  deleteSelected() {
    const sel = this.viewport.getSelected();
    if (!sel.length) return;
    this.snapshot();
    // Delete areas + elements before nodes to avoid dangling references
    const areas = sel.filter(s => s.type === 'area');
    const elems = sel.filter(s => s.type === 'elem');
    const nodes = sel.filter(s => s.type === 'node');
    for (const { id } of areas) { this.viewport.removeAreaMesh(id); this.model.removeArea(id); }
    for (const { id } of elems) {
      this.viewport.removeElemLine(id);
      this.model.removeElement(id);
    }
    for (const { id } of nodes) {
      for (const [eid, el] of this.model.elements) {
        if (el.n1 === id || el.n2 === id) {
          this.viewport.removeElemLine(eid);
          this.model.removeElement(eid);
        }
      }
      for (const aid of this._areasDeNodo(id)) { this.viewport.removeAreaMesh(aid); this.model.removeArea(aid); }
      this.viewport.removeNodeMesh(id);
      this.model.removeNode(id);
    }
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
  }

  // ── Discretización de elementos ─────────────────────────────────────────────
  discretizeElement(elemId, opts) {
    this.snapshot();
    const ids = (opts.length > 0)
      ? splitByLength(this.model, elemId, opts.length)
      : splitElement(this.model, elemId, opts.parts || 2);
    if (!ids || ids.length < 2) {
      this.toast('No se pudo discretizar (¿el tramo objetivo es mayor que el elemento?)', 'warn');
      return;
    }
    this.viewport.renderModel(this.model);
    this.refreshLoads();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`Elemento #${elemId} dividido en ${ids.length} tramos`, 'ok');
  }

  joinSelectedElements() {
    const sel = this.viewport.getSelected().filter(s => s.type === 'elem').map(s => s.id);
    if (sel.length < 2) {
      this.toast('Seleccione 2 o más elementos colineales (Ctrl+clic) para unir', 'warn');
      return;
    }
    this.snapshot();
    const r = joinElements(this.model, sel);
    if (!r.ok) { this.toast(`No se pudo unir: ${r.reason}`, 'warn'); return; }
    this.viewport.renderModel(this.model);
    this.refreshLoads();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`${sel.length} elementos unidos → Elemento #${r.elemId}`, 'ok');
  }

  /** Crea un nodo común en la intersección de 2 elementos que se cruzan. */
  unirInterseccion() {
    const sel = this.viewport.getSelected().filter(s => s.type === 'elem').map(s => s.id);
    if (sel.length !== 2) {
      this.toast('Seleccione exactamente 2 elementos que se intersecten (Ctrl+clic) para unirlos', 'warn');
      return;
    }
    this.snapshot();
    const r = intersectarElementos(this.model, sel[0], sel[1]);
    if (!r.ok) { this.toast(`No se pudo unir: ${r.reason}`, 'warn'); return; }
    this.viewport.renderModel(this.model);
    this.refreshLoads();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`Nodo de intersección creado (#${r.nodeId}); ${r.nuevos} tramos`, 'ok');
  }

  // ── Acciones masivas sobre la selección de elementos ───────────────────────
  _selElems() { return this.viewport.getSelected().filter(s => s.type === 'elem').map(s => s.id); }
  _selAreas() { return this.viewport.getSelected().filter(s => s.type === 'area').map(s => s.id); }

  // Aplica comportamiento / espesor / material a TODAS las áreas seleccionadas.
  setAreasProps(props) {
    const ids = this._selAreas(); if (!ids.length) return;
    this.snapshot();
    for (const id of ids) {
      this.model.updateArea(id, props);
      this.viewport.addAreaMesh(this.model.areas.get(id));
      this.viewport._setAreaHL(id, 0xffc107);
    }
    this.markDirty(); this._updateStats?.();
    this.toast(`${ids.length} área(s) actualizadas`, 'ok');
  }
  _reselect(ids) { this.viewport.selectElements(ids); this.panel.showSelection(this.viewport.getSelected()); }

  setMaterialSelected(matId) {
    const ids = this._selElems(); if (!ids.length || matId == null) return;
    this.snapshot();
    for (const id of ids) this.model.updateElement(id, { matId: +matId });
    this.viewport.renderModel(this.model); this.markDirty(); this._updateStats();
    this.toast(`Material aplicado a ${ids.length} elemento(s)`, 'ok');
    this._reselect(ids);
  }
  setSectionSelected(secId) {
    const ids = this._selElems(); if (!ids.length || secId == null) return;
    this.snapshot();
    for (const id of ids) this.model.updateElement(id, { secId: +secId });
    this.viewport.renderModel(this.model); this.markDirty(); this._updateStats();
    this.toast(`Sección aplicada a ${ids.length} elemento(s)`, 'ok');
    this._reselect(ids);
  }
  discretizeSelected(parts) {
    const ids = this._selElems(); if (!ids.length) return;
    parts = Math.max(2, Math.round(parts || 2));
    this.snapshot();
    let tramos = 0; for (const id of ids) { const r = splitElement(this.model, id, parts); tramos += (r && r.length) ? r.length : 1; }
    this.viewport.renderModel(this.model); this.refreshLoads(); this.panel.showNothing(); this.markDirty(); this._updateStats();
    this.toast(`${ids.length} elemento(s) divididos en ${parts} (${tramos} tramos)`, 'ok');
  }
  hideSelected() {
    const ids = this._selElems(); if (!ids.length) { this.toast('Seleccione elementos para ocultar', 'warn'); return; }
    this.viewport.hideElements(ids); this.viewport.clearSelection(); this.panel.showNothing();
    this.toast(`${ids.length} elemento(s) oculto(s) · Vista → Mostrar todo para revertir`, 'ok');
  }
  showAllElements() {
    const n = this.viewport.hiddenCount(); this.viewport.showAllElements();
    this.toast(n ? `${n} elemento(s) mostrado(s)` : 'No había elementos ocultos', 'ok');
  }

  // ── Grupos de elementos (estado de sesión) ──────────────────────────────────
  grupos() { return (this._grupos ||= new Map()); }
  crearGrupo(nombre) {
    const ids = this._selElems(); if (!ids.length) { this.toast('Seleccione elementos para agrupar', 'warn'); return; }
    this.grupos();
    nombre = String(nombre || '').trim() || `Grupo ${this._grupos.size + 1}`;
    this._grupos.set(nombre, new Set(ids));
    this.toast(`Grupo "${nombre}" creado (${ids.length} elementos)`, 'ok');
    this.panel.showSelection(this.viewport.getSelected());
  }
  seleccionarGrupo(nombre) { const g = this.grupos().get(nombre); if (!g) return; this.viewport.selectElements([...g]); this.panel.showSelection(this.viewport.getSelected()); }
  ocultarGrupo(nombre) { const g = this.grupos().get(nombre); if (!g) return; this.viewport.hideElements([...g]); this.toast(`Grupo "${nombre}" oculto`, 'ok'); }
  mostrarGrupo(nombre) { const g = this.grupos().get(nombre); if (!g) return; this.viewport.showElements([...g]); this.toast(`Grupo "${nombre}" mostrado`, 'ok'); }
  eliminarGrupo(nombre) { this.grupos().delete(nombre); this.toast(`Grupo "${nombre}" eliminado`, 'ok'); this.panel.showSelection(this.viewport.getSelected()); }

  // ── Elementos de área (membrana CST/QUAD) ────────────────────────────────
  async crearAreaSeleccion() {
    const ids = this._selNodes();
    if (ids.length !== 3 && ids.length !== 4) { this.toast('Seleccione 3 nodos (CST) o 4 nodos (QUAD) para crear un elemento de área', 'warn'); return; }
    const str = await this._promptModal('Elemento de área',
      'Espesor t (m) y comportamiento (M=membrana, P=placa, S=shell=membrana+placa), separados por coma. Ej: 0.2,S', '0.2,M');
    if (str == null) return;
    const p = str.split(',').map(s => s.trim());
    const t = parseFloat(p[0]); if (!(t > 0)) { this.toast('Espesor inválido', 'warn'); return; }
    const behavior = this._behaviorCode(p[1]);
    this._lastAreaOpts = { thickness: t, behavior };   // recordado para la herramienta Área
    const ordered = ids.length === 4 ? this._ordenarCuad(ids) : ids;
    this.snapshot();
    const matId = [...this.model.materials.keys()][0];
    const a = this.model.addArea(ordered, matId, { thickness: t, behavior });
    if (!a) { this.toast('No se pudo crear el área (nodos repetidos o inexistentes)', 'warn'); return; }
    this.viewport.addAreaMesh(a);
    this.markDirty(); this._updateStats?.();
    this.toast(`Elemento de área ${a.kind} #${a.id} (${this._behaviorLabel(behavior)}, t=${t} m) creado`, 'ok');
  }

  // Crea un área a partir de 3/4 nodos (herramienta Área de la barra lateral),
  // con las últimas opciones usadas (espesor/comportamiento) — sin diálogo. El
  // usuario ajusta material/espesor/comportamiento después en el panel del área.
  crearAreaDesdeNodos(ids) {
    if (!ids || (ids.length !== 3 && ids.length !== 4)) { this.toast('Un área necesita 3 (CST) o 4 (QUAD) nodos', 'warn'); return; }
    const opts = this._lastAreaOpts || (this._lastAreaOpts = { thickness: 0.2, behavior: 'membrane' });
    const ordered = ids.length === 4 ? this._ordenarCuad(ids) : ids;
    this.snapshot();
    const matId = [...this.model.materials.keys()][0];
    const a = this.model.addArea(ordered, matId, { ...opts });
    if (!a) { this.toast('No se pudo crear el área (nodos repetidos o inexistentes)', 'warn'); return; }
    this.viewport.addAreaMesh(a);
    this.markDirty(); this._updateStats?.();
    this.toast(`Área ${a.kind} #${a.id} (${this._behaviorLabel(opts.behavior)}, t=${opts.thickness} m) — ajusta sus propiedades en el panel`, 'ok');
  }

  // Códigos/etiquetas de comportamiento de área.
  _behaviorCode(s) { const c = (s || 'M').toUpperCase()[0]; return c === 'S' ? 'shell' : c === 'P' ? 'plate' : 'membrane'; }
  _behaviorLabel(b) { return b === 'shell' ? 'shell' : b === 'plate' ? 'placa' : 'membrana'; }

  // Ordena 4 nodos en sentido antihorario alrededor del centroide, en su plano,
  // para que el cuadrilátero no quede cruzado sin importar el orden de selección.
  _ordenarCuad(ids) {
    const P = ids.map(id => { const n = this.model.nodes.get(id); return { id, x: n.x, y: n.y, z: n.z }; });
    const c = P.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4, z: s.z + p.z / 4 }), { x: 0, y: 0, z: 0 });
    const v1 = [P[1].x - P[0].x, P[1].y - P[0].y, P[1].z - P[0].z];
    let nrm = null;
    for (let k = 2; k < 4; k++) {
      const w = [P[k].x - P[0].x, P[k].y - P[0].y, P[k].z - P[0].z];
      const cr = [v1[1] * w[2] - v1[2] * w[1], v1[2] * w[0] - v1[0] * w[2], v1[0] * w[1] - v1[1] * w[0]];
      if (Math.hypot(...cr) > 1e-9) { nrm = cr; break; }
    }
    if (!nrm) return ids;
    const nn = Math.hypot(...nrm), ez = nrm.map(v => v / nn);
    const e1n = Math.hypot(...v1), ex = v1.map(v => v / e1n);
    const ey = [ez[1] * ex[2] - ez[2] * ex[1], ez[2] * ex[0] - ez[0] * ex[2], ez[0] * ex[1] - ez[1] * ex[0]];
    const ang = p => { const d = [p.x - c.x, p.y - c.y, p.z - c.z]; return Math.atan2(d[0] * ey[0] + d[1] * ey[1] + d[2] * ey[2], d[0] * ex[0] + d[1] * ex[1] + d[2] * ex[2]); };
    return [...P].sort((a, b) => ang(a) - ang(b)).map(p => p.id);
  }

  // Malla un panel: 4 nodos esquina → grilla estructurada nx×ny de membranas
  // (MESHGEN, interpolación bilineal del bloque). Reutiliza los 4 nodos esquina.
  async mallarPanelSeleccion() {
    const ids = this._selNodes();
    if (ids.length !== 4) { this.toast('Seleccione 4 nodos esquina del panel (en cualquier orden)', 'warn'); return; }
    const str = await this._promptModal('Mallar panel (4 esquinas)',
      'nx, ny, espesor t (m), tipo (Q=quad / T=tri) y comportamiento (M=membrana/P=placa/S=shell). Ej: 6,2,0.2,Q,S', '4,2,0.2,Q,M');
    if (str == null) return;
    const p = str.split(',').map(s => s.trim());
    const nx = Math.round(+p[0]), ny = Math.round(+p[1]), t = parseFloat(p[2]);
    const tri = (p[3] || 'Q').toUpperCase().startsWith('T');
    const behavior = this._behaviorCode(p[4]);
    if (!(nx >= 1 && ny >= 1 && t > 0)) { this.toast('Valores inválidos (nx, ny ≥ 1; t > 0)', 'warn'); return; }
    if (nx * ny > 2500) { this.toast('Demasiados elementos (>2500). Reduzca nx·ny.', 'warn'); return; }

    const ordered = this._ordenarCuad(ids);
    const corners = ordered.map(id => { const n = this.model.nodes.get(id); return [n.x, n.y, n.z]; });
    const pts = bilinearGrid(corners, nx, ny);
    const ci = cornerGridIndices(nx, ny);   // [P1,P2,P3,P4] índices de grilla
    const cornerMap = new Map([[ci[0], ordered[0]], [ci[1], ordered[1]], [ci[2], ordered[2]], [ci[3], ordered[3]]]);

    this.snapshot();
    const nodeId = [];
    for (let g = 0; g < pts.length; g++) {
      if (cornerMap.has(g)) nodeId[g] = cornerMap.get(g);
      else { const q = pts[g]; nodeId[g] = this.model.addNode(q[0], q[1], q[2]).id; }
    }
    const matId = [...this.model.materials.keys()][0];
    let created = 0;
    for (const cell of blockCells(nx, ny, tri)) {
      const a = this.model.addArea(cell.map(g => nodeId[g]), matId, { thickness: t, behavior });
      if (a) created++;
    }
    this.viewport.renderModel(this.model);
    this.markDirty(); this._updateStats?.();
    this.toast(`Panel mallado: ${created} ${tri ? 'CST' : 'QUAD'} (${nx}×${ny}, ${this._behaviorLabel(behavior)}), ${pts.length - 4} nodos nuevos · t=${t} m`, 'ok');
  }

  // ── Acciones masivas sobre NODOS ────────────────────────────────────────────
  _selNodes() { return this.viewport.getSelected().filter(s => s.type === 'node').map(s => s.id); }
  setSupportSelectedNodes(preset) {
    const ids = this._selNodes(); if (!ids.length) { this.toast('Seleccione nodos', 'warn'); return; }
    const R = preset === 'empotrado' ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 }
      : preset === 'rotulado' ? { ux: 1, uy: 1, uz: 1, rx: 0, ry: 0, rz: 0 }
      : preset === 'rodillo' ? { ux: 0, uy: 0, uz: 1, rx: 0, ry: 0, rz: 0 }
      : { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };
    this.snapshot();
    for (const id of ids) { this.model.updateNode(id, { restraints: { ...R } }); this.viewport.refreshNode(this.model.nodes.get(id)); }
    this.markDirty(); this._updateStats();
    this.toast(`Apoyo "${preset}" aplicado a ${ids.length} nodo(s)`, 'ok');
    this.panel.showSelection(this.viewport.getSelected());
  }

  // ── Mover / Copiar (array lineal) la selección ──────────────────────────────
  _nodosDeSeleccion() {
    const set = new Set(this._selNodes());
    for (const id of this._selElems()) { const e = this.model.elements.get(id); if (e) { set.add(e.n1); set.add(e.n2); } }
    for (const s of this.viewport.getSelected()) if (s.type === 'area') { const a = this.model.areas.get(s.id); if (a) a.nodes.forEach(n => set.add(n)); }
    return set;
  }
  moverSeleccion(dx, dy, dz) {
    dx = +dx || 0; dy = +dy || 0; dz = +dz || 0;
    if (!(dx || dy || dz)) { this.toast('Indique un desplazamiento (dX, dY o dZ)', 'warn'); return; }
    const ids = this._nodosDeSeleccion(); if (!ids.size) { this.toast('Seleccione nodos o elementos para mover', 'warn'); return; }
    this.snapshot();
    for (const id of ids) { const n = this.model.nodes.get(id); this.model.updateNode(id, { x: n.x + dx, y: n.y + dy, z: n.z + dz }); }
    this.viewport.renderModel(this.model); this.refreshLoads(); this.markDirty(); this._updateStats();
    this.toast(`${ids.size} nodo(s) movidos (${dx}, ${dy}, ${dz})`, 'ok');
  }
  copiarSeleccion(dx, dy, dz, reps, dx2 = 0, dy2 = 0, dz2 = 0, reps2 = 0) {
    dx = +dx || 0; dy = +dy || 0; dz = +dz || 0; reps = Math.max(1, Math.round(reps || 1));
    dx2 = +dx2 || 0; dy2 = +dy2 || 0; dz2 = +dz2 || 0; reps2 = Math.max(0, Math.round(reps2 || 0));
    if (!(dx || dy || dz)) { this.toast('Indique un desplazamiento (dX, dY o dZ) ≠ 0', 'warn'); return; }
    const elems = this._selElems().map(id => this.model.elements.get(id)).filter(Boolean);
    const nodeIds = this._nodosDeSeleccion(); if (!nodeIds.size) { this.toast('Seleccione nodos o elementos para copiar', 'warn'); return; }
    this.snapshot();
    const rk = (v) => Math.round(v * 1e4) / 1e4, key = (x, y, z) => `${rk(x)}|${rk(y)}|${rk(z)}`;
    const coordIdx = new Map(); for (const n of this.model.nodes.values()) coordIdx.set(key(n.x, n.y, n.z), n.id);
    const getOrAdd = (x, y, z, src) => {
      const k = key(x, y, z); if (coordIdx.has(k)) return coordIdx.get(k);
      const nn = this.model.addNode(rk(x), rk(y), rk(z), src ? { ...src.restraints } : {});
      if (src) this.model.updateNode(nn.id, { springs: { ...src.springs } });
      coordIdx.set(k, nn.id); return nn.id;
    };
    const pares = new Set(); for (const e of this.model.elements.values()) pares.add(`${Math.min(e.n1, e.n2)}-${Math.max(e.n1, e.n2)}`);
    // Una copia de la selección con un nodo-mapeo dado (offset o reflexión).
    const copiarInstancia = (mapCoord) => {
      const map = new Map();
      for (const nid of nodeIds) { const n = this.model.nodes.get(nid); const p = mapCoord(n); map.set(nid, getOrAdd(p.x, p.y, p.z, n)); }
      let k = 0;
      for (const e of elems) {
        const a = map.get(e.n1), b = map.get(e.n2); if (a == null || b == null || a === b) continue;
        const pk = `${Math.min(a, b)}-${Math.max(a, b)}`; if (pares.has(pk)) continue; pares.add(pk);
        const ne = this.model.addElement(a, b, e.matId, e.secId);
        if (!ne) continue;
        // Propiedades del elemento: liberaciones, cable / pretensado.
        const upd = {};
        if (e.releases && e.releases.some(x => x)) upd.releases = [...e.releases];
        if (e.cable) upd.cable = true;
        if (e.L0factor != null && e.L0factor !== 1) upd.L0factor = e.L0factor;
        if (Object.keys(upd).length) this.model.updateElement(ne.id, upd);
        // Cargas del elemento (todas las dist/temp de todos los casos) → copia.
        for (const lc of this.model.loadCases.values())
          for (const ld of (lc.loads || []))
            if (ld.elemId === e.id && (ld.type === 'dist' || ld.type === 'temp'))
              lc.loads.push({ ...ld, elemId: ne.id });
        // Pertenencia a grupos (estado de sesión).
        if (this._grupos) for (const set of this._grupos.values()) if (set.has(e.id)) set.add(ne.id);
        k++;
      }
      return k;
    };
    let nEl = 0;
    // grilla (reps+1)×(reps2+1) salvo el original (0,0); reps2=0 → array lineal
    for (let i = 0; i <= reps; i++) for (let j = 0; j <= reps2; j++) {
      if (i === 0 && j === 0) continue;
      const ox = dx * i + dx2 * j, oy = dy * i + dy2 * j, oz = dz * i + dz2 * j;
      nEl += copiarInstancia((n) => ({ x: n.x + ox, y: n.y + oy, z: n.z + oz }));
    }
    this._afterCopia(nEl);
    const total = reps2 > 0 ? `${reps}×${reps2}` : `×${reps}`;
    this.toast(`Copiado ${total}: +${nEl} elemento(s)`, 'ok');
  }

  _afterCopia(nEl) {
    this.viewport.renderModel(this.model); this.refreshLoads(); this.viewport.clearSelection(); this.panel.showNothing(); this.markDirty(); this._updateStats();
  }

  // Espejar (reflejar) la selección respecto al plano perpendicular a 'eje' en 'coord'.
  espejarSeleccion(eje, coord) {
    coord = +coord || 0; eje = String(eje || 'X').toUpperCase();
    const elems = this._selElems().map(id => this.model.elements.get(id)).filter(Boolean);
    const nodeIds = this._nodosDeSeleccion(); if (!nodeIds.size) { this.toast('Seleccione nodos o elementos para espejar', 'warn'); return; }
    this.snapshot();
    const rk = (v) => Math.round(v * 1e4) / 1e4, key = (x, y, z) => `${rk(x)}|${rk(y)}|${rk(z)}`;
    const coordIdx = new Map(); for (const n of this.model.nodes.values()) coordIdx.set(key(n.x, n.y, n.z), n.id);
    const getOrAdd = (x, y, z, src) => {
      const k = key(x, y, z); if (coordIdx.has(k)) return coordIdx.get(k);
      const nn = this.model.addNode(rk(x), rk(y), rk(z), src ? { ...src.restraints } : {});
      if (src) this.model.updateNode(nn.id, { springs: { ...src.springs } });
      coordIdx.set(k, nn.id); return nn.id;
    };
    const pares = new Set(); for (const e of this.model.elements.values()) pares.add(`${Math.min(e.n1, e.n2)}-${Math.max(e.n1, e.n2)}`);
    const refl = (n) => ({ x: eje === 'X' ? 2 * coord - n.x : n.x, y: eje === 'Y' ? 2 * coord - n.y : n.y, z: eje === 'Z' ? 2 * coord - n.z : n.z });
    const map = new Map();
    for (const nid of nodeIds) { const n = this.model.nodes.get(nid); const p = refl(n); map.set(nid, getOrAdd(p.x, p.y, p.z, n)); }
    let nEl = 0;
    for (const e of elems) {
      const a = map.get(e.n1), b = map.get(e.n2); if (a == null || b == null || a === b) continue;
      const pk = `${Math.min(a, b)}-${Math.max(a, b)}`; if (pares.has(pk)) continue; pares.add(pk);
      const ne = this.model.addElement(a, b, e.matId, e.secId);
      if (ne && e.releases && e.releases.some(x => x)) this.model.updateElement(ne.id, { releases: [...e.releases] });
      if (ne) nEl++;
    }
    this._afterCopia(nEl);
    this.toast(`Espejado en ${eje}=${coord}: +${nEl} elemento(s)`, 'ok');
  }

  // ── Carga distribuida masiva sobre los elementos seleccionados ──────────────
  setCargaDistSelected(w, dir, lcId) {
    const ids = this._selElems(); if (!ids.length) { this.toast('Seleccione elementos', 'warn'); return; }
    const lc = this.model.loadCases.get(+lcId) || this.model.loadCases.get(this._activeLcId) || [...this.model.loadCases.values()][0];
    if (!lc) { this.toast('No hay caso de carga', 'warn'); return; }
    if (lc.type === 'spectrum') { this.toast('El caso espectral no admite cargas distribuidas', 'warn'); return; }
    w = +w; dir = dir || 'gravity';
    this.snapshot();
    const set = new Set(ids);
    lc.loads = (lc.loads || []).filter(l => !(l.type === 'dist' && set.has(l.elemId)));   // reemplaza la existente
    if (w && Number.isFinite(w)) for (const id of ids) lc.loads.push({ type: 'dist', elemId: id, dir, w });
    this.refreshLoads(); this.markDirty(); this._updateStats();
    this.toast(w ? `Carga ${w} kN/m (${dir}) en ${ids.length} elem. · ${lc.name}` : `Cargas distribuidas quitadas de ${ids.length} elem. · ${lc.name}`, 'ok');
    this._reselect(ids);
  }

  // ── Carga de TEMPERATURA (ΔT uniforme) sobre los elementos seleccionados ────
  setCargaTempSelected(dT, lcId) {
    const ids = this._selElems(); if (!ids.length) { this.toast('Seleccione elementos', 'warn'); return; }
    const lc = this.model.loadCases.get(+lcId) || this.model.loadCases.get(this._activeLcId) || [...this.model.loadCases.values()][0];
    if (!lc) { this.toast('No hay caso de carga', 'warn'); return; }
    if (lc.type === 'spectrum') { this.toast('El caso espectral no admite cargas de temperatura', 'warn'); return; }
    dT = +dT;
    this.snapshot();
    const set = new Set(ids);
    lc.loads = (lc.loads || []).filter(l => !(l.type === 'temp' && set.has(l.elemId)));   // reemplaza la previa
    if (dT && Number.isFinite(dT)) for (const id of ids) lc.loads.push({ type: 'temp', elemId: id, dT });
    this.refreshLoads(); this.markDirty(); this._updateStats();
    this.toast(dT ? `ΔT = ${dT} °C en ${ids.length} elem. · ${lc.name}` : `Cargas de temperatura quitadas de ${ids.length} elem. · ${lc.name}`, 'ok');
    this._reselect(ids);
  }

  async discretizeAllDialog() {
    if (this.model.elements.size === 0) { this.toast('No hay elementos', 'warn'); return; }
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Discretizar Todos los Elementos';
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-row">
        <div class="prop-field"><label>Modo</label>
          <select id="disc-mode">
            <option value="parts">Nº de partes por elemento</option>
            <option value="length">Longitud de tramo (m)</option>
          </select>
        </div>
        <div class="prop-field"><label>Valor</label>
          <input type="number" id="disc-val" value="5" min="0.01" step="1" style="width:90px">
        </div>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:8px">
        Ej.: modo longitud con 0.25 divide cada elemento en tramos de ≈25 cm.<br>
        Para revertir use Deshacer (Ctrl+Z) o seleccione tramos y Editar → Unir.
      </p>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;
    const mode = document.getElementById('disc-mode')?.value;
    const val  = parseFloat(document.getElementById('disc-val')?.value);
    if (!(val > 0)) return;
    this.snapshot();
    const before = this.model.elements.size;
    discretizeAll(this.model, mode === 'length'
      ? { length: val }
      : { parts: Math.max(2, Math.round(val)) });
    this.viewport.renderModel(this.model);
    this.refreshLoads();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`Discretizado: ${before} → ${this.model.elements.size} elementos`, 'ok');
  }

  // ── Visor de matrices (didáctico) ────────────────────────────────────────────
  _fmtMtx(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    return (a >= 1e5 || a < 1e-3) ? v.toExponential(2) : String(+v.toPrecision(5));
  }

  _matrixHTML(M, labels, title, highlightZeros = true) {
    const n = M.length;
    let h = `<div class="mtx-title">${title}</div><div class="mtx-wrap"><table class="mtx"><tr><th></th>`;
    for (let j = 0; j < n; j++) h += `<th>${labels[j]}</th>`;
    h += '</tr>';
    for (let i = 0; i < n; i++) {
      h += `<tr><th>${labels[i]}</th>`;
      for (let j = 0; j < n; j++) {
        const v = M[i][j];
        const cls = (highlightZeros && Math.abs(v) < 1e-12) ? ' class="mz"' : '';
        h += `<td${cls}>${this._fmtMtx(v)}</td>`;
      }
      h += '</tr>';
    }
    return h + '</table></div>';
  }

  _matrixCSV(M, labels, title) {
    const lines = [`# ${title}`, ',' + labels.join(',')];
    M.forEach((row, i) => lines.push(labels[i] + ',' + row.map(v => v.toExponential(6)).join(',')));
    return lines.join('\r\n');
  }

  showElementMatrices(elemId) {
    const elem = this.model.elements.get(elemId);
    if (!elem) return;
    const n1 = this.model.nodes.get(elem.n1), n2 = this.model.nodes.get(elem.n2);
    const mat = this.model.materials.get(elem.matId), sec = this.model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) { this.toast('Elemento incompleto', 'warn'); return; }

    const { ex, ey, ez, L } = localAxes(n1, n2);
    const Ke = stiffnessMatrix(L, mat, sec);
    const Me = massMatrix(L, mat, sec);
    const T  = transformMatrix(ex, ey, ez);
    const hasRel = elem.releases?.some(r => r);
    const KeC = hasRel ? applyReleases(Ke, elem.releases.map(r => r !== 0)) : null;
    const KG  = globalStiffness(KeC ?? Ke, T);

    const L12 = ['u₁','v₁','w₁','θx₁','θy₁','θz₁','u₂','v₂','w₂','θx₂','θy₂','θz₂'];
    const fx = v => +v.toFixed(4);
    let html = `
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
        Elemento #${elem.id} (nodos ${elem.n1}→${elem.n2}) · L = ${+L.toFixed(4)} m ·
        ejes locales: x=[${ex.map(fx)}], y=[${ey.map(fx)}], z=[${ez.map(fx)}]<br>
        Orden de GDL locales: [u, v, w, θx, θy, θz] por nodo. Unidades: kN, m, ton.
      </p>`;
    html += this._matrixHTML(Ke, L12, 'Ke — rigidez LOCAL (12×12)');
    if (KeC) html += this._matrixHTML(KeC, L12, 'Ke* — rigidez local CONDENSADA por liberaciones (filas/columnas liberadas = 0)');
    html += this._matrixHTML(T, L12, 'T — matriz de transformación local ← global');
    html += this._matrixHTML(KG, L12, 'K = Tᵀ·Ke·T — rigidez en coordenadas GLOBALES');
    html += this._matrixHTML(Me, L12, 'Me — masa consistente LOCAL (12×12)');
    html += `<button class="btn-secondary" id="mtx-csv" style="width:100%;margin-top:8px">⬇ Exportar matrices a CSV</button>`;

    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-box').classList.add('modal-wide');
    document.getElementById('modal-title').textContent = `Matrices del Elemento #${elem.id}`;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-cancel').style.display = 'none';
    overlay.classList.remove('hidden');
    overlay._resolve = () => {};
    overlay._reject  = () => {};

    document.getElementById('mtx-csv')?.addEventListener('click', () => {
      const csv = [
        this._matrixCSV(Ke, L12, `Ke local — Elemento ${elem.id}`),
        KeC ? this._matrixCSV(KeC, L12, 'Ke condensada (liberaciones)') : '',
        this._matrixCSV(T, L12, 'T transformación'),
        this._matrixCSV(KG, L12, 'K global del elemento'),
        this._matrixCSV(Me, L12, 'Me masa local'),
      ].filter(Boolean).join('\r\n#\r\n');
      this._downloadText(csv, `matrices_elemento_${elem.id}.csv`, 'text/csv;charset=utf-8');
    });
  }

  showGlobalMatrices() {
    if (this.model.nodes.size === 0) { this.toast('Modelo vacío', 'warn'); return; }
    const nodeIndex = buildNodeIndex(this.model);
    const { K, M, nDOF } = assembleK(this.model, nodeIndex);
    const ids = [...this.model.nodes.keys()];
    const sub = ['ux','uy','uz','rx','ry','rz'];
    const labels = [];
    for (const id of ids) for (const s of sub) labels.push(`N${id}.${s}`);

    const toRows = (flat) => Array.from({ length: nDOF }, (_, i) =>
      Array.from({ length: nDOF }, (_, j) => flat[i * nDOF + j]));

    const MAX_SHOW = 120;   // hasta 20 nodos en pantalla; siempre exportable a CSV
    let html = `<p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
      ${this.model.nodes.size} nodos × 6 GDL = <b>${nDOF} GDL</b> (orden: por nodo, [ux uy uz rx ry rz] globales).
      Incluye liberaciones condensadas, resortes y restricciones de diafragma (penalty).</p>`;
    if (nDOF <= MAX_SHOW) {
      html += this._matrixHTML(toRows(K), labels, `K — rigidez GLOBAL (${nDOF}×${nDOF})`);
      html += this._matrixHTML(toRows(M), labels, `M — masa GLOBAL (${nDOF}×${nDOF})`);
    } else {
      html += `<p style="color:var(--warn);font-size:12px">Matriz demasiado grande para mostrar
        (límite ${MAX_SHOW} GDL) — use la exportación CSV.</p>`;
    }
    html += `<button class="btn-secondary" id="gmtx-csv" style="width:100%;margin-top:8px">⬇ Exportar K y M globales a CSV</button>`;

    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-box').classList.add('modal-wide');
    document.getElementById('modal-title').textContent = 'Matrices Globales K y M';
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-cancel').style.display = 'none';
    overlay.classList.remove('hidden');
    overlay._resolve = () => {};
    overlay._reject  = () => {};

    document.getElementById('gmtx-csv')?.addEventListener('click', () => {
      const csv = this._matrixCSV(toRows(K), labels, `K global (${nDOF} GDL)`) +
        '\r\n#\r\n' + this._matrixCSV(toRows(M), labels, `M global (${nDOF} GDL)`);
      this._downloadText(csv, 'matrices_globales.csv', 'text/csv;charset=utf-8');
    });
  }

  // ── Ayuda (F1) ───────────────────────────────────────────────────────────────
  _initHelp() {
    const overlay = document.getElementById('help-overlay');
    if (!overlay) return;
    document.getElementById('help-close')?.addEventListener('click', () => this.closeHelp());
    overlay.addEventListener('click', e => { if (e.target === overlay) this.closeHelp(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) this.closeHelp();
    });
    overlay.querySelectorAll('.help-tab').forEach(btn =>
      btn.addEventListener('click', () => this._switchHelpSec(btn.dataset.hsec)));
  }

  _switchHelpSec(sec) {
    document.querySelectorAll('.help-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.hsec === sec));
    document.querySelectorAll('.help-sec').forEach(s =>
      s.classList.toggle('active', s.id === 'hsec-' + sec));
  }

  openHelp(sec = 'guia') {
    document.getElementById('help-overlay')?.classList.remove('hidden');
    this._switchHelpSec(sec);
    this._renderHelpExamples();
  }

  closeHelp() {
    document.getElementById('help-overlay')?.classList.add('hidden');
  }

  // Lista de ejemplos guiados: lee examples/index.json (el docente la mantiene)
  async _renderHelpExamples() {
    const box = document.getElementById('help-examples-list');
    if (!box) return;
    try {
      const r = await fetch('examples/index.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('sin index');
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) throw new Error('vacío');
      box.innerHTML = '';
      for (const ex of list) {
        const card = document.createElement('div');
        card.className = 'help-excard';
        card.innerHTML = `
          <div class="help-extitle">${ex.titulo || ex.archivo}</div>
          <div class="help-exdesc">${ex.descripcion || ''}</div>
          ${ex.observar ? `<div class="help-exobs">👁 ${ex.observar}</div>` : ''}
          <button class="btn-add help-exopen">Abrir ejemplo</button>`;
        card.querySelector('.help-exopen').addEventListener('click', async () => {
          if (this._dirty) {
            const ok = await this._confirm('¿Descartar los cambios no guardados y abrir el ejemplo?');
            if (!ok) return;
          }
          try {
            const fr = await fetch('examples/' + ex.archivo, { cache: 'no-store' });
            if (!fr.ok) throw new Error('archivo no encontrado');
            this._loadJSON(await fr.text(), ex.archivo);
            this.closeHelp();
            this.toast(`Ejemplo "${ex.titulo || ex.archivo}" cargado`, 'ok');
          } catch (e) {
            this.toast(`No se pudo abrir: ${e.message}`, 'error');
          }
        });
        box.appendChild(card);
      }
    } catch {
      box.innerHTML = `<p class="help-note">Aún no hay ejemplos publicados.
        El docente puede agregarlos siguiendo las instrucciones de más abajo —
        aparecerán aquí automáticamente.</p>`;
    }
  }

  // ── DCL: diagrama de cuerpo libre del elemento (didáctico) ──────────────────
  // Dibuja las fuerzas de extremo que actúan SOBRE el elemento (coords locales)
  // en cada plano de flexión, más la verificación de equilibrio ΣF=0, ΣM=0.
  _dclPlaneSVG({ titulo, V1, V2, M1, M2, q, L, lblV, lblM, lblQ }) {
    const W = 640, H = 210, x1 = 120, x2 = 520, yb = 105;
    const fmt = v => Math.abs(v) >= 1000 ? v.toFixed(0) : String(+v.toPrecision(4));
    const CV = '#38bdf8', CM = '#ce93d8', CQ = '#fbbf24';
    let s = `<svg viewBox="0 0 ${W} ${H}" class="dcl-svg">`;
    s += `<text x="12" y="20" class="dcl-title">${titulo}</text>`;
    // viga + nodos
    s += `<rect x="${x1}" y="${yb - 6}" width="${x2 - x1}" height="12" rx="3" class="dcl-beam"/>`;
    s += `<circle cx="${x1}" cy="${yb}" r="7" class="dcl-node"/><circle cx="${x2}" cy="${yb}" r="7" class="dcl-node"/>`;
    s += `<text x="${x1}" y="${yb + 30}" class="dcl-end">1</text><text x="${x2}" y="${yb + 30}" class="dcl-end">2</text>`;
    s += `<text x="${(x1 + x2) / 2}" y="${yb + 32}" class="dcl-len">L = ${fmt(L)} m</text>`;

    // flecha vertical de corte: positivo = +y local = hacia ARRIBA en pantalla
    const vArrow = (x, val, name) => {
      if (Math.abs(val) < 1e-9) return '';
      const up = val > 0, len = 42;
      const yTip  = up ? yb - 12 : yb + 12;
      const yTail = up ? yTip + len : yTip - len;
      const hd = up ? -8 : 8;
      return `<line x1="${x}" y1="${yTail}" x2="${x}" y2="${yTip + hd}" stroke="${CV}" stroke-width="2.4"/>` +
             `<polygon points="${x - 5},${yTip + hd} ${x + 5},${yTip + hd} ${x},${yTip}" fill="${CV}"/>` +
             `<text x="${x}" y="${up ? yTail + 16 : yTail - 8}" class="dcl-val" fill="${CV}">${name}=${fmt(val)}</text>`;
    };
    // arco de momento: positivo = antihorario (regla de la mano derecha)
    const mArc = (x, val, name) => {
      if (Math.abs(val) < 1e-9) return '';
      const r = 19, ccw = val > 0;
      const sweep = ccw ? 0 : 1;
      const p = a => [x + r * Math.cos(a * Math.PI / 180), yb - r * Math.sin(a * Math.PI / 180)];
      const [sx, sy] = p(ccw ? -50 : 230), [tx2, ty2] = p(ccw ? 230 : -50);
      return `<path d="M ${sx} ${sy} A ${r} ${r} 0 1 ${sweep} ${tx2} ${ty2}" fill="none" stroke="${CM}" stroke-width="2.2"/>` +
             `<circle cx="${tx2}" cy="${ty2}" r="3.4" fill="${CM}"/>` +
             `<text x="${x}" y="${yb - r - 12}" class="dcl-val" fill="${CM}">${name}=${fmt(val)}</text>`;
    };
    // carga distribuida (positivo = +y local = ↑)
    let qs = '';
    if (Math.abs(q) > 1e-9) {
      const up = q > 0, n = 9, yA = up ? yb + 50 : yb - 50, yB = up ? yb + 12 : yb - 12;
      const hd = up ? 6 : -6;
      for (let i = 1; i < n; i++) {
        const x = x1 + 30 + (x2 - x1 - 60) * i / n;
        qs += `<line x1="${x}" y1="${yA}" x2="${x}" y2="${yB + hd}" stroke="${CQ}" stroke-width="1.6"/>` +
              `<polygon points="${x - 4},${yB + hd} ${x + 4},${yB + hd} ${x},${yB}" fill="${CQ}"/>`;
      }
      qs += `<line x1="${x1 + 30}" y1="${yA}" x2="${x2 - 30}" y2="${yA}" stroke="${CQ}" stroke-width="1.6"/>`;
      qs += `<text x="${(x1 + x2) / 2}" y="${up ? yA + 16 : yA - 8}" class="dcl-val" fill="${CQ}">${lblQ}=${fmt(q)} kN/m</text>`;
    }
    // V₂/M₂ con convención de resultados: ef.Vy2 = corte interno en 2; la fuerza
    // SOBRE el elemento en el extremo 2 es −Vy2 (idem momento). Se pasa ya con signo.
    s += qs + vArrow(x1 - 30, V1, name1(lblV)) + vArrow(x2 + 30, V2, name2(lblV));
    s += mArc(x1, M1, name1(lblM)) + mArc(x2, M2, name2(lblM));
    return s + '</svg>';
    function name1(b) { return b + '₁'; }
    function name2(b) { return b + '₂'; }
  }

  showElementDCL(elemId) {
    if (!this._results) { this.toast('Ejecute el análisis primero (F5) para ver el DCL', 'warn'); return; }
    const ef = this._results.getElemForces(elemId);
    if (!ef) { this.toast('Sin resultados para este elemento', 'warn'); return; }
    const elem = this.model.elements.get(elemId);
    const { L, qy, qz } = ef;
    const fmt = v => Math.abs(v) >= 1000 ? v.toFixed(0) : String(+v.toPrecision(4));

    // Vector fe = fuerzas SOBRE el elemento (locales), reconstruido de los resultados
    const fe1 = ef.Vy1, fe7 = -ef.Vy2, fe5 = ef.Mz1, fe11 = -ef.Mz2;
    const fe2 = ef.Vz1, fe8 = -ef.Vz2, fe4 = ef.My1, fe10 = -ef.My2;
    const eq = [
      ['ΣFy (plano x–y)',  fe1 + fe7 + (qy || 0) * L],
      ['ΣMz respecto a 1', fe5 + fe11 + fe7 * L + (qy || 0) * L * L / 2],
      ['ΣFz (plano x–z)',  fe2 + fe8 + (qz || 0) * L],
      ['ΣMy respecto a 1', fe4 + fe10 - fe8 * L - (qz || 0) * L * L / 2],
    ];
    const scale = Math.max(1, ...[fe1, fe5, fe2, fe4].map(Math.abs));
    const eqHTML = eq.map(([n, v]) => {
      const ok = Math.abs(v) < 1e-6 * scale + 1e-9;
      return `<tr><td>${n}</td><td style="text-align:right;font-family:var(--font-mono)">${v.toExponential(2)}</td>
        <td style="color:${ok ? 'var(--success)' : 'var(--danger)'};font-weight:700">${ok ? '✓ ≈ 0' : '✗ ≠ 0'}</td></tr>`;
    }).join('');

    const axial = ef.N > 1e-9 ? `tracción, +${fmt(ef.N)} kN` :
                  ef.N < -1e-9 ? `compresión, ${fmt(ef.N)} kN` : '≈ 0';

    let html = `
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">
        Fuerzas que actúan <b>sobre el elemento</b>, en coordenadas <b>locales</b>.
        Corte positivo = +y/+z local (↑ en el dibujo) · momento positivo = antihorario ⟲.<br>
        <b style="color:var(--success)">N = ${fmt(ef.N)} kN (${axial})</b> &nbsp;·&nbsp;
        <b>T = ${fmt(ef.T)} kN·m (torsión)</b></p>`;
    html += this._dclPlaneSVG({ titulo: 'Plano local x–y · corte Vy y momento Mz',
      V1: ef.Vy1, V2: -ef.Vy2, M1: ef.Mz1, M2: -ef.Mz2, q: qy || 0, L, lblV: 'Vy', lblM: 'Mz', lblQ: 'qy' });
    html += this._dclPlaneSVG({ titulo: 'Plano local x–z · corte Vz y momento My',
      V1: ef.Vz1, V2: -ef.Vz2, M1: ef.My1, M2: -ef.My2, q: qz || 0, L, lblV: 'Vz', lblM: 'My', lblQ: 'qz' });
    html += `<div class="mtx-title">Verificación de equilibrio (ΣF = 0 · ΣM = 0)</div>
      <table class="dcl-eq"><tr><th>Ecuación</th><th>Residuo</th><th>Estado</th></tr>${eqHTML}</table>`;

    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-box').classList.add('modal-wide');
    document.getElementById('modal-title').textContent =
      `DCL — Elemento #${elemId} (nodos ${elem?.n1 ?? '?'}→${elem?.n2 ?? '?'})`;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-cancel').style.display = 'none';
    overlay.classList.remove('hidden');
    overlay._resolve = () => {};
    overlay._reject  = () => {};
  }

  // ── Ejes de grilla (estilo SAP/ETABS) ────────────────────────────────────────
  // Sintaxis: lista separada por comas; cada término es una coordenada o "n@d"
  // (n tramos de largo d desde la última coordenada). Ej: "0, 3@5" → 0,5,10,15
  _parseGridSpec(str) {
    const coords = [];
    let cur = null;
    for (const tok of String(str || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const m = tok.match(/^(\d+)\s*@\s*([\d.]+)$/);
      if (m) {
        const n = +m[1], d = +m[2];
        if (cur === null) { cur = 0; coords.push(0); }
        for (let i = 0; i < n; i++) { cur += d; coords.push(+cur.toFixed(6)); }
      } else {
        const v = parseFloat(tok);
        if (!isNaN(v)) { coords.push(v); cur = v; }
      }
    }
    return [...new Set(coords)].sort((a, b) => a - b);
  }

  async defineGridsDialog() {
    const g = this.model.grids || { x: [], y: [], z: [] };
    const join = arr => (arr || []).join(', ');
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Definir Ejes de Grilla';
    document.getElementById('modal-body').innerHTML = `
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
        Coordenadas separadas por coma, o <b>n@d</b> = n tramos de d metros.<br>
        Ej.: <code>0, 3@5</code> → ejes en 0, 5, 10, 15. Vacío = sin ejes en esa dirección.<br>
        Al insertar nodos, el cursor se ajusta a los ejes cercanos.
      </p>
      <div class="prop-field"><label>Ejes X (A, B, C…) — dirección X global</label>
        <input type="text" id="gr-x" value="${join(g.x)}" placeholder="0, 3@5" style="width:100%"></div>
      <div class="prop-field" style="margin-top:6px"><label>Ejes Y (1, 2, 3…) — dirección Y global</label>
        <input type="text" id="gr-y" value="${join(g.y)}" placeholder="0, 2@6" style="width:100%"></div>
      <div class="prop-field" style="margin-top:6px"><label>Niveles Z (pisos)</label>
        <input type="text" id="gr-z" value="${join(g.z)}" placeholder="0, 4@3" style="width:100%"></div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;
    this.snapshot();
    this.model.grids = {
      x: this._parseGridSpec(document.getElementById('gr-x')?.value),
      y: this._parseGridSpec(document.getElementById('gr-y')?.value),
      z: this._parseGridSpec(document.getElementById('gr-z')?.value),
    };
    this.markDirty();
    this.viewport.refreshGridAxes();
    this.viewport.refreshElevationOptions();   // ejes nuevos → elevaciones disponibles
    const n = this.model.grids.x.length + this.model.grids.y.length + this.model.grids.z.length;
    this.toast(n ? `Ejes definidos: ${this.model.grids.x.length}×X, ${this.model.grids.y.length}×Y, ${this.model.grids.z.length} niveles` : 'Ejes eliminados', 'ok');
  }

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  undo() {
    const prev = this.undoStack.undo(this.serializer.toJSON(this.model));
    if (!prev) { this.toast('Nada que deshacer', 'warn'); return; }
    this.model = this.serializer.fromJSON(prev);
    this.viewport.renderModel(this.model);
    this.panel.showNothing();
    this.panel.refresh(this.model);
    this._updateStats();
    this.toast('Deshecho', '');
  }

  redo() {
    const next = this.undoStack.redo(this.serializer.toJSON(this.model));
    if (!next) { this.toast('Nada que rehacer', 'warn'); return; }
    this.model = this.serializer.fromJSON(next);
    this.viewport.renderModel(this.model);
    this.panel.showNothing();
    this.panel.refresh(this.model);
    this._updateStats();
    this.toast('Rehecho', '');
  }

  // ── Diaphragm CRUD ────────────────────────────────────────────────────────
  autoDetectDiaphragms() {
    if (this.model.nodes.size < 2) {
      this.toast('El modelo no tiene suficientes nodos', 'warn'); return;
    }
    this.snapshot();
    const { diaphragms: created, nodes: newNodes } = autoDetectDiaphragms(this.model);
    if (created.length === 0) {
      this.toast('No se encontraron nuevos pisos (nodos en el mismo nivel Z)', 'warn');
    } else {
      // Add any new virtual master nodes (CR nodes) to the viewport
      for (const n of newNodes) this.viewport.addNodeMesh(n);
      this.viewport.refreshDiaphragms();
      this.markDirty();
      this._updateStats();
      this.panel.refresh(this.model);
      this.panel._switchTab('dia');
      const extra = newNodes.length > 0
        ? ` (${newNodes.length} nodo(s) master creado(s) en CR)`
        : '';
      this.toast(`${created.length} diafragma(s) creado(s) automáticamente${extra}`, 'ok');
    }
  }

  addDiaphragmManual() {
    this.snapshot();
    // Find a floor Z to suggest (highest Z with multiple nodes, not already in a diaphragm)
    const usedZ = new Set([...this.model.diaphragms.values()].map(d => d.z));
    let suggestZ = 3.0;
    if (this.model.nodes.size > 0) {
      const zVals = [...this.model.nodes.values()].map(n => n.z).filter(z => !usedZ.has(z) && z > 0);
      if (zVals.length > 0) suggestZ = Math.max(...zVals);
    }
    const d = this.model.addDiaphragm({
      name: `Piso ${this.model.diaphragms.size + 1}`,
      z: suggestZ,
      nodes: [],
      masterId: null,
      cm: { x: 0, y: 0 },
      mass: { m: 0, Icm: 0 },
      eccentricity: { ex: 0, ey: 0 }
    });
    this.viewport.refreshDiaphragms();
    this.markDirty();
    this.panel.renderDiaphragms();
    this.panel._switchTab('dia');
    this.toast(`Diafragma ${d.id} creado — asigne nodos en el panel`, 'ok');
  }

  // ── Centro de análisis (ventana flotante) ──────────────────────────────────
  // Abierta desde el botón "Análisis" de la barra lateral: reúne TODOS los
  // análisis en un solo lugar con su estado (ejecutado / sin ejecutar) y permite
  // VER resultados ya calculados sin recalcular.
  _tieneEstaticos() { return !!(this._results || (this._resultsByCase && this._resultsByCase.size)); }
  _ensureHubStyles() {
    if (document.getElementById('analysis-hub-style')) return;
    const s = document.createElement('style');
    s.id = 'analysis-hub-style';
    s.textContent = `
      #analysis-hub{position:absolute;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;
        background:rgba(0,0,0,.28);padding-top:54px}
      #analysis-hub .ah-card{width:min(440px,92%);max-height:82%;overflow:auto;background:var(--bg-elev,#141b27);
        border:1px solid var(--border,#334);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);color:var(--text,#e6edf3)}
      #analysis-hub .ah-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;
        border-bottom:1px solid var(--border,#334);font-size:14px;position:sticky;top:0;background:var(--bg-elev,#141b27)}
      #analysis-hub .ah-x{background:none;border:none;color:var(--text-muted,#9aa);cursor:pointer;font-size:14px}
      #analysis-hub .ah-body{padding:8px 12px}
      #analysis-hub .ah-sec{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted,#9aa);
        margin:10px 2px 4px}
      #analysis-hub .ah-row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;align-items:center;
        padding:8px;border:1px solid var(--border,#334);border-radius:7px;margin-bottom:6px}
      #analysis-hub .ah-info{flex:1 1 200px;min-width:0}
      #analysis-hub .ah-name{font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      #analysis-hub .ah-desc{font-size:11px;color:var(--text-muted,#9aa);margin-top:1px}
      #analysis-hub .ah-acts{display:flex;gap:6px;flex:0 0 auto}
      #analysis-hub .ah-extra{flex:1 1 100%;font-size:11px;color:var(--text-muted,#9aa);margin-top:4px;
        display:flex;flex-wrap:wrap;gap:6px;align-items:center}
      #analysis-hub button.ah-run,#analysis-hub button.ah-see{font-size:11px;padding:4px 9px;border-radius:5px;cursor:pointer;
        border:1px solid var(--border,#334);background:var(--bg4,#1e2735);color:var(--text,#e6edf3)}
      #analysis-hub button.ah-run{background:var(--accent,#388bfd);border-color:var(--accent,#388bfd);color:#fff}
      #analysis-hub .ah-badge{font-size:10px;font-weight:500;padding:1px 7px;border-radius:10px}
      #analysis-hub .ah-ok{background:rgba(52,199,89,.18);color:#34c759}
      #analysis-hub .ah-no{background:rgba(150,160,175,.15);color:var(--text-muted,#9aa)}
      #analysis-hub .ah-foot{padding:8px 14px;border-top:1px solid var(--border,#334);font-size:11px;color:var(--text-muted,#9aa)}`;
    document.head.appendChild(s);
  }
  openAnalysisHub() {
    this._ensureHubStyles();
    document.getElementById('analysis-hub')?.remove();
    const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const badge = ok => ok
      ? '<span class="ah-badge ah-ok">✓ resultados</span>'
      : '<span class="ah-badge ah-no">sin ejecutar</span>';
    const espList = [...this._spectrumResults.entries()].map(([k, v]) =>
      `<button class="ah-see" data-see="esp:${esc(k)}">Ver ${esc(k.replace(/^esp/, 'Dir '))}${v?.params?.method ? ' · ' + esc(v.params.method) : ''}</button>`
    ).join('');

    const row = (titulo, desc, runAct, seeOk, extra = '') => `
      <div class="ah-row">
        <div class="ah-info"><div class="ah-name">${titulo} ${badge(seeOk)}</div><div class="ah-desc">${desc}</div></div>
        <div class="ah-acts">
          <button class="ah-run" data-run="${runAct}">Ejecutar…</button>
          ${seeOk ? `<button class="ah-see" data-see="${runAct}">Ver</button>` : ''}
        </div>
        ${extra ? `<div class="ah-extra">${extra}</div>` : ''}
      </div>`;

    const el = document.createElement('div');
    el.id = 'analysis-hub';
    el.innerHTML = `
      <div class="ah-card" role="dialog" aria-label="Centro de análisis">
        <div class="ah-head"><b>Análisis</b><button class="ah-x" title="Cerrar">✕</button></div>
        <div class="ah-body">
          <div class="ah-sec">Lineal</div>
          ${row('Estático', 'Todos los casos y combinaciones', 'run', this._tieneEstaticos())}
          ${row('Modal', 'Frecuencias y formas modales', 'run-modal', !!this._modalResults)}
          ${row('Espectro de respuesta', 'NCh433 · requiere modal', 'run-spectrum', this._spectrumResults.size > 0,
            this._spectrumResults.size ? `Casos espectrales corridos: ${espList}` : '')}
          <div class="ah-sec">Avanzado (NL-lite)</div>
          ${row('No lineal — cables', 'Cables tracción / pretensado', 'run-nonlinear', false)}
          ${row('P-Delta', 'Rigidez geométrica iterativa', 'run-pdelta', false)}
          ${row('Pandeo lineal', 'Factor crítico (autovalores)', 'run-buckling', false)}
          ${row('Form-finding', 'Densidades de fuerza (FDM)', 'run-formfind', false)}
          ${row('Rótulas plásticas', 'Colapso evento a evento', 'run-plastic', false)}
          ${row('Pushover (control δ)', 'Curva carga–desplazamiento', 'run-pushover-dc', false)}
        </div>
        <div class="ah-foot">Tip: "Ver" muestra resultados ya calculados sin volver a correrlos.</div>
      </div>`;
    document.getElementById('viewport-wrap')?.appendChild(el) || document.body.appendChild(el);

    const close = () => el.remove();
    el.querySelector('.ah-x').addEventListener('click', close);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    el.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => {
      close(); this._runByAction(b.dataset.run);
    }));
    el.querySelectorAll('[data-see]').forEach(b => b.addEventListener('click', () => {
      close(); this._verResultados(b.dataset.see);
    }));
  }

  _runByAction(act) {
    ({
      'run': () => this.runAnalysis(), 'run-modal': () => this.runModal(),
      'run-spectrum': () => this.runSpectrum(), 'run-nonlinear': () => this.runNonlinear(),
      'run-pdelta': () => this.runPDelta(), 'run-buckling': () => this.runBuckling(),
      'run-formfind': () => this.runFormFinding(), 'run-plastic': () => this.runPlastic(),
      'run-pushover-dc': () => this.runPushoverDC(),
    }[act] || (() => {}))();
  }

  // Re-muestra resultados YA calculados, sin recalcular.
  _verResultados(key) {
    if (key === 'run') {                       // estáticos
      if (!this._tieneEstaticos()) { this.toast('No hay resultados estáticos', 'warn'); return; }
      this.panel._switchVTab('resultados'); this.panel._switchRTab?.('estatico');
      this._refreshResultView(true); this.panel.renderStaticResults?.();
    } else if (key === 'run-modal') {          // modal
      if (!this._modalResults) { this.toast('No hay resultados modales', 'warn'); return; }
      this._setupModalOverlay?.(); this._refreshModalView?.();
      this.panel._switchVTab('resultados'); this.panel._switchRTab?.('modal'); this.panel.renderModalResults?.();
    } else if (key.startsWith('esp:')) {       // un caso espectral concreto
      const entry = this._spectrumResults.get(key.slice(4));
      if (!entry) { this.toast('Caso espectral no encontrado', 'warn'); return; }
      this._results = entry.result;
      this.panel._switchVTab('resultados'); this.panel._switchRTab?.('estatico');
      this._refreshResultView(true); this.panel.renderStaticResults?.();
    }
  }

  // ── Analysis ──────────────────────────────────────────────────────────────
  // Resuelve TODOS los casos de carga (cada uno con su propio flag de peso
  // propio) y todas las combinaciones por superposición. El resultado mostrado
  // es el del caso/combo seleccionado en el desplegable.
  // force=true ignora la caché y resuelve de nuevo (menú "Recalcular").
  runAnalysis(force = false) {
    if (this.model.nodes.size === 0 || this.model.elements.size === 0) {
      this.toast('El modelo debe tener nodos y elementos', 'warn'); return;
    }
    // P4-14: pre-analysis validation
    const valWarns = this._validateModel();
    const valErrors = valWarns.filter(w => w.startsWith('⛔'));
    if (valErrors.length > 0) { this.toast(valErrors[0], 'error'); return; }
    if (valWarns.length > 0)  { this.toast(`${valWarns[0]}`, 'warn'); }

    const btn = document.getElementById('btn-run');
    if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = 'Analizando…';

    // Slight delay so browser can repaint before heavy computation
    setTimeout(async () => {
      try {
        // ── Auto-discretización (×10) para el análisis ──
        // El modelo original se guarda y se restaura al limpiar resultados.
        const autoDisc = document.getElementById('auto-disc')?.checked;
        if (autoDisc) {
          const nParts = Math.max(2, Math.round(parseFloat(document.getElementById('auto-disc-n')?.value) || 5));
          if (!this._predisc) this._predisc = this.serializer.toJSON(this.model);
          else this.model = this.serializer.fromJSON(this._predisc);  // re-análisis: partir del original
          discretizeAll(this.model, { parts: nParts });
          this.viewport.renderModel(this.model);
        } else if (this._predisc) {
          // estaba auto-discretizado y la casilla se desactivó: restaurar
          this.model = this.serializer.fromJSON(this._predisc);
          this._predisc = null;
          this.viewport.renderModel(this.model);
        }

        // Firma del modelo original (+ auto-disc): identifica unívocamente los
        // resultados. Si coincide con la caché, se reutiliza sin volver a resolver.
        const sig = this._modelSig(autoDisc);
        let reused = false;
        if (!force && this._resultsCache && this._resultsCache.sig === sig) {
          reused = this._reconstructResultsFromCache();
        }

        if (!reused) {
          // Resolver todos los casos ESTÁTICOS (los espectrales se calculan con
          // F6+F7 y conservan su resultado en _resultsByCase si ya corrieron).
          const prevSpec = new Map();
          if (this._resultsByCase) {
            for (const lc of this.model.loadCases.values()) {
              if (lc.type === 'spectrum' && this._resultsByCase.has(lc.id))
                prevSpec.set(lc.id, this._resultsByCase.get(lc.id));
            }
          }
          this._resultsByCase = new Map(prevSpec);
          const staticLcs = [...this.model.loadCases.values()].filter(lc => lc.type !== 'spectrum');
          const cases = [];
          if (staticLcs.length) {
            // Solver en Web Worker (no congela la UI), factorización única + banda.
            const resMap = await this._solveStaticCases(staticLcs);
            for (const lc of staticLcs) {
              const res = resMap.get(lc.id); if (!res) continue;
              this._resultsByCase.set(lc.id, res);
              cases.push({
                key: lc.id, lcId: lc.id, selfWeight: !!lc.selfWeight,
                u: Array.from(res.u), reactions: Array.from(res.reactions),
              });
            }
          }
          if (!cases.length) { this.toast('No hay casos de carga estáticos que analizar', 'warn'); }
          // Combinaciones por superposición de lo ya resuelto
          for (const combo of this.model.combinations.values()) {
            const res = this._combineFromCache(combo);
            if (res) this._resultsByCase.set('C' + combo.id, res);
          }
          this._resultsCache = { sig, autoDisc: !!autoDisc, cases };
          this._persistResults();
        }

        // Mostrar el resultado seleccionado
        const key = this._activeResultKey ?? this._activeLcId;
        this._results = this._resultsByCase.get(key)
                     || this._resultsByCase.get(this._activeLcId)
                     || this._resultsByCase.values().next().value;
        if (!this._results) {
          this.toast('Sin resultados: cree un caso de carga estático o ejecute F6+F7 para los espectrales', 'warn');
          return;
        }

        const sum = this._results.getSummary();
        const nLC = [...this.model.loadCases.values()].filter(l => l.type !== 'spectrum').length;
        const nCB = this.model.combinations.size;
        this.toast(
          (reused ? 'Resultados recuperados (sin recalcular)' : 'Análisis OK') +
          `: ${nLC} caso(s)` +
          (nCB ? ` + ${nCB} combo(s)` : '') +
          ` | δmax=${sum.maxU.toExponential(2)}`, 'ok');

        document.getElementById('result-type').value = 'deformed';
        this._refreshResultView(true);
        this.refreshLoads();
        this.panel._switchVTab('resultados');
        this.panel._switchRTab('estatico');
        this.panel.renderStaticResults();

        // Kick off background diagram pre-computation (shows progress bar)
        this._precomputeDiagramsAsync(this._results);
      } catch (err) {
        if (err.message === 'cancelado') this.toast('Análisis cancelado', 'warn');
        else { this.toast(`Error: ${err.message}`, 'error'); console.error(err); }
      } finally {
        if (btn) btn.classList.remove('running');
        document.getElementById('sb-mode').textContent = 'Modo: Resultados';
      }
    }, 20);
  }

  // Resuelve TODOS los casos estáticos en un Web Worker (no congela la UI),
  // ensamblando K una vez y factorizando una vez (Cholesky en banda con RCM).
  // Si el worker falla o la matriz no es SPD, usa el solver denso de respaldo.
  async _solveStaticCases(staticLcs) {
    const model = this.model;
    const nodeIndex = buildNodeIndex(model);
    const nDOF = nodeIndex.size * 6;

    const is2D = model.mode === '2D';
    const freeDOF = [];
    const freeMap = new Int32Array(nDOF).fill(-1);
    for (const node of model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id);
      const r = node.restraints;
      const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
      d.forEach((gi, li) => { if (!rArr[li]) { freeMap[gi] = freeDOF.length; freeDOF.push(gi); } });
    }
    if (!freeDOF.length) throw new Error('El modelo no tiene grados de libertad libres (¿todos los nodos están empotrados?)');

    const Flist = staticLcs.map(lc => assembleF(model, nodeIndex, lc.id, !!lc.selfWeight));
    const map = new Map();

    // Por defecto: ensamblaje DISPERSO (CSR) → sin matriz densa nDOF². El modo
    // «matriz densa» (académico) usa el ensamblaje denso clásico.
    const dense = !!this._config?.analisis?.matrizDensa;
    let out = null;
    try {
      if (dense) {
        const { K } = assembleK(model, nodeIndex);
        out = await this._staticWorkerSolve(K, nDOF, Int32Array.from(freeDOF), Flist, true);
      } else {
        const { S } = assembleSparseGlobal(model, nodeIndex, { withMass: false });
        const { csr, cf } = extractFreeCSR(S, freeMap, freeDOF.length);
        out = await this._staticWorkerSolveSparse(csr, cf, nDOF, Int32Array.from(freeDOF), Flist);
      }
    }
    catch (e) {
      if (e?.message === 'cancelado') throw e;   // cancelación → abortar, no usar respaldo
      console.warn('Worker estático falló, se usa el solver de respaldo:', e?.message || e); out = null;
    }

    if (out && out.ok) {
      const freeSet = new Set(freeDOF);
      staticLcs.forEach((lc, idx) => {
        const u = out.uList[idx], reactions = out.reactionsList[idx], F = Flist[idx];
        for (const node of model.nodes.values()) {   // reacciones de apoyos elásticos
          const sp = node.springs; if (!sp) continue;
          const ks = [sp.kux, sp.kuy, sp.kuz, sp.krx, sp.kry, sp.krz];
          if (!ks.some(k => k > 0)) continue;
          const d = getNodeDOFs(nodeIndex, node.id);
          for (let i = 0; i < 6; i++) if (ks[i] > 0 && freeSet.has(d[i])) reactions[d[i]] = -ks[i] * u[d[i]];
        }
        map.set(lc.id, new Results(model, nodeIndex, u, reactions, F, lc.id, !!lc.selfWeight));
      });
      return map;
    }

    // ── Respaldo: solver denso original (numeric.js), por caso ──
    const solver = new StaticSolver();
    for (const lc of staticLcs) map.set(lc.id, solver.solve(model, lc.id, !!lc.selfWeight));
    return map;
  }

  // Lanza el worker estático y resuelve con progreso + cancelar.
  _staticWorkerSolve(K, nDOF, freeDOF, Flist, dense = false) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(new URL('./solver/static_worker.js?v=101', import.meta.url), { type: 'module' }); }
      catch (e) { reject(e); return; }
      this._staticWorker = worker;
      const cancelar = () => { try { worker.terminate(); } catch (e) {} this._staticWorker = null; this._hideProgress(); reject(new Error('cancelado')); };
      this._showProgress('Analizando…', 'Resolviendo K·u = F (en segundo plano)', cancelar);
      worker.onmessage = (ev) => {
        const d = ev.data;
        if (d && d.progress) {
          const sub = d.progress === 'factorizando' ? 'Factorizando la matriz de rigidez…'
            : `Resolviendo caso ${d.done}/${d.total}…`;
          this._showProgress('Analizando…', sub, cancelar);
          return;
        }
        try { worker.terminate(); } catch (e) {}
        this._staticWorker = null;
        this._hideProgress();
        resolve(d);
      };
      worker.onerror = (ev) => { try { worker.terminate(); } catch (e) {} this._staticWorker = null; this._hideProgress(); reject(new Error(ev.message || 'error en worker estático')); };
      // K se transfiere (zero-copy); Flist se copia (el main lo necesita para los Results).
      worker.postMessage({ Kflat: K, nDOF, freeDOF, Flist, dense }, [K.buffer, freeDOF.buffer]);
    });
  }

  // Igual que _staticWorkerSolve pero por el camino DISPERSO (CSR): nunca se
  // transfiere la matriz densa, solo los no-ceros.
  _staticWorkerSolveSparse(csr, cf, nDOF, freeDOF, Flist) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(new URL('./solver/static_worker.js?v=101', import.meta.url), { type: 'module' }); }
      catch (e) { reject(e); return; }
      this._staticWorker = worker;
      const cancelar = () => { try { worker.terminate(); } catch (e) {} this._staticWorker = null; this._hideProgress(); reject(new Error('cancelado')); };
      this._showProgress('Analizando…', 'Resolviendo K·u = F (matriz dispersa, en segundo plano)', cancelar);
      worker.onmessage = (ev) => {
        const d = ev.data;
        if (d && d.progress) {
          const sub = d.progress === 'factorizando' ? 'Factorizando la matriz de rigidez (dispersa)…'
            : `Resolviendo caso ${d.done}/${d.total}…`;
          this._showProgress('Analizando…', sub, cancelar);
          return;
        }
        try { worker.terminate(); } catch (e) {}
        this._staticWorker = null;
        this._hideProgress();
        resolve(d);
      };
      worker.onerror = (ev) => { try { worker.terminate(); } catch (e) {} this._staticWorker = null; this._hideProgress(); reject(new Error(ev.message || 'error en worker estático')); };
      // Solo se transfieren los no-ceros (zero-copy); Flist se copia.
      worker.postMessage({ csr, cf, nDOF, freeDOF, Flist }, [
        csr.rowPtr.buffer, csr.colIdx.buffer, csr.val.buffer,
        cf.rowDof.buffer, cf.ptr.buffer, cf.freeIdx.buffer, cf.val.buffer,
        freeDOF.buffer,
      ]);
    });
  }

  // Combina resultados ya resueltos (this._resultsByCase) según los factores
  // del combo. Devuelve un Results o null si ningún factor es resoluble.
  _combineFromCache(combo) {
    let nodeIndex = null, nDOF = 0, cU = null, cR = null;
    const combinedEF = new Map();
    let any = false;

    for (const { lcId, factor } of combo.factors) {
      const f = parseFloat(factor) || 0;
      const isSpectral = typeof lcId === 'string' && lcId.startsWith('esp');

      if (isSpectral) {
        const sr = this._spectrumResults.get(lcId);
        if (!sr) { this.toast(`Combo "${combo.name}": ejecute el espectro "${lcId}" primero`, 'warn'); continue; }
        if (cU && sr.result.U.length !== nDOF) { this.toast(`Combo "${combo.name}": espectro incompatible con el modelo actual`, 'warn'); continue; }
        if (!cU) {
          nodeIndex = sr.result.nodeIndex;
          nDOF = sr.result.U.length;
          cU = new Float64Array(nDOF); cR = new Float64Array(nDOF);
        }
        for (let i = 0; i < nDOF; i++) cU[i] += f * sr.result.U[i];
        any = true;
      } else {
        const numId = typeof lcId === 'number' ? lcId : parseInt(lcId);
        const res = this._resultsByCase?.get(numId);
        if (!res) {
          const lc = this.model.loadCases.get(numId);
          if (lc?.type === 'spectrum')
            this.toast(`Combo "${combo.name}": ejecute F6+F7 para el caso espectral "${lc.name}"`, 'warn');
          continue;
        }

        if (res.U && !res.u) {
          // Caso ESPECTRAL (SpectrumResults): envolvente — se superpone solo
          // el desplazamiento (las fuerzas envolventes no tienen signo único).
          if (cU && res.U.length !== nDOF) { this.toast(`Combo "${combo.name}": espectro incompatible con el modelo actual`, 'warn'); continue; }
          if (!cU) {
            nodeIndex = res.nodeIndex;
            nDOF = res.U.length;
            cU = new Float64Array(nDOF); cR = new Float64Array(nDOF);
          }
          for (let i = 0; i < nDOF; i++) cU[i] += f * res.U[i];
          any = true;
          continue;
        }

        if (!cU) {
          nodeIndex = res.nodeIndex;
          nDOF = res.u.length;
          cU = new Float64Array(nDOF); cR = new Float64Array(nDOF);
        }
        for (let i = 0; i < nDOF; i++) {
          cU[i] += f * res.u[i];
          cR[i] += f * res.reactions[i];
        }
        for (const [eid, ef] of res._elemForces) {
          if (!ef) continue;
          const cur = combinedEF.get(eid);
          if (!cur) combinedEF.set(eid, _scaleEF(ef, f));
          else      _addScaledEF(cur, ef, f);
        }
        any = true;
      }
    }

    if (!any) return null;
    return new Results(this.model, nodeIndex, cU, cR, new Float64Array(nDOF),
                       null, false, combinedEF.size ? combinedEF : null);
  }

  // Pre-computes diagram data for all elements in background chunks so the UI
  // stays responsive and the progress bar advances visibly.
  _precomputeDiagramsAsync(results) {
    // SpectrumResults (envolvente) no tiene pre-cómputo por sub-elementos
    if (!results || typeof results.precomputeChunk !== 'function') return;
    const TYPES    = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'];
    const NPTS     = 20;
    const CHUNK    = 12;   // elements per setTimeout slice
    const elemKeys = [...this.model.elements.keys()];
    const total    = elemKeys.length;
    if (total === 0) return;

    const progressEl = document.getElementById('sb-progress');
    const modeEl     = document.getElementById('sb-mode');
    if (progressEl) { progressEl.value = 0; progressEl.classList.remove('hidden'); }

    let i = 0;
    const tick = () => {
      i = results.precomputeChunk(elemKeys, TYPES, NPTS, i, CHUNK);
      const pct = Math.round(i / total * 100);
      if (progressEl) progressEl.value = pct;
      if (modeEl && i < total) modeEl.textContent = `Diagramas (${i}/${total})…`;

      if (i < total) {
        setTimeout(tick, 0);
      } else {
        if (progressEl) progressEl.classList.add('hidden');
        if (modeEl) modeEl.textContent = 'Modo: Resultados';
        // Refresh force diagram if one is currently displayed
        const type = document.getElementById('result-type')?.value;
        if (type && type !== 'deformed') this._refreshResultView();
      }
    };
    setTimeout(tick, 30);
  }

  _refreshResultView(autoScale = false) {
    if (!this._results) return;
    const type   = document.getElementById('result-type')?.value || 'deformed';
    // factor relativo (1 = auto-normalizado); null fuerza la normalización
    const factor = autoScale ? null : (parseFloat(document.getElementById('result-scale')?.value) || null);

    if (type === 'deformed') {
      this.viewport.showDeformed(this._results, factor);
    } else {
      this.viewport.showForceDiagram(this._results, type, factor);
    }
    // Reacciones: re-dibujar con los valores del resultado mostrado
    if (this._showReactions) this.viewport.showReactions(this._results);
  }

  clearResults() {
    this._results       = null;
    this._resultsByCase = null;
    this._activeResultKey = this._activeLcId;
    this._modalResults = null;
    this._modalPlaying = false;
    this._spectrumResults.clear();
    this.viewport.clearResults();
    // Apagar la visualización de reacciones
    this._showReactions = false;
    this.viewport.clearReactions();
    document.getElementById('btn-show-reactions')?.classList.remove('active');
    // Restaurar el modelo original si el análisis lo auto-discretizó
    if (this._predisc) {
      this.model = this.serializer.fromJSON(this._predisc);
      this._predisc = null;
      this.viewport.renderModel(this.model);
      this._updateStats();
    }
    this._renderLcSelector();
    this.refreshLoads();
    document.getElementById('sb-mode').textContent = 'Modo: Seleccionar';
    document.getElementById('modal-analysis-overlay')?.classList.add('hidden');
    this.panel.showNothing();
  }

  refreshLoads() {
    if (typeof this.viewport.showLoads === 'function') {
      this.viewport.showLoads(this.model, this._activeLcId);
    }
  }

  setResultType(type) {
    if (!this._results && !this._modalResults) return;
    const sel = document.getElementById('result-type');
    if (sel) sel.value = type;
    // Re-normalizar al cambiar de tipo (cada diagrama nace bien dimensionado).
    if (this._results) this._refreshResultView(true);
  }

  exportResults() {
    if (!this._results) { this.toast('No hay resultados — ejecute el análisis primero', 'warn'); return; }
    const csv = this._results.toCSV();
    this._downloadText(csv, 'resultados.csv', 'text/csv;charset=utf-8');
    this.toast('Resultados exportados', 'ok');
  }

  // ── Modal analysis ─────────────────────────────────────────────────────────
  async runModal() {
    if (this.model.nodes.size === 0 || this.model.elements.size === 0) {
      this.toast('El modelo debe tener nodos y elementos', 'warn'); return;
    }
    const hasSupport = [...this.model.nodes.values()]
      .some(n => Object.values(n.restraints).some(v => v) ||
                 (n.springs && Object.values(n.springs).some(k => k > 0)));
    if (!hasSupport) {
      this.toast('El modelo no tiene apoyos', 'warn'); return;
    }
    // Salir del modo resultados (p.ej. deformada estática) antes de correr el
    // modal, para hacerlo "desde afuera" sobre el modelo limpio.
    if (this.viewport._inResultsMode) this.viewport.clearResults();

    // HTML modal instead of native prompt()
    const modalOpts = await this._modalNModesDialog();
    if (!modalOpts) return;
    const { nModes, method: modalMethod } = modalOpts;

    const btn = document.getElementById('btn-run');
    if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = 'Análisis modal…';
    this._showProgress('Analizando…', 'Resolviendo el problema de autovalores K·φ = ω²·M·φ (en segundo plano)');
    await new Promise(r => setTimeout(r, 20));   // deja pintar la caja antes de ensamblar

    try {
      // ── Assemble stiffness / mass on main thread ─────────────────────────────
      const nodeIndex = buildNodeIndex(this.model);
      const { K, M, nDOF } = assembleK(this.model, nodeIndex);

      // Extract free DOFs (en modelos 2D, uy/rx/rz quedan restringidos)
      const is2D = this.model.mode === '2D';
      const freeDOF = [];
      for (const node of this.model.nodes.values()) {
        const d = getNodeDOFs(nodeIndex, node.id);
        const r = node.restraints;
        [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz].forEach((fixed, li) => {
          if (!fixed) freeDOF.push(d[li]);
        });
      }
      if (freeDOF.length === 0) throw new Error('No hay grados de libertad libres.');
      const nF = freeDOF.length;

      // Build Kff / Mff as flat Float64Arrays for zero-copy transfer to worker
      const Kff_flat = new Float64Array(nF * nF);
      const Mff_flat = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) {
        for (let j = 0; j < nF; j++) {
          Kff_flat[i * nF + j] = K[freeDOF[i] * nDOF + freeDOF[j]];
          Mff_flat[i * nF + j] = M[freeDOF[i] * nDOF + freeDOF[j]];
        }
      }

      // ── Run Stodola in a Web Worker (non-blocking) ───────────────────────────
      const denseModal = !!this._config?.analisis?.matrizDensa;
      const modes = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./solver/modal_worker.js?v=101', import.meta.url), { type: 'module' });
        worker.postMessage({ Kff_flat, Mff_flat, nF, nModes, dense: denseModal, method: modalMethod },
          [Kff_flat.buffer, Mff_flat.buffer]); // transfer — zero copy
        worker.onmessage = (ev) => {
          worker.terminate();
          if (ev.data.error) reject(new Error(ev.data.error));
          else               resolve(ev.data.modes);
        };
        worker.onerror = (ev) => {
          worker.terminate();
          reject(new Error(ev.message || 'Error en worker modal'));
        };
      });

      this._modalResults = new ModalResults(this.model, nodeIndex, freeDOF, modes, M, nDOF);
      this._modalMode    = 0;
      this._modalPlaying = false;

      const f1 = this._modalResults.freq[0].toFixed(3);
      const T1 = this._modalResults.period[0].toFixed(3);
      this.toast(
        `Modal OK — ${this._modalResults.nModes} modos | f₁=${f1} Hz | T₁=${T1} s`, 'ok'
      );

      this._setupModalOverlay();
      this._refreshModalView();
      this.panel._switchVTab('resultados');
      this.panel._switchRTab('modal');
      this.panel.renderModalResults();
    } catch (err) {
      this.toast(`Error modal: ${err.message}`, 'error');
      console.error(err);
    } finally {
      if (btn) btn.classList.remove('running');
      this._hideProgress();
      document.getElementById('sb-mode').textContent = 'Modo: Modal';
    }
  }

  /** HTML modal dialog — ask for number of modes (replaces native prompt). */
  _modalNModesDialog() {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = 'Análisis Modal';
      document.getElementById('modal-cancel').style.display = '';
      const lastMethod = this._modalMethod || 'stodola';
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-row">
          <div class="prop-field">
            <label>Número de modos a extraer (1–50)</label>
            <input type="number" id="modal-nmodes" value="10" min="1" max="50" step="1"
              style="width:90px">
          </div>
          <div class="prop-field" style="justify-content:flex-end">
            <span style="color:var(--text-muted);font-size:11px">
              Recomendado:<br>≥ 3 × número de pisos.
            </span>
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <div class="prop-field">
            <label>Método de extracción</label>
            <select id="modal-method" style="width:100%">
              <option value="stodola" ${lastMethod === 'stodola' ? 'selected' : ''}>Iteración inversa (Stodola) — robusto, modo a modo</option>
              <option value="subspace" ${lastMethod === 'subspace' ? 'selected' : ''}>Iteración de subespacio (Bathe) — bloque, rápido con muchos modos</option>
            </select>
          </div>
        </div>`;
      overlay.classList.remove('hidden');
      setTimeout(() => {
        const el = document.getElementById('modal-nmodes');
        el?.focus(); el?.select();
      }, 50);
      overlay._resolve = () => {
        const v = parseInt(document.getElementById('modal-nmodes')?.value) || 10;
        const method = document.getElementById('modal-method')?.value || 'stodola';
        this._modalMethod = method;
        resolve({ nModes: Math.max(1, Math.min(50, v)), method });
      };
      overlay._reject = () => resolve(null);
    });
  }

  /** Generic single-input prompt modal (replaces native prompt). */
  _promptModal(title, label, defaultValue = '') {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-cancel').style.display = '';
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-field">
          <label>${label}</label>
          <input type="text" id="modal-prompt-inp" value="${defaultValue}"
            style="width:100%;margin-top:4px">
        </div>`;
      overlay.classList.remove('hidden');
      setTimeout(() => {
        const el = document.getElementById('modal-prompt-inp');
        el?.focus(); el?.select();
      }, 50);
      overlay._resolve = () => {
        const v = document.getElementById('modal-prompt-inp')?.value?.trim();
        resolve(v || null);
      };
      overlay._reject = () => resolve(null);
    });
  }

  _setupModalOverlay() {
    const mr  = this._modalResults;
    const sel = document.getElementById('modal-mode-select');
    if (!sel) return;

    // Populate mode selector
    sel.innerHTML = '';
    for (let i = 0; i < mr.nModes; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Modo ${i+1}  (${mr.freq[i].toFixed(3)} Hz)`;
      sel.appendChild(opt);
    }
    sel.value = '0';

    // Show overlay
    document.getElementById('modal-analysis-overlay').classList.remove('hidden');
    document.getElementById('results-overlay').classList.add('hidden');
    document.getElementById('btn-clear-results').style.display = '';

    // Bind events (remove old listeners by cloning)
    const bindBtn = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      const fresh = el.cloneNode(true);
      el.parentNode.replaceChild(fresh, el);
      fresh.addEventListener('click', fn);
    };

    // Use property assignment to avoid listener accumulation on repeated runs
    sel.onchange = e => {
      this._modalMode = +e.target.value;
      if (this._modalPlaying) this.viewport.stopAnimation(this._modalAmp());
      this._modalPlaying = false;
      const pb = document.getElementById('modal-play-btn');
      if (pb) { pb.textContent = '▶'; pb.classList.remove('playing'); }
      this._refreshModalView();
    };

    bindBtn('modal-play-btn', () => this._toggleModalAnimation());
    bindBtn('modal-table-btn', () => this._showParticipationTable());
    bindBtn('modal-export-btn', () => this.exportModalResults());

    const ampEl = document.getElementById('modal-amp');
    if (ampEl) ampEl.oninput = () => { if (!this._modalPlaying) this._refreshModalView(); };
  }

  _modalAmp() {
    return Math.max(0.01, parseFloat(document.getElementById('modal-amp')?.value) || 1);
  }

  _refreshModalView() {
    if (!this._modalResults) return;
    const mr   = this._modalResults;
    const mi   = this._modalMode;
    const amp  = this._modalAmp();

    // Auto-scale: amp × (model span / 5)
    const b    = this.model.getBounds();
    const span = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
    const scale = amp * span / 5;

    this.viewport.showModeShape(mr, mi, scale);

    // Update freq / period display
    document.getElementById('modal-freq-val').textContent   = mr.freq[mi].toFixed(4);
    document.getElementById('modal-period-val').textContent = mr.period[mi].toFixed(4);

    // Keep mode selector in sync
    const sel = document.getElementById('modal-mode-select');
    if (sel) sel.value = mi;
  }

  _toggleModalAnimation() {
    if (!this._modalResults) return;
    const btn   = document.getElementById('modal-play-btn');
    const speed = parseFloat(document.getElementById('modal-speed')?.value) || 1;
    const b     = this.model.getBounds();
    const span  = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
    const scale = this._modalAmp() * span / 5;

    if (this._modalPlaying) {
      this.viewport.stopAnimation(scale);
      this._modalPlaying = false;
      if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
    } else {
      this._refreshModalView();
      this.viewport.startModeAnimation(scale, speed);
      this._modalPlaying = true;
      if (btn) { btn.textContent = '⏸'; btn.classList.add('playing'); }
    }
  }

  _showParticipationTable() {
    if (!this._modalResults) return;
    const { rows } = this._modalResults.getParticipation();

    const header = `
      <tr>
        <th style="text-align:center">#</th>
        <th>f (Hz)</th><th>T (s)</th>
        <th>X (%)</th><th>Y (%)</th><th>Rz (%)</th>
        <th>ΣX</th><th>ΣY</th><th>ΣRz</th>
      </tr>`;

    const bodyRows = rows.map(r => {
      const cx = r.cumPct[0], cy = r.cumPct[1], crz = r.cumPct[2];
      const cuOk  = pct => pct >= 90 ? 'cum-ok' : pct >= 70 ? 'cum-warn' : '';
      return `<tr>
        <td>${r.mode}</td>
        <td>${r.freq.toFixed(4)}</td>
        <td>${r.period.toFixed(4)}</td>
        <td>${r.pct[0].toFixed(1)}</td>
        <td>${r.pct[1].toFixed(1)}</td>
        <td>${r.pct[2].toFixed(1)}</td>
        <td class="${cuOk(cx)}">${cx.toFixed(1)}</td>
        <td class="${cuOk(cy)}">${cy.toFixed(1)}</td>
        <td class="${cuOk(crz)}">${crz.toFixed(1)}</td>
      </tr>`;
    }).join('');

    this._alert(
      'Participación de masas modales',
      `<table class="modal-part-table"><thead>${header}</thead><tbody>${bodyRows}</tbody></table>
       <p style="margin-top:8px;font-size:11px;color:var(--text-muted)">
         Verde ≥ 90% — cumple criterio sísmico mínimo de masa participante.</p>`
    );
  }

  exportModalResults() {
    if (!this._modalResults) {
      this.toast('No hay resultados modales — ejecute Análisis Modal primero', 'warn'); return;
    }
    const csv = this._modalResults.toCSV();
    this._downloadText(csv, 'resultados_modales.csv', 'text/csv;charset=utf-8');
    this.toast('Resultados modales exportados', 'ok');
  }

  exportSpectrumResults() {
    if (!this._results?.toCSV || !this._results?.meta) {
      this.toast('No hay resultados espectrales — ejecute Espectro de Respuesta primero', 'warn'); return;
    }
    const csv = this._results.toCSV();
    this._downloadText(csv, 'resultados_espectrales.csv', 'text/csv;charset=utf-8');
    this.toast('Resultados espectrales exportados', 'ok');
  }

  // ── Response spectrum analysis ─────────────────────────────────────────────
  async runSpectrum() {
    if (!this._modalResults) {
      this.toast('Ejecute primero el Análisis Modal (F6)', 'warn'); return;
    }

    // Sin curva precargada: el espectro lo genera el usuario (botón NCh433, ya
    // con T* del modal) o lo escribe. Así nada parece "ya calculado".
    const defaultText = this._lastSpectrum || '';

    const params = await this._spectrumDialog(defaultText);
    if (!params) return;
    this._lastSpectrum = params.rawText;

    const btn = document.getElementById('btn-run');
    if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = 'Espectro…';
    this._showProgress('Analizando…', 'Combinando respuestas modales (espectro de respuesta)');

    setTimeout(() => {
      try {
        const solver  = new SpectrumSolver();
        this._results = solver.solve(this._modalResults, params);

        // Store by direction so combos can reference it (legado [ESP])
        this._spectrumResults.set('esp' + params.direction, { result: this._results, params });

        // ── Asignar el resultado a su CASO DE CARGA espectral ──
        // Si no existe un caso espectral para esta dirección, se crea: así el
        // espectro queda en el sistema de casos (selector, combos, archivo).
        let specLc = [...this.model.loadCases.values()]
          .find(l => l.type === 'spectrum' && l.specDir === params.direction);
        if (!specLc) {
          specLc = this.model.addLoadCase(`Sismo ${params.direction} (esp)`, false, 'spectrum', params.direction);
          this.markDirty();
        }
        specLc.spec = {   // parámetros usados (se guardan en el .s3d)
          method: params.method, zeta: params.zeta,
          saFactor: params.saFactor, rawText: params.rawText,
        };
        this._resultsByCase ??= new Map();
        this._resultsByCase.set(specLc.id, this._results);
        this._activeResultKey = specLc.id;
        this._renderLcSelector();

        const sum = this._results.getSummary();
        const { direction, method } = params;
        this.toast(
          `Espectro ${direction} ${method} → caso "${specLc.name}" | δmax=${sum.maxU.toExponential(3)}`,
          'ok'
        );

        document.getElementById('result-type').value = 'deformed';
        this._refreshResultView(true);
        document.getElementById('result-summary').textContent =
          `Espectro Dir-${direction} (${method}, ζ=${(params.zeta*100).toFixed(0)}%) | δmax=${sum.maxU.toExponential(3)}`;
        document.getElementById('modal-analysis-overlay')?.classList.add('hidden');

        // Show spectral results in sidebar
        this.panel._switchVTab('resultados');
        this.panel._switchRTab('estatico');
        this.panel.renderStaticResults();
        this.panel.renderCombinations(); // refresh combo dropdowns with new spectral case
      } catch (err) {
        this.toast(`Error espectro: ${err.message}`, 'error');
        console.error(err);
      } finally {
        if (btn) btn.classList.remove('running');
        this._hideProgress();
        document.getElementById('sb-mode').textContent = 'Modo: Espectro';
      }
    }, 20);
  }

  // ── Análisis NO LINEAL geométrico (NL-lite, Fase 1) ───────────────────────
  // Trata TODOS los elementos como barras de dos fuerzas (truss); los marcados
  // como «cable» resisten solo tracción. Pretensado por longitud natural L0.
  // Combina todos los casos estáticos a factor 1 (cargas nodales + peso propio +
  // distribuidas concentradas a los nodos extremos). Newton incremental.
  runNonlinear() {
    if (!this._config?.analisis?.nlLite) {
      this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración primero', 'warn');
      this.configDialog?.();
      return;
    }
    if (this.model.nodes.size === 0 || this.model.elements.size === 0) {
      this.toast('Modelo vacío: agregue nodos y elementos', 'warn'); return;
    }

    // Índice de nodos (0-based) y coordenadas de referencia
    const nodeIds = [...this.model.nodes.keys()];
    const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
    const nNode = nodeIds.length;
    const X = new Float64Array(3 * nNode);
    nodeIds.forEach((id, i) => { const n = this.model.nodes.get(id); X[3*i] = n.x; X[3*i+1] = n.y; X[3*i+2] = n.z; });

    // Elementos barra/cable
    const elems = [], elemIds = [];
    for (const el of this.model.elements.values()) {
      const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
      const mat = this.model.materials.get(el.matId), sec = this.model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      const L = Math.hypot(n2.x-n1.x, n2.y-n1.y, n2.z-n1.z);
      if (L < 1e-12) continue;
      const L0 = (el.L0factor || 1) * L;
      elems.push({ n1: idxOf.get(el.n1), n2: idxOf.get(el.n2), EA: mat.E * sec.A, L0, cable: !!el.cable });
      elemIds.push(el.id);
    }
    if (!elems.length) { this.toast('No hay elementos válidos para el análisis no lineal', 'warn'); return; }

    // GDL libres (solo traslaciones; en 2D, uy fijo)
    const is2D = this.model.mode === '2D';
    const free = [];
    nodeIds.forEach((id, i) => {
      const r = this.model.nodes.get(id).restraints;
      const fix = [r.ux, is2D ? 1 : r.uy, r.uz];
      for (let c = 0; c < 3; c++) if (!fix[c]) free.push(3*i + c);
    });
    if (!free.length) { this.toast('Todos los nodos están restringidos (sin GDL libres)', 'warn'); return; }

    // Carga de referencia: combina todos los casos estáticos a factor 1
    const Fref = new Float64Array(3 * nNode);
    const addNode = (id, fx, fy, fz) => { const i = idxOf.get(id); if (i==null) return; Fref[3*i]+=fx; Fref[3*i+1]+=fy; Fref[3*i+2]+=fz; };
    const dirVec = (dir) => dir==='globalX' ? [1,0,0] : dir==='globalY' ? [0,1,0] : dir==='globalZ' ? [0,0,1] : [0,0,-1]; // gravity = −Z
    let nCasos = 0;
    for (const lc of this.model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      nCasos++;
      for (const load of (lc.loads || [])) {
        if (load.type === 'nodal') addNode(load.nodeId, load.F[0]||0, load.F[1]||0, load.F[2]||0);
        else if (load.type === 'dist') {
          const el = this.model.elements.get(load.elemId);
          if (!el) continue;
          const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
          if (!n1 || !n2) continue;
          const L = Math.hypot(n2.x-n1.x, n2.y-n1.y, n2.z-n1.z);
          const half = (load.w || 0) * L / 2;
          const g = dirVec(load.dir || 'gravity');
          addNode(el.n1, half*g[0], half*g[1], half*g[2]);
          addNode(el.n2, half*g[0], half*g[1], half*g[2]);
        }
      }
      if (lc.selfWeight) {   // peso propio concentrado a los nodos (−Z)
        for (const el of this.model.elements.values()) {
          const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
          const mat = this.model.materials.get(el.matId), sec = this.model.sections.get(el.secId);
          if (!n1 || !n2 || !mat || !sec) continue;
          const L = Math.hypot(n2.x-n1.x, n2.y-n1.y, n2.z-n1.z);
          const w = mat.rho * sec.A * L / 2;   // mitad a cada nodo
          addNode(el.n1, 0, 0, -w); addNode(el.n2, 0, 0, -w);
        }
      }
    }

    const nSteps = Math.max(1, Math.min(200, Math.round(parseFloat(this._nlSteps) || 12)));
    let res;
    try {
      res = solveNonlinear({ X, elems, free, Fref, nSteps, maxIter: 60, tol: 1e-8, slack: 1e-6 });
    } catch (e) { this.toast(`Error no lineal: ${e.message}`, 'error'); console.error(e); return; }

    if (!res.steps.length || !res.steps[0]) { this.toast('El análisis no lineal no produjo pasos (¿mecanismo?)', 'error'); return; }
    this._nlResult = { res, X, nodeIds, idxOf, elemIds };
    if (!res.converged) this.toast(`No convergió en el paso ${res.steps.length}/${nSteps} (tangente singular o carga excesiva). Se muestran los pasos logrados.`, 'warn');
    else this.toast(`No lineal OK · ${res.steps.length} pasos · ${nCasos} caso(s) combinados`, 'ok');
    this._nlOpenOverlay();
  }

  // Panel flotante con control paso a paso de la deformada no lineal.
  _nlOpenOverlay() {
    const steps = this._nlResult.res.steps;
    let el = document.getElementById('nl-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nl-overlay';
      el.style.cssText = 'position:fixed;right:16px;bottom:84px;z-index:50;background:var(--panel,#0f1830);border:1px solid var(--border,#26324d);border-radius:8px;padding:10px 12px;width:260px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;color:var(--text,#dbe4f5)';
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:var(--accent,#38bdf8)">Deformada no lineal</b>
        <button id="nl-close" title="Cerrar" style="background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:16px;line-height:1">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <button id="nl-play" class="btn-secondary" style="font-size:14px;padding:2px 8px">▶</button>
        <input type="range" id="nl-step" min="1" max="${steps.length}" value="${steps.length}" style="flex:1">
      </div>
      <div id="nl-readout" style="color:var(--text-muted,#94a3b8);font-size:11px;line-height:1.5;margin-bottom:6px"></div>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="color:var(--text-muted,#94a3b8)">Escala ×</label>
        <input type="number" id="nl-scale" value="1" min="0.05" step="0.25" style="width:64px">
      </div>`;
    const stepInp = el.querySelector('#nl-step');
    const scaleInp = el.querySelector('#nl-scale');
    const playBtn = el.querySelector('#nl-play');
    const redraw = () => this._nlShowStep(+stepInp.value - 1);
    stepInp.addEventListener('input', redraw);
    scaleInp.addEventListener('input', redraw);
    el.querySelector('#nl-close').addEventListener('click', () => { this._nlStopPlay(); el.remove(); this.viewport.clearResults(); });
    playBtn.addEventListener('click', () => {
      if (this._nlPlayTimer) { this._nlStopPlay(); playBtn.textContent = '▶'; return; }
      playBtn.textContent = '⏸';
      this._nlPlayTimer = setInterval(() => {
        let v = +stepInp.value + 1; if (v > steps.length) v = 1;
        stepInp.value = v; redraw();
      }, 350);
    });
    redraw();
  }

  _nlStopPlay() { if (this._nlPlayTimer) { clearInterval(this._nlPlayTimer); this._nlPlayTimer = null; } }

  _nlShowStep(s) {
    const { res, nodeIds, idxOf, elemIds } = this._nlResult;
    const step = res.steps[Math.max(0, Math.min(s, res.steps.length - 1))];
    if (!step) return;
    const uByNode = new Map();
    nodeIds.forEach((id) => { const i = idxOf.get(id); uByNode.set(id, [step.u[3*i], step.u[3*i+1], step.u[3*i+2]]); });
    const elemState = new Map();
    elemIds.forEach((eid, k) => elemState.set(eid, { N: step.N[k], taut: step.taut[k], cable: this.model.elements.get(eid)?.cable }));
    const factor = parseFloat(document.getElementById('nl-scale')?.value) || 1;
    let maxD = 0; for (const u of uByNode.values()) maxD = Math.max(maxD, Math.hypot(u[0], u[1], u[2]));
    this.viewport.showNLDeformed(uByNode, elemState, factor,
      `No lineal · paso ${Math.round(step.lambda * res.steps.length)}/${res.steps.length} · λ=${step.lambda.toFixed(2)} · δmax=${maxD.toExponential(2)} m · ${step.iters} iter`);
    const ro = document.getElementById('nl-readout');
    if (ro) {
      const taut = step.taut.filter(t => t !== false).length;
      const slack = step.taut.length - taut;
      const Nmax = Math.max(0, ...step.N.map(Math.abs));
      ro.innerHTML = `λ = <b>${step.lambda.toFixed(3)}</b> · iter ${step.iters} · resid ${step.resid.toExponential(1)}<br>|N|máx = ${Nmax.toFixed(2)} kN · cables tensos ${taut}${slack ? ` · flojos ${slack}` : ''}`;
    }
  }

  // ── NL-lite Fase 2: rigidez geométrica (P-Delta + pandeo lineal) ──────────
  // Monta el problema geométrico: K densa, GDL libres y la carga estática
  // COMBINADA (todos los casos a factor 1) como carga de referencia.
  _buildGeomProblem() {
    const model = this.model;
    const nodeIndex = buildNodeIndex(model);
    const { K, nDOF } = assembleK(model, nodeIndex);
    const is2D = model.mode === '2D';
    const freeDOF = [];
    for (const node of model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
      const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
      d.forEach((gi, li) => { if (!rArr[li]) freeDOF.push(gi); });
    }
    const F = new Float64Array(nDOF);
    let nCasos = 0;
    for (const lc of model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      const Fi = assembleF(model, nodeIndex, lc.id, !!lc.selfWeight);
      for (let i = 0; i < nDOF; i++) F[i] += Fi[i];
      nCasos++;
    }
    return { nodeIndex, K, nDOF, freeDOF, F, nCasos };
  }

  _maxTransDisp(u) {
    let mx = 0;
    for (const node of this.model.nodes.values()) {
      const d = getNodeDOFs(this._geomNI, node.id);
      mx = Math.max(mx, Math.hypot(u[d[0]], u[d[1]], u[d[2]]));
    }
    return mx;
  }

  // PANDEO lineal por autovalores: (K + λ·Kg)·φ = 0 → λcr y modo de pandeo.
  runBuckling() {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    const num = window.numeric;
    if (!num) { this.toast('numeric.js no disponible', 'error'); return; }
    if (this.model.nodes.size === 0 || this.model.elements.size === 0) { this.toast('Modelo vacío', 'warn'); return; }

    const { nodeIndex, K, nDOF, freeDOF, F, nCasos } = this._buildGeomProblem();
    this._geomNI = nodeIndex;
    if (!freeDOF.length) { this.toast('Sin GDL libres', 'warn'); return; }
    if (!nCasos) { this.toast('Defina al menos un caso de carga: es la carga de referencia del pandeo.', 'warn'); return; }

    const nF = freeDOF.length;
    // Kff y Kgff en formato plano (Float64Array nF×nF)
    const Kff = new Float64Array(nF * nF);
    const Ff = new Float64Array(nF);
    for (let i = 0; i < nF; i++) { Ff[i] = F[freeDOF[i]]; const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff[i * nF + j] = K[ri + freeDOF[j]]; }

    // Estado de referencia: K_ff·u = F_ff (Cholesky densa; sirve para el axial Y
    // para reducir el problema de autovalores).
    const F0 = denseFactor(Kff, nF);
    if (!F0.ok) { this.toast('Estado de referencia singular/inestable (mecanismo). Revise apoyos — p.ej. torsión libre del conjunto.', 'error'); return; }
    const ufA = triBackward(F0, triForward(F0, Ff));   // u_f = K_ff⁻¹·F_ff
    const u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[freeDOF[i]] = ufA[i];

    const { Kg, Nmax } = assembleKg(this.model, nodeIndex, u);
    if (Nmax < 1e-9) { this.toast('La carga de referencia no genera fuerzas axiales (sin efecto de pandeo).', 'warn'); return; }

    // Reducción simétrica del problema (K+λKg)φ=0:
    //   Kff = L·Lᵀ ⇒ A = L⁻¹·(−Kgff)·L⁻ᵀ (simétrica). A·ψ = μ·ψ con μ = 1/λ.
    //   φ = L⁻ᵀ·ψ.  El mayor μ>0 ⇒ el menor λcr>0. eig de matriz SIMÉTRICA = robusto.
    const M = [];   // M[c] = L⁻¹·(−Kg)[:,c]
    for (let c = 0; c < nF; c++) {
      const col = new Float64Array(nF);
      for (let i = 0; i < nF; i++) col[i] = -Kg[freeDOF[i] * nDOF + freeDOF[c]];
      M.push(triForward(F0, col));
    }
    const A = [];   // A[c] = L⁻¹·(fila c de M)   ⇒ A simétrica
    for (let c = 0; c < nF; c++) {
      const rowc = new Float64Array(nF);
      for (let i = 0; i < nF; i++) rowc[i] = M[i][c];
      A.push(triForward(F0, rowc));
    }
    const Asym = Array.from({ length: nF }, (_, i) => Array.from({ length: nF }, (_, j) => A[j][i]));

    let eig;
    try { eig = num.eig(Asym); } catch (e) { this.toast('Falló el cálculo de autovalores de pandeo.', 'error'); console.error(e); return; }
    const mu = eig.lambda.x, muI = eig.lambda.y || [];
    const Ex = eig.E.x;
    const modes = [];
    for (let k = 0; k < mu.length; k++) {
      const re = mu[k], im = muI[k] || 0;
      if (Math.abs(im) > 1e-6 * Math.max(1, Math.abs(re))) continue;   // sin parte imaginaria
      if (re <= 1e-9) continue;                                         // μ>0 ⇒ λ>0 (compresión)
      const lambda = 1 / re;
      const psi = new Float64Array(nF);
      for (let i = 0; i < nF; i++) psi[i] = Ex[i][k];
      const phi = triBackward(F0, psi);                                 // φ = L⁻ᵀ·ψ
      const vec = new Float64Array(nDOF);
      for (let i = 0; i < nF; i++) vec[freeDOF[i]] = phi[i];
      modes.push({ lambda, vec });
    }
    modes.sort((a, b) => a.lambda - b.lambda);
    if (!modes.length) { this.toast('No se hallaron modos de pandeo (la carga de referencia no produce compresión). Revise su sentido.', 'warn'); return; }

    this._buckResult = { modes: modes.slice(0, 6), nCasos };
    this.toast(`Pandeo: λcr = ${modes[0].lambda.toFixed(3)} · carga crítica = λcr × carga de referencia`, 'ok');
    this._buckOpenOverlay();
  }

  _buckOpenOverlay() {
    const modes = this._buckResult.modes;
    let el = document.getElementById('buck-overlay');
    if (!el) { el = document.createElement('div'); el.id = 'buck-overlay'; document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;right:16px;bottom:84px;z-index:50;background:var(--panel,#0f1830);border:1px solid var(--border,#26324d);border-radius:8px;padding:10px 12px;width:268px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;color:var(--text,#dbe4f5)';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:var(--accent,#38bdf8)">Pandeo lineal</b>
        <button id="buck-close" title="Cerrar" style="background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:16px;line-height:1">✕</button>
      </div>
      <div style="margin-bottom:6px">Modo:
        <select id="buck-mode">${modes.map((m, i) => `<option value="${i}">#${i + 1} — λcr = ${m.lambda.toFixed(3)}</option>`).join('')}</select>
      </div>
      <div id="buck-readout" style="color:var(--text-muted,#94a3b8);font-size:11px;line-height:1.5;margin-bottom:6px"></div>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="color:var(--text-muted,#94a3b8)">Escala ×</label>
        <input type="number" id="buck-scale" value="1" min="0.05" step="0.25" style="width:64px">
      </div>`;
    const sel = el.querySelector('#buck-mode'), scl = el.querySelector('#buck-scale');
    const redraw = () => this._buckShowMode(+sel.value);
    sel.addEventListener('change', redraw);
    scl.addEventListener('input', redraw);
    el.querySelector('#buck-close').addEventListener('click', () => { el.remove(); this.viewport.clearResults(); });
    redraw();
  }

  _buckShowMode(k) {
    const m = this._buckResult.modes[k]; if (!m) return;
    const uByNode = new Map();
    for (const node of this.model.nodes.values()) {
      const d = getNodeDOFs(this._geomNI, node.id);
      uByNode.set(node.id, [m.vec[d[0]], m.vec[d[1]], m.vec[d[2]]]);
    }
    const factor = parseFloat(document.getElementById('buck-scale')?.value) || 1;
    this.viewport.showNLDeformed(uByNode, new Map(), factor,
      `Pandeo modo ${k + 1} · factor crítico λcr = ${m.lambda.toFixed(3)} (carga crítica = λcr × carga de referencia)`);
    const ro = document.getElementById('buck-readout');
    if (ro) ro.innerHTML = `λcr = <b>${m.lambda.toFixed(4)}</b><br>Carga de pandeo = ${m.lambda.toFixed(3)} × la carga aplicada combinada.<br>${m.lambda < 1 ? '<b style="color:#f87171">λcr &lt; 1: la estructura pandea bajo la carga actual.</b>' : 'λcr &gt; 1: estable ante pandeo bajo la carga actual.'}`;
  }

  // P-DELTA: resuelve (K + Kg(u))·u = F iterando (frames). Muestra la deformada
  // amplificada y compara δmax lineal vs P-Delta.
  runPDelta() {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    const num = window.numeric;
    if (!num) { this.toast('numeric.js no disponible', 'error'); return; }
    const { nodeIndex, K, nDOF, freeDOF, F, nCasos } = this._buildGeomProblem();
    this._geomNI = nodeIndex;
    if (!freeDOF.length) { this.toast('Sin GDL libres', 'warn'); return; }
    if (!nCasos) { this.toast('Defina al menos un caso de carga.', 'warn'); return; }

    const nF = freeDOF.length;
    const Kff = freeDOF.map(a => freeDOF.map(b => K[a * nDOF + b]));
    const Ff = freeDOF.map(a => F[a]);
    let uf;
    try { uf = num.solve(Kff, Ff); } catch (e) { this.toast('Estado lineal inestable (mecanismo).', 'error'); return; }
    if (!uf || uf.some(v => !isFinite(v))) { this.toast('Estado lineal singular.', 'error'); return; }
    let u = new Float64Array(nDOF); freeDOF.forEach((d, i) => u[d] = uf[i]);
    const dLin = this._maxTransDisp(u);

    let conv = false, it = 0;
    for (it = 0; it < 25; it++) {
      const { Kg } = assembleKg(this.model, nodeIndex, u);
      const KT = freeDOF.map(a => freeDOF.map(b => K[a * nDOF + b] + Kg[a * nDOF + b]));
      let uf2;
      try { uf2 = num.solve(KT, Ff); } catch (e) { this.toast('Tangente singular: la carga iguala o supera la de pandeo (λcr ≤ 1). Reduzca la carga o ejecute Pandeo.', 'error'); return; }
      if (!uf2 || uf2.some(v => !isFinite(v))) { this.toast('Divergió: la carga alcanza la de pandeo.', 'error'); return; }
      const uNew = new Float64Array(nDOF); freeDOF.forEach((d, i) => uNew[d] = uf2[i]);
      let dn = 0, de = 0; for (let i = 0; i < nDOF; i++) { dn += (uNew[i] - u[i]) ** 2; de += uNew[i] ** 2; }
      u = uNew;
      if (de > 0 && Math.sqrt(dn / de) < 1e-6) { conv = true; it++; break; }
    }
    const dPD = this._maxTransDisp(u);
    this._pdResult = { u };
    const amp = dLin > 1e-12 ? dPD / dLin : 1;
    this.toast(`P-Delta: δmax ${dLin.toExponential(2)} → ${dPD.toExponential(2)} m (amplificación ×${amp.toFixed(2)}) · ${conv ? it + ' iter' : 'no convergió'}`, conv ? 'ok' : 'warn');

    const uByNode = new Map();
    for (const node of this.model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id);
      uByNode.set(node.id, [u[d[0]], u[d[1]], u[d[2]]]);
    }
    this.viewport.showNLDeformed(uByNode, new Map(), 1,
      `P-Delta · δmax=${dPD.toExponential(2)} m · amplificación ×${amp.toFixed(2)} vs lineal · ${conv ? it + ' iter' : 'sin converger'}`);
  }

  // ── NL-lite Fase 3: FORM-FINDING por densidades de fuerza (FDM) ───────────
  // Halla la forma de equilibrio de la red de cables/barras y REPOSICIONA los
  // nodos libres a esa geometría (queda como modelo base; Ctrl+Z deshace).
  // Anclas = nodos con alguna restricción de traslación. q = densidad de fuerza.
  async runFormFinding() {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    const model = this.model;
    if (model.nodes.size === 0 || model.elements.size === 0) { this.toast('Modelo vacío', 'warn'); return; }

    const nodeIds = [...model.nodes.keys()];
    const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
    const n = nodeIds.length;
    const coords = new Float64Array(3 * n);
    const fixed = [];
    nodeIds.forEach((id, i) => {
      const nd = model.nodes.get(id);
      coords[3 * i] = nd.x; coords[3 * i + 1] = nd.y; coords[3 * i + 2] = nd.z;
      const r = nd.restraints;
      fixed.push(!!(r.ux || r.uy || r.uz));   // ancla = cualquier restricción de traslación
    });
    if (fixed.filter(Boolean).length < 2) { this.toast('El form-finding necesita ≥ 2 nodos ancla (apoyos). Restrinja algunos nodos.', 'warn'); return; }

    const branches = [];
    for (const el of model.elements.values()) {
      const i = idxOf.get(el.n1), j = idxOf.get(el.n2);
      if (i != null && j != null) branches.push([i, j]);
    }
    if (!branches.length) { this.toast('Sin elementos para formar la red.', 'warn'); return; }

    const qStr = await this._promptModal('Form-finding (densidades de fuerza)',
      'Densidad de fuerza q = N/L [kN/m], uniforme (mayor q → forma más tensa/recta):', '10');
    if (qStr == null) return;
    const q0 = parseFloat(qStr);
    if (!(q0 > 0)) { this.toast('q debe ser un número > 0', 'warn'); return; }
    const q = branches.map(() => q0);

    // Cargas externas combinadas (todos los casos estáticos) sobre nodos libres.
    const loads = nodeIds.map(() => [0, 0, 0]);
    let hasLoad = false;
    const dirVec = d => d === 'globalX' ? [1, 0, 0] : d === 'globalY' ? [0, 1, 0] : d === 'globalZ' ? [0, 0, 1] : [0, 0, -1];
    for (const lc of model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      for (const ld of (lc.loads || [])) {
        if (ld.type === 'nodal') {
          const i = idxOf.get(ld.nodeId);
          if (i != null) { loads[i][0] += ld.F[0] || 0; loads[i][1] += ld.F[1] || 0; loads[i][2] += ld.F[2] || 0; hasLoad = true; }
        } else if (ld.type === 'dist') {
          const el = model.elements.get(ld.elemId); if (!el) continue;
          const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2); if (!n1 || !n2) continue;
          const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
          const half = (ld.w || 0) * L / 2, g = dirVec(ld.dir || 'gravity');
          const a = idxOf.get(el.n1), b = idxOf.get(el.n2);
          if (a != null) for (let c = 0; c < 3; c++) loads[a][c] += half * g[c];
          if (b != null) for (let c = 0; c < 3; c++) loads[b][c] += half * g[c];
          hasLoad = true;
        }
      }
      if (lc.selfWeight) {
        for (const el of model.elements.values()) {
          const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
          const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
          if (!mat || !sec || !n1 || !n2) continue;
          const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
          const wgt = mat.rho * sec.A * L / 2;
          const a = idxOf.get(el.n1), b = idxOf.get(el.n2);
          if (a != null) loads[a][2] -= wgt; if (b != null) loads[b][2] -= wgt;
          hasLoad = true;
        }
      }
    }

    const res = formFind({ coords, fixed, branches, q, loads: hasLoad ? loads : null });
    if (!res.ok) { this.toast('Form-finding: ' + res.note, 'error'); return; }

    // Reposicionar los nodos libres a la geometría de equilibrio (deshacer con Ctrl+Z).
    this.snapshot();
    let moved = 0, dmax = 0;
    for (const i of res.freeIdx) {
      const nd = model.nodes.get(nodeIds[i]);
      const nx = res.coords[3 * i], ny = res.coords[3 * i + 1], nz = res.coords[3 * i + 2];
      dmax = Math.max(dmax, Math.hypot(nx - nd.x, ny - nd.y, nz - nd.z));
      nd.x = nx; nd.y = ny; nd.z = nz; moved++;
    }
    this.viewport.renderModel(model);
    this.viewport.zoomExtents?.();
    this.markDirty();
    this.toast(`Form-finding OK · ${moved} nodos reposicionados (Δmáx ${dmax.toFixed(3)} m) · ${hasLoad ? 'forma funicular bajo carga' : 'red de longitud mínima'}. Geometría de equilibrio guardada (Ctrl+Z deshace).`, 'ok');
  }

  // ── NL-lite Fase 4: material bilineal + RÓTULAS PLÁSTICAS ──────────────────
  // Ensambla K (densa) con las liberaciones actuales (rótulas formadas) y guarda
  // por elemento {ed, T, KeCond} para recuperar los momentos de extremo.
  _plasticAssemble(nodeIndex, releasesByElem) {
    const model = this.model;
    const nDOF = nodeIndex.size * 6;
    const K = new Float64Array(nDOF * nDOF);
    const elems = [];
    for (const el of model.elements.values()) {
      const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
      const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      const { ex, ey, ez, L } = localAxes(n1, n2);
      let Ke = stiffnessMatrix(L, mat, sec);
      const rel = releasesByElem.get(el.id);
      const relBool = rel ? rel.map(r => !!r) : null;
      if (relBool && relBool.some(Boolean)) Ke = applyReleases(Ke, relBool);
      const T = transformMatrix(ex, ey, ez);
      const KG = globalStiffness(Ke, T);
      const ed = [...getNodeDOFs(nodeIndex, el.n1), ...getNodeDOFs(nodeIndex, el.n2)];
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) K[ed[i] * nDOF + ed[j]] += KG[i][j];
      elems.push({ id: el.id, ed, T, KeCond: Ke });
    }
    return { K, nDOF, elems };
  }

  // Análisis incremental EVENTO-A-EVENTO con rótulas plásticas (pushover plástico).
  // Material elasto-perfectamente-plástico: cada extremo forma rótula al alcanzar
  // el momento plástico Mp; se libera ese GDL de giro y su momento queda fijo en
  // Mp. El colapso ocurre cuando se forma un MECANISMO (K singular).
  async runPlastic() {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    const model = this.model;
    if (model.nodes.size === 0 || model.elements.size === 0) { this.toast('Modelo vacío', 'warn'); return; }

    const MpStr = await this._promptModal('Rótulas plásticas (material elasto-plástico)',
      'Momento plástico Mp [kN·m], uniforme (capacidad de cada rótula):', '100');
    if (MpStr == null) return;
    const Mp = parseFloat(MpStr);
    if (!(Mp > 0)) { this.toast('Mp debe ser un número > 0', 'warn'); return; }

    const nodeIndex = buildNodeIndex(model);
    const nDOF = nodeIndex.size * 6;
    const is2D = model.mode === '2D';
    const freeDOF = [];
    for (const node of model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
      const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
      d.forEach((gi, li) => { if (!rArr[li]) freeDOF.push(gi); });
    }
    if (!freeDOF.length) { this.toast('Sin GDL libres', 'warn'); return; }
    const nF = freeDOF.length;

    // Carga de referencia combinada (factor 1)
    const F = new Float64Array(nDOF);
    let nCasos = 0;
    for (const lc of model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      const Fi = assembleF(model, nodeIndex, lc.id, !!lc.selfWeight);
      for (let i = 0; i < nDOF; i++) F[i] += Fi[i];
      nCasos++;
    }
    if (!nCasos) { this.toast('Defina al menos un caso de carga (patrón de carga del pushover).', 'warn'); return; }

    const releasesByElem = new Map();
    for (const el of model.elements.values()) releasesByElem.set(el.id, (el.releases || Array(12).fill(0)).slice());
    const Macc = new Map(), hinged = new Set();
    let lambda = 0; const u = new Float64Array(nDOF);
    const events = []; let collapsed = false;
    const maxEvents = 6 * model.elements.size + 12;

    for (let k = 0; k < maxEvents; k++) {
      const { K, elems } = this._plasticAssemble(nodeIndex, releasesByElem);
      const Kff = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff[i * nF + j] = K[ri + freeDOF[j]]; }
      const fac = makeFactor(Kff, nF, false);
      if (!fac.ok) { collapsed = true; break; }   // mecanismo → colapso

      const Ff = new Float64Array(nF); for (let i = 0; i < nF; i++) Ff[i] = F[freeDOF[i]];
      const uf = fac.solve(Ff);
      const uUnit = new Float64Array(nDOF); for (let i = 0; i < nF; i++) uUnit[freeDOF[i]] = uf[i];

      // Tasa de momento por extremo/eje (no rotulado): m_unit = KeCond·(T·ue)
      const rates = [];
      for (const e of elems) {
        const ue = e.ed.map(d => uUnit[d]);
        const ul = new Array(12).fill(0);
        for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.T[i][j] * ue[j]; ul[i] = s; }
        const fl = new Array(12).fill(0);
        for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.KeCond[i][j] * ul[j]; fl[i] = s; }
        for (const [end, dl, axis] of [[1, 4, 'My'], [1, 5, 'Mz'], [2, 10, 'My'], [2, 11, 'Mz']]) {
          const key = `${e.id}:${end}:${axis}`;
          if (hinged.has(key)) continue;
          rates.push({ key, elemId: e.id, end, axis, dofLocal: dl, mr: fl[dl] });
        }
      }

      // Δλ mínimo para alcanzar ±Mp en algún extremo
      let dlam = Infinity;
      const cand = [];   // {r, dl} candidatos a rotular
      for (const r of rates) {
        if (Math.abs(r.mr) < 1e-9) continue;
        const M0 = Macc.get(r.key) || 0;
        let best = Infinity;
        for (const tgt of [Mp, -Mp]) { const dl = (tgt - M0) / r.mr; if (dl > 1e-9 && dl < best) best = dl; }
        if (isFinite(best)) { cand.push({ r, dl: best }); if (best < dlam) dlam = best; }
      }
      if (!cand.length || !isFinite(dlam)) break;   // no hay más fluencia (carga insuficiente para colapsar)

      lambda += dlam;
      for (const r of rates) Macc.set(r.key, (Macc.get(r.key) || 0) + dlam * r.mr);
      for (let i = 0; i < nDOF; i++) u[i] += dlam * uUnit[i];
      let dctrl = 0;
      for (const node of model.nodes.values()) { const d = getNodeDOFs(nodeIndex, node.id); dctrl = Math.max(dctrl, Math.hypot(u[d[0]], u[d[1]], u[d[2]])); }
      // Rotular TODOS los extremos que alcanzan Mp a la misma carga (casos
      // simétricos/degenerados forman varias rótulas simultáneas).
      const tol = Math.max(1e-9, dlam * 1e-6);
      for (const c of cand) {
        if (c.dl > dlam + tol) continue;
        releasesByElem.get(c.r.elemId)[c.r.dofLocal] = 1;   // insertar rótula
        hinged.add(c.r.key);
        const nd = model.elements.get(c.r.elemId);
        events.push({ lambda, elemId: c.r.elemId, nodeId: c.r.end === 1 ? nd.n1 : nd.n2, axis: c.r.axis, dctrl });
      }
    }

    if (!events.length) { this.toast('Ningún extremo alcanza Mp con esta carga (Mp demasiado alto o carga muy baja).', 'warn'); return; }
    this._plasticResult = { events, lambda, collapsed, u: Float64Array.from(u), nodeIndex, Mp, nCasos };

    // Mostrar mecanismo de colapso (deformada) + secuencia de rótulas
    const uByNode = new Map();
    for (const node of model.nodes.values()) { const d = getNodeDOFs(nodeIndex, node.id); uByNode.set(node.id, [u[d[0]], u[d[1]], u[d[2]]]); }
    this.viewport.showNLDeformed(uByNode, new Map(), 1,
      collapsed ? `Colapso plástico · λc = ${lambda.toFixed(3)} · ${events.length} rótulas · mecanismo` : `Plástico · λ = ${lambda.toFixed(3)} · ${events.length} rótulas (sin mecanismo)`);
    this.toast(collapsed ? `Colapso plástico: λc = ${lambda.toFixed(3)} × carga de referencia · ${events.length} rótulas` : `Plástico: ${events.length} rótulas, sin mecanismo (λ=${lambda.toFixed(3)})`, collapsed ? 'ok' : 'warn');
    this._plasticOpenOverlay();
  }

  _plasticOpenOverlay() {
    const { events, lambda, collapsed, Mp } = this._plasticResult;
    let el = document.getElementById('plastic-overlay');
    if (!el) { el = document.createElement('div'); el.id = 'plastic-overlay'; document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;right:16px;bottom:84px;z-index:50;background:var(--panel,#0f1830);border:1px solid var(--border,#26324d);border-radius:8px;padding:10px 12px;width:280px;max-height:60vh;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;color:var(--text,#dbe4f5)';
    const rows = events.map((e, i) => `<tr><td>${i + 1}</td><td>#${e.elemId}</td><td>${e.nodeId}</td><td>${e.axis}</td><td>${e.lambda.toFixed(3)}</td><td>${e.dctrl.toExponential(1)}</td></tr>`).join('');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:var(--accent,#38bdf8)">Rótulas plásticas</b>
        <button id="plastic-close" title="Cerrar" style="background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:16px;line-height:1">✕</button>
      </div>
      <div style="margin-bottom:6px">${collapsed
        ? `<b style="color:#34d399">Colapso · λc = ${lambda.toFixed(3)}</b><br><span style="color:var(--text-muted,#94a3b8)">Carga de colapso = ${lambda.toFixed(3)} × carga de referencia. Mp = ${Mp} kN·m.</span>`
        : `<b style="color:#fbbf24">Sin mecanismo</b><br><span style="color:var(--text-muted,#94a3b8)">${events.length} rótulas; la carga no completa un mecanismo.</span>`}</div>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px"><thead><tr style="color:var(--text-muted,#94a3b8)">
        <th>#</th><th>Elem</th><th>Nodo</th><th>Eje</th><th>λ</th><th>δctrl</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="color:var(--text-muted,#94a3b8);font-size:10px;margin-top:6px">Secuencia de formación de rótulas (λ = factor de carga). δctrl = desplazamiento máximo (curva carga-desplazamiento).</p>`;
    el.querySelector('#plastic-close').addEventListener('click', () => { el.remove(); this.viewport.clearResults(); });
  }

  // ── NL-lite: arma el problema no lineal (barras/cables) desde el modelo ────
  _buildNLProblem() {
    const model = this.model;
    const nodeIds = [...model.nodes.keys()];
    const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
    const nNode = nodeIds.length;
    const X = new Float64Array(3 * nNode);
    nodeIds.forEach((id, i) => { const n = model.nodes.get(id); X[3 * i] = n.x; X[3 * i + 1] = n.y; X[3 * i + 2] = n.z; });
    const elems = [], elemIds = [];
    for (const el of model.elements.values()) {
      const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
      const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z); if (L < 1e-12) continue;
      elems.push({ n1: idxOf.get(el.n1), n2: idxOf.get(el.n2), EA: mat.E * sec.A, L0: (el.L0factor || 1) * L, cable: !!el.cable });
      elemIds.push(el.id);
    }
    const is2D = model.mode === '2D';
    const free = [];
    nodeIds.forEach((id, i) => { const r = model.nodes.get(id).restraints; const fix = [r.ux, is2D ? 1 : r.uy, r.uz]; for (let c = 0; c < 3; c++) if (!fix[c]) free.push(3 * i + c); });
    const Fref = new Float64Array(3 * nNode); let nCasos = 0;
    const addN = (id, fx, fy, fz) => { const i = idxOf.get(id); if (i == null) return; Fref[3 * i] += fx; Fref[3 * i + 1] += fy; Fref[3 * i + 2] += fz; };
    const dirVec = d => d === 'globalX' ? [1, 0, 0] : d === 'globalY' ? [0, 1, 0] : d === 'globalZ' ? [0, 0, 1] : [0, 0, -1];
    for (const lc of model.loadCases.values()) {
      if (lc.type === 'spectrum') continue; nCasos++;
      for (const ld of (lc.loads || [])) {
        if (ld.type === 'nodal') addN(ld.nodeId, ld.F[0] || 0, ld.F[1] || 0, ld.F[2] || 0);
        else if (ld.type === 'dist') {
          const el = model.elements.get(ld.elemId); if (!el) continue;
          const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2); if (!n1 || !n2) continue;
          const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
          const half = (ld.w || 0) * L / 2, g = dirVec(ld.dir || 'gravity');
          addN(el.n1, half * g[0], half * g[1], half * g[2]); addN(el.n2, half * g[0], half * g[1], half * g[2]);
        }
      }
      if (lc.selfWeight) for (const el of model.elements.values()) {
        const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
        const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
        if (!mat || !sec || !n1 || !n2) continue;
        const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z), w = mat.rho * sec.A * L / 2;
        addN(el.n1, 0, 0, -w); addN(el.n2, 0, 0, -w);
      }
    }
    return { X, elems, elemIds, free, Fref, nodeIds, idxOf, nNode, nCasos };
  }

  // ── NL-lite Fase 5: pushover por CONTROL DE DESPLAZAMIENTO + imperfecciones ─
  // + curva carga–desplazamiento. Traza la trayectoria de equilibrio completa
  // (snap-through / puntos límite). Imperfección inicial opcional para disparar
  // inestabilidades. Trata los elementos como barras/cables (truss).
  async runPushoverDC() {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    const model = this.model;
    if (model.nodes.size === 0 || model.elements.size === 0) { this.toast('Modelo vacío', 'warn'); return; }
    const P = this._buildNLProblem();
    if (!P.free.length) { this.toast('Sin GDL libres', 'warn'); return; }
    if (!P.nCasos) { this.toast('Defina un caso de carga (patrón de referencia).', 'warn'); return; }

    const impStr = await this._promptModal('Pushover — control de desplazamiento',
      'Imperfección inicial (amplitud en m; 0 = perfecta). Se aplica en la forma de la respuesta para disparar inestabilidades:', '0');
    if (impStr == null) return;
    const imp = parseFloat(impStr) || 0;

    // Respuesta lineal (1 paso, 1 iteración desde u=0) → GDL de control + forma de imperfección
    const lin = solveNonlinear({ X: P.X, elems: P.elems, free: P.free, Fref: P.Fref, nSteps: 1, maxIter: 1, tol: 1e-30 });
    const uLin = lin.steps[0]?.u || new Float64Array(P.X.length);
    let cDOF = P.free[0], best = -1;
    for (const d of P.free) { const v = Math.abs(uLin[d]); if (v > best) { best = v; cDOF = d; } }
    if (best < 1e-30) { this.toast('La carga no produce desplazamiento (¿estructura indeformable?).', 'warn'); return; }

    const Ximp = Float64Array.from(P.X);
    if (imp > 0) {
      let nrm = 0; for (const d of P.free) nrm += uLin[d] * uLin[d]; nrm = Math.sqrt(nrm) || 1;
      for (const d of P.free) Ximp[d] += imp * uLin[d] / nrm;
    }
    const linCtrl = uLin[cDOF] || 1e-3;
    const target = linCtrl * 25;   // empuja bien más allá de puntos límite (traza el snap-through completo)
    const res = solveNonlinearDC({ X: Ximp, elems: P.elems, free: P.free, Fref: P.Fref, controlDOF: cDOF, targetDisp: target, nSteps: 60 });
    if (!res.path || res.path.length < 2) { this.toast('Pushover DC: ' + (res.note || 'sin trayectoria'), 'error'); return; }

    this._dcResult = { res, P, cDOF, imp, Ximp };
    let peak = -Infinity, peakD = 0; for (const p of res.path) if (p.lambda > peak) { peak = p.lambda; peakD = p.disp; }
    const ni = Math.floor(cDOF / 3), nodeId = P.nodeIds[ni], axis = 'XYZ'[cDOF % 3];
    this._dcCtrlLabel = `nodo ${nodeId} · ${axis}`;
    this.toast(`${res.ok ? 'Pushover DC OK' : res.note} · pico λ=${peak.toFixed(3)} (carga límite) · control ${this._dcCtrlLabel}${imp ? ` · imperfección ${imp} m` : ''}`, res.ok ? 'ok' : 'warn');
    this._dcOpenOverlay();
  }

  _dcOpenOverlay() {
    const { res } = this._dcResult;
    const path = res.path;
    // curva λ vs desplazamiento de control (SVG)
    const W = 256, H = 120, ml = 4, mr = 4, mt = 6, mb = 4;
    const ds = path.map(p => p.disp), ls = path.map(p => p.lambda);
    const dmin = Math.min(...ds), dmax = Math.max(...ds), lmin = Math.min(...ls, 0), lmax = Math.max(...ls, 0);
    const sx = d => ml + (W - ml - mr) * (Math.abs(dmax - dmin) < 1e-30 ? 0.5 : (d - dmin) / (dmax - dmin));
    const sy = l => mt + (H - mt - mb) * (1 - (Math.abs(lmax - lmin) < 1e-30 ? 0.5 : (l - lmin) / (lmax - lmin)));
    const poly = path.map(p => `${sx(p.disp).toFixed(1)},${sy(p.lambda).toFixed(1)}`).join(' ');
    const y0 = sy(0).toFixed(1);
    this._dcSVG = (k) => `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:var(--bg3,#0b1220);border-radius:6px">
      <line x1="${ml}" y1="${y0}" x2="${W - mr}" y2="${y0}" stroke="var(--border,#26324d)" stroke-width="1"/>
      <polyline points="${poly}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="1.5"/>
      <circle cx="${sx(path[k].disp).toFixed(1)}" cy="${sy(path[k].lambda).toFixed(1)}" r="3.5" fill="#f59e0b"/>
    </svg>`;
    let el = document.getElementById('dc-overlay');
    if (!el) { el = document.createElement('div'); el.id = 'dc-overlay'; document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;right:16px;bottom:84px;z-index:50;background:var(--panel,#0f1830);border:1px solid var(--border,#26324d);border-radius:8px;padding:10px 12px;width:288px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;color:var(--text,#dbe4f5)';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:var(--accent,#38bdf8)">Curva carga–desplazamiento</b>
        <button id="dc-close" title="Cerrar" style="background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:16px;line-height:1">✕</button>
      </div>
      <div id="dc-plot"></div>
      <div style="display:flex;align-items:center;gap:6px;margin:6px 0">
        <button id="dc-play" class="btn-secondary" style="font-size:14px;padding:2px 8px">▶</button>
        <input type="range" id="dc-step" min="0" max="${path.length - 1}" value="${path.length - 1}" style="flex:1">
      </div>
      <div id="dc-readout" style="color:var(--text-muted,#94a3b8);font-size:11px;line-height:1.5"></div>`;
    const stepInp = el.querySelector('#dc-step'), playBtn = el.querySelector('#dc-play');
    const redraw = () => this._dcShowStep(+stepInp.value);
    stepInp.addEventListener('input', redraw);
    el.querySelector('#dc-close').addEventListener('click', () => { this._dcStopPlay(); el.remove(); this.viewport.clearResults(); });
    playBtn.addEventListener('click', () => {
      if (this._dcPlayTimer) { this._dcStopPlay(); playBtn.textContent = '▶'; return; }
      playBtn.textContent = '⏸';
      this._dcPlayTimer = setInterval(() => { let v = +stepInp.value + 1; if (v > path.length - 1) v = 0; stepInp.value = v; redraw(); }, 120);
    });
    redraw();
  }

  _dcStopPlay() { if (this._dcPlayTimer) { clearInterval(this._dcPlayTimer); this._dcPlayTimer = null; } }

  _dcShowStep(k) {
    const { res, P } = this._dcResult;
    const p = res.path[Math.max(0, Math.min(k, res.path.length - 1))]; if (!p) return;
    const uByNode = new Map(), elemState = new Map();
    P.nodeIds.forEach((id, i) => uByNode.set(id, [p.u[3 * i], p.u[3 * i + 1], p.u[3 * i + 2]]));
    P.elemIds.forEach((eid, j) => elemState.set(eid, { N: p.N[j], cable: this.model.elements.get(eid)?.cable, taut: !(this.model.elements.get(eid)?.cable) || p.N[j] >= 0 }));
    this.viewport.showNLDeformed(uByNode, elemState, 1,
      `Pushover DC · λ=${p.lambda.toFixed(3)} · δ(${this._dcCtrlLabel})=${p.disp.toExponential(2)} m`);
    const plot = document.getElementById('dc-plot'); if (plot) plot.innerHTML = this._dcSVG(k);
    const ro = document.getElementById('dc-readout');
    if (ro) ro.innerHTML = `λ = <b>${p.lambda.toFixed(4)}</b> (× carga de referencia)<br>δ control (${this._dcCtrlLabel}) = ${p.disp.toExponential(3)} m<br>punto ${k + 1}/${res.path.length}`;
  }

  _spectrumDialog(defaultText) {
    const is2D = this.model.mode === '2D';
    // Preseleccionar la dirección del caso espectral activo (si lo hay)
    const activeLc = this.model.loadCases.get(this._activeLcId);
    const prefDir = activeLc?.type === 'spectrum' ? activeLc.specDir : 'X';
    // Prefill: si el caso espectral activo ya tiene un espectro guardado en el
    // .s3d (lc.spec.rawText), se reutiliza para no perder lo definido.
    const savedText = activeLc?.type === 'spectrum' ? activeLc.spec?.rawText : null;
    const initialText = savedText || defaultText;
    // T* fundamental sugerido desde el análisis modal (si está disponible)
    const Tstar0 = this._modalResults?.period?.[0]
      ? this._modalResults.period[0].toFixed(3) : '';
    // Selector de período: lista de modos del análisis modal o valor arbitrario.
    const periodos = this._modalResults?.period || [];
    const tmodeSelect = periodos.length
      ? `<select id="sp-Tmode" style="width:100%;margin-bottom:3px">
          <option value="__arb">Período arbitrario (escribir ↓)</option>
          ${periodos.slice(0, 20).map((T, i) => `<option value="${(+T).toFixed(4)}" ${i === 0 ? 'selected' : ''}>Modo ${i + 1} — T = ${(+T).toFixed(3)} s</option>`).join('')}
         </select>` : '';

    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = 'Espectro de Respuesta';
      document.getElementById('modal-cancel').style.display = '';

      document.getElementById('modal-body').innerHTML = `
<div class="prop-row cols3" style="margin-bottom:10px">
  <div class="prop-field">
    <label>Dirección sísmica</label>
    <select id="sp-dir">
      <option value="X" ${prefDir !== 'Y' ? 'selected' : ''}>X  (E–O)</option>
      ${is2D ? '' : `<option value="Y" ${prefDir === 'Y' ? 'selected' : ''}>Y  (N–S)</option>`}
    </select>
  </div>
  <div class="prop-field">
    <label>Combinación</label>
    <select id="sp-method">
      <option value="CQC">CQC (recomendado)</option>
      <option value="SRSS">SRSS</option>
    </select>
  </div>
  <div class="prop-field">
    <label>Amortiguamiento ζ</label>
    <input type="number" id="sp-zeta" value="0.05" step="0.01" min="0.01" max="0.5">
  </div>
</div>

<fieldset style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:10px">
  <legend style="padding:0 6px;color:var(--accent);font-size:12px">Construir espectro NCh433 / DS61</legend>
  <div class="prop-row cols3" style="margin-bottom:8px">
    <div class="prop-field"><label>Zona sísmica (Ao)</label>
      <select id="sp-zona"><option value="1">1 (0.20 g)</option><option value="2" selected>2 (0.30 g)</option><option value="3">3 (0.40 g)</option></select>
    </div>
    <div class="prop-field"><label>Tipo de suelo</label>
      <select id="sp-suelo"><option>A</option><option>B</option><option>C</option><option selected>D</option><option>E</option></select>
    </div>
    <div class="prop-field"><label>Categoría (I)</label>
      <select id="sp-cat"><option value="I">I (0.6)</option><option value="II" selected>II (1.0)</option><option value="III">III (1.2)</option><option value="IV">IV (1.2)</option></select>
    </div>
  </div>
  <div class="prop-row cols3" style="margin-bottom:8px">
    <div class="prop-field"><label>Ro</label><input type="number" id="sp-Ro" value="11" step="0.5" min="1"></div>
    <div class="prop-field"><label>T* (s) — período fundamental</label>${tmodeSelect}<input type="number" id="sp-Tstar" value="${Tstar0}" step="0.01" min="0" placeholder="período en s"></div>
    <div class="prop-field"><label>&nbsp;</label><button type="button" id="sp-gen" class="btn" style="width:100%">Generar curva</button></div>
  </div>
  <small id="sp-rstar" style="color:var(--text-muted);display:block">Sa(T)=S·Ao·I·α(T)/R*. Si T* está vacío, R*=1 (espectro elástico).</small>
</fieldset>

<div class="prop-row" style="margin-bottom:10px">
  <div class="prop-field">
    <label>Unidades de Sa</label>
    <select id="sp-unit">
      <option value="9.81">g  (×9.81 → m/s²)</option>
      <option value="1">m/s²</option>
      <option value="0.01">cm/s²</option>
      <option value="0.3048">ft/s²</option>
    </select>
  </div>
</div>
<div class="prop-field">
  <label>Espectro — T (s), Sa   (una pareja por línea)</label>
  <textarea id="sp-spectrum" rows="7" class="sp-textarea" placeholder="Aún sin espectro. Use «Generar curva» (NCh433) o pegue sus pares T, Sa.">${initialText}</textarea>
</div>
<div class="prop-field" style="margin-top:8px">
  <label>Curva Sa(T) <span style="color:var(--text-muted);font-weight:400">(se dibuja desde los datos de arriba)</span></label>
  <svg id="sp-graph" viewBox="0 0 420 200" style="width:100%;height:170px;background:var(--bg-elev,#1b1b1b);border:1px solid var(--border);border-radius:6px"></svg>
</div>`;

      // ── Tablas NCh433/DS61 (mismas que asistente/reglas.json) ──────────────
      const SUELOS = { A:{S:0.9,To:0.15,p:2.0}, B:{S:1.0,To:0.30,p:1.5}, C:{S:1.05,To:0.40,p:1.6}, D:{S:1.2,To:0.75,p:1.0}, E:{S:1.3,To:1.2,p:1.0} };
      const AO = { '1':0.20, '2':0.30, '3':0.40 };
      const CAT = { I:0.6, II:1.0, III:1.2, IV:1.2 };

      const $ = (id) => document.getElementById(id);

      const drawGraph = () => {
        const pts = _parseSpectrum($('sp-spectrum').value); // [{T,Sa},...]
        const svg = $('sp-graph');
        const W = 420, H = 200, ml = 38, mr = 8, mt = 12, mb = 24;
        if (pts.length < 2) { svg.innerHTML = `<text x="${W/2}" y="${H/2}" fill="#888" font-size="11" text-anchor="middle">Sin curva — genérela o ingrésela arriba</text>`; return; }
        const Tmax = Math.max(...pts.map(p => p.T)) || 1;
        const Samax = Math.max(...pts.map(p => p.Sa)) || 1;
        const sx = (t) => ml + (t / Tmax) * (W - ml - mr);
        const sy = (s) => H - mb - (s / Samax) * (H - mt - mb);
        const poly = pts.map(p => `${sx(p.T).toFixed(1)},${sy(p.Sa).toFixed(1)}`).join(' ');
        const gx = [0, 0.25, 0.5, 0.75, 1].map(f => { const t = +(f*Tmax).toFixed(2); return `<line x1="${sx(t)}" y1="${mt}" x2="${sx(t)}" y2="${H-mb}" stroke="#333"/><text x="${sx(t)}" y="${H-8}" fill="#888" font-size="9" text-anchor="middle">${t}</text>`; }).join('');
        const gy = [0, 0.5, 1].map(f => { const s = +(f*Samax).toFixed(3); return `<line x1="${ml}" y1="${sy(s)}" x2="${W-mr}" y2="${sy(s)}" stroke="#333"/><text x="${ml-4}" y="${sy(s)+3}" fill="#888" font-size="9" text-anchor="end">${s}</text>`; }).join('');
        svg.innerHTML = `${gy}${gx}<polyline points="${poly}" fill="none" stroke="var(--accent,#4ea1ff)" stroke-width="2"/><text x="${W-mr}" y="${mt+2}" fill="#888" font-size="9" text-anchor="end">Sa  ·  T (s)</text>`;
      };

      const genNCh433 = () => {
        const su = SUELOS[$('sp-suelo').value]; const Ao = AO[$('sp-zona').value]; const I = CAT[$('sp-cat').value];
        const Ro = parseFloat($('sp-Ro').value) || 11; const Tstar = parseFloat($('sp-Tstar').value);
        const Rstar = (Tstar > 0) ? 1 + Tstar / (0.10 * su.To + Tstar / Ro) : 1;
        const alpha = (T) => (1 + 4.5 * Math.pow(T / su.To, su.p)) / (1 + Math.pow(T / su.To, 3));
        const lines = [];
        for (let T = 0; T <= 3.0001; T += 0.05) {
          const Tr = +T.toFixed(2);
          lines.push(`${Tr.toFixed(2)}, ${(su.S * Ao * I * alpha(Tr) / Rstar).toFixed(4)}`);
        }
        $('sp-spectrum').value = lines.join('\n');
        $('sp-unit').value = '9.81';
        $('sp-rstar').textContent = `R* = ${Rstar.toFixed(4)} (To=${su.To}, Ro=${Ro}${Tstar>0?`, T*=${Tstar}`:''}). Sa(0)=${(su.S*Ao*I/Rstar).toFixed(4)} g.`;
        drawGraph();
      };

      $('sp-gen').addEventListener('click', genNCh433);
      $('sp-spectrum').addEventListener('input', drawGraph);
      // Selector de período (modo del análisis modal → rellena T*)
      $('sp-Tmode')?.addEventListener('change', (e) => {
        const v = e.target.value;
        if (v && v !== '__arb') { $('sp-Tstar').value = v; if ($('sp-spectrum').value.trim()) genNCh433(); }
      });
      drawGraph();

      overlay.classList.remove('hidden');

      overlay._resolve = () => {
        const dir     = $('sp-dir').value;
        const method  = $('sp-method').value;
        const zeta    = parseFloat($('sp-zeta').value) || 0.05;
        const factor  = parseFloat($('sp-unit').value) || 9.81;
        const rawText = $('sp-spectrum').value;
        const spectrum = _parseSpectrum(rawText);
        if (spectrum.length < 2) {
          this.toast('El espectro necesita al menos 2 puntos (T,Sa)', 'error');
          resolve(null); return;
        }
        // Parámetros NCh433/DS61 con que se construyó la curva (para la memoria de cálculo).
        const su = SUELOS[$('sp-suelo').value];
        const TstarV = parseFloat($('sp-Tstar').value);
        const RoV = parseFloat($('sp-Ro').value) || 11;
        const RstarV = (TstarV > 0) ? 1 + TstarV / (0.10 * su.To + TstarV / RoV) : 1;
        const nch433 = {
          zona: $('sp-zona').value, suelo: $('sp-suelo').value, cat: $('sp-cat').value,
          Ao: AO[$('sp-zona').value], I: CAT[$('sp-cat').value],
          S: su.S, To: su.To, p: su.p, Ro: RoV,
          Tstar: TstarV > 0 ? TstarV : null, Rstar: RstarV,
          unidadSa: $('sp-unit').options[$('sp-unit').selectedIndex]?.text || '',
        };
        resolve({ spectrum, saFactor: factor, direction: dir, zeta, method, rawText, nch433 });
      };
      overlay._reject = () => resolve(null);
    });
  }

  // ── P1-2: Refresh stale CR values after loading a .s3d file ──────────────
  _refreshDiaphragmCRs() {
    for (const d of this.model.diaphragms.values()) {
      const nodeIds = d.nodes.filter(id => this.model.nodes.has(id));
      if (nodeIds.length < 2) continue;
      const floorNodeSet = new Set(nodeIds);
      const cr = computeFloorCR(this.model, floorNodeSet, d.z);
      if (!cr) continue;
      d.cr = cr;

      // Update masterId if the saved one is at the wrong position
      const CTOL = 0.05;
      const existingMaster = this.model.nodes.get(d.masterId);
      const masterMisplaced = !existingMaster
        || Math.abs(existingMaster.x - cr.x) > CTOL
        || Math.abs(existingMaster.y - cr.y) > CTOL;
      if (masterMisplaced) {
        const match = nodeIds
          .map(id => this.model.nodes.get(id))
          .find(n => n && Math.abs(n.x - cr.x) < CTOL && Math.abs(n.y - cr.y) < CTOL);
        if (match) d.masterId = match.id;
      }
    }
  }

  // ── P4-14: Pre-analysis model validation ──────────────────────────────────
  _validateModel() {
    const warnings = [];
    const model = this.model;

    // Nodes without connected elements
    // (diaphragm master/CR nodes are constraint-only — not structural elements)
    const connectedNodes = new Set();
    for (const e of model.elements.values()) {
      connectedNodes.add(e.n1); connectedNodes.add(e.n2);
    }
    const diaphragmMasters = new Set(
      [...model.diaphragms.values()].map(d => d.masterId).filter(id => id != null)
    );
    const floating = [...model.nodes.keys()].filter(
      id => !connectedNodes.has(id) && !diaphragmMasters.has(id)
    );
    if (floating.length > 0) {
      const list = floating.slice(0, 5).join(', ') + (floating.length > 5 ? '…' : '');
      warnings.push(`⚠ ${floating.length} nodo(s) sin elementos: [${list}]`);
    }

    // No supports
    const hasSupport = [...model.nodes.values()]
      .some(n => Object.values(n.restraints).some(v => v) ||
                 (n.springs && Object.values(n.springs).some(k => k > 0)));
    if (!hasSupport) warnings.push('⛔ No hay apoyos — el modelo es inestable');

    return warnings;
  }

  // ── Load case management ───────────────────────────────────────────────────
  _initLoadCaseUI() {
    this._activeLcId = ensureDefaultLC(this.model);
    this._activeResultKey = this._activeLcId;
    this._renderLcSelector();

    document.getElementById('lc-select')?.addEventListener('change', e => {
      const v = e.target.value;
      if (v.startsWith('C')) {
        // Combinación: mostrarla (del caché si existe; si no, analiza todo)
        this.runCombination(parseInt(v.slice(1)));
      } else {
        this._activeLcId = +v;
        this._activeResultKey = +v;
        if (this._resultsByCase?.has(+v)) {
          // Ya resuelto en el análisis completo — cambio instantáneo
          this._results = this._resultsByCase.get(+v);
          this._refreshResultView(true);
          this.refreshLoads();
          this.panel.renderStaticResults();
          this._precomputeDiagramsAsync(this._results);
        } else if (this._results) {
          this.runAnalysis();
        } else {
          this.refreshLoads();
        }
      }
    });

    document.getElementById('btn-add-lc')?.addEventListener('click', () => this.newCaseDialog());
    document.getElementById('btn-edit-lc')?.addEventListener('click', () => this.editCaseDialog());
    document.getElementById('btn-toggle-loads')?.addEventListener('click', () => {
      const vis = this.viewport.toggleLoads();
      const btn = document.getElementById('btn-toggle-loads');
      if (btn) { btn.style.color = vis ? 'var(--success)' : 'var(--text-muted)'; btn.textContent = vis ? '⬇ cargas' : '⬇ cargas (off)'; }
    });
  }

  // Diálogo "+": crear caso de carga (con opción de peso propio) o combinación
  async newCaseDialog() {
    const overlay = document.getElementById('modal-overlay');
    const is2D = this.model.mode === '2D';
    document.getElementById('modal-title').textContent = 'Nuevo Caso / Combinación';
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-row">
        <div class="prop-field"><label>Tipo</label>
          <select id="nc-type">
            <option value="case">Caso de carga estático</option>
            <option value="spectrum">Caso sísmico — espectro de respuesta</option>
            <option value="combo">Combinación</option>
          </select>
        </div>
        <div class="prop-field"><label>Nombre</label>
          <input type="text" id="nc-name" value="LC${this.model.loadCases.size + 1}">
        </div>
      </div>
      <label id="nc-sw-row" style="display:flex;align-items:center;gap:7px;margin-top:10px;cursor:pointer;font-size:12px;color:var(--text)">
        <input type="checkbox" id="nc-sw" style="accent-color:var(--accent)">
        Incluir peso propio de los elementos en este caso (típico de CM / carga muerta)
      </label>
      <div id="nc-dir-row" style="display:none;margin-top:10px">
        <div class="prop-field"><label>Dirección sísmica</label>
          <select id="nc-dir">
            <option value="X">X (E–O)</option>
            ${is2D ? '' : '<option value="Y">Y (N–S)</option>'}
          </select>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:6px">
          Un caso espectral no admite cargas: se calcula con Análisis Modal (F6)
          + Espectro de Respuesta (F7), y su resultado (envolvente) queda
          asignado a este caso para verlo y combinarlo.</p>
      </div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    // Peso propio solo para casos estáticos; dirección solo para espectrales
    const typeSel = document.getElementById('nc-type');
    typeSel.addEventListener('change', () => {
      const t = typeSel.value;
      document.getElementById('nc-sw-row').style.display  = t === 'case' ? 'flex' : 'none';
      document.getElementById('nc-dir-row').style.display = t === 'spectrum' ? 'block' : 'none';
      const nameInp = document.getElementById('nc-name');
      nameInp.value = t === 'combo'    ? `Combo ${this.model.combinations.size + 1}`
                    : t === 'spectrum' ? `Sismo ${document.getElementById('nc-dir')?.value || 'X'} (esp)`
                    : `LC${this.model.loadCases.size + 1}`;
    });
    document.getElementById('nc-dir')?.addEventListener('change', e => {
      if (typeSel.value === 'spectrum')
        document.getElementById('nc-name').value = `Sismo ${e.target.value} (esp)`;
    });
    setTimeout(() => { const el = document.getElementById('nc-name'); el?.focus(); el?.select(); }, 50);

    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;

    const type = document.getElementById('nc-type')?.value;
    const name = document.getElementById('nc-name')?.value?.trim();
    if (!name) return;
    this.snapshot();
    if (type === 'combo') {
      const combo = this.model.addCombination({ name, factors: [] });
      this.markDirty();
      this._renderLcSelector();
      this.openCombosTab();   // llevar al usuario a definir los factores
      this.toast(`Combinación "${combo.name}" creada — agregue factores`, 'ok');
    } else if (type === 'spectrum') {
      const dir = document.getElementById('nc-dir')?.value === 'Y' ? 'Y' : 'X';
      const lc = this.model.addLoadCase(name, false, 'spectrum', dir);
      this._activeLcId = lc.id;
      this._activeResultKey = lc.id;
      this.markDirty();
      this._renderLcSelector();
      this.refreshLoads();
      this.toast(`Caso espectral "${lc.name}" (dir ${dir}) creado — ejecute F6 (modal) y F7 (espectro)`, 'ok');
    } else {
      const sw = document.getElementById('nc-sw')?.checked || false;
      const lc = this.model.addLoadCase(name, sw);
      this._activeLcId = lc.id;
      this._activeResultKey = lc.id;
      this.markDirty();
      this._renderLcSelector();
      this.refreshLoads();
    }
  }

  // Diálogo ✎: editar el caso de carga activo (nombre, peso propio, eliminar)
  async editCaseDialog() {
    const lc = this.model.loadCases.get(this._activeLcId);
    if (!lc) { this.toast('No hay caso de carga activo', 'warn'); return; }
    const overlay = document.getElementById('modal-overlay');
    const isSpec = lc.type === 'spectrum';
    document.getElementById('modal-title').textContent = `Editar Caso "${lc.name}"`;
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-field"><label>Nombre</label>
        <input type="text" id="ec-name" value="${lc.name}" style="width:100%">
      </div>
      ${isSpec ? `
      <p style="font-size:11.5px;color:var(--teal);margin-top:10px">
        〜 Caso espectral — dirección sísmica <b>${lc.specDir}</b>.
        Se calcula con Análisis Modal (F6) + Espectro (F7); no admite cargas ni peso propio.
      </p>` : `
      <label style="display:flex;align-items:center;gap:7px;margin-top:10px;cursor:pointer;font-size:12px;color:var(--text)">
        <input type="checkbox" id="ec-sw" ${lc.selfWeight ? 'checked' : ''} style="accent-color:var(--accent)">
        Incluir peso propio de los elementos en este caso
      </label>`}
      ${this.model.loadCases.size > 1 ? `
      <button id="ec-del" class="btn-danger" style="width:100%;margin-top:14px">
        Eliminar este caso${isSpec ? '' : ` (y sus ${lc.loads.length} carga(s))`}
      </button>` : ''}`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');

    // Eliminar caso: acción inmediata con confirmación
    document.getElementById('ec-del')?.addEventListener('click', async () => {
      overlay.classList.add('hidden');
      const sure = await this._confirm(`¿Eliminar el caso "${lc.name}" y todas sus cargas?`);
      if (!sure) return;
      this.snapshot();
      this.model.loadCases.delete(lc.id);
      // limpiar factores de combos que lo referencien
      for (const combo of this.model.combinations.values()) {
        combo.factors = combo.factors.filter(f => f.lcId !== lc.id);
      }
      this._activeLcId = this.model.loadCases.keys().next().value;
      this._activeResultKey = this._activeLcId;
      this.markDirty();
      this._renderLcSelector();
      this.refreshLoads();
      this.toast(`Caso "${lc.name}" eliminado`, 'ok');
    });

    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;
    if (!this.model.loadCases.has(lc.id)) return;   // fue eliminado
    this.snapshot();
    lc.name = document.getElementById('ec-name')?.value?.trim() || lc.name;
    lc.selfWeight = document.getElementById('ec-sw')?.checked || false;
    this.markDirty();
    this._renderLcSelector();
    this.toast(`Caso "${lc.name}" actualizado`, 'ok');
  }

  _renderLcSelector() {
    const sel = document.getElementById('lc-select');
    if (!sel) return;
    sel.innerHTML = '';
    const activeKey = this._activeResultKey ?? this._activeLcId;
    for (const lc of this.model.loadCases.values()) {
      const opt = document.createElement('option');
      opt.value = lc.id;
      opt.textContent = lc.type === 'spectrum'
        ? `〜 ${lc.name} [esp ${lc.specDir}]`
        : lc.name + (lc.selfWeight ? ' ⊕PP' : '');
      opt.selected = lc.id === activeKey;
      sel.appendChild(opt);
    }
    if (this.model.combinations.size > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '── Combos ──';
      for (const c of this.model.combinations.values()) {
        const opt = document.createElement('option');
        opt.value = 'C' + c.id;
        opt.textContent = 'Σ ' + c.name;
        opt.selected = ('C' + c.id) === activeKey;
        grp.appendChild(opt);
      }
      sel.appendChild(grp);
    }
  }

  // ── Panel resize handle ────────────────────────────────────────────────────
  _initResizeHandle() {
    const handle = document.getElementById('panel-resize-handle');
    const main   = document.getElementById('main');
    if (!handle || !main) return;
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', e => {
      dragging = true;
      startX = e.clientX;
      startW = document.getElementById('panel').offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const newW = Math.max(220, Math.min(700, startW + (startX - e.clientX)));
      main.style.gridTemplateColumns = `var(--toolbar-w) 1fr 5px ${newW}px`;
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Load combinations ──────────────────────────────────────────────────────
  // Ver una combinación: si el análisis completo ya corrió, muestra el resultado
  // cacheado; si no, ejecuta el análisis completo (que resuelve todo).
  runCombination(comboId) {
    const combo = this.model.combinations.get(comboId);
    if (!combo || combo.factors.length === 0) {
      this.toast('Combinación vacía — agregue al menos un factor', 'warn'); return;
    }
    this._activeResultKey = 'C' + comboId;
    const cached = this._resultsByCase?.get('C' + comboId);
    if (cached) {
      this._results = cached;
      this.toast(`"${combo.name}" | δmax=${cached.getMaxDisp().toExponential(2)}`, 'ok');
      document.getElementById('result-type').value = 'deformed';
      this._refreshResultView(true);
      this.panel._switchVTab('resultados');
      this.panel._switchRTab('estatico');
      this.panel.renderStaticResults();
      this._renderLcSelector();
    } else {
      this.runAnalysis();   // resuelve todos los casos y combos, y muestra éste
    }
  }

  // Abre la pestaña de combinaciones (accesible desde menú Análisis / F8)
  openCombosTab() {
    this.panel._switchVTab('resultados');
    this.panel._switchRTab('combos');
    this.panel.renderCombinations();
  }

  // Crea los casos de carga base (D, L) y las combinaciones de la norma por
  // defecto (NCh3171 / LRFD). Las sísmicas se agregan por dirección si existen
  // casos espectrales (X/Y). Todas son EDITABLES en la pestaña Combos.
  crearCasosYCombosNorma() {
    const m = this.model;
    this.snapshot();
    const findLC = re => [...m.loadCases.values()].find(l => l.type === 'static' && re.test(l.name));
    let D = [...m.loadCases.values()].find(l => l.type === 'static' && l.selfWeight) || findLC(/muerta|dead|peso propio|\bpp\b|\bd\b/i);
    if (!D) D = m.addLoadCase('D — Carga muerta (PP)', true);
    let L = findLC(/viva|sobrecarga|live|uso|\bl\b/i);
    if (!L) L = m.addLoadCase('L — Sobrecarga de uso', false);

    const specs = [...m.loadCases.values()].filter(l => l.type === 'spectrum');
    const ex = specs.find(s => s.specDir === 'X'), ey = specs.find(s => s.specDir === 'Y');

    const combos = [
      { name: '1.4D', f: [[D, 1.4]] },
      { name: '1.2D + 1.6L', f: [[D, 1.2], [L, 1.6]] },
    ];
    const seismic = (E, d) => {
      combos.push({ name: `1.2D + 1.0L + 1.4E${d}`, f: [[D, 1.2], [L, 1.0], [E, 1.4]] });
      combos.push({ name: `1.2D + 1.0L − 1.4E${d}`, f: [[D, 1.2], [L, 1.0], [E, -1.4]] });
      combos.push({ name: `0.9D + 1.4E${d}`, f: [[D, 0.9], [E, 1.4]] });
      combos.push({ name: `0.9D − 1.4E${d}`, f: [[D, 0.9], [E, -1.4]] });
    };
    if (ex) seismic(ex, 'x');
    if (ey) seismic(ey, 'y');

    const exist = new Set([...m.combinations.values()].map(c => c.name));
    let n = 0;
    for (const c of combos) {
      if (exist.has(c.name)) continue;
      m.addCombination({ name: c.name, factors: c.f.map(([lc, factor]) => ({ lcId: lc.id, factor })) });
      n++;
    }
    this.markDirty(); this._updateStats?.(); this.refreshLoads?.();
    this.panel.renderCombinations?.(); this._renderLcSelector?.();
    const note = (ex || ey) ? '' : ' · las sísmicas se añaden al correr el espectro X/Y';
    this.toast(`Norma NCh3171: casos D/L + ${n} combinación(es)${note}`, 'ok');
    this.openCombosTab();
  }

  async runCombinationDialog() {
    if (this.model.combinations.size === 0) {
      this.toast('No hay combinaciones — créelas en la pestaña Combos.', 'warn'); return;
    }
    if (this.model.combinations.size === 1) {
      this.runCombination([...this.model.combinations.keys()][0]); return;
    }
    const opts = [...this.model.combinations.values()]
      .map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Ejecutar Combinación';
    document.getElementById('modal-body').innerHTML =
      `<div class="prop-field"><label>Combinación</label><select id="combo-pick">${opts}</select></div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;
    this.runCombination(+document.getElementById('combo-pick').value);
  }

  // ── File I/O ───────────────────────────────────────────────────────────────
  async newFile() {
    if (this._dirty) {
      const ok = await this._confirm('¿Descartar cambios no guardados y crear un nuevo modelo?');
      if (!ok) return;
    }
    // El modo 2D/3D se elige AL CREAR el modelo y no se cambia después:
    // define cómo se modela (plano vs espacio) y qué GDL participan.
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Nuevo Modelo';
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-field"><label>Tipo de modelo</label>
        <select id="nm-mode" style="width:100%">
          <option value="3D">Estructura 3D (espacial)</option>
          <option value="2D">Pórtico 2D — plano X–Z (vista ortográfica real)</option>
        </select>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">
        <b>2D:</b> se modela en un plano sin profundidad (cámara ortográfica fija);
        los GDL fuera del plano (uy, rx, rz) se restringen automáticamente y el
        análisis es plano. <b>El modo no puede cambiarse después.</b></p>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok2 = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok2) return;
    const mode = document.getElementById('nm-mode')?.value === '2D' ? '2D' : '3D';

    this.model = new Model();
    this.model.mode = mode;
    this.viewport._elevation = null;
    this.undoStack.clear();
    this._fileHandle = null;
    this._filePath   = null;
    this._dirty = false;
    this._results = null;
    this._resultsByCase = null;
    this._discardResultsCache();   // modelo nuevo → resultados previos no aplican
    this._activeLcId = ensureDefaultLC(this.model);
    this._activeResultKey = this._activeLcId;
    this._renderLcSelector();
    this.refreshLoads();
    this.viewport.renderModel(this.model);
    this.viewport.applyProjectMode();
    this.panel.showNothing();
    this._updateStats();
    this._updateTitle();
    this.toast(`Nuevo modelo ${mode} creado`, 'ok');
  }

  async openFile() {
    if (this._dirty) {
      const ok = await this._confirm('¿Descartar cambios no guardados?');
      if (!ok) return;
    }
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.openFile();
        if (!result) return;
        this._filePath   = result.filePath;
        this._fileHandle = null;
        this._loadJSON(result.content, result.filePath.split(/[\\/]/).pop());
      } else if ('showOpenFilePicker' in window) {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'PÓRTICO (.s3d)', accept: { 'application/json': ['.s3d', '.json'] } }]
        });
        const text = await (await handle.getFile()).text();
        this._fileHandle = handle;
        this._filePath   = null;
        this._loadJSON(text, handle.name);
      } else {
        this._fallbackOpen();
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.toast(`Error al abrir: ${err.message}`, 'error');
    }
  }

  _fallbackOpen() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.s3d,.json';
    inp.onchange = async () => {
      const text = await inp.files[0].text();
      this._loadJSON(text, inp.files[0].name);
    };
    inp.click();
  }

  _loadJSON(text, filename, keepResults = false) {
    try {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      this.model = this.serializer.fromJSON(text);
      // Grupos y ocultos guardados en el archivo (estado de vista).
      this._grupos = new Map((parsed && Array.isArray(parsed.grupos) ? parsed.grupos : [])
        .map((g) => [g.name, new Set((g.elems || []).filter((id) => this.model.elements.has(id)))]));
      this.viewport.clearHidden();
      if (parsed && Array.isArray(parsed.ocultos))
        this.viewport._hiddenElems = new Set(parsed.ocultos.filter((id) => this.model.elements.has(id)));
      this.viewport._elevation = null;          // la elevación es por sesión
      this._refreshDiaphragmCRs();   // P1-2: fix stale CR/masterId from saved files
      this.undoStack.clear();
      this._dirty = false;
      this.viewport.renderModel(this.model);
      this.panel.showNothing();
      this.panel.refresh(this.model);
      this._results = null;
      this._resultsByCase = null;
      this._activeLcId = ensureDefaultLC(this.model);
      this._activeResultKey = this._activeLcId;
      // Resultados embebidos en el archivo → adoptarlos (queda "ya corrido").
      // Si no hay, descartar la caché salvo en recuperación de sesión / ejemplo,
      // donde la firma decidirá después si los resultados guardados sirven.
      if (parsed && parsed.results) {
        this._adoptEmbeddedResults(parsed.results);
      } else if (!keepResults) {
        this._discardResultsCache();
      }
      this._renderLcSelector();
      this.refreshLoads();
      this._updateStats();
      this._updateTitle(filename);
      this.viewport.applyProjectMode();   // cámara/insumos según modo 2D/3D
      if (this.model.mode !== '2D') this.viewport.zoomExtents();
      this.toast(`Modelo cargado: ${filename}${this.model.mode === '2D' ? ' (2D)' : ''}`, 'ok');
      // Sync unit selector
      document.getElementById('unit-select').value = this.model.units || 'kN-m';
      document.getElementById('sb-units').textContent = (this.model.units || 'kN-m').replace('-', ' — ');
    } catch (err) {
      this.toast(`Error al cargar archivo: ${err.message}`, 'error');
    }
  }

  // ── Asistente: ficha → generador determinista → modelo ──────────────────
  asistenteDialog() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Asistente — generar modelo desde ficha';
    document.getElementById('modal-box')?.classList.add('modal-wide');
    document.getElementById('modal-cancel').style.display = '';
    const okBtn = document.getElementById('modal-ok');
    okBtn.textContent = 'Generar modelo';

    const ep = localStorage.getItem('portico_n8n_endpoint') || '/api/asistente';
    const plantilla = JSON.stringify({
      proyecto: 'Edificio ejemplo', modo: '3D',
      ubicacion: { ciudad: 'Valdivia', latitud_sur_deg: 39.8, altitud_msnm: 10, exposicion: 'C' },
      geometria: {
        niveles: [
          { altura_m: 3, uso_NCh1537: 'Salas de Clases' },
          { altura_m: 5, uso_NCh1537: 'bodegas livianas' }
        ],
        vanos_x: { cantidad: 4, luz_m: 3 },
        vanos_y: [5, 5]
      },
      secciones: { material: 'S275', vigas: 'IPE300', pilares: 'HEB200' },
      apoyo_base: 'empotrado', diafragma_rigido: true,
      cargas: { muerta_adicional_kN_m2: 1.5, sismo: true }
    }, null, 2);

    document.getElementById('modal-body').innerHTML = `
<div class="prop-field">
  <label>Describe el modelo en palabras (el asistente arma la ficha)</label>
  <textarea id="asis-nl" rows="4" class="sp-textarea" placeholder="Ej.: edificio de 4 niveles de 3 m, planta con 3 vanos de 6 m en X y 2 de 5 m en Y, hormigón H30, vigas 25x50, pilares 35x35, salas de clases, en Valdivia, con sismo zona 2 suelo D"></textarea>
</div>
<div class="prop-row" style="margin-top:6px;align-items:end">
  <div class="prop-field" style="flex:1"><label>Endpoint del asistente (Cloudflare Worker /api/asistente)</label>
    <input type="text" id="asis-endpoint" value="${ep}" placeholder="/api/asistente"></div>
  <button type="button" id="btn-asis-llm" class="btn-primary" style="margin-left:8px">✦ Pedir ficha al asistente</button>
</div>
<small style="color:var(--text-muted);display:block;margin-top:4px">La credencial del asistente vive como secreto del servidor (Cloudflare Worker), nunca en el navegador. Luego pulsa <b>Generar modelo</b>.</small>

<details style="margin-top:12px">
  <summary style="cursor:pointer;color:var(--accent)">Ver / editar la ficha (JSON) — avanzado</summary>
  <div class="prop-field" style="margin-top:8px">
    <textarea id="asis-ficha" rows="14" class="sp-textarea" style="font-family:monospace;font-size:12px">${plantilla}</textarea>
    <small style="color:var(--text-muted);display:block;margin-top:4px">El generador determinista construye el modelo (geometría, secciones, cargas NCh, combinaciones) y reemplaza el modelo actual. Si falta o no se reconoce algún dato, se sustituye/estima y se informa.</small>
  </div>
</details>`;

    document.getElementById('btn-asis-llm')?.addEventListener('click', async () => {
      const url = document.getElementById('asis-endpoint').value.trim();
      const msg = document.getElementById('asis-nl').value.trim();
      if (!url) { this.toast('Configure el endpoint del asistente', 'warn'); return; }
      if (!msg) { this.toast('Escriba una descripción', 'warn'); return; }
      localStorage.setItem('portico_n8n_endpoint', url);
      this._showProgress('Consultando al asistente…', 'Puede tardar varios segundos');
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mensaje: msg }) });
        const data = await r.json().catch(() => ({}));   // el servidor envía { error } aun en fallo
        if (!r.ok) throw new Error(data.error || data.message || `HTTP ${r.status}`);
        const ficha = data.ficha ?? data;
        this._lastAsisLogId = data._logId || null;   // para feedback tras generar
        const ta = document.getElementById('asis-ficha');
        if (ta) { ta.value = JSON.stringify(ficha, null, 2); ta.closest('details')?.setAttribute('open', ''); }
        this.toast('Ficha recibida — pulsa «Generar modelo»', 'ok');
      } catch (e) { this.toast('Error asistente: ' + e.message, 'error'); }
      finally { this._hideProgress(); }
    });

    const restore = () => { okBtn.textContent = 'Aceptar'; };
    overlay.classList.remove('hidden');
    overlay._resolve = () => { restore(); this._generarDesdeFicha(document.getElementById('asis-ficha').value); };
    overlay._reject = restore;
  }

  /** Pide la ficha al asistente (endpoint) desde un texto y genera el modelo.
   *  Usado por el cuadro de la portada y reutilizable desde cualquier lugar. */
  async asistenteDesdeTexto(mensaje) {
    const url = localStorage.getItem('portico_n8n_endpoint') || '/api/asistente';
    this._showProgress('Consultando al asistente…', 'Interpretando tu descripción');
    let ficha = null;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mensaje }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || data.message || `HTTP ${r.status}`);
      ficha = data.ficha ?? data;
      this._lastAsisLogId = data._logId || null;   // para feedback tras generar
      // El modelo que generó la ficha se reporta en la consola (no en pantalla).
      if (data._llm) {
        console.info(`[asistente] proveedor: ${data._llm.proveedor} · modelo: ${data._llm.modelo}`);
        if (data._llm.intentos && data._llm.intentos.length) console.info('[asistente] cascada (intentos fallidos antes del exitoso):', data._llm.intentos);
      }
      if (data._rag) {
        console.info(`[asistente] RAG: ${data._rag.usados.length} ejemplo(s) usados (score ${data._rag.score})`, data._rag.usados);
        if (data._rag.novedoso) console.info('[asistente] pedido NOVEDOSO (sin ejemplo parecido): candidato para agregar a asistente/ejemplos.json en la revisión semanal.');
      }
    } catch (e) {
      this._hideProgress();
      this.toast('Error asistente: ' + e.message, 'error');
      return;
    }
    await this._generarDesdeFicha(JSON.stringify(ficha));
  }

  async _generarDesdeFicha(fichaText) {
    let ficha;
    try { ficha = JSON.parse(fichaText); }
    catch (e) { this.toast('Ficha JSON inválida: ' + e.message, 'error'); return; }

    // Si ya hay un modelo, preguntar qué hacer: sobreponer / nueva / cancelar.
    let modo = 'nueva';
    if (this.model.nodes.size > 0) {
      modo = await this._dialogoModeloExistente();
      if (modo === 'cancelar') return;
    }

    this._showProgress('Generando el modelo…', 'Aplicando reglas y cargas normativas');
    try {
      const libs = await this._cargarBibliotecasAsistente();
      const { generarModelo } = await import('../asistente/generador.js?v=101');
      const modelo = generarModelo(ficha, libs);

      if (modo === 'sobreponer') {
        const src = this.serializer.fromJSON(JSON.stringify(modelo));
        const modoMix = src.mode !== this.model.mode;
        const { welded } = this._mergeGeneratedInto(src);
        this.viewport.clearResults();
        this._results = null; this._resultsByCase = null;
        this._discardResultsCache?.();
        this.viewport.renderModel(this.model);
        this.panel.showNothing();
        this.panel.refresh(this.model);
        this._renderLcSelector();
        this.refreshLoads();
        this._updateStats();
        this.markDirty();
        if (this.model.mode !== '2D') this.viewport.zoomExtents();
        this.toast(`Estructura sobrepuesta — ${welded} nodo(s) coincidente(s) fundido(s)`, 'ok');
        if (modoMix) this.toast(`Aviso: el modelo generado era ${src.mode} y el actual es ${this.model.mode}; se conservó ${this.model.mode}`, 'warn');
      } else {
        this._loadJSON(JSON.stringify(modelo), (ficha.proyecto || 'asistente') + '.s3d');
        this.markDirty();
        this.toast(`Modelo generado — ${modelo._generado?.resumen || ''}`, 'ok');
      }
      this._mostrarAvisos(modelo._avisos || []);
      // Feedback: si esta generación vino de una consulta al asistente, ofrecer
      // marcarla como "no era lo que pedí" (alimenta la revisión semanal).
      const fid = this._lastAsisLogId; this._lastAsisLogId = null;
      if (fid) this._ofrecerFeedbackAsistente(fid);
    } catch (e) {
      this.toast('Error al generar: ' + e.message, 'error');
      console.error(e);
    } finally { this._hideProgress(); }
  }

  /** Barra de feedback tras generar desde el asistente: ✓ Sí / ✗ No era lo que pedí.
   *  El "no" envía POST /api/asistente/feedback marcando el registro como incorrecto. */
  _ofrecerFeedbackAsistente(logId) {
    if (!logId) return;
    document.getElementById('asis-feedback')?.remove();
    const el = document.createElement('div');
    el.id = 'asis-feedback';
    el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:100001;background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-size:13px;color:var(--text,#e6edf3)';
    el.innerHTML = `
      <span>¿El modelo es lo que pediste?</span>
      <button id="afb-yes" style="border:1px solid var(--success,#15803d);background:transparent;color:var(--success,#15803d);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">✓ Sí</button>
      <button id="afb-no" style="border:1px solid var(--danger,#dc2626);background:transparent;color:var(--danger,#dc2626);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">✗ No era lo que pedí</button>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    const timer = setTimeout(close, 15000);
    el.querySelector('#afb-yes').onclick = () => { clearTimeout(timer); close(); };
    el.querySelector('#afb-no').onclick = async () => {
      clearTimeout(timer); close();
      const comentario = await this._promptModal('Feedback del asistente', '¿Qué esperabas? (opcional, ayuda a mejorar)', '');
      try {
        const base = localStorage.getItem('portico_n8n_endpoint') || '/api/asistente';
        const r = await fetch(base + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: logId, comentario: comentario || null }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
        this.toast('Gracias — registrado como «no era lo solicitado»', 'ok');
      } catch (e) { this.toast('No se pudo enviar el feedback: ' + e.message, 'warn'); }
    };
  }

  // ── Configuración de la aplicación (persistida en localStorage) ─────────────
  _defaultConfig() {
    return {
      memoria: {
        titulo: 'Memoria de Cálculo',
        kicker: 'ANÁLISIS Y DISEÑO ESTRUCTURAL',
        institucion: 'UNIVERSIDAD AUSTRAL DE CHILE',
        subInstitucion: 'Facultad de Ciencias de la Ingeniería · Instituto de Obras Civiles',
        proyectista: '',
        revisor: '',
        descripcion: '',       // PRO
        footer: '',            // PRO (vacío = pie académico por defecto)
        limitaciones: '',      // PRO (vacío = limitaciones académicas por defecto)
        logoEmpresa: '',       // PRO (data URL del logo de la empresa)
        mostrarIds: true,      // mostrar IDs de nodos/elementos en las figuras
        modosVisibles: true,   // amplificar las formas modales para que se noten
      },
      analisis: { motor: 'normal', shellTipos: [], matrizDensa: false, nlLite: false },   // matrizDensa: false = solver en banda (rápido); true = denso (académico). nlLite: análisis no lineal geométrico (sin token). motor/área: PRO.
      seccion_mod_default: { A: 1, Iy: 1, Iz: 1, J: 1 },
    };
  }

  // Pie de página y limitaciones de la VERSIÓN ACADÉMICA (no editables sin token).
  get _ACAD_FOOTER() { return 'Producto académico · IOC · UACh — no sustituye la revisión de un profesional competente'; }
  get _ACAD_LIMITS() {
    return [
      'Documento generado automáticamente por PÓRTICO con fines <b>docentes</b>; no reemplaza el criterio ni la firma de un profesional competente.',
      'La verificación de diseño usa propiedades de sección (A, I) y los parámetros editables de <code>asistente/diseno_params.json</code>; el hormigón armado se evalúa con la cuantía indicada y supuestos declarados.',
      'La verificación de <b>resistencia</b> cubre flexión, corte, axial e interacción flexo-axial (AISC H1 / NDS) por envolvente de combinaciones. La de <b>servicio</b> cubre la flecha de vigas bajo sobrecarga de uso sin mayorar y las derivas de entrepiso (NCh433, límite 2/1000·h, entre centros de masa y entre nodos externos). NO incluye diseño de uniones, fundaciones, pandeo lateral-torsional ni clasificación de perfiles. Los efectos P-Δ y el pandeo global (factor crítico λcr) se evalúan aparte con NL-lite (no se incorporan automáticamente a las razones D/C).',
      'Las cargas de viento, nieve y sobrecargas se representan como casos de carga; verifique su clasificación y magnitud según la normativa aplicable.',
    ];
  }
  _loadConfig() {
    const def = this._defaultConfig();
    try {
      const raw = JSON.parse(localStorage.getItem('portico_config') || '{}');
      return {
        memoria: { ...def.memoria, ...(raw.memoria || {}) },
        analisis: { ...def.analisis, ...(raw.analisis || {}) },
        seccion_mod_default: { ...def.seccion_mod_default, ...(raw.seccion_mod_default || {}) },
      };
    } catch { return def; }
  }
  _saveConfig() { try { localStorage.setItem('portico_config', JSON.stringify(this._config)); } catch (e) {} }

  // ── Modo profesional (token validado contra el secreto del Worker) ──────────
  async _verificarPro(token) {
    const base = localStorage.getItem('portico_n8n_endpoint') || '/api/asistente';
    const r = await fetch(base + '/pro', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d.ok, error: d.error };
  }
  async activarPro(token) {
    token = String(token || '').trim();
    if (!token) return { ok: false, error: 'Ingrese un token.' };
    try {
      const res = await this._verificarPro(token);
      if (res.ok) {
        this._pro = true;
        try { localStorage.setItem('portico_pro_token', token); } catch (e) {}
        this._actualizarBadgePro();
        return { ok: true };
      }
      return { ok: false, error: res.error || 'Token inválido.' };
    } catch (e) { return { ok: false, error: 'No se pudo contactar el servidor: ' + e.message }; }
  }
  desactivarPro() {
    this._pro = false;
    try { localStorage.removeItem('portico_pro_token'); } catch (e) {}
    this._actualizarBadgePro();
  }
  _initPro() {
    this._pro = false;
    this._actualizarBadgePro();
    let tok = null; try { tok = localStorage.getItem('portico_pro_token'); } catch (e) {}
    if (tok) this._verificarPro(tok).then(r => { this._pro = !!r.ok; this._actualizarBadgePro(); }).catch(() => {});
  }
  _actualizarBadgePro() {
    const b = document.getElementById('pro-badge');
    if (b) b.style.display = this._pro ? '' : 'none';
  }

  configDialog() {
    const mm = this._config.memoria, sd = this._config.seccion_mod_default, an = this._config.analisis;
    const pro = !!this._pro;
    const overlay = document.getElementById('modal-overlay');
    const ea = s => String(s ?? '').replace(/"/g, '&quot;');
    const G = pro ? '' : 'disabled';   // gate: deshabilitado sin token
    const lock = pro ? '' : ' 🔒';
    const motores = [['normal','Normal (lineal elástico)'],['rapido','Rápido (no implementado)'],
      ['no_lineal_estatico','No lineal estático (no implementado)'],['pushover','Carga progresiva — pushover (no implementado)'],
      ['no_lineal_dinamico','No lineal dinámico, integración directa (no implementado)']];
    document.getElementById('modal-title').textContent = '⚙ Configuración';
    document.getElementById('modal-box')?.classList.add('modal-wide');
    document.getElementById('modal-cancel').style.display = '';
    document.getElementById('modal-body').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;font-size:13px">
        <fieldset style="border:1px solid ${pro ? 'var(--teal)' : 'var(--border)'};border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:${pro ? 'var(--teal)' : 'var(--accent)'}">Modo profesional ${pro ? '— ACTIVO ✔' : '— inactivo'}</legend>
          <p style="color:var(--text-muted);font-size:11px;margin-bottom:6px">Las funciones profesionales (editar descripción, pie de página, limitaciones, logo de empresa, motor de análisis y elementos de área) requieren un <b>token autorizado</b>, que se obtiene enviando una solicitud. Garantiza que la herramienta no se use con fines comerciales sin autorización. La versión académica conserva los créditos UACh · Facultad · IOC.</p>
          ${pro
            ? `<button type="button" id="cfg-pro-off" class="btn">Desactivar modo profesional</button>`
            : `<div class="prop-row" style="gap:8px;align-items:end"><div class="prop-field" style="flex:1"><label>Token profesional</label><input id="cfg-pro-token" type="password" placeholder="pegue su token"></div><button type="button" id="cfg-pro-on" class="btn-primary" style="margin-left:8px">Activar</button></div>`}
        </fieldset>

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Memoria — encabezado</legend>
          <div class="prop-row cols2" style="gap:8px">
            <div class="prop-field"><label>Título</label><input id="cfg-titulo" value="${ea(mm.titulo)}"></div>
            <div class="prop-field"><label>Subtítulo (kicker)${lock}</label><input id="cfg-kicker" value="${ea(mm.kicker)}" ${G}></div>
          </div>
          <div class="prop-row cols2" style="gap:8px;margin-top:6px">
            <div class="prop-field"><label>Institución${lock}</label><input id="cfg-inst" value="${ea(mm.institucion)}" ${G}></div>
            <div class="prop-field"><label>Sub-institución / unidad${lock}</label><input id="cfg-subinst" value="${ea(mm.subInstitucion)}" ${G}></div>
          </div>
          <div class="prop-row cols2" style="gap:8px;margin-top:6px">
            <div class="prop-field"><label>Proyectista</label><input id="cfg-proy" value="${ea(mm.proyectista)}"></div>
            <div class="prop-field"><label>Revisó</label><input id="cfg-rev" value="${ea(mm.revisor)}"></div>
          </div>
        </fieldset>

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Memoria — contenido profesional${lock}</legend>
          <div class="prop-field"><label>Descripción del proyecto</label><textarea id="cfg-desc" rows="3" style="width:100%" ${G}>${ea(mm.descripcion)}</textarea></div>
          <div class="prop-field" style="margin-top:6px"><label>Pie de página (vacío = pie académico)</label><input id="cfg-footer" value="${ea(mm.footer)}" placeholder="${ea(this._ACAD_FOOTER)}" ${G}></div>
          <div class="prop-field" style="margin-top:6px"><label>Limitaciones (una por línea; vacío = limitaciones académicas)</label><textarea id="cfg-limit" rows="3" style="width:100%" ${G}>${ea(mm.limitaciones)}</textarea></div>
          <div class="prop-field" style="margin-top:6px"><label>Logo de empresa</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input id="cfg-logo-file" type="file" accept="image/*" ${G} style="flex:1">
              ${mm.logoEmpresa ? '<img id="cfg-logo-prev" src="' + mm.logoEmpresa + '" style="height:28px;border:1px solid var(--border);border-radius:4px;background:#fff">' : ''}
              <button type="button" id="cfg-logo-clear" class="btn" ${G}>Quitar</button>
            </div>
          </div>
        </fieldset>

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Visualización de la memoria</legend>
          <label style="display:block;margin-bottom:5px"><input type="checkbox" id="cfg-ids" ${mm.mostrarIds ? 'checked' : ''}> Mostrar IDs de nodos y elementos en las figuras</label>
          <label style="display:block"><input type="checkbox" id="cfg-modos" ${mm.modosVisibles ? 'checked' : ''}> Amplificar las formas modales para que se observen</label>
        </fieldset>

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Análisis</legend>
          <label style="display:block"><input type="checkbox" id="cfg-densa" ${this._config.analisis.matrizDensa ? 'checked' : ''}> Usar matriz de rigidez <b>densa</b> (exploración académica; más lenta)</label>
          <small style="color:var(--text-muted);font-size:10.5px">Por defecto se usa la versión <b>condensada en banda</b> (rápida, factorización única). La densa arma y factoriza la matriz completa tal cual — útil para entender cómo se construye, pero O(n³).</small>
          <label style="display:block;margin-top:8px"><input type="checkbox" id="cfg-nllite" ${this._config.analisis.nlLite ? 'checked' : ''}> Habilitar <b>análisis no lineal (NL-lite)</b></label>
          <small style="color:var(--text-muted);font-size:10.5px">Activa <b>Análisis → No lineal</b>: cables (solo tracción), pretensado por longitud natural y no linealidad geométrica (corotacional, Newton incremental) con deformada paso a paso. Marca elementos como «cable» en la pestaña Elem. Sin token.</small>
        </fieldset>

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Funciones avanzadas (profesional)${lock}</legend>
          <div class="prop-field"><label>Motor de análisis (elija uno)</label>
            <div>${motores.map(([v, t]) => `<label style="display:block;font-size:12px;margin:1px 0"><input type="checkbox" class="cfg-motor-cb" value="${v}" ${an.motor === v ? 'checked' : ''} ${G}> ${t}</label>`).join('')}</div></div>
          <div class="prop-field" style="margin-top:8px"><label>Elementos de área (membrana / placa / Shell lineal elástico)</label>
            ${[['membrana', 'Membrana (no implementado)'], ['placa', 'Placa (no implementado)'], ['shell', 'Shell lineal elástico (no implementado)']]
              .map(([v, t]) => `<label style="display:block;font-size:12px;margin:1px 0"><input type="checkbox" class="cfg-shell-cb" value="${v}" ${(an.shellTipos || []).includes(v) ? 'checked' : ''} ${G}> ${t}</label>`).join('')}
            <small style="color:var(--text-muted);font-size:10.5px">Mostrarán tensiones, deformaciones y esfuerzos; con subdivisión configurable (N divisiones horizontales/verticales). Disponible en la versión avanzada.</small>
          </div>
        </fieldset>

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Modificadores de sección por defecto (rigidez)</legend>
          <p style="color:var(--text-muted);font-size:11px;margin-bottom:6px">Factores aplicados a A, I, J en el análisis (p.ej. sección agrietada ACI: viga 0.35, columna 0.70). Editables por sección en la pestaña Sec.</p>
          <div class="prop-row cols4" style="gap:8px">
            <div class="prop-field"><label>×A</label><input type="number" id="cfg-mA" value="${sd.A}" step="0.05" min="0.01"></div>
            <div class="prop-field"><label>×Iy</label><input type="number" id="cfg-mIy" value="${sd.Iy}" step="0.05" min="0.01"></div>
            <div class="prop-field"><label>×Iz</label><input type="number" id="cfg-mIz" value="${sd.Iz}" step="0.05" min="0.01"></div>
            <div class="prop-field"><label>×J</label><input type="number" id="cfg-mJ" value="${sd.J}" step="0.05" min="0.01"></div>
          </div>
          <button type="button" id="cfg-apply-mod" class="btn" style="margin-top:8px">Aplicar estos modificadores a TODAS las secciones</button>
        </fieldset>
        <p style="color:var(--text-muted);font-size:11px">Los parámetros de diseño (Fy, f′c, φ, cuantía…) se editan en <code>asistente/diseno_params.json</code>.</p>
      </div>`;
    overlay.classList.remove('hidden');

    // Activar / desactivar modo profesional
    document.getElementById('cfg-pro-on')?.addEventListener('click', async () => {
      const tok = document.getElementById('cfg-pro-token')?.value;
      const r = await this.activarPro(tok);
      if (r.ok) { this.toast('Modo profesional activado', 'ok'); this.configDialog(); }
      else this.toast(r.error || 'Token inválido', 'error');
    });
    document.getElementById('cfg-pro-off')?.addEventListener('click', () => { this.desactivarPro(); this.toast('Modo profesional desactivado', 'ok'); this.configDialog(); });
    // Logo de empresa (file → data URL)
    document.getElementById('cfg-logo-file')?.addEventListener('change', (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { mm.logoEmpresa = rd.result; this.toast('Logo cargado (se aplica al guardar)', 'ok'); };
      rd.readAsDataURL(f);
    });
    document.getElementById('cfg-logo-clear')?.addEventListener('click', () => { if (pro) { mm.logoEmpresa = ''; document.getElementById('cfg-logo-prev')?.remove(); } });
    // Motor de análisis: checkboxes con selección única (radio-like)
    document.querySelectorAll('.cfg-motor-cb').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) document.querySelectorAll('.cfg-motor-cb').forEach(o => { if (o !== cb) o.checked = false; });
      else cb.checked = true;   // siempre debe haber uno marcado
    }));
    document.getElementById('cfg-apply-mod')?.addEventListener('click', () => {
      const mod = { A: +document.getElementById('cfg-mA').value || 1, Iy: +document.getElementById('cfg-mIy').value || 1,
        Iz: +document.getElementById('cfg-mIz').value || 1, J: +document.getElementById('cfg-mJ').value || 1 };
      for (const s of this.model.sections.values()) this.model.updateSection(s.id, { mod: { ...mod } });
      this.markDirty(); this.panel.renderSections?.();
      this.toast('Modificadores aplicados a todas las secciones', 'ok');
    });
    overlay._resolve = () => {
      const v = id => document.getElementById(id)?.value ?? '';
      mm.titulo = v('cfg-titulo'); mm.proyectista = v('cfg-proy'); mm.revisor = v('cfg-rev');
      mm.mostrarIds = document.getElementById('cfg-ids')?.checked ?? true;
      mm.modosVisibles = document.getElementById('cfg-modos')?.checked ?? true;
      an.matrizDensa = document.getElementById('cfg-densa')?.checked ?? false;   // densa/banda: académico, sin token
      an.nlLite = document.getElementById('cfg-nllite')?.checked ?? false;        // no lineal: sin token
      if (pro) {   // campos profesionales solo si hay token
        mm.kicker = v('cfg-kicker'); mm.institucion = v('cfg-inst'); mm.subInstitucion = v('cfg-subinst');
        mm.descripcion = v('cfg-desc'); mm.footer = v('cfg-footer'); mm.limitaciones = v('cfg-limit');
        const motorSel = [...document.querySelectorAll('.cfg-motor-cb')].find(c => c.checked)?.value || 'normal';
        if (motorSel !== 'normal') this.toast('El motor seleccionado no está implementado en esta versión; se usará Normal.', 'warn');
        an.motor = motorSel;
        const shellSel = [...document.querySelectorAll('.cfg-shell-cb')].filter(c => c.checked).map(c => c.value);
        if (shellSel.length) this.toast('Los elementos de área (membrana/placa/Shell) no están implementados aún (versión avanzada).', 'warn');
        an.shellTipos = shellSel;
      }
      sd.A = +v('cfg-mA') || 1; sd.Iy = +v('cfg-mIy') || 1; sd.Iz = +v('cfg-mIz') || 1; sd.J = +v('cfg-mJ') || 1;
      this._saveConfig();
      document.getElementById('modal-box')?.classList.remove('modal-wide');
      this.toast('Configuración guardada', 'ok');
    };
    overlay._reject = () => document.getElementById('modal-box')?.classList.remove('modal-wide');
  }

  /** Diálogo de 3 opciones cuando ya existe un modelo al generar desde el asistente. */
  _dialogoModeloExistente() {
    return new Promise(resolve => {
      document.getElementById('portico-choice')?.remove();
      const s = this.model.getStats();
      const el = document.createElement('div');
      el.id = 'portico-choice';
      el.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(6,10,18,.72);backdrop-filter:blur(2px)';
      el.innerHTML = `
        <div style="background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;padding:22px 24px;max-width:460px;box-shadow:0 10px 40px rgba(0,0,0,.5)">
          <div style="color:var(--text,#e6edf3);font-weight:600;font-size:15px;margin-bottom:6px">⚠️ Ya existe un modelo</div>
          <div style="color:var(--text-muted,#9aa);font-size:13px;line-height:1.5;margin-bottom:16px">
            El modelo actual tiene <b>${s.nodes}</b> nodos y <b>${s.elements}</b> elementos.
            ¿Qué hago con la estructura que generará el asistente?</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button data-choice="sobreponer" style="width:100%;text-align:left;padding:10px 12px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;font-size:13px">➕ Sobreponer — agregar al modelo actual (funde nodos coincidentes)</button>
            <button data-choice="nueva" style="width:100%;text-align:left;padding:10px 12px;border-radius:6px;border:1px solid var(--border2,#445);background:transparent;color:var(--text,#e6edf3);cursor:pointer;font-size:13px">🗑 Nueva — reemplazar el modelo actual por el generado</button>
            <button data-choice="cancelar" style="width:100%;text-align:left;padding:10px 12px;border-radius:6px;border:1px solid var(--border2,#445);background:transparent;color:var(--text-muted,#9aa);cursor:pointer;font-size:13px">✕ Cancelar</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      const done = v => { el.remove(); resolve(v); };
      el.querySelectorAll('[data-choice]').forEach(b => b.addEventListener('click', () => done(b.dataset.choice)));
      el.addEventListener('mousedown', e => { if (e.target === el) done('cancelar'); });
    });
  }

  /** Funde un modelo generado dentro de this.model (sobreponer): remapea ids,
   *  funde nodos coincidentes por coordenada y deduplica barras/material/sección. */
  _mergeGeneratedInto(src) {
    const dst = this.model;
    const rk = v => Math.round(v * 1e4) / 1e4;
    const ckey = (x, y, z) => `${rk(x)},${rk(y)},${rk(z)}`;
    const strip = o => { const { id, ...r } = o; return r; };

    // Materiales y secciones (dedupe por nombre)
    const matByName = new Map([...dst.materials.values()].map(m => [m.name, m.id]));
    const matMap = new Map();
    for (const m of src.materials.values()) {
      if (matByName.has(m.name)) { matMap.set(m.id, matByName.get(m.name)); continue; }
      const nm = dst.addMaterial(strip(m)); matMap.set(m.id, nm.id); matByName.set(nm.name, nm.id);
    }
    const secByName = new Map([...dst.sections.values()].map(s => [s.name, s.id]));
    const secMap = new Map();
    for (const s of src.sections.values()) {
      if (secByName.has(s.name)) { secMap.set(s.id, secByName.get(s.name)); continue; }
      const ns = dst.addSection(strip(s)); secMap.set(s.id, ns.id); secByName.set(ns.name, ns.id);
    }

    // Nodos: fundir por coordenada
    const coordIdx = new Map();
    for (const n of dst.nodes.values()) coordIdx.set(ckey(n.x, n.y, n.z), n.id);
    const nodeMap = new Map();
    let welded = 0;
    for (const n of src.nodes.values()) {
      const k = ckey(n.x, n.y, n.z);
      if (coordIdx.has(k)) {
        const exId = coordIdx.get(k);
        nodeMap.set(n.id, exId);
        const r = {};
        for (const g of ['ux', 'uy', 'uz', 'rx', 'ry', 'rz']) if (n.restraints?.[g]) r[g] = 1;
        dst.updateNode(exId, { restraints: r, springs: n.springs, nodeMass: n.nodeMass });
        welded++;
      } else {
        const nn = dst.addNode(n.x, n.y, n.z, n.restraints || {});
        dst.updateNode(nn.id, { springs: n.springs, nodeMass: n.nodeMass });
        nodeMap.set(n.id, nn.id);
        coordIdx.set(k, nn.id);
      }
    }

    // Elementos (dedupe por par de nodos)
    const pk = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;
    const elemPairs = new Set([...dst.elements.values()].map(e => pk(e.n1, e.n2)));
    const elemMap = new Map();
    for (const e of src.elements.values()) {
      const a = nodeMap.get(e.n1), b = nodeMap.get(e.n2);
      if (a == null || b == null || a === b || elemPairs.has(pk(a, b))) continue;
      const ne = dst.addElement(a, b, matMap.get(e.matId), secMap.get(e.secId));
      if (!ne) continue;
      if (e.releases) dst.updateElement(ne.id, { releases: e.releases });
      elemMap.set(e.id, ne.id);
      elemPairs.add(pk(a, b));
    }

    // Casos de carga (merge por nombre; cargas con destino remapeado)
    const srcLcName = new Map([...src.loadCases.values()].map(l => [l.id, l.name]));
    const lcByName = new Map([...dst.loadCases.values()].map(l => [l.name, l.id]));
    for (const lc of src.loadCases.values()) {
      let dstLcId = lcByName.get(lc.name);
      if (dstLcId == null) {
        const nl = dst.addLoadCase(lc.name, lc.selfWeight, lc.type, lc.specDir);
        if (lc.spec) nl.spec = lc.spec;
        dstLcId = nl.id; lcByName.set(nl.name, nl.id);
      }
      const dlc = dst.loadCases.get(dstLcId);
      for (const ld of (lc.loads || [])) {
        if (ld.type === 'nodal') { const id = nodeMap.get(ld.nodeId); if (id != null) dlc.loads.push({ type: 'nodal', nodeId: id, F: [...ld.F] }); }
        else if (ld.type === 'dist') { const id = elemMap.get(ld.elemId); if (id != null) dlc.loads.push({ type: 'dist', elemId: id, dir: ld.dir, w: ld.w }); }
      }
    }

    // Diafragmas (remapear nodos / masterId)
    for (const d of src.diaphragms.values()) {
      const nodes = (d.nodes || []).map(id => nodeMap.get(id)).filter(x => x != null);
      if (!nodes.length) continue;
      const nd = dst.addDiaphragm({ ...strip(d), nodes });
      if (d.masterId != null && nodeMap.get(d.masterId) != null) nd.masterId = nodeMap.get(d.masterId);
    }

    // Combinaciones (remapear lcId de los factores; dedupe por nombre)
    const comboNames = new Set([...dst.combinations.values()].map(c => c.name));
    for (const c of src.combinations.values()) {
      if (comboNames.has(c.name)) continue;
      const factors = (c.factors || [])
        .map(f => ({ lcId: lcByName.get(srcLcName.get(f.lcId)), factor: f.factor }))
        .filter(f => f.lcId != null);
      dst.addCombination({ name: c.name, factors });
      comboNames.add(c.name);
    }

    return { welded };
  }

  /** Resumen de reemplazos/estimaciones/omisiones del generador. */
  _mostrarAvisos(avisos) {
    if (!avisos || !avisos.length) { this.toast('Sin reemplazos: todo se interpretó correctamente', 'ok'); return; }
    const icono = { reemplazo: '🔁', estimado: '📐', omitido: '⚠️', info: 'ℹ️' };
    const items = avisos.map(a => `<li style="margin:4px 0"><b>${icono[a.tipo] || '•'} ${a.tipo}</b> — ${a.msg}</li>`).join('');
    this._alert('Resumen del asistente — ajustes realizados',
      `<p style="color:var(--text-muted);margin-bottom:6px">El modelo se generó. Estos datos faltaban o no se reconocieron y se sustituyeron/estimaron:</p>
       <ul style="max-height:340px;overflow:auto;padding-left:18px;font-size:12px">${items}</ul>`);
  }

  /** Overlay de progreso a pantalla completa que bloquea la interacción. */
  _showProgress(titulo, sub = '', onCancel = null) {
    let el = document.getElementById('portico-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'portico-progress';
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(6,10,18,.72);backdrop-filter:blur(2px)';
      el.innerHTML =
        `<div style="background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;padding:22px 26px;min-width:300px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)">
           <div id="pp-titulo" style="color:var(--text,#e6edf3);font-weight:600;margin-bottom:4px"></div>
           <div id="pp-sub" style="color:var(--text-muted,#9aa);font-size:12px;margin-bottom:12px"></div>
           <div style="height:6px;border-radius:3px;background:var(--border,#223);overflow:hidden">
             <div style="height:100%;width:40%;border-radius:3px;background:var(--accent,#4ea1ff);animation:pp-slide 1.1s ease-in-out infinite"></div>
           </div>
           <button id="pp-cancel" style="display:none;margin-top:14px;background:transparent;border:1px solid var(--danger,#dc2626);color:var(--danger,#dc2626);border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px">Cancelar</button>
         </div>
         <style>@keyframes pp-slide{0%{margin-left:-40%}100%{margin-left:100%}}</style>`;
      document.body.appendChild(el);
    }
    el.querySelector('#pp-titulo').textContent = titulo;
    el.querySelector('#pp-sub').textContent = sub;
    const cancel = el.querySelector('#pp-cancel');
    cancel.style.display = onCancel ? '' : 'none';
    cancel.onclick = onCancel || null;
    el.style.display = 'flex';
  }

  _hideProgress() {
    const el = document.getElementById('portico-progress');
    if (el) el.style.display = 'none';
  }

  // ── Tema claro / oscuro (claro por defecto) ────────────────────────────────
  _initTheme() {
    const t = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    this.aplicarTema(t);
    const toggle = () => {
      const actual = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      this.aplicarTema(actual === 'dark' ? 'light' : 'dark');
    };
    document.getElementById('btn-theme')?.addEventListener('click', toggle);
    document.getElementById('landing-theme')?.addEventListener('click', toggle);   // mismo toggle en la portada
  }

  aplicarTema(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('portico_theme', theme); } catch (e) {}   // se recuerda por máquina
    const icon = theme === 'dark' ? '☀️' : '🌙';
    const ttl  = theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
    for (const id of ['btn-theme', 'landing-theme']) {
      const btn = document.getElementById(id);
      if (btn) { btn.textContent = icon; btn.title = ttl; }
    }
    this._swapLogos(theme);
    this.viewport?.setTheme?.(theme === 'light');
  }

  /** Logos institucionales: versión NEGRA en modo claro, BLANCA en oscuro. */
  _swapLogos(theme) {
    const suf = theme === 'light' ? 'negro' : 'blanco';
    for (const img of document.querySelectorAll('img')) {
      const s = img.getAttribute('src') || '';
      if (/(UACh-color-|Facultad-color-|SomosIngenieria[\w-]*?)(blanco|negro)/.test(s))
        img.setAttribute('src', s.replace(/(blanco|negro)(?=[^/]*\.svg$)/, suf));
    }
  }

  async _cargarBibliotecasAsistente() {
    if (this._asisLibs) return this._asisLibs;
    const parseCSV = (txt) => {
      const lines = txt.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
      const head = lines[0].split(',').map(s => s.trim());
      return lines.slice(1).map(l => {
        const c = l.split(',').map(s => s.trim());
        return Object.fromEntries(head.map((h, i) => [h, c[i]]));
      });
    };
    const base = 'asistente/';
    const [reglas, pTxt, mTxt, sTxt] = await Promise.all([
      fetch(base + 'reglas.json').then(r => r.json()),
      fetch(base + 'perfiles.csv').then(r => r.text()),
      fetch(base + 'materiales.csv').then(r => r.text()),
      fetch(base + 'sobrecargas_NCh1537.csv').then(r => r.text()),
    ]);
    this._asisLibs = { reglas, perfiles: parseCSV(pTxt), materiales: parseCSV(mTxt), sobrecargas: parseCSV(sTxt) };
    return this._asisLibs;
  }

  async saveFile() {
    if (window.electronAPI && this._filePath) {
      try {
        await window.electronAPI.writeFile(this._filePath, this._fullSaveJSON());
        this._dirty = false;
        this._updateTitle();
        this.toast(this._saveToastMsg(), 'ok');
      } catch (err) {
        this.toast(`Error al guardar: ${err.message}`, 'error');
      }
    } else if (this._fileHandle) {
      try {
        const writable = await this._fileHandle.createWritable();
        await writable.write(this._fullSaveJSON());
        await writable.close();
        this._dirty = false;
        this._updateTitle();
        this.toast(this._saveToastMsg(), 'ok');
      } catch (err) {
        this.toast(`Error al guardar: ${err.message}`, 'error');
      }
    } else {
      await this.saveFileAs();
    }
  }

  async saveFileAs() {
    try {
      if (window.electronAPI) {
        const filePath = await window.electronAPI.saveFileAs('modelo.s3d');
        if (!filePath) return;
        await window.electronAPI.writeFile(filePath, this._fullSaveJSON());
        this._filePath   = filePath;
        this._fileHandle = null;
        this._dirty = false;
        this._updateTitle(filePath.split(/[\\/]/).pop());
        this.toast(this._saveToastMsg(), 'ok');
      } else if ('showSaveFilePicker' in window) {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'modelo.s3d',
          types: [{ description: 'PÓRTICO', accept: { 'application/json': ['.s3d'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(this._fullSaveJSON());
        await writable.close();
        this._fileHandle = handle;
        this._filePath   = null;
        this._dirty = false;
        this._updateTitle(handle.name);
        this.toast(this._saveToastMsg(), 'ok');
      } else {
        this._downloadText(this._fullSaveJSON(), 'modelo.s3d', 'application/json');
        this._dirty = false;
        this._updateTitle();
        this.toast(this._saveToastMsg(), 'ok');
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.toast(`Error al guardar: ${err.message}`, 'error');
    }
  }

  importCSV() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.csv,.txt';
    inp.onchange = async () => {
      try {
        const text = await inp.files[0].text();
        this.snapshot();
        const { model, errors } = this.serializer.fromCSV(text, this.model);
        this.model = model;
        this.viewport.renderModel(model);
        this.panel.showNothing();
        this.panel.refresh(model);
        this.markDirty();
        this._updateStats();
        this.viewport.zoomExtents();
        if (errors.length > 0) {
          this.toast(`CSV importado con ${errors.length} advertencia(s)`, 'warn');
          console.warn('CSV import warnings:', errors);
        } else {
          this.toast('CSV importado correctamente', 'ok');
        }
        // Show error details if any
        if (errors.length > 0) {
          this._alert(
            'Advertencias al importar CSV',
            `<pre style="font-size:11px;color:#d29922;white-space:pre-wrap;">${errors.slice(0,20).join('\n')}</pre>`
          );
        }
      } catch (err) {
        this.toast(`Error al importar CSV: ${err.message}`, 'error');
      }
    };
    inp.click();
  }

  exportCSV() {
    // Si el análisis auto-discretizó el modelo, exportar el ORIGINAL del usuario
    const m = this._predisc ? this.serializer.fromJSON(this._predisc) : this.model;
    const csv = this.serializer.toCSV(m);
    this._downloadText(csv, 'modelo.csv', 'text/csv;charset=utf-8');
    this.toast('CSV exportado', 'ok');
  }

  // JSON a guardar en disco: si el análisis auto-discretizó el modelo,
  // se guarda el modelo ORIGINAL del usuario, no el subdividido temporal.
  _modelJSONForSave() {
    return this._predisc ?? this.serializer.toJSON(this.model);
  }

  // ¿Hay resultados consistentes con el modelo actual, aptos para guardar?
  _hasSavableResults() {
    const c = this._resultsCache;
    return !!(c && c.cases && c.cases.length && c.sig === this._modelSig(!!c.autoDisc));
  }

  // JSON para guardar en el archivo .s3d: modelo + (si existen y corresponden)
  // los resultados del análisis embebidos, para reabrir el archivo "ya corrido".
  _fullSaveJSON() {
    const modelJSON = this._modelJSONForSave();
    let obj;
    try { obj = JSON.parse(modelJSON); } catch { return modelJSON; }
    // Grupos y elementos ocultos (estado de vista) — persisten en el .s3d.
    if (this._grupos && this._grupos.size)
      obj.grupos = [...this._grupos].map(([name, set]) => ({ name, elems: [...set] }));
    if (this.viewport?.hiddenCount?.())
      obj.ocultos = [...this.viewport._hiddenElems];
    if (this._hasSavableResults()) {
      obj.results = {
        sig:          this._resultsCache.sig,
        autoDisc:     !!this._resultsCache.autoDisc,
        activeKey:    this._activeResultKey ?? this._activeLcId,
        showReactions:!!this._showReactions,
        savedAt:      new Date().toISOString(),
        cases:        this._resultsCache.cases,
      };
    }
    return (obj.grupos || obj.ocultos || obj.results) ? JSON.stringify(obj, null, 2) : modelJSON;
  }

  _saveToastMsg() {
    return this._hasSavableResults() ? 'Guardado (con resultados)' : 'Guardado';
  }

  // Adopta los resultados embebidos en un archivo .s3d recién cargado.
  _adoptEmbeddedResults(e) {
    if (!e || !Array.isArray(e.cases) || !e.cases.length) return false;
    const cb = document.getElementById('auto-disc');
    if (cb) cb.checked = !!e.autoDisc;   // alinear con el usado al generar los resultados
    const sig = this._modelSig(!!e.autoDisc);
    if (e.sig && e.sig !== sig) {
      // El modelo del archivo fue editado tras guardar los resultados → ignorarlos
      this._discardResultsCache();
      this.toast('El archivo trae resultados que no calzan con el modelo (se ignoran)', 'warn');
      return false;
    }
    this._resultsCache = { sig, autoDisc: !!e.autoDisc, cases: e.cases };
    if (e.activeKey != null) this._activeResultKey = e.activeKey;
    this._showReactions = !!e.showReactions;
    this._persistResults();
    this._autoShowResults();   // abrir mostrando los resultados, sin pulsar nada
    return true;
  }

  // Muestra los resultados cacheados automáticamente (sin que el usuario pulse
  // Análisis). Reutiliza la caché → no recalcula. Se usa al abrir un .s3d "ya
  // corrido" o al recuperar la sesión anterior.
  _autoShowResults() {
    if (!this._resultsCache || !this.model.elements.size) return;
    setTimeout(() => this.runAnalysis(), 250);
  }

  // ── Persistencia de resultados (no recalcular en cada sesión) ────────────────
  // Hash djb2 del JSON del modelo original (+ auto-disc): detecta cambios. Si el
  // modelo no cambió, los resultados guardados siguen siendo válidos.
  _hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  _modelSig(autoDisc) {
    return this._hashStr(this._modelJSONForSave() + '|ad:' + (autoDisc ? 1 : 0));
  }

  // Reconstruye _resultsByCase desde los vectores crudos cacheados, sobre el
  // modelo actual (ya subdividido si corresponde). No resuelve el sistema.
  _reconstructResultsFromCache() {
    const cache = this._resultsCache;
    if (!cache || !cache.cases) return false;
    const m = this.model;
    const nodeIndex = buildNodeIndex(m);
    const nDOF = nodeIndex.size * 6;
    const byCase = new Map();
    for (const c of cache.cases) {
      if (!c.u || c.u.length !== nDOF) return false;  // el modelo no calza → recalcular
      const u = Float64Array.from(c.u);
      const r = Float64Array.from(c.reactions);
      byCase.set(c.key, new Results(m, nodeIndex, u, r, new Float64Array(nDOF), c.lcId, c.selfWeight));
    }
    // Combos por superposición de los casos reconstruidos
    this._resultsByCase = byCase;
    for (const combo of m.combinations.values()) {
      const res = this._combineFromCache(combo);
      if (res) this._resultsByCase.set('C' + combo.id, res);
    }
    return true;
  }

  _persistResults() {
    try {
      localStorage.setItem('portico_results', JSON.stringify({
        sig: this._resultsCache.sig,
        autoDisc: !!this._resultsCache.autoDisc,
        cases: this._resultsCache.cases,
        activeKey: this._activeResultKey ?? this._activeLcId,
        showReactions: !!this._showReactions,
        ts: Date.now(),
      }));
    } catch { /* cuota llena → los resultados siguen en memoria esta sesión */ }
  }

  // Al arrancar: si hay resultados guardados de ESTE mismo modelo, prepararlos
  // para reutilizarlos (un clic en Análisis los muestra sin recalcular).
  _offerCachedResults() {
    // Si el modelo ya trae resultados embebidos (de un .s3d), tienen prioridad
    if (this._hasSavableResults()) return;
    try {
      const raw = localStorage.getItem('portico_results');
      if (!raw) return;
      const p = JSON.parse(raw);
      const cb = document.getElementById('auto-disc');
      if (cb && p.autoDisc != null) cb.checked = !!p.autoDisc;
      if (p.sig !== this._modelSig(!!p.autoDisc)) { this._discardResultsCache(); return; }
      // El modelo coincide → conservar la caché y el estado de vista guardado
      this._resultsCache = { sig: p.sig, autoDisc: !!p.autoDisc, cases: p.cases };
      if (p.activeKey != null) this._activeResultKey = p.activeKey;
      this._showReactions = !!p.showReactions;
      this._autoShowResults();   // mostrar los resultados de inmediato
    } catch { this._discardResultsCache(); }
  }

  _discardResultsCache() {
    this._resultsCache = null;
    this._activeResultKey = this._activeLcId;
    this._showReactions = false;
    try { localStorage.removeItem('portico_results'); } catch {}
  }

  downloadTemplate() {
    const csv = this.serializer.getTemplate();
    this._downloadText(csv, 'plantilla_structweb3d.csv', 'text/csv;charset=utf-8');
    this.toast('Plantilla descargada', 'ok');
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  markDirty() {
    this._dirty = true;
    this._updateTitle();
    // Autoguardado: 1.5 s después del último cambio (evita perder trabajo en aula)
    clearTimeout(this._autosaveT);
    this._autosaveT = setTimeout(() => this._autosaveNow(), 1500);
  }

  _autosaveNow() {
    try {
      localStorage.setItem('portico_autosave',
        JSON.stringify({ ts: Date.now(), json: this._modelJSONForSave() }));
    } catch { /* cuota de localStorage llena — ignorar */ }
  }

  // Al arrancar: ofrecer recuperar la sesión autoguardada; si no, cargar ejemplo.
  // Tras tener el modelo, ofrecer los resultados guardados si coinciden.
  async _restoreOrLoadExample() {
    let restored = false;
    try {
      const raw = localStorage.getItem('portico_autosave');
      if (raw) {
        const { ts, json } = JSON.parse(raw);
        const when = new Date(ts).toLocaleString('es-CL');
        const ok = await this._confirm(
          `Hay un modelo autoguardado de la sesión anterior (${when}).<br>¿Desea recuperarlo?`);
        if (ok) {
          this._loadJSON(json, 'autoguardado', true);   // keepResults: conservar caché de resultados
          this.toast('Sesión anterior recuperada', 'ok');
          restored = true;
        } else {
          localStorage.removeItem('portico_autosave');
        }
      }
    } catch (e) { console.warn('Autosave: no se pudo recuperar', e); }
    if (!restored) {
      // Iniciar SIEMPRE con un modelo nuevo y vacío (no se carga ningún ejemplo).
      this._loadJSON(this.serializer.toJSON(this.model), 'nuevo', false);
    }
    this.viewport.applyProjectMode();   // badge + cámara según modo del modelo
    this._offerCachedResults();
  }

  _updateTitle(filename) {
    const name = filename
      ? filename.replace(/\.[^.]+$/, '')
      : (this._fileHandle ? 'modelo' : 'Sin título');
    document.title = (this._dirty ? '● ' : '') + `${name} — PÓRTICO`;
  }

  _updateStats() {
    const s = this.model.getStats();
    document.getElementById('sb-model').textContent =
      `Nodos: ${s.nodes} | Elem: ${s.elements} | Mat: ${s.materials} | Sec: ${s.sections}`;
  }

  _downloadText(content, filename, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── P2-5: Export viewport as PNG ──────────────────────────────────────────
  exportViewportPNG() {
    // Force a render pass so the canvas buffer is current
    this.viewport._renderer.render(this.viewport._scene, this.viewport._camera);
    const url = this.viewport._renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `structweb3d_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.png`;
    a.click();
    this.toast('Imagen exportada', 'ok');
  }

  // ── Memoria / Bases de Cálculo (documento imprimible a PDF) ─────────────────
  async generarBasesCalculo() {
    if (this.model.nodes.size === 0) {
      this.toast('Modelo vacío — nada que documentar', 'warn'); return;
    }
    this.toast('Generando memoria de cálculo…');
    let imgs = { base: null, deformada: null, modos: [] };
    try { imgs = await this._capturarVistasMemoria(); }
    catch (e) { console.error('Captura de vistas falló:', e); }

    const diseno = await this._calcularDiseno();   // verificación de resistencia (si hay resultados)
    const deflex = this._calcularDeflexionesVigas(diseno?.params);   // servicio: flecha de vigas (sobrecarga sin mayorar)
    const drift  = this._calcularDrift();                            // servicio: derivas de entrepiso NCh433
    const html = this._memoriaHTML(imgs, diseno, deflex, drift);

    const win = window.open('', '_blank');
    if (!win) {
      this._downloadText(html, 'memoria_calculo.html', 'text/html;charset=utf-8');
      this.toast('Pop-up bloqueado — memoria descargada como HTML', 'warn');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    this.toast('Memoria generada — use «Imprimir → Guardar como PDF»', 'ok');
  }

  // Verificación de diseño (flexión/corte/axial) por elemento, usando los
  // resultados actuales y los parámetros editables de asistente/diseno_params.json.
  async _calcularDiseno() {
    const ver = '?v=101';
    let params = null;
    try { params = await fetch('asistente/diseno_params.json' + ver).then(r => r.json()); }
    catch (e) { console.error('No se pudo cargar diseno_params.json:', e); return null; }
    // Sin resultados: igual devolvemos los parámetros (métodos/normas/flechas).
    if (!this._results || typeof this._results.getElemForces !== 'function') {
      return { filas: [], params, caso: null };
    }
    try {
      const mod = await import('./design/diseno.js' + ver);

      // ── Conjunto de resultados de diseño: ENVOLVENTE sobre combinaciones ──
      // (las combos son los estados ULS factorizados). Si no hay combos resueltas,
      // se usan los casos estáticos individuales. _resultsByCase: lcId | 'C'+id.
      if (!this._resultsByCase) { try { this._reconstructResultsFromCache(); } catch {} }
      const byCase = this._resultsByCase;
      const disResults = [];
      if (byCase) {
        for (const c of (this.model.combinations?.values() || [])) {
          const r = byCase.get('C' + c.id); if (r) disResults.push({ nombre: c.name, res: r });
        }
        if (!disResults.length) {
          for (const lc of this.model.loadCases.values()) {
            if (lc.type === 'spectrum') continue;
            const r = byCase.get(lc.id); if (r) disResults.push({ nombre: lc.name, res: r });
          }
        }
      }
      if (!disResults.length) {
        const key = this._activeResultKey ?? this._activeLcId;
        const nom = this.model.loadCases.get(key)?.name || this.model.combinations?.get(key)?.name || `caso ${key}`;
        disResults.push({ nombre: nom, res: this._results });
      }

      const maxAbs = (res, eid, type) => {
        let d; try { d = res.getDiagramData(eid, type, 12); } catch { return 0; }
        let m = 0;
        for (const p of (d.pts || [])) m = Math.max(m, Math.abs(p.val));
        for (const e of (d.extremes || [])) m = Math.max(m, Math.abs(e.val));
        return m;
      };
      // La verificación de DEFORMACIONES se hace aparte (servicio): tabla de
      // flechas de vigas bajo sobrecarga de uso sin mayorar (_calcularDeflexionesVigas)
      // y derivas de entrepiso (_calcularDrift). Aquí solo resistencia (D/C).
      const filas = [];
      for (const el of this.model.elements.values()) {
        const sec = this.model.sections.get(el.secId);
        const mat = this.model.materials.get(el.matId);
        if (!sec || !mat) continue;
        let peor = null, peorNom = null, peorFuerzas = null;
        for (const { nombre, res } of disResults) {
          const f = res.getElemForces(el.id); if (!f) continue;
          const fuerzas = {
            N: (Math.sign(f.N) || 1) * maxAbs(res, el.id, 'N'),
            Vy: maxAbs(res, el.id, 'Vy'), Vz: maxAbs(res, el.id, 'Vz'),
            My: maxAbs(res, el.id, 'My'), Mz: maxAbs(res, el.id, 'Mz'), L: f.L,
          };
          const r = mod.verificarElemento({ fuerzas, sec, matNombre: mat.name, params });
          if (!peor || r.ratioMax > peor.ratioMax) { peor = r; peorNom = nombre; peorFuerzas = fuerzas; }
        }
        if (!peor) continue;
        filas.push({ id: el.id, mat: mat.name, sec: sec.name, fuerzas: peorFuerzas, combo: peorNom, ...peor });
      }
      filas.sort((a, b) => b.ratioMax - a.ratioMax);
      return { filas, params, caso: disResults.length > 1 ? `envolvente de ${disResults.length} estados` : disResults[0].nombre, envolvente: disResults.length > 1 };
    } catch (e) { console.error('Diseño falló:', e); return { filas: [], params, caso: null }; }
  }

  // ── Servicio: deformaciones de VIGAS bajo SOBRECARGA DE USO sin mayorar ────
  // Tabla solo de elementos viga (casi horizontales), flecha relativa a la cuerda
  // usando exclusivamente el caso de sobrecarga de uso (factor 1, sin combinar).
  _calcularDeflexionesVigas(params) {
    const out = { rows: [], note: '', caso: null, limSobre: (params?.flechas_admisibles?.viga_sobrecarga_L_sobre) || 360 };
    if (!this._resultsByCase) { try { this._reconstructResultsFromCache(); } catch {} }
    const byCase = this._resultsByCase;
    const isLive = lc => lc.type !== 'spectrum' && !lc.selfWeight && /viva|sobrecarga|uso|\bcv\b|live/i.test(lc.name || '');
    const lcLive = [...this.model.loadCases.values()].find(isLive);
    if (!lcLive) { out.note = 'No se identificó el caso de sobrecarga de uso. Nómbrelo con «sobrecarga», «viva», «uso» o «CV» (y sin peso propio).'; return out; }
    out.caso = lcLive.name;
    const res = byCase?.get(lcLive.id);
    if (!res || typeof res.getElemAtXi !== 'function') { out.note = `Ejecute el análisis estático (F5) para tener resultados del caso «${lcLive.name}».`; return out; }

    // Flecha máxima relativa a la cuerda recta entre los nodos (sag del vano).
    const flechaMax = (el) => {
      try {
        const u1 = res.getNodeDisp(el.n1), u2 = res.getNodeDisp(el.n2);
        if (!u1 || !u2) return 0;
        let dmax = 0;
        for (let k = 1; k < 10; k++) {
          const xi = k / 10, d = res.getElemAtXi(el.id, xi); if (!d) continue;
          const cx = u1[0] + xi * (u2[0] - u1[0]), cy = u1[1] + xi * (u2[1] - u1[1]), cz = u1[2] + xi * (u2[2] - u1[2]);
          dmax = Math.max(dmax, Math.hypot(d.ux - cx, d.uy - cy, d.uz - cz));
        }
        return dmax;
      } catch { return 0; }
    };

    for (const el of this.model.elements.values()) {
      const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
      if (!n1 || !n2) continue;
      const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
      if (L < 1e-9) continue;
      if (Math.abs(n2.z - n1.z) > 0.2 * L) continue;   // solo vigas (casi horizontales)
      const delta = flechaMax(el);
      const lim = L / out.limSobre;
      out.rows.push({ id: el.id, sec: this.model.sections.get(el.secId)?.name || '', L, delta, lim, ratio: lim > 1e-9 ? delta / lim : 0 });
    }
    out.rows.sort((a, b) => b.ratio - a.ratio);
    return out;
  }

  // ── Servicio: DERIVAS de entrepiso (drift) según NCh433 ────────────────────
  // (1) entre CENTROS DE MASA (nodos maestros de diafragma) y (2) entre los nodos
  // EXTERNOS (máximo desplazamiento del nivel). Ambas ≤ 0.002·h (2/1000 de la
  // altura de entrepiso). Usa los desplazamientos sísmicos (espectro F6+F7).
  _calcularDrift() {
    const limit = 0.002;
    const out = { limit, dirs: [], note: '', hasCM: false };
    const spec = this._spectrumResults;
    const dirDefs = [['X', 0, 'espX'], ['Y', 1, 'espY']].filter(([, , k]) => spec?.get(k)?.result);
    if (!dirDefs.length) { out.note = 'Las derivas usan los resultados sísmicos: ejecute Análisis Modal (F6) y Espectro de Respuesta (F7) en X y/o Y.'; return out; }

    // Niveles de piso: diafragmas (maestro = CM) si existen; si no, agrupar nodos por z.
    let levels;
    const diaphs = [...this.model.diaphragms.values()];
    if (diaphs.length) {
      levels = diaphs.map(d => ({ z: d.z, masterId: d.masterId, nodeIds: (d.nodes || []).filter(id => this.model.nodes.has(id)) }));
      out.hasCM = true;
    } else {
      const byZ = new Map();
      for (const n of this.model.nodes.values()) {
        if (Math.abs(n.z) < 0.01) continue;   // base
        const zk = Math.round(n.z * 100) / 100;
        if (!byZ.has(zk)) byZ.set(zk, []);
        byZ.get(zk).push(n.id);
      }
      levels = [...byZ.entries()].map(([z, ids]) => ({ z, masterId: null, nodeIds: ids }));
      out.note = 'Sin diafragmas rígidos: la deriva entre centros de masa requiere definir diafragmas (Análisis → diafragmas). Se reporta solo la deriva entre nodos externos por nivel de Z.';
    }
    levels.sort((a, b) => a.z - b.z);
    if (!levels.length) { out.note = 'No hay niveles de entrepiso (todos los nodos están en la base).'; return out; }

    for (const [dir, idx, key] of dirDefs) {
      const res = spec.get(key).result;
      const dispH = id => { try { return Math.abs(res.getNodeDisp(id)[idx]); } catch { return 0; } };
      const lvlData = levels.map(L => ({
        z: L.z,
        cm: L.masterId != null ? dispH(L.masterId) : null,
        ext: L.nodeIds.reduce((mx, id) => Math.max(mx, dispH(id)), 0),
      }));
      // Referencia de base (suelo) en z=0 con u=0
      let prev = { z: 0, cm: 0, ext: 0 };
      const stories = [];
      lvlData.forEach((cur, i) => {
        const h = cur.z - prev.z;
        if (h <= 1e-6) { prev = cur; return; }
        const driftCM = (cur.cm != null && prev.cm != null) ? Math.abs(cur.cm - prev.cm) / h : null;
        const driftExt = Math.abs(cur.ext - prev.ext) / h;
        stories.push({
          piso: i + 1, z: cur.z, h,
          driftCM, ratioCM: driftCM != null ? driftCM / limit : null, okCM: driftCM != null ? driftCM <= limit : null,
          driftExt, ratioExt: driftExt / limit, okExt: driftExt <= limit,
        });
        prev = cur;
      });
      out.dirs.push({ dir, stories });
    }
    return out;
  }

  // Captura base, deformada y hasta 3 modos, y restaura la vista del usuario.
  async _capturarVistasMemoria() {
    const vp  = this.viewport;
    const out = { base: null, deformada: null, modos: [] };
    const hadResults     = !!this._results;
    const hadModal       = !!this._modalResults;
    const prevMode       = this._modalMode;
    const prevType       = document.getElementById('result-type')?.value || 'deformed';
    const modalVisible   = !document.getElementById('modal-analysis-overlay')?.classList.contains('hidden');
    const resultsVisible = !document.getElementById('results-overlay')?.classList.contains('hidden');
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    const cm = this._config?.memoria || {};
    const b0  = this.model.getBounds();
    const span = Math.max(b0.max.x - b0.min.x, b0.max.y - b0.min.y, b0.max.z - b0.min.z, 1);

    // Mostrar IDs de nodos/elementos en las figuras (config)
    const idsPrev = vp._showIds;
    if (cm.mostrarIds && !vp._showIds) vp.toggleIds();
    else if (!cm.mostrarIds && vp._showIds) vp.toggleIds();

    vp.setView('iso');

    // Modelo base (sin deformada ni modos)
    vp.clearResults();
    await frame();
    out.base = vp.snapshot();

    // Deformada (si hay resultados estáticos)
    if (hadResults) {
      vp.showDeformed(this._results, null);
      await frame();
      out.deformada = vp.snapshot();
    }

    // Hasta 3 modos de vibrar (si hay análisis modal). Escala NORMALIZADA a ~12%
    // del span para que el modo se observe (antes span/5 quedaba muy chico).
    if (hadModal) {
      const mr = this._modalResults;
      const n = Math.min(3, mr.nModes);
      for (let i = 0; i < n; i++) {
        let maxd = 0;
        try { for (const d of mr.getModeShape(i).values()) maxd = Math.max(maxd, Math.hypot(d[0], d[1], d[2])); } catch {}
        const base = maxd > 1e-9 ? (span * 0.14) / maxd : span / 5;
        const scale = cm.modosVisibles !== false ? base : span / 5;
        vp.showModeShape(mr, i, scale);
        await frame();
        out.modos.push({ n: i + 1, freq: mr.freq[i], period: mr.period[i], img: vp.snapshot() });
      }
    }

    // Restaurar IDs y lo que el usuario tenía en pantalla
    if (vp._showIds !== idsPrev) vp.toggleIds();
    vp.clearResults();
    if (hadModal && modalVisible) {
      document.getElementById('modal-analysis-overlay')?.classList.remove('hidden');
      this._modalMode = prevMode;
      this._refreshModalView();
    } else if (hadResults && resultsVisible) {
      const s = document.getElementById('result-type'); if (s) s.value = prevType;
      document.getElementById('results-overlay')?.classList.remove('hidden');
      this._refreshResultView();
    }
    return out;
  }

  _memoriaHTML(imgs, diseno, deflex, drift) {
    const m = this.model;
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
    const fmt = (v, d = 3) => (v == null || !isFinite(v)) ? '—'
      : (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3) ? (+v).toExponential(2) : (+v).toFixed(d));
    const proyecto = (document.title || '').replace(/^●\s*/, '').replace(/\s*—\s*PÓRTICO.*$/i, '').trim() || 'Modelo sin título';
    const fecha = new Date().toLocaleDateString('es-CL', { year:'numeric', month:'long', day:'numeric' });
    const U = m.units || 'kN-m';
    const cm = this._config?.memoria || {};
    const clasif = (n) => { n = String(n||'').toLowerCase();
      if (/(horm|concret|h\s*\d|fc)/.test(n)) return 'hormigon';
      if (/(mader|pino|wood|gl\b|lvl|conif)/.test(n)) return 'madera';
      return 'acero'; };
    const dp = diseno?.params || null;

    // ── Materiales ──────────────────────────────────────────────────────────
    const matRows = [...m.materials.values()].map(mt => `<tr>
      <td>${esc(mt.name)}</td><td>${fmt(mt.E,0)}</td><td>${fmt(mt.G,0)}</td>
      <td>${fmt(mt.nu,2)}</td><td>${fmt(mt.rho,3)}</td></tr>`).join('') || '<tr><td colspan="5">Sin materiales</td></tr>';

    // ── Secciones (con conteo de elementos que la usan) ─────────────────────
    const secCount = new Map();
    for (const el of m.elements.values()) secCount.set(el.secId, (secCount.get(el.secId) || 0) + 1);
    const modTxt = (md) => { const o = md || {}; const a=o.A??1,iy=o.Iy??1,iz=o.Iz??1,j=o.J??1;
      return (a===1&&iy===1&&iz===1&&j===1) ? '—' : `A·${a} Iy·${iy} Iz·${iz} J·${j}`; };
    const secRows = [...m.sections.values()].map(s => `<tr>
      <td>${esc(s.name)}</td><td>${fmt(s.A,5)}</td><td>${fmt(s.Iy,6)}</td><td>${fmt(s.Iz,6)}</td>
      <td>${fmt(s.J,6)}</td><td>${fmt(s.Avy,5)}</td><td>${fmt(s.Avz,5)}</td>
      <td>${modTxt(s.mod)}</td><td>${secCount.get(s.id) || 0}</td></tr>`).join('') || '<tr><td colspan="9">Sin secciones</td></tr>';

    // ── Clasificación de casos y cargas ─────────────────────────────────────
    const tipoCaso = (lc) => {
      if (lc.type === 'spectrum') return 'Sísmica (espectro)';
      const n = (lc.name || '').toLowerCase();
      if (/vient|wind/.test(n)) return 'Viento';
      if (/niev|snow/.test(n)) return 'Nieve';
      if (/sism|seism|\bsx\b|\bsy\b|\beq\b/.test(n)) return 'Sísmica';
      if (/sobre|live|\bcv\b|uso/.test(n)) return 'Sobrecarga de uso';
      if (/event|acc/.test(n)) return 'Eventual';
      if (/perm|muert|\bcm\b|dead|propio/.test(n) || lc.selfWeight) return 'Permanente';
      return 'Carga';
    };
    const dirLabel = { gravity:'Gravedad ↓ (−Z)', globalX:'Global +X', globalY:'Global +Y',
      globalZ:'Global +Z', localY:'Local y', localZ:'Local z', x:'Global +X', y:'Global +Y', z:'Global +Z' };

    const casosStatic = [...m.loadCases.values()].filter(lc => lc.type !== 'spectrum');
    const cargasHTML = casosStatic.map(lc => {
      const loadRows = (lc.loads || []).map(ld => {
        if (ld.type === 'nodal') {
          const [Fx,Fy,Fz,Mx,My,Mz] = ld.F || [];
          return `<tr><td>Puntual</td><td>Nodo ${ld.nodeId}</td><td>—</td>
            <td>F=(${fmt(Fx,2)}, ${fmt(Fy,2)}, ${fmt(Fz,2)}) kN · M=(${fmt(Mx,2)}, ${fmt(My,2)}, ${fmt(Mz,2)}) kN·m</td></tr>`;
        }
        if (ld.type === 'temp') {
          return `<tr><td>Temperatura</td><td>Elem ${ld.elemId}</td><td>Uniforme</td><td>ΔT = ${fmt(ld.dT,1)} °C</td></tr>`;
        }
        return `<tr><td>Distribuida</td><td>Elem ${ld.elemId}</td>
          <td>${esc(dirLabel[ld.dir] || ld.dir || 'Gravedad')}</td><td>w = ${fmt(ld.w,2)} kN/m</td></tr>`;
      }).join('');
      const cuerpo = loadRows || `<tr><td colspan="4" class="muted">${lc.selfWeight ? 'Solo peso propio' : 'Sin cargas asignadas'}</td></tr>`;
      return `<h3>${esc(lc.name)} <span class="tag">${tipoCaso(lc)}</span>${lc.selfWeight ? ' <span class="tag tag-pp">+ peso propio</span>' : ''}</h3>
        <table><thead><tr><th>Tipo</th><th>Aplicada en</th><th>Dirección</th><th>Valor</th></tr></thead>
        <tbody>${cuerpo}</tbody></table>`;
    }).join('') || '<p class="muted">No hay casos de carga estáticos definidos.</p>';

    // ── Sísmico (espectros con sus parámetros NCh433/DS61) ──────────────────
    let sismoHTML = '';
    const espectros = [...this._spectrumResults.values()].filter(e => e?.params);
    if (espectros.length) {
      sismoHTML = espectros.map(({ params: p }) => {
        const k = p.nch433 || {};
        const tabla = `<table><tbody>
          <tr><th>Dirección sísmica</th><td>${esc(p.direction)}</td><th>Método combinación</th><td>${esc(p.method)}</td></tr>
          <tr><th>Zona sísmica</th><td>${esc(k.zona ?? '—')} (A₀ = ${fmt(k.Ao,2)} g)</td><th>Tipo de suelo</th><td>${esc(k.suelo ?? '—')} (S=${fmt(k.S,2)}, T₀=${fmt(k.To,2)}, p=${fmt(k.p,2)})</td></tr>
          <tr><th>Categoría de importancia</th><td>${esc(k.cat ?? '—')} (I = ${fmt(k.I,2)})</td><th>Amortiguamiento ζ</th><td>${fmt(p.zeta,2)}</td></tr>
          <tr><th>R₀</th><td>${fmt(k.Ro,1)}</td><th>R* / T*</th><td>R*=${fmt(k.Rstar,3)} ${k.Tstar ? `(T*=${fmt(k.Tstar,3)} s)` : '(elástico)'}</td></tr>
        </tbody></table>`;
        return `<h3>Espectro de respuesta — dirección ${esc(p.direction)}</h3>
          ${tabla}
          <div class="spec-graph">${this._memoriaEspectroSVG(p.spectrum)}</div>
          <p class="muted">Sa(T) = S·A₀·I·α(T)/R* (NCh433 / DS61). Unidad de Sa: ${esc(k.unidadSa || 'g')}.</p>`;
      }).join('');
    } else {
      sismoHTML = '<p class="muted">No se ha ejecutado un análisis de espectro de respuesta. ' +
        'Ejecute «Análisis → Espectro de Respuesta (F7)» para documentar zona sísmica, suelo, importancia y el espectro de diseño.</p>';
    }

    // ── Modal (3 modos) ─────────────────────────────────────────────────────
    let modalHTML = '';
    if (this._modalResults) {
      const { rows } = this._modalResults.getParticipation();
      const partRows = rows.slice(0, Math.max(3, Math.min(rows.length, 12))).map(r => `<tr>
        <td>${r.mode}</td><td>${fmt(r.freq,3)}</td><td>${fmt(r.period,3)}</td>
        <td>${fmt(r.pct[0],1)}</td><td>${fmt(r.pct[1],1)}</td><td>${fmt(r.pct[2],1)}</td>
        <td>${fmt(r.cumPct[0],1)}</td><td>${fmt(r.cumPct[1],1)}</td><td>${fmt(r.cumPct[2],1)}</td></tr>`).join('');
      const modeImgs = imgs.modos.map(md => `<figure>
        <img src="${md.img}" alt="Modo ${md.n}">
        <figcaption>Modo ${md.n} — f = ${fmt(md.freq,3)} Hz · T = ${fmt(md.period,3)} s</figcaption></figure>`).join('');
      modalHTML = `
        <p>Modos extraídos: ${this._modalResults.nModes}. Frecuencias y períodos de los primeros modos:</p>
        <table><thead><tr><th>Modo</th><th>f (Hz)</th><th>T (s)</th>
          <th>Mx (%)</th><th>My (%)</th><th>Mrz (%)</th><th>ΣMx</th><th>ΣMy</th><th>ΣMrz</th></tr></thead>
          <tbody>${partRows}</tbody></table>
        <p class="muted">Mx/My/Mrz = masa modal participante (%). Σ = acumulada.</p>
        ${modeImgs ? `<div class="figrow">${modeImgs}</div>` : ''}`;
    } else {
      modalHTML = '<p class="muted">No se ha ejecutado el análisis modal. Ejecute «Análisis → Análisis Modal (F6)» para documentar los modos de vibrar.</p>';
    }

    // ── Imágenes del modelo ─────────────────────────────────────────────────
    const idsNota = cm.mostrarIds ? ' — con IDs de nodos y elementos' : '';
    const figBase = imgs.base ? `<figure><img src="${imgs.base}" alt="Modelo base"><figcaption>Modelo estructural (geometría base${idsNota})</figcaption></figure>` : '';
    const figDef  = imgs.deformada ? `<figure><img src="${imgs.deformada}" alt="Deformada"><figcaption>Deformada (resultado estático${idsNota})</figcaption></figure>`
      : '<p class="muted">Deformada no disponible — ejecute el análisis estático (F5).</p>';

    const s = m.getStats();

    // ── Métodos de diseño (solo materiales presentes) ───────────────────────
    const tipos = new Set([...m.materials.values()].map(mt => clasif(mt.name)));
    const nombreTipo = { acero:'Acero estructural', hormigon:'Hormigón armado', madera:'Madera' };
    const metodosHTML = dp ? [...tipos].map(t => {
      const p = dp[t] || {};
      let det = '';
      if (t === 'acero')    det = `Fy = ${fmt(p.Fy_MPa,0)} MPa · Fu = ${fmt(p.Fu_MPa,0)} MPa · E = ${fmt(p.E_MPa,0)} MPa · φ_b=${p.phi?.flexion} φ_v=${p.phi?.corte} φ_c=${p.phi?.axial_compresion}`;
      if (t === 'hormigon') det = `f′c = ${fmt(p.fc_MPa,0)} MPa · fy = ${fmt(p.fy_refuerzo_MPa,0)} MPa · cuantía ρ = ${fmt(p.cuantia_long_rho,3)} · rec. = ${fmt(p.recubrimiento_mm,0)} mm · φ_b=${p.phi?.flexion} φ_v=${p.phi?.corte}`;
      if (t === 'madera')   det = `Fb = ${fmt(p.Fb_MPa,1)} · Fv = ${fmt(p.Fv_MPa,1)} · Fc = ${fmt(p.Fc_MPa,1)} · Ft = ${fmt(p.Ft_MPa,1)} MPa · ∏Ki = ${fmt(Object.values(p.factores_modificacion||{}).reduce((a,b)=>a*b,1),2)}`;
      return `<tr><th>${nombreTipo[t]}</th><td>${esc(p.metodo||'—')}<br><span class="muted">${det}</span></td></tr>`;
    }).join('') : '<tr><td colspan="2" class="muted">Parámetros de diseño no disponibles.</td></tr>';

    // ── Normas y códigos ────────────────────────────────────────────────────
    const normas = [
      ['Acción sísmica', 'NCh433.Of96 Mod.2009 · DS61 (espectro de diseño)'],
      ['Cargas y sobrecargas', 'NCh1537.Of2009 (permanentes y sobrecargas de uso)'],
      ['Combinaciones de carga', 'NCh3171.Of2010 (disposiciones generales)'],
      ['Viento', 'NCh432.Of2010'],
      ['Nieve', 'NCh431.Of2010'],
      ['Acero estructural', 'NCh427/1 · ANSI/AISC 360-16 (LRFD)'],
      ['Hormigón armado', 'NCh430 · ACI 318'],
      ['Madera estructural', 'NCh1198 (tensiones admisibles modificadas)'],
    ].map(([a,b]) => `<tr><th>${a}</th><td>${esc(b)}</td></tr>`).join('');

    // ── Combinaciones de carga del modelo ───────────────────────────────────
    const lcName = id => m.loadCases.get(id)?.name || m.combinations?.get(id)?.name || `LC${id}`;
    const comboRows = [...(m.combinations?.values() || [])].map(c =>
      `<tr><td>${esc(c.name)}</td><td>${(c.factors||[]).map(f => `${fmt(f.factor,2)}·${esc(lcName(f.lcId))}`).join('  +  ') || '—'}</td></tr>`).join('')
      || '<tr><td colspan="2" class="muted">No hay combinaciones definidas.</td></tr>';

    // ── Flechas admisibles ──────────────────────────────────────────────────
    const fl = dp?.flechas_admisibles || {};
    const flechasHTML = `<table><tbody>
      <tr><th>Viga — carga total</th><td>L / ${fl.viga_carga_total_L_sobre ?? 300}</td>
          <th>Viga — sobrecarga</th><td>L / ${fl.viga_sobrecarga_L_sobre ?? 360}</td></tr>
      <tr><th>Voladizo</th><td>L / ${fl.voladizo_L_sobre ?? 150}</td>
          <th>δ máx del modelo</th><td>${this._results?.getMaxDisp ? fmt(this._results.getMaxDisp(),5)+' m' : '—'}</td></tr>
    </tbody></table>
    <p class="muted">Límites como fracción de la luz L. La verificación de flecha por elemento debe contrastarse con la luz libre de cada vano.</p>`;

    // ── Diseño de elementos: verificación de RESISTENCIA flexión/corte/axial ──
    // (las DEFORMACIONES de servicio van en su propia sección, no aquí).
    let disenoHTML;
    const rClass = r => r > 1.0 ? 'r-bad' : r > 0.9 ? 'r-warn' : 'r-ok';
    if (diseno && diseno.filas && diseno.filas.length) {
      const f = diseno.filas;
      const malo = x => x.ratioMax > 1;
      const aj   = x => !malo(x) && x.ratioMax > 0.9;
      const nNo = f.filter(malo).length;
      const nAj = f.filter(aj).length;
      const nOk = f.length - nNo - nAj;
      const top = f.slice(0, 60);
      const rows = top.map(x => `<tr>
        <td>#${x.id}</td><td>${esc(x.sec)}</td><td>${esc(x.mat)}</td><td title="${esc(x.combo||'')}">${esc((x.combo||'').slice(0,14))}</td>
        <td>${fmt(x.fuerzas.N,1)}</td><td>${fmt(Math.max(x.fuerzas.My,x.fuerzas.Mz),1)}</td><td>${fmt(Math.max(x.fuerzas.Vy,x.fuerzas.Vz),1)}</td>
        <td class="${rClass(x.flexion.ratio)}">${fmt(x.flexion.ratio,2)}</td>
        <td class="${rClass(x.corte.ratio)}">${fmt(x.corte.ratio,2)}</td>
        <td class="${rClass(x.axial.ratio)}">${fmt(x.axial.ratio,2)}</td>
        <td class="${rClass(x.interaccion?.ratio)}">${fmt(x.interaccion?.ratio,2)}</td>
        <td>${x.gobierna}</td>
        <td class="${rClass(x.ratioMax)}"><b>${fmt(x.ratioMax,2)}</b></td>
        <td class="${malo(x)?'r-bad':aj(x)?'r-warn':'r-ok'}">${malo(x)?'NO CUMPLE':aj(x)?'ajustado':'cumple'}</td></tr>`).join('');
      disenoHTML = `
        <p>Verificación de <b>resistencia</b> por <b>${diseno.envolvente ? 'envolvente de las combinaciones de carga' : `el estado «${esc(diseno.caso||'activo')}»`}</b>:
        para cada elemento se reporta la combinación más desfavorable. La razón <b>D/C = demanda/capacidad</b> debe ser ≤ 1.0.
        Las deformaciones (servicio) se verifican en la sección de deformaciones de vigas. Parámetros en <code>asistente/diseno_params.json</code>.</p>
        <table style="font-size:9.5px"><thead><tr>
          <th>Elem</th><th>Sección</th><th>Material</th><th>Combo</th><th>N (kN)</th><th>M (kN·m)</th><th>V (kN)</th>
          <th>flex.</th><th>corte</th><th>axial</th><th>interac.</th><th>Gobierna</th><th>D/C máx</th><th>Estado</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">${f.length > 60 ? `Se muestran los 60 elementos más solicitados de ${f.length}. ` : ''}
        Resumen: <b class="r-ok">${nOk} cumplen</b> · <b class="r-warn">${nAj} ajustados</b> · <b class="r-bad">${nNo} no cumplen</b>.
        D/C: flexión/corte/axial e interacción flexo-axial. Colores: verde ≤ 0.90 · ámbar 0.90–1.00 · rojo &gt; 1.00.</p>`;
    } else {
      disenoHTML = '<p class="muted">No hay resultados de análisis para verificar. Ejecute el análisis estático (F5) con sus combinaciones de carga antes de generar la memoria.</p>';
    }

    // ── Deformaciones de vigas (servicio · sobrecarga de uso sin mayorar) ─────
    let deflexHTML;
    if (deflex && deflex.rows && deflex.rows.length) {
      const dr = deflex.rows.slice(0, 60);
      const rows = dr.map(x => `<tr>
        <td>#${x.id}</td><td>${esc(x.sec)}</td><td>${fmt(x.L,2)}</td>
        <td>${fmt(x.delta*1000,2)}</td><td>L/${deflex.limSobre} = ${fmt(x.lim*1000,2)}</td>
        <td class="${rClass(x.ratio)}"><b>${fmt(x.ratio,2)}</b></td>
        <td class="${x.ratio>1?'r-bad':x.ratio>0.9?'r-warn':'r-ok'}">${x.ratio>1?'NO CUMPLE':x.ratio>0.9?'ajustado':'cumple'}</td></tr>`).join('');
      const nNo = deflex.rows.filter(x => x.ratio > 1).length;
      deflexHTML = `
        <p>Flecha de las <b>vigas</b> (elementos casi horizontales) bajo el caso de <b>sobrecarga de uso «${esc(deflex.caso)}» sin mayorar</b>
        (factor 1.0), medida respecto a la cuerda recta del vano. Límite de servicio L/${deflex.limSobre}.</p>
        <table style="font-size:9.5px"><thead><tr>
          <th>Viga</th><th>Sección</th><th>L (m)</th><th>δ (mm)</th><th>δ admisible (mm)</th><th>δ/δadm</th><th>Estado</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">${deflex.rows.length > 60 ? `Se muestran las 60 vigas más deformadas de ${deflex.rows.length}. ` : ''}
        ${nNo ? `<b class="r-bad">${nNo} viga(s) superan el límite.</b> ` : 'Todas cumplen el límite de servicio. '}
        δ = flecha relativa máxima en el vano por sobrecarga de uso (sin mayorar).</p>`;
    } else {
      deflexHTML = `<p class="muted">${esc(deflex?.note || 'Sin datos de deformaciones de vigas.')}</p>`;
    }

    // ── Derivas sísmicas de entrepiso (NCh433) ────────────────────────────────
    let driftHTML;
    if (drift && drift.dirs && drift.dirs.length) {
      const cls = ok => ok === false ? 'r-bad' : ok === true ? 'r-ok' : '';
      const lblOk = ok => ok === false ? 'NO CUMPLE' : ok === true ? 'cumple' : '—';
      const cell = (v, d = 5) => v == null ? '—' : fmt(v, d);
      driftHTML = drift.dirs.map(D => {
        const rows = D.stories.map(s => `<tr>
          <td>${s.piso}</td><td>${fmt(s.z,2)}</td><td>${fmt(s.h,2)}</td>
          <td>${cell(s.driftCM)}</td><td class="${cls(s.okCM)}">${cell(s.ratioCM,2)}</td><td class="${cls(s.okCM)}">${lblOk(s.okCM)}</td>
          <td>${cell(s.driftExt)}</td><td class="${cls(s.okExt)}">${cell(s.ratioExt,2)}</td><td class="${cls(s.okExt)}">${lblOk(s.okExt)}</td></tr>`).join('');
        return `<h3>Dirección sísmica ${esc(D.dir)}</h3>
        <table style="font-size:9.5px"><thead><tr>
          <th>Piso</th><th>Z (m)</th><th>h (m)</th>
          <th>δ/h (CM)</th><th>·/0.002</th><th>Estado CM</th>
          <th>δ/h (ext.)</th><th>·/0.002</th><th>Estado ext.</th>
        </tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">Sin entrepisos.</td></tr>'}</tbody></table>`;
      }).join('');
      driftHTML += `<p class="muted">Deriva de entrepiso δ/h = desplazamiento relativo entre pisos consecutivos ÷ altura de entrepiso.
        <b>Límite NCh433: 0.002</b> (2/1000) tanto entre <b>centros de masa</b> (Art. 5.9.2) como entre <b>nodos externos</b> del piso (Art. 5.9.3).
        Calculada con los desplazamientos del espectro de respuesta.${drift.hasCM ? '' : ' <i>Sin diafragmas: se reporta solo la deriva entre nodos externos.</i>'}</p>`;
    } else {
      driftHTML = `<p class="muted">${esc(drift?.note || 'Sin datos de derivas sísmicas.')}</p>`;
    }

    // ── Portada (estilo institucional, configurable) ────────────────────────
    // Logos: versión académica = UACh + Facultad + IOC; versión profesional puede
    // anteponer el logo de la empresa.
    const logosAcad = `<div class="cover-logos">
        <img src="icons/UACh-color-negro.svg" alt="UACh"><img src="icons/Facultad-color-negro.svg" alt="Facultad"><img src="icons/IOC-color.svg" alt="IOC"></div>`;
    const logoEmp = (this._pro && cm.logoEmpresa) ? `<div class="cover-logo-emp"><img src="${cm.logoEmpresa}" alt="Empresa"></div>` : '';
    const portada = `<section class="cover">
      ${logoEmp}${logosAcad}
      <div class="cover-inst">${esc(cm.institucion || 'UNIVERSIDAD AUSTRAL DE CHILE')}<br><span>${esc(cm.subInstitucion || 'Facultad de Ciencias de la Ingeniería · Instituto de Obras Civiles')}</span></div>
      <svg class="cover-frame" viewBox="0 0 360 200" aria-hidden="true">
        <path d="M60 175 V55 H300 V175" fill="none" stroke="#0a3a57" stroke-width="4" stroke-linecap="round"/>
        <path d="M46 188 L74 188 L60 175 Z" fill="#0d9488"/><path d="M286 188 L314 188 L300 175 Z" fill="#0d9488"/>
        <path d="M44 188 H76 M284 188 H316" stroke="#0a3a57" stroke-width="2"/>
        <circle cx="60" cy="55" r="5" fill="#0e7fc0"/><circle cx="300" cy="55" r="5" fill="#0e7fc0"/>
      </svg>
      <div class="cover-kicker">${esc(cm.kicker || 'ANÁLISIS Y DISEÑO ESTRUCTURAL')}</div>
      <h1 class="cover-title">${esc(cm.titulo || 'Memoria de Cálculo')}</h1>
      <div class="cover-proj">${esc(proyecto)}</div>
      <div class="cover-badge">Producto académico — generado con PÓRTICO, laboratorio virtual de análisis estructural 3D (IOC · UACh)</div>
      <table class="cover-meta"><tbody>
        <tr><th>Proyecto</th><td>${esc(proyecto)}</td></tr>
        <tr><th>Fecha</th><td>${esc(fecha)}</td></tr>
        <tr><th>Unidades</th><td>${esc(U.replace('-',' · '))}</td></tr>
        <tr><th>Proyectista</th><td>${esc(cm.proyectista) || '&nbsp;'}</td></tr>
        <tr><th>Revisó</th><td>${esc(cm.revisor) || '&nbsp;'}</td></tr>
      </tbody></table>
      <p class="cover-note">Documento de carácter docente. Los resultados deben ser validados por un profesional competente antes de cualquier uso en obra.</p>
    </section>`;
    const descripcionHTML = (this._pro && cm.descripcion) ? `<p>${esc(cm.descripcion)}</p>` : '';
    // Pie y limitaciones: académicos por defecto; editables solo con token profesional.
    const footerTxt = (this._pro && cm.footer) ? cm.footer : this._ACAD_FOOTER;
    const limitItems = (this._pro && cm.limitaciones)
      ? cm.limitaciones.split('\n').map(s => s.trim()).filter(Boolean).map(esc)
      : this._ACAD_LIMITS;
    const limitHTML = limitItems.map(li => `<li>${li}</li>`).join('');

    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<base href="${esc(location.origin)}/">
<title>${esc(cm.titulo || 'Memoria de Cálculo')} — ${esc(proyecto)}</title>
<style>
  :root{--ink:#1b2533;--mut:#5c6a7d;--bd:#cdd6e3;--ac:#0e7fc0;--head:#0a3a57;--teal:#0d9488;}
  *{box-sizing:border-box;}
  body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--ink);margin:0;padding:30px 40px 64px;font-size:12px;line-height:1.5;}
  h1{font-size:22px;color:var(--head);margin:0 0 2px;}
  h2{font-size:15px;color:var(--head);border-bottom:2px solid var(--ac);padding-bottom:3px;margin:24px 0 10px;}
  h3{font-size:13px;color:var(--head);margin:15px 0 6px;}
  .sub{color:var(--mut);font-size:12px;margin:0 0 4px;}
  table{width:100%;border-collapse:collapse;margin:6px 0 12px;font-size:11px;}
  th,td{border:1px solid var(--bd);padding:4px 7px;text-align:left;vertical-align:top;}
  th{background:#eef3f9;color:var(--head);font-weight:600;}
  td{font-variant-numeric:tabular-nums;}
  code{background:#eef3f9;padding:0 4px;border-radius:3px;font-size:11px;}
  .muted{color:var(--mut);}
  .tag{display:inline-block;background:var(--ac);color:#fff;font-size:9px;padding:1px 7px;border-radius:9px;vertical-align:middle;font-weight:600;}
  .tag-pp{background:#15803d;}
  figure{margin:8px 0;text-align:center;}
  img{max-width:100%;border:1px solid var(--bd);border-radius:6px;background:#f6f8fb;}
  figcaption{color:var(--mut);font-size:10px;margin-top:3px;}
  .figrow{display:flex;flex-wrap:wrap;gap:10px;}
  .figrow figure{flex:1 1 30%;min-width:200px;margin:4px 0;}
  .spec-graph{border:1px solid var(--bd);border-radius:6px;padding:6px;background:#f6f8fb;max-width:480px;}
  .r-ok{background:#e8f6ed;color:#15803d;} .r-warn{background:#fdf3e2;color:#b45309;} .r-bad{background:#fde8e8;color:#dc2626;font-weight:700;}
  .print-btn{position:fixed;top:12px;right:12px;background:var(--ac);color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);z-index:10;}
  .page-footer{position:fixed;bottom:0;left:0;right:0;height:42px;display:flex;align-items:center;justify-content:space-between;
    padding:0 40px;font-size:9px;color:var(--mut);border-top:1px solid var(--bd);background:#fff;}
  .page-footer b{color:var(--head);}
  .cover{min-height:88vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;page-break-after:always;}
  .cover-logos{display:flex;gap:22px;align-items:center;justify-content:center;margin-bottom:10px;flex-wrap:wrap;}
  .cover-logos img{height:46px;width:auto;border:none;background:none;border-radius:0;}
  .cover-logo-emp{margin-bottom:8px;} .cover-logo-emp img{height:54px;width:auto;border:none;background:none;}
  .cover-inst{font-size:12px;letter-spacing:.5px;color:var(--head);font-weight:600;margin-bottom:6px;}
  .cover-inst span{display:block;font-weight:400;color:var(--mut);font-size:10px;letter-spacing:0;}
  .cover-frame{width:240px;height:auto;margin:14px 0;}
  .cover-kicker{letter-spacing:3px;font-size:12px;color:var(--teal);font-weight:600;}
  .cover-title{font-size:38px;color:var(--head);margin:4px 0 2px;letter-spacing:1px;}
  .cover-proj{font-size:16px;color:var(--ink);margin-bottom:14px;}
  .cover-badge{max-width:480px;font-size:11px;color:var(--mut);border:1px dashed var(--bd);border-radius:8px;padding:8px 12px;margin-bottom:18px;}
  .cover-meta{max-width:420px;font-size:12px;} .cover-meta th{width:120px;}
  .cover-note{max-width:480px;font-size:10px;color:var(--mut);margin-top:16px;font-style:italic;}
  @media print{.print-btn{display:none;} h2{break-after:avoid;} table,figure{break-inside:avoid;} body{padding:0 40px 64px;}}
</style></head><body>
<button class="print-btn" onclick="window.print()">🖨 Imprimir / Guardar PDF</button>
<div class="page-footer"><span><b>PÓRTICO</b> · ${esc(cm.titulo || 'Memoria de Cálculo')} — ${esc(proyecto)}</span>
  <span>${esc(footerTxt)}</span>
  <span>${esc(fecha)}</span></div>

${portada}

<h2>1. Bases de cálculo</h2>

<h3>1.1 Descripción del modelo</h3>
${descripcionHTML}
<table><tbody>
  <tr><th>Nodos</th><td>${s.nodes}</td><th>Elementos</th><td>${s.elements}</td></tr>
  <tr><th>Materiales</th><td>${s.materials}</td><th>Secciones</th><td>${s.sections}</td></tr>
  <tr><th>Modo del proyecto</th><td>${esc(m.mode || '3D')}</td><th>Casos de carga</th><td>${m.loadCases.size}</td></tr>
</tbody></table>
${figBase}

<h3>1.2 Métodos de diseño</h3>
<table><tbody>${metodosHTML}</tbody></table>

<h3>1.3 Normas y códigos</h3>
<table><tbody>${normas}</tbody></table>

<h3>1.4 Materiales y propiedades mecánicas</h3>
<table><thead><tr><th>Material</th><th>E (kN/m²)</th><th>G (kN/m²)</th><th>ν</th><th>ρ (t/m³)</th></tr></thead>
<tbody>${matRows}</tbody></table>

<h3>1.5 Secciones</h3>
<table><thead><tr><th>Sección</th><th>A (m²)</th><th>Iy (m⁴)</th><th>Iz (m⁴)</th><th>J (m⁴)</th><th>Avy (m²)</th><th>Avz (m²)</th><th>Modif. rigidez</th><th># elem</th></tr></thead>
<tbody>${secRows}</tbody></table>

<h3>1.6 Cargas y sobrecargas</h3>
${cargasHTML}

<h3>1.7 Acción sísmica</h3>
${sismoHTML}

<h3>1.8 Combinaciones de carga</h3>
<table><thead><tr><th>Combinación</th><th>Factores</th></tr></thead><tbody>${comboRows}</tbody></table>

<h3>1.9 Flechas admisibles</h3>
${flechasHTML}

<h2>2. Análisis estructural</h2>
<h3>2.1 Modelo deformado</h3>
${figDef}
<h3>2.2 Análisis modal — modos de vibrar</h3>
${modalHTML}

<h2>3. Diseño de elementos (resistencia)</h2>
${disenoHTML}

<h2>4. Verificaciones de servicio</h2>
<h3>4.1 Deformaciones de vigas — sobrecarga de uso (sin mayorar)</h3>
${deflexHTML}
<h3>4.2 Derivas sísmicas de entrepiso — NCh433 (límite 2/1000·h)</h3>
${driftHTML}

<h2>5. Limitaciones y alcances</h2>
<ul style="font-size:11px;line-height:1.6">${limitHTML}</ul>
</body></html>`;
  }

  // SVG del espectro Sa(T) para la memoria de cálculo.
  _memoriaEspectroSVG(pts) {
    if (!Array.isArray(pts) || pts.length < 2) return '<p class="muted">Sin curva.</p>';
    const W = 460, H = 220, ml = 46, mr = 12, mt = 12, mb = 30;
    const Tmax = Math.max(...pts.map(p => p.T)) || 1;
    const Smax = Math.max(...pts.map(p => p.Sa)) || 1;
    const sx = t => ml + (t / Tmax) * (W - ml - mr);
    const sy = s => H - mb - (s / Smax) * (H - mt - mb);
    const poly = pts.map(p => `${sx(p.T).toFixed(1)},${sy(p.Sa).toFixed(1)}`).join(' ');
    const gx = [0,0.25,0.5,0.75,1].map(f => { const t=+(f*Tmax).toFixed(2);
      return `<line x1="${sx(t)}" y1="${mt}" x2="${sx(t)}" y2="${H-mb}" stroke="#dde5ef"/><text x="${sx(t)}" y="${H-10}" fill="#5c6a7d" font-size="9" text-anchor="middle">${t}</text>`; }).join('');
    const gy = [0,0.25,0.5,0.75,1].map(f => { const sv=+(f*Smax).toFixed(3);
      return `<line x1="${ml}" y1="${sy(sv)}" x2="${W-mr}" y2="${sy(sv)}" stroke="#dde5ef"/><text x="${ml-5}" y="${sy(sv)+3}" fill="#5c6a7d" font-size="9" text-anchor="end">${sv}</text>`; }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
      ${gy}${gx}
      <polyline points="${poly}" fill="none" stroke="#0e7fc0" stroke-width="2"/>
      <text x="${ml}" y="${mt-1}" fill="#5c6a7d" font-size="9">Sa</text>
      <text x="${W-mr}" y="${H-2}" fill="#5c6a7d" font-size="9" text-anchor="end">T (s)</text>
    </svg>`;
  }

  // ── Toast notifications ────────────────────────────────────────────────────
  toast(msg, type = '') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast${type ? ' ' + type : ''}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ── Modal helpers ──────────────────────────────────────────────────────────
  _bindModal() {
    document.getElementById('modal-cancel')?.addEventListener('click', () => {
      const overlay = document.getElementById('modal-overlay');
      overlay.classList.add('hidden');
      document.getElementById('modal-box')?.classList.remove('modal-wide');
      document.getElementById('modal-cancel').style.display = '';
      if (overlay._reject) overlay._reject(new Error('cancelled'));
    });
    document.getElementById('modal-ok')?.addEventListener('click', () => {
      const overlay = document.getElementById('modal-overlay');
      overlay.classList.add('hidden');
      document.getElementById('modal-box')?.classList.remove('modal-wide');
      document.getElementById('modal-cancel').style.display = '';
      if (overlay._resolve) overlay._resolve(true);
    });
  }

  _confirm(msg) {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = 'Confirmar';
      document.getElementById('modal-body').innerHTML = `<p style="color:var(--text)">${msg}</p>`;
      document.getElementById('modal-cancel').style.display = '';
      overlay.classList.remove('hidden');
      overlay._resolve = resolve;
      overlay._reject  = () => resolve(false);
    });
  }

  _alert(title, html) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-cancel').style.display = 'none';
    overlay.classList.remove('hidden');
    overlay._resolve = () => {};
    overlay._reject  = () => {};
  }

  // ── Electron native menu → app methods ────────────────────────────────────
  _bindElectronMenu() {
    if (!window.electronAPI) return;
    window.electronAPI.onMenu('menu:new',  () => this.newFile());
    window.electronAPI.onMenu('menu:open', () => this.openFile());
    window.electronAPI.onMenu('menu:save', () => this.saveFile());
    window.electronAPI.onMenu('menu:undo', () => this.undo());
    window.electronAPI.onMenu('menu:redo', () => this.redo());
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  _bindKeys() {
    document.addEventListener('keydown', e => {
      const tag = document.activeElement?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl) {
        switch (e.key.toLowerCase()) {
          case 'z': e.preventDefault(); this.undo();        break;
          case 'y': e.preventDefault(); this.redo();        break;
          case 's': e.preventDefault(); this.saveFile();    break;
          case 'o': e.preventDefault(); this.openFile();    break;
          case 'n': e.preventDefault(); this.newFile();     break;
          case 'a': e.preventDefault(); this.viewport.selectAll(); break;
        }
        return;
      }

      if (inInput) return;

      switch (e.key.toLowerCase()) {
        case 's':      this.viewport.setMode('select');     break;
        case 'n':      this.viewport.setMode('addnode');    break;
        case 'e':      this.viewport.setMode('addelem');    break;
        case 'r':      this.viewport.setMode('addsupport'); break;
        case 'd':      this.viewport.toggleIds();           break;
        case 'x':      this.viewport.toggleExtruded();      break;
        case 'delete':
        case 'backspace': this.deleteSelected();            break;
        case 'home':   this.viewport.zoomExtents();         break;
        case 'i':      this.viewport.setView('iso');        break;
        case 't':      this.viewport.setView('top');        break;
        case 'f':      this.viewport.setView('front');      break;
        case 'l':      this.viewport.setView('side');       break;
        case 'g':      this.viewport.toggleGrid();          break;
        case 'h':      if (e.shiftKey) this.showAllElements(); else this.hideSelected(); break;
      }
    });
  }

  // ── Example loader ─────────────────────────────────────────────────────────
  async _loadExample() {
    try {
      const resp = await fetch('examples/portico_simple.s3d');
      if (!resp.ok) return;
      const text = await resp.text();
      this._loadJSON(text, 'portico_simple.s3d', true);   // keepResults: la firma decide
      this._dirty = false;
      this._updateTitle('portico_simple');
    } catch {
      // No example available — start empty, that's fine
    }
  }
}

// ── Module helpers ────────────────────────────────────────────────────────────
function _parseSpectrum(text) {
  const pts = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/[\s,;]+/);
    const T  = parseFloat(parts[0]);
    const Sa = parseFloat(parts[1]);
    if (isFinite(T) && isFinite(Sa) && T >= 0 && Sa >= 0) pts.push({ T, Sa });
  }
  pts.sort((a, b) => a.T - b.T);
  return pts;
}

// ── Element-force superposition helpers for load combinations ─────────────────
const _EF_SCALAR_KEYS = ['N','Vy1','Vz1','T','My1','Mz1','Vy2','Vz2','My2','Mz2',
                          'Vmax','Mmax','Nabs','qy','qz'];

function _scaleEF(ef, factor) {
  const out = { ...ef };   // copy geometry (ex,ey,ez,L,_ue)
  for (const k of _EF_SCALAR_KEYS) out[k] = (ef[k] ?? 0) * factor;
  return out;
}

function _addScaledEF(target, ef, factor) {
  for (const k of _EF_SCALAR_KEYS) target[k] = (target[k] ?? 0) + (ef[k] ?? 0) * factor;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});

