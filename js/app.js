// ──────────────────────────────────────────────────────────────────────────────
// App — main orchestrator
// ──────────────────────────────────────────────────────────────────────────────
import { Model }           from './model/model.js?v=32';
import { Serializer }      from './model/serializer.js?v=32';
import { Viewport }        from './ui/viewport.js?v=32';
import { PropertiesPanel } from './ui/properties.js?v=32';
import { MenuBar }         from './ui/menu.js?v=32';
import { UndoStack }       from './utils/undo.js?v=32';
import { StaticSolver, ensureDefaultLC }   from './solver/static_solver.js?v=32';
import { Results }                         from './solver/postprocess.js?v=32';
import { ModalSolver }                     from './solver/modal_solver.js?v=32';
import { buildNodeIndex, assembleK, getNodeDOFs } from './solver/assembler.js?v=32';
import { ModalResults }                    from './solver/modal_results.js?v=32';
import { SpectrumSolver }                  from './solver/spectrum_solver.js?v=32';
import { autoDetectDiaphragms, computeFloorCR } from './solver/diaphragm.js?v=32';
import { splitElement, splitByLength, discretizeAll, joinElements } from './model/discretize.js?v=32';
import { localAxes, stiffnessMatrix, massMatrix, transformMatrix, globalStiffness, applyReleases } from './solver/timoshenko.js?v=32';

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

    // Results type/scale changes
    document.getElementById('result-type')?.addEventListener('change', () => this._refreshResultView());
    document.getElementById('result-scale')?.addEventListener('change', () => {
      this._refreshResultView();
      // Sync range slider
      const v = parseFloat(document.getElementById('result-scale')?.value) || 1;
      const logV = Math.log10(Math.max(v, 1e-3));
      const rangeEl = document.getElementById('result-scale-range');
      if (rangeEl) rangeEl.value = Math.max(-2, Math.min(4, logV));
    });
    document.getElementById('result-scale-range')?.addEventListener('input', e => {
      const scale = Math.pow(10, parseFloat(e.target.value));
      const numEl = document.getElementById('result-scale');
      if (numEl) numEl.value = +scale.toPrecision(3);
      if (this._results) this._refreshResultView();
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
          <input type="number" id="disc-val" value="4" min="0.01" step="1" style="width:90px">
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
          if (!this._predisc) this._predisc = this.serializer.toJSON(this.model);
          else this.model = this.serializer.fromJSON(this._predisc);  // re-análisis: partir del original
          discretizeAll(this.model, { parts: 10 });
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
    const type  = document.getElementById('result-type')?.value || 'deformed';
    const scale = autoScale ? null : (parseFloat(document.getElementById('result-scale')?.value) || null);

    if (type === 'deformed') {
      this.viewport.showDeformed(this._results, scale);
    } else {
      this.viewport.showForceDiagram(this._results, type, scale);
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
    if (this._results) this._refreshResultView();
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

    const defaultText = this._lastSpectrum ||
`0.00, 0.20
0.10, 0.45
0.30, 0.45
0.50, 0.40
0.75, 0.35
1.00, 0.28
1.50, 0.19
2.00, 0.14
3.00, 0.10
4.00, 0.07`;

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
  <textarea id="sp-spectrum" rows="9" class="sp-textarea">${defaultText}</textarea>
  <small style="color:var(--text-muted);display:block;margin-top:4px">
    Columnas: T [s] , Sa [unidad seleccionada]. Ejemplo en <em>g</em> (NCh433 simplificado).
  </small>
</div>`;

      overlay.classList.remove('hidden');

      overlay._resolve = () => {
        const dir     = document.getElementById('sp-dir').value;
        const method  = document.getElementById('sp-method').value;
        const zeta    = parseFloat(document.getElementById('sp-zeta').value) || 0.05;
        const factor  = parseFloat(document.getElementById('sp-unit').value) || 9.81;
        const rawText = document.getElementById('sp-spectrum').value;
        const spectrum = _parseSpectrum(rawText);
        if (spectrum.length < 2) {
          this.toast('El espectro necesita al menos 2 puntos (T,Sa)', 'error');
          resolve(null); return;
        }
        resolve({ spectrum, saFactor: factor, direction: dir, zeta, method, rawText });
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
    if (!this._hasSavableResults()) return modelJSON;
    try {
      const obj = JSON.parse(modelJSON);
      obj.results = {
        sig:          this._resultsCache.sig,
        autoDisc:     !!this._resultsCache.autoDisc,
        activeKey:    this._activeResultKey ?? this._activeLcId,
        showReactions:!!this._showReactions,
        savedAt:      new Date().toISOString(),
        cases:        this._resultsCache.cases,
      };
      return JSON.stringify(obj, null, 2);
    } catch { return modelJSON; }
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
    if (!restored) await this._loadExample();
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

