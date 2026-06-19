// ──────────────────────────────────────────────────────────────────────────────
// App — main orchestrator
// ──────────────────────────────────────────────────────────────────────────────
import { Model }           from './model/model.js?v=71';
import { Serializer }      from './model/serializer.js?v=71';
import { Viewport }        from './ui/viewport.js?v=71';
import { PropertiesPanel } from './ui/properties.js?v=71';
import { MenuBar }         from './ui/menu.js?v=71';
import { UndoStack }       from './utils/undo.js?v=71';
import { StaticSolver, ensureDefaultLC }   from './solver/static_solver.js?v=71';
import { Results }                         from './solver/postprocess.js?v=71';
import { ModalSolver }                     from './solver/modal_solver.js?v=71';
import { buildNodeIndex, assembleK, getNodeDOFs } from './solver/assembler.js?v=71';
import { ModalResults }                    from './solver/modal_results.js?v=71';
import { SpectrumSolver }                  from './solver/spectrum_solver.js?v=71';
import { autoDetectDiaphragms, computeFloorCR } from './solver/diaphragm.js?v=71';
import { splitElement, splitByLength, discretizeAll, joinElements, intersectarElementos } from './model/discretize.js?v=71';
import { localAxes, stiffnessMatrix, massMatrix, transformMatrix, globalStiffness, applyReleases } from './solver/timoshenko.js?v=71';

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

    // Analysis button
    document.getElementById('btn-run')?.addEventListener('click', () => this.runAnalysis());
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

  deleteSelected() {
    const sel = this.viewport.getSelected();
    if (!sel.length) return;
    this.snapshot();
    // Delete elements before nodes to avoid dangling references
    const elems = sel.filter(s => s.type === 'elem');
    const nodes = sel.filter(s => s.type === 'node');
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
        if (ne && e.releases && e.releases.some(x => x)) this.model.updateElement(ne.id, { releases: [...e.releases] });
        if (ne) k++;
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
    setTimeout(() => {
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
          const solver = new StaticSolver();
          const prevSpec = new Map();
          if (this._resultsByCase) {
            for (const lc of this.model.loadCases.values()) {
              if (lc.type === 'spectrum' && this._resultsByCase.has(lc.id))
                prevSpec.set(lc.id, this._resultsByCase.get(lc.id));
            }
          }
          this._resultsByCase = new Map(prevSpec);
          const cases = [];
          for (const lc of this.model.loadCases.values()) {
            if (lc.type === 'spectrum') continue;
            const res = solver.solve(this.model, lc.id, !!lc.selfWeight);
            this._resultsByCase.set(lc.id, res);
            cases.push({
              key: lc.id, lcId: lc.id, selfWeight: !!lc.selfWeight,
              u: Array.from(res.u), reactions: Array.from(res.reactions),
            });
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
        this.toast(`Error: ${err.message}`, 'error');
        console.error(err);
      } finally {
        if (btn) btn.classList.remove('running');
        document.getElementById('sb-mode').textContent = 'Modo: Resultados';
      }
    }, 20);
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

    // HTML modal instead of native prompt()
    const nModes = await this._modalNModesDialog();
    if (nModes === null) return;

    const btn = document.getElementById('btn-run');
    if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = 'Análisis modal…';

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
      const modes = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./solver/modal_worker.js', import.meta.url));
        worker.postMessage({ Kff_flat, Mff_flat, nF, nModes },
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
      document.getElementById('sb-mode').textContent = 'Modo: Modal';
    }
  }

  /** HTML modal dialog — ask for number of modes (replaces native prompt). */
  _modalNModesDialog() {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = 'Análisis Modal';
      document.getElementById('modal-cancel').style.display = '';
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
        </div>`;
      overlay.classList.remove('hidden');
      setTimeout(() => {
        const el = document.getElementById('modal-nmodes');
        el?.focus(); el?.select();
      }, 50);
      overlay._resolve = () => {
        const v = parseInt(document.getElementById('modal-nmodes')?.value) || 10;
        resolve(Math.max(1, Math.min(50, v)));
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
        document.getElementById('sb-mode').textContent = 'Modo: Espectro';
      }
    }, 20);
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
      const { generarModelo } = await import('../asistente/generador.js?v=71');
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
        descripcion: '',
        footer: 'Producto académico · IOC · UACh — no sustituye la revisión de un profesional competente',
        mostrarIds: true,      // mostrar IDs de nodos/elementos en las figuras
        modosVisibles: true,   // amplificar las formas modales para que se noten
      },
      seccion_mod_default: { A: 1, Iy: 1, Iz: 1, J: 1 },
    };
  }
  _loadConfig() {
    const def = this._defaultConfig();
    try {
      const raw = JSON.parse(localStorage.getItem('portico_config') || '{}');
      return {
        memoria: { ...def.memoria, ...(raw.memoria || {}) },
        seccion_mod_default: { ...def.seccion_mod_default, ...(raw.seccion_mod_default || {}) },
      };
    } catch { return def; }
  }
  _saveConfig() { try { localStorage.setItem('portico_config', JSON.stringify(this._config)); } catch (e) {} }

  configDialog() {
    const mm = this._config.memoria, sd = this._config.seccion_mod_default;
    const overlay = document.getElementById('modal-overlay');
    const ea = s => String(s ?? '').replace(/"/g, '&quot;');
    document.getElementById('modal-title').textContent = '⚙ Configuración';
    document.getElementById('modal-box')?.classList.add('modal-wide');
    document.getElementById('modal-cancel').style.display = '';
    document.getElementById('modal-body').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;font-size:13px">
        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Memoria de cálculo — encabezado</legend>
          <div class="prop-row cols2" style="gap:8px">
            <div class="prop-field"><label>Título</label><input id="cfg-titulo" value="${ea(mm.titulo)}"></div>
            <div class="prop-field"><label>Subtítulo (kicker)</label><input id="cfg-kicker" value="${ea(mm.kicker)}"></div>
          </div>
          <div class="prop-row cols2" style="gap:8px;margin-top:6px">
            <div class="prop-field"><label>Institución</label><input id="cfg-inst" value="${ea(mm.institucion)}"></div>
            <div class="prop-field"><label>Sub-institución / unidad</label><input id="cfg-subinst" value="${ea(mm.subInstitucion)}"></div>
          </div>
          <div class="prop-row cols2" style="gap:8px;margin-top:6px">
            <div class="prop-field"><label>Proyectista</label><input id="cfg-proy" value="${ea(mm.proyectista)}"></div>
            <div class="prop-field"><label>Revisó</label><input id="cfg-rev" value="${ea(mm.revisor)}"></div>
          </div>
          <div class="prop-field" style="margin-top:6px"><label>Descripción del proyecto</label>
            <textarea id="cfg-desc" rows="3" style="width:100%">${ea(mm.descripcion)}</textarea></div>
          <div class="prop-field" style="margin-top:6px"><label>Pie de página</label><input id="cfg-footer" value="${ea(mm.footer)}"></div>
        </fieldset>
        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Visualización de la memoria</legend>
          <label style="display:block;margin-bottom:5px"><input type="checkbox" id="cfg-ids" ${mm.mostrarIds ? 'checked' : ''}> Mostrar IDs de nodos y elementos en las figuras</label>
          <label style="display:block"><input type="checkbox" id="cfg-modos" ${mm.modosVisibles ? 'checked' : ''}> Amplificar las formas modales para que se observen</label>
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
    document.getElementById('cfg-apply-mod')?.addEventListener('click', () => {
      const mod = { A: +document.getElementById('cfg-mA').value || 1, Iy: +document.getElementById('cfg-mIy').value || 1,
        Iz: +document.getElementById('cfg-mIz').value || 1, J: +document.getElementById('cfg-mJ').value || 1 };
      for (const s of this.model.sections.values()) this.model.updateSection(s.id, { mod: { ...mod } });
      this.markDirty(); this.panel.renderSections?.();
      this.toast('Modificadores aplicados a todas las secciones', 'ok');
    });
    overlay._resolve = () => {
      const v = id => document.getElementById(id)?.value ?? '';
      mm.titulo = v('cfg-titulo'); mm.kicker = v('cfg-kicker'); mm.institucion = v('cfg-inst');
      mm.subInstitucion = v('cfg-subinst'); mm.proyectista = v('cfg-proy'); mm.revisor = v('cfg-rev');
      mm.descripcion = v('cfg-desc'); mm.footer = v('cfg-footer');
      mm.mostrarIds = document.getElementById('cfg-ids')?.checked ?? true;
      mm.modosVisibles = document.getElementById('cfg-modos')?.checked ?? true;
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
  _showProgress(titulo, sub = '') {
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
         </div>
         <style>@keyframes pp-slide{0%{margin-left:-40%}100%{margin-left:100%}}</style>`;
      document.body.appendChild(el);
    }
    el.querySelector('#pp-titulo').textContent = titulo;
    el.querySelector('#pp-sub').textContent = sub;
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

    const diseno = await this._calcularDiseno();   // verificación flexión/corte/axial (si hay resultados)
    const html = this._memoriaHTML(imgs, diseno);

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
    const ver = '?v=71';
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
      // Flecha relativa a la cuerda: δ(ξ) = u(ξ) − interp(u1,u2). Máx sobre el vano.
      const flechaMax = (res, el, L) => {
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

      const limFlecha = (params.flechas_admisibles || {}).viga_carga_total_L_sobre || 300;
      const filas = [];
      for (const el of this.model.elements.values()) {
        const sec = this.model.sections.get(el.secId);
        const mat = this.model.materials.get(el.matId);
        if (!sec || !mat) continue;
        let peor = null, peorNom = null, peorFuerzas = null, defMax = 0;
        for (const { nombre, res } of disResults) {
          const f = res.getElemForces(el.id); if (!f) continue;
          const fuerzas = {
            N: (Math.sign(f.N) || 1) * maxAbs(res, el.id, 'N'),
            Vy: maxAbs(res, el.id, 'Vy'), Vz: maxAbs(res, el.id, 'Vz'),
            My: maxAbs(res, el.id, 'My'), Mz: maxAbs(res, el.id, 'Mz'), L: f.L,
          };
          const r = mod.verificarElemento({ fuerzas, sec, matNombre: mat.name, params });
          if (!peor || r.ratioMax > peor.ratioMax) { peor = r; peorNom = nombre; peorFuerzas = fuerzas; }
          defMax = Math.max(defMax, flechaMax(res, el, f.L));
        }
        if (!peor) continue;
        const L = peorFuerzas.L || 1;
        const flecha = { delta: defMax, limite: L / limFlecha, ratio: (L / limFlecha) > 1e-9 ? defMax / (L / limFlecha) : 0, Lsobre: limFlecha };
        const estadoFlecha = flecha.ratio > 1 ? 'NO CUMPLE' : 'cumple';
        filas.push({ id: el.id, mat: mat.name, sec: sec.name, fuerzas: peorFuerzas, combo: peorNom, flecha, estadoFlecha, ...peor });
      }
      filas.sort((a, b) => Math.max(b.ratioMax, b.flecha.ratio) - Math.max(a.ratioMax, a.flecha.ratio));
      return { filas, params, caso: disResults.length > 1 ? `envolvente de ${disResults.length} estados` : disResults[0].nombre, envolvente: disResults.length > 1 };
    } catch (e) { console.error('Diseño falló:', e); return { filas: [], params, caso: null }; }
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

  _memoriaHTML(imgs, diseno) {
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

    // ── Diseño de elementos: verificación flexión / corte / axial ───────────
    let disenoHTML;
    const rClass = r => r > 1.0 ? 'r-bad' : r > 0.9 ? 'r-warn' : 'r-ok';
    if (diseno && diseno.filas && diseno.filas.length) {
      const f = diseno.filas;
      const frr = x => x.flecha?.ratio ?? 0;
      const malo = x => x.ratioMax > 1 || frr(x) > 1;
      const aj   = x => !malo(x) && (x.ratioMax > 0.9 || frr(x) > 0.9);
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
        <td class="${rClass(frr(x))}">${fmt(frr(x),2)}</td>
        <td class="${malo(x)?'r-bad':aj(x)?'r-warn':'r-ok'}">${malo(x)?'NO CUMPLE':aj(x)?'ajustado':'cumple'}</td></tr>`).join('');
      disenoHTML = `
        <p>Verificación por <b>${diseno.envolvente ? 'envolvente de las combinaciones de carga' : `el estado «${esc(diseno.caso||'activo')}»`}</b>:
        para cada elemento se reporta la combinación más desfavorable. La razón <b>D/C = demanda/capacidad</b> (resistencia)
        y la <b>flecha δ</b> (servicio, vs L/${(dp?.flechas_admisibles?.viga_carga_total_L_sobre)||300}) deben ser ≤ 1.0.
        Parámetros en <code>asistente/diseno_params.json</code>.</p>
        <table style="font-size:9.5px"><thead><tr>
          <th>Elem</th><th>Sección</th><th>Material</th><th>Combo</th><th>N (kN)</th><th>M (kN·m)</th><th>V (kN)</th>
          <th>flex.</th><th>corte</th><th>axial</th><th>interac.</th><th>Gobierna</th><th>D/C máx</th><th>δ</th><th>Estado</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">${f.length > 60 ? `Se muestran los 60 elementos más solicitados de ${f.length}. ` : ''}
        Resumen: <b class="r-ok">${nOk} cumplen</b> · <b class="r-warn">${nAj} ajustados</b> · <b class="r-bad">${nNo} no cumplen</b>.
        D/C: flexión/corte/axial e interacción flexo-axial. δ = flecha relativa máxima respecto a la luz. Colores: verde ≤ 0.90 · ámbar 0.90–1.00 · rojo &gt; 1.00.</p>`;
    } else {
      disenoHTML = '<p class="muted">No hay resultados de análisis para verificar. Ejecute el análisis estático (F5) con sus combinaciones de carga antes de generar la memoria.</p>';
    }

    // ── Portada (estilo institucional, configurable) ────────────────────────
    const portada = `<section class="cover">
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
    const descripcionHTML = cm.descripcion ? `<p>${esc(cm.descripcion)}</p>` : '';

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
  <span>${esc(cm.footer || 'Producto académico · IOC · UACh — no sustituye la revisión de un profesional competente')}</span>
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

<h2>3. Diseño de elementos</h2>
${disenoHTML}

<h2>4. Limitaciones y alcances</h2>
<ul style="font-size:11px;line-height:1.6">
  <li>Documento generado automáticamente por PÓRTICO con fines <b>docentes</b>; no reemplaza el criterio ni la firma de un profesional competente.</li>
  <li>La verificación de diseño usa propiedades de sección (A, I) y los parámetros editables de <code>asistente/diseno_params.json</code>; el hormigón armado se evalúa con la cuantía indicada y supuestos declarados.</li>
  <li>La verificación cubre flexión, corte, axial, interacción flexo-axial (AISC H1 / NDS) y flecha de servicio por envolvente de combinaciones. NO incluye diseño de uniones, fundaciones, pandeo lateral-torsional, clasificación de perfiles ni efectos P-Δ.</li>
  <li>Las cargas de viento, nieve y sobrecargas se representan como casos de carga; verifique su clasificación y magnitud según la normativa aplicable.</li>
</ul>
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

