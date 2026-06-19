// ──────────────────────────────────────────────────────────────────────────────
// PropertiesPanel — right-side panel: node/element properties + mat/sec tabs
// ──────────────────────────────────────────────────────────────────────────────
import { computeFloorCR, computeFloorCM, computeTributaryWeights } from '../solver/diaphragm.js?v=68';
import { localAxes } from '../solver/timoshenko.js?v=68';

export class PropertiesPanel {
  constructor(panelEl, app) {
    this.panel = panelEl;
    this.app   = app;

    // ── Vertical super-tabs (Modelo / Resultados) ──────────────────────────
    this._vtabBtns = [...panelEl.querySelectorAll('.vtab')];
    this._vpanels  = {
      modelo:     document.getElementById('vpanel-modelo'),
      resultados: document.getElementById('vpanel-resultados'),
    };
    this._currentVTab = 'modelo';

    // ── Horizontal sub-tabs (dentro de Modelo) ─────────────────────────────
    this._tabBtns    = [...panelEl.querySelectorAll('#panel-tabs .ptab')];
    this._tabContents = {
      sel:   document.getElementById('ptab-sel'),
      nodos: document.getElementById('ptab-nodos'),
      elems: document.getElementById('ptab-elems'),
      mat:   document.getElementById('ptab-mat'),
      sec:   document.getElementById('ptab-sec'),
      dia:   document.getElementById('ptab-dia'),
    };
    this._currentTab = 'sel';

    // ── Result sub-tabs (dentro de Resultados) ─────────────────────────────
    this._rtabBtns    = [...panelEl.querySelectorAll('.rtab')];
    this._rtabContents = {
      modal:    document.getElementById('rtab-modal'),
      estatico: document.getElementById('rtab-estatico'),
      combos:   document.getElementById('rtab-combos'),
    };
    this._currentRTab = 'modal';

    this._init();
  }

  _init() {
    this._vtabBtns.forEach(btn =>
      btn.addEventListener('click', () => this._switchVTab(btn.dataset.vtab))
    );
    this._tabBtns.forEach(btn =>
      btn.addEventListener('click', () => this._switchTab(btn.dataset.tab))
    );
    this._rtabBtns.forEach(btn =>
      btn.addEventListener('click', () => this._switchRTab(btn.dataset.rtab))
    );

    document.getElementById('btn-add-mat')?.addEventListener('click',    () => this._addMaterial());
    document.getElementById('btn-add-sec')?.addEventListener('click',    () => this._addSection());
    document.getElementById('btn-section-calc')?.addEventListener('click', () => this._sectionCalculatorDialog());
    document.getElementById('btn-add-dia')?.addEventListener('click',    () => this.app.addDiaphragmManual());
    document.getElementById('btn-detect-dia')?.addEventListener('click', () => this.app.autoDetectDiaphragms());
    document.getElementById('btn-add-combo')?.addEventListener('click',  () => this._addCombination());
    document.getElementById('btn-add-node-row')?.addEventListener('click', () => this._addNodeRow());
  }

  _switchVTab(vtab) {
    this._currentVTab = vtab;
    this._vtabBtns.forEach(b => b.classList.toggle('active', b.dataset.vtab === vtab));
    Object.entries(this._vpanels).forEach(([k, el]) =>
      el?.classList.toggle('active', k === vtab)
    );
    if (vtab === 'resultados') this._switchRTab(this._currentRTab);
  }

  _switchTab(tab) {
    this._currentTab = tab;
    this._tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    Object.entries(this._tabContents).forEach(([k, el]) =>
      el?.classList.toggle('active', k === tab)
    );
    if (tab === 'mat')   this.renderMaterials();
    if (tab === 'sec')   this.renderSections();
    if (tab === 'dia')   this.renderDiaphragms();
    if (tab === 'nodos') this.renderNodesGrid();
    if (tab === 'elems') this.renderElemsGrid();
  }

  _switchRTab(rtab) {
    this._currentRTab = rtab;
    this._rtabBtns.forEach(b => b.classList.toggle('active', b.dataset.rtab === rtab));
    Object.entries(this._rtabContents).forEach(([k, el]) =>
      el?.classList.toggle('active', k === rtab)
    );
    if (rtab === 'modal')    this.renderModalResults();
    if (rtab === 'estatico') this.renderStaticResults();
    if (rtab === 'combos')   this.renderCombinations();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  showDiaphragm(dId, showCM = false) {
    this._switchVTab('modelo');
    this._switchTab('dia');
    setTimeout(() => {
      const card = document.querySelector(`#dia-list .mat-card[data-id="${dId}"]`);
      if (card && !card.classList.contains('open')) card.classList.add('open');
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
    // Show CM displacements in sel tab if results exist
    if (showCM || this.app._results) {
      const d = this.app.model.diaphragms.get(dId);
      const res = this.app._results;
      if (d && res) {
        const masterId = d.masterId || d.nodes[0];
        const masterNode = this.app.model.nodes.get(masterId);
        if (masterNode) {
          this._switchVTab('modelo');
          this._switchTab('sel');
          const disp = res.getNodeDisp(masterId);
          const fv = v => `<span style="font-family:var(--font-mono);color:${Math.abs(v)<1e-10?'var(--text-muted)':v>0?'#ef5350':'#42a5f5'}">${Math.abs(v)<1e-10?'—':v.toExponential(4)}</span>`;
          this._tabContents.sel.innerHTML = `
            <div class="prop-id" style="color:#ff7043">⊕ CM Diafragma #${dId}</div>
            <div class="prop-section" style="border:1px solid #ff7043;border-radius:4px;padding:8px">
              <div class="prop-title" style="color:#ff7043">Desplazamientos Nodo Master #${masterId}</div>
              <table class="results-table">
                <tr><th>DOF</th><th>Valor</th></tr>
                ${['Ux','Uy','Uz','Rx','Ry','Rz'].map((n,i)=>`<tr><td>${n}</td><td>${fv(disp[i])}</td></tr>`).join('')}
              </table>
            </div>`;
        }
      }
    }
  }

  showSelection(items) {
    this._switchVTab('modelo');
    this._switchTab('sel');
    const res  = this.app._results;
    const elems = items.filter(i => i.type === 'elem');
    const nodes = items.filter(i => i.type === 'node');

    // colour helper: sign-based for individual values, amber for aggregates
    const fv = (v, amber = false) => {
      const zero = Math.abs(v) < 1e-10;
      const col  = amber ? '#ffc107'
                 : zero  ? 'var(--text-muted)'
                 : v > 0 ? '#ef5350' : '#42a5f5';
      return `<td style="font-family:var(--font-mono);text-align:right;font-size:10px;color:${col}">${zero && !amber ? '—' : v.toExponential(3)}</td>`;
    };

    let html = `<div class="prop-id" style="color:var(--warn)">${items.length} objetos seleccionados</div>
      <p class="panel-hint" style="margin-bottom:6px">Ctrl+clic: añadir/quitar &nbsp;|&nbsp; Clic vacío: deseleccionar</p>`;

    // ── Elements ────────────────────────────────────────────────────────────
    if (elems.length > 0) {
      if (!res) {
        html += `<p class="panel-hint">${elems.length} elemento(s) — ejecute el análisis para ver fuerzas.</p>`;
      } else {
        const sum = { N:0, Vy:0, Vz:0, T:0, My:0, Mz:0,
                      maxN:0, maxVy:0, maxVz:0, maxMy:0, maxMz:0 };
        let rowsHtml = '';
        for (const { id } of elems) {
          const f = res.getElemForces(id);
          if (!f) continue;
          const Vy = Math.abs(f.Vy1) > Math.abs(f.Vy2) ? f.Vy1 : f.Vy2;
          const Vz = Math.abs(f.Vz1) > Math.abs(f.Vz2) ? f.Vz1 : f.Vz2;
          const My = Math.abs(f.My1) > Math.abs(f.My2) ? f.My1 : f.My2;
          const Mz = Math.abs(f.Mz1) > Math.abs(f.Mz2) ? f.Mz1 : f.Mz2;
          const T  = f.T || 0;
          sum.N  += f.N;  sum.maxN  = Math.max(sum.maxN,  Math.abs(f.N));
          sum.Vy += Vy;   sum.maxVy = Math.max(sum.maxVy, Math.abs(Vy));
          sum.Vz += Vz;   sum.maxVz = Math.max(sum.maxVz, Math.abs(Vz));
          sum.My += My;   sum.maxMy = Math.max(sum.maxMy, Math.abs(My));
          sum.Mz += Mz;   sum.maxMz = Math.max(sum.maxMz, Math.abs(Mz));
          sum.T  += T;
          rowsHtml += `<tr>
            <td style="color:var(--text-muted);font-size:10px;font-family:var(--font-mono)">${id}</td>
            ${fv(f.N)}${fv(Vy)}${fv(Vz)}${fv(T)}${fv(My)}${fv(Mz)}
          </tr>`;
        }
        const sepStyle = 'border-top:1px solid var(--warn)';
        rowsHtml += `<tr style="${sepStyle}">
          <td style="font-size:10px;color:var(--warn);font-weight:700">Σ</td>
          ${fv(sum.N,true)}${fv(sum.Vy,true)}${fv(sum.Vz,true)}${fv(sum.T,true)}${fv(sum.My,true)}${fv(sum.Mz,true)}
        </tr>
        <tr>
          <td style="font-size:10px;color:#ffc107">max|·|</td>
          ${fv(sum.maxN,true)}${fv(sum.maxVy,true)}${fv(sum.maxVz,true)}<td>—</td>${fv(sum.maxMy,true)}${fv(sum.maxMz,true)}
        </tr>`;
        html += `<div style="border:1px solid var(--warn);border-radius:4px;padding:8px;margin-bottom:8px;overflow-x:auto">
          <div class="res-section-title" style="color:var(--warn);margin-top:0">${elems.length} Elementos — Fuerzas Internas (valor dominante en extremos)</div>
          <table class="res-table"><thead>
            <tr><th>El.</th><th>N</th><th>Vy</th><th>Vz</th><th>T</th><th>My</th><th>Mz</th></tr>
          </thead><tbody>${rowsHtml}</tbody></table>
        </div>`;
      }
    }

    // ── Nodes ───────────────────────────────────────────────────────────────
    if (nodes.length > 0) {
      if (!res) {
        html += `<p class="panel-hint">${nodes.length} nodo(s) — ejecute el análisis para ver desplazamientos.</p>`;
      } else {
        let rowsHtml = '';
        for (const { id } of nodes) {
          const d   = res.getNodeDisp(id);
          const mag = Math.hypot(d[0], d[1], d[2]);
          rowsHtml += `<tr>
            <td style="color:var(--text-muted);font-size:10px;font-family:var(--font-mono)">${id}</td>
            ${fv(d[0])}${fv(d[1])}${fv(d[2])}${fv(mag, true)}
          </tr>`;
        }
        html += `<div style="border:1px solid var(--node-col);border-radius:4px;padding:8px;overflow-x:auto">
          <div class="res-section-title" style="color:var(--node-col);margin-top:0">${nodes.length} Nodos — Desplazamientos</div>
          <table class="res-table"><thead>
            <tr><th>Nd.</th><th>Ux</th><th>Uy</th><th>Uz</th><th>|δ|</th></tr>
          </thead><tbody>${rowsHtml}</tbody></table>
        </div>`;
      }
    }

    // ── Acciones masivas ──────────────────────────────────────────────────────
    if (elems.length > 0) html += this._accionesSelHTML(elems);
    if (nodes.length > 0) html += this._accionesNodosHTML(nodes);
    html += this._transformHTML(items.length);
    html += this._gruposHTML();

    this._tabContents.sel.innerHTML = html;
    if (elems.length > 0) this._bindAccionesSel(elems.map(e => e.id));
    if (nodes.length > 0) this._bindAccionesNodos();
    this._bindTransform();
    this._bindGrupos();
  }

  _accionesNodosHTML(nodes) {
    return `
      <div class="prop-section" style="border:1px solid var(--node-col);border-radius:6px;padding:8px;margin-top:8px">
        <div class="prop-title" style="color:var(--node-col);margin-top:0">Apoyo · ${nodes.length} nodo(s)</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn-secondary nod-sup" data-p="empotrado" style="flex:1;font-size:11px" title="Fija las 6 GDL">Empotrado</button>
          <button class="btn-secondary nod-sup" data-p="rotulado" style="flex:1;font-size:11px" title="Fija traslaciones, libera giros">Rótula</button>
          <button class="btn-secondary nod-sup" data-p="rodillo" style="flex:1;font-size:11px" title="Solo vertical (Uz)">Rodillo</button>
          <button class="btn-secondary nod-sup" data-p="libre" style="flex:1;font-size:11px" title="Sin apoyo">Libre</button>
        </div>
      </div>`;
  }
  _bindAccionesNodos() {
    this._tabContents.sel.querySelectorAll('.nod-sup').forEach(b => b.addEventListener('click', () => this.app.setSupportSelectedNodes(b.dataset.p)));
  }

  // Mover / Copiar (array lineal) — sirve para nodos y elementos.
  _transformHTML(n) {
    return `
      <div class="prop-section" style="border:1px solid var(--teal);border-radius:6px;padding:8px;margin-top:8px">
        <div class="prop-title" style="color:var(--teal);margin-top:0">Mover / Copiar selección</div>
        <div class="prop-row cols3" style="margin-bottom:6px">
          <div class="prop-field"><label>dX (m)</label><input type="number" id="tr-dx" value="0" step="0.5"></div>
          <div class="prop-field"><label>dY (m)</label><input type="number" id="tr-dy" value="0" step="0.5"></div>
          <div class="prop-field"><label>dZ (m)</label><input type="number" id="tr-dz" value="0" step="0.5"></div>
        </div>
        <div class="prop-row" style="align-items:flex-end;gap:6px">
          <div class="prop-field" style="width:96px"><label>Repeticiones</label><input type="number" id="tr-rep" value="1" min="1" step="1"></div>
          <button class="btn-secondary" id="tr-copy" style="flex:1;font-size:11px" title="Crea copias desplazadas (array)">Copiar ×N</button>
          <button class="btn-secondary" id="tr-move" style="flex:1;font-size:11px" title="Desplaza la selección">Mover</button>
        </div>
        <details style="margin-top:6px">
          <summary style="cursor:pointer;font-size:11px;color:var(--text-muted)">2ª dirección (array 2D) y espejar</summary>
          <div class="prop-row cols3" style="gap:6px;margin:6px 0">
            <div class="prop-field"><label>dX₂</label><input type="number" id="tr-dx2" value="0" step="0.5"></div>
            <div class="prop-field"><label>dY₂</label><input type="number" id="tr-dy2" value="0" step="0.5"></div>
            <div class="prop-field"><label>dZ₂</label><input type="number" id="tr-dz2" value="0" step="0.5"></div>
          </div>
          <div class="prop-row" style="align-items:flex-end;gap:6px;margin-bottom:8px">
            <div class="prop-field" style="width:96px"><label>Repeticiones₂</label><input type="number" id="tr-rep2" value="0" min="0" step="1"></div>
            <span class="panel-hint" style="flex:1">Array 2D = grilla rep × rep₂ (usa "Copiar ×N").</span>
          </div>
          <div class="prop-row" style="align-items:flex-end;gap:6px">
            <div class="prop-field"><label>Espejar plano</label>
              <select id="tr-mir"><option value="X">X = c</option><option value="Y">Y = c</option><option value="Z">Z = c</option></select></div>
            <div class="prop-field" style="width:70px"><label>c (m)</label><input type="number" id="tr-mirc" value="0" step="0.5"></div>
            <button class="btn-secondary" id="tr-mirror" style="flex:1;font-size:11px" title="Crea una copia reflejada de la selección">Espejar</button>
          </div>
        </details>
        <p class="panel-hint" style="margin:6px 0 0">Ej.: dX=5, rep=10 → 10 copias cada 5 m. Con dY₂ y rep₂ se hace grilla 2D. Copias coincidentes se fusionan.</p>
      </div>`;
  }
  _bindTransform() {
    const $ = (i) => this._tabContents.sel.querySelector(i);
    const num = (i) => parseFloat($(i).value) || 0;
    $('#tr-copy')?.addEventListener('click', () => this.app.copiarSeleccion(num('#tr-dx'), num('#tr-dy'), num('#tr-dz'), parseInt($('#tr-rep').value, 10), num('#tr-dx2'), num('#tr-dy2'), num('#tr-dz2'), parseInt($('#tr-rep2').value, 10)));
    $('#tr-move')?.addEventListener('click', () => this.app.moverSeleccion(num('#tr-dx'), num('#tr-dy'), num('#tr-dz')));
    $('#tr-mirror')?.addEventListener('click', () => this.app.espejarSeleccion($('#tr-mir').value, num('#tr-mirc')));
  }

  // HTML de acciones masivas para N elementos seleccionados.
  _accionesSelHTML(elems) {
    const mats = [...this.app.model.materials.values()].map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    const secs = [...this.app.model.sections.values()].map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    const lcs = [...this.app.model.loadCases.values()].filter(l => l.type !== 'spectrum')
      .map(l => `<option value="${l.id}" ${l.id === this.app._activeLcId ? 'selected' : ''}>${l.name}${l.selfWeight ? ' ⊕PP' : ''}</option>`).join('');
    const n = elems.length;
    return `
      <div class="prop-section" style="border:1px solid var(--accent);border-radius:6px;padding:8px;margin-top:8px">
        <div class="prop-title" style="color:var(--accent);margin-top:0">Acciones · ${n} elemento(s)</div>
        <div class="prop-row" style="align-items:flex-end;gap:6px;margin-bottom:6px">
          <div class="prop-field" style="flex:1"><label>Material a todos</label>
            <select id="sel-mat"><option value="">—</option>${mats}</select></div>
          <button class="btn-secondary" id="sel-mat-go" style="font-size:11px">Aplicar</button>
        </div>
        <div class="prop-row" style="align-items:flex-end;gap:6px;margin-bottom:6px">
          <div class="prop-field" style="flex:1"><label>Sección a todos</label>
            <select id="sel-sec"><option value="">—</option>${secs}</select></div>
          <button class="btn-secondary" id="sel-sec-go" style="font-size:11px">Aplicar</button>
        </div>
        <div class="prop-row" style="align-items:flex-end;gap:6px;margin-bottom:8px">
          <div class="prop-field" style="flex:1"><label>Discretizar (nº tramos c/u)</label>
            <input type="number" id="sel-disc" value="4" min="2" step="1"></div>
          <button class="btn-secondary" id="sel-disc-go" style="font-size:11px">Dividir</button>
        </div>
        <div style="border-top:1px dashed var(--border2);margin:4px 0 8px;padding-top:8px">
          <div class="prop-row cols3" style="gap:6px;margin-bottom:6px">
            <div class="prop-field"><label>Carga w (kN/m)</label><input type="number" id="sel-w" value="10" step="1"></div>
            <div class="prop-field"><label>Dirección</label>
              <select id="sel-wdir">
                <option value="gravity">Gravedad ↓</option>
                <option value="globalX">Global +X</option>
                <option value="globalY">Global +Y</option>
                <option value="localY">Local y</option>
                <option value="localZ">Local z</option>
              </select></div>
            <div class="prop-field"><label>Caso</label><select id="sel-wlc">${lcs}</select></div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-secondary" id="sel-w-go" style="flex:1;font-size:11px" title="Asigna la misma carga distribuida a todos (reemplaza la previa en ese caso)">Aplicar carga</button>
            <button class="btn-secondary" id="sel-w-clr" style="flex:1;font-size:11px" title="Quita las cargas distribuidas de estos elementos en el caso elegido">Quitar carga</button>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <button class="btn-secondary" id="sel-join" style="flex:1;font-size:11px" title="Une tramos colineales en una sola barra">Unir colineales</button>
          ${n === 2 ? `<button class="btn-secondary" id="sel-inter" style="flex:1;font-size:11px" title="Crea un nodo común en el cruce de los 2 elementos">Cortar en intersección</button>` : ''}
          <button class="btn-secondary" id="sel-hide" style="flex:1;font-size:11px" title="Oculta los elementos (Vista → Mostrar todo para revertir)">Ocultar</button>
        </div>
        <div class="prop-row" style="align-items:flex-end;gap:6px">
          <div class="prop-field" style="flex:1"><label>Crear grupo (nombre)</label>
            <input type="text" id="sel-grp" placeholder="ej. Cordón superior"></div>
          <button class="btn-secondary" id="sel-grp-go" style="font-size:11px">Agrupar</button>
        </div>
      </div>`;
  }

  _bindAccionesSel(ids) {
    const $ = (i) => this._tabContents.sel.querySelector(i);
    $('#sel-mat-go')?.addEventListener('click', () => { const v = $('#sel-mat').value; if (v) this.app.setMaterialSelected(v); });
    $('#sel-sec-go')?.addEventListener('click', () => { const v = $('#sel-sec').value; if (v) this.app.setSectionSelected(v); });
    $('#sel-disc-go')?.addEventListener('click', () => this.app.discretizeSelected(parseInt($('#sel-disc').value, 10)));
    $('#sel-w-go')?.addEventListener('click', () => this.app.setCargaDistSelected(parseFloat($('#sel-w').value), $('#sel-wdir').value, $('#sel-wlc').value));
    $('#sel-w-clr')?.addEventListener('click', () => this.app.setCargaDistSelected(0, $('#sel-wdir').value, $('#sel-wlc').value));
    $('#sel-join')?.addEventListener('click', () => this.app.joinSelectedElements());
    $('#sel-inter')?.addEventListener('click', () => this.app.unirInterseccion());
    $('#sel-hide')?.addEventListener('click', () => this.app.hideSelected());
    $('#sel-grp-go')?.addEventListener('click', () => this.app.crearGrupo($('#sel-grp').value));
  }

  // Lista de grupos guardados (seleccionar / ocultar / mostrar / eliminar).
  _gruposHTML() {
    const g = this.app.grupos?.() ;
    if (!g || !g.size) return '';
    let rows = '';
    for (const [nombre, set] of g) {
      rows += `<div class="prop-row" style="align-items:center;gap:4px;margin-bottom:4px">
        <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${nombre}">${nombre} <span style="color:var(--text-muted)">(${set.size})</span></span>
        <button class="btn-secondary grp-sel" data-g="${nombre}" style="font-size:10px;padding:3px 6px" title="Seleccionar">◉</button>
        <button class="btn-secondary grp-hide" data-g="${nombre}" style="font-size:10px;padding:3px 6px" title="Ocultar">🚫</button>
        <button class="btn-secondary grp-show" data-g="${nombre}" style="font-size:10px;padding:3px 6px" title="Mostrar">👁</button>
        <button class="btn-secondary grp-del" data-g="${nombre}" style="font-size:10px;padding:3px 6px" title="Eliminar grupo">✕</button>
      </div>`;
    }
    return `<div class="prop-section" style="border:1px solid var(--border2);border-radius:6px;padding:8px;margin-top:8px">
      <div class="prop-title" style="margin-top:0">Grupos</div>${rows}</div>`;
  }

  _bindGrupos() {
    const root = this._tabContents.sel;
    root.querySelectorAll('.grp-sel').forEach(b => b.addEventListener('click', () => this.app.seleccionarGrupo(b.dataset.g)));
    root.querySelectorAll('.grp-hide').forEach(b => b.addEventListener('click', () => this.app.ocultarGrupo(b.dataset.g)));
    root.querySelectorAll('.grp-show').forEach(b => b.addEventListener('click', () => this.app.mostrarGrupo(b.dataset.g)));
    root.querySelectorAll('.grp-del').forEach(b => b.addEventListener('click', () => this.app.eliminarGrupo(b.dataset.g)));
  }

  showNothing() {
    const sel = this._tabContents.sel;
    if (sel) {
      const ocultos = this.app.viewport?.hiddenCount?.() || 0;
      sel.innerHTML = '<p class="panel-hint">Haga clic en un nodo o elemento para editar sus propiedades. Ctrl+clic para seleccionar varios.</p>'
        + (ocultos ? `<p class="panel-hint" style="color:var(--warn)">${ocultos} elemento(s) oculto(s) · Vista → Mostrar todo</p>` : '')
        + this._gruposHTML();
      this._bindGrupos();
    }
    this._switchVTab('modelo');
    this._switchTab('sel');
  }

  showNode(node, focusSupports = false) {
    if (!node) { this.showNothing(); return; }
    this._switchVTab('modelo');
    this._switchTab('sel');
    const results = this.app._results;
    let diaphHTML = '';
    try { diaphHTML = this._nodeDiaphragmHTML(node); } catch (e) { console.warn('nodeDiaphragmHTML:', e); }
    this._tabContents.sel.innerHTML = this._nodeHTML(node)
      + diaphHTML
      + (results ? this._nodeResultsHTML(node, results) : '')
      + this._nodeLoadsHTML(node);
    this._bindNodeEvents(node);
    this._bindNodeLoadsEvents(node);
    if (focusSupports) {
      const el = this._tabContents.sel.querySelector('.restraints-section');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  showElement(elem) {
    if (!elem) { this.showNothing(); return; }
    this._switchVTab('modelo');
    this._switchTab('sel');
    const results = this.app._results;
    this._tabContents.sel.innerHTML = this._elemHTML(elem)
      + (results ? this._elemResultsHTML(elem, results) : '')
      + this._elemLoadsHTML(elem);
    this._bindElemEvents(elem);
    this._bindElemLoadsEvents(elem);
  }

  refresh(model) {
    if (this._currentTab === 'mat')   this.renderMaterials();
    if (this._currentTab === 'sec')   this.renderSections();
    if (this._currentTab === 'dia')   this.renderDiaphragms();
    if (this._currentTab === 'nodos') this.renderNodesGrid();
    if (this._currentVTab === 'resultados') this._switchRTab(this._currentRTab);
    if (this._currentTab === 'elems') this.renderElemsGrid();
  }

  // ── Node grid ──────────────────────────────────────────────────────────────
  renderNodesGrid() {
    const wrap = document.getElementById('nodes-grid-wrap');
    if (!wrap) return;
    const model = this.app.model;

    if (model.nodes.size === 0) {
      wrap.innerHTML = '<p class="panel-hint">No hay nodos. Créelos en la vista 3D (tecla N) o con el botón de abajo.</p>';
      return;
    }

    const dofs = ['ux','uy','uz','rx','ry','rz'];
    let tbody = '';
    for (const node of model.nodes.values()) {
      const r = node.restraints;
      const cbs = dofs.map(d =>
        `<td class="ng-cb"><input type="checkbox" data-nid="${node.id}" data-dof="${d}" ${r[d] ? 'checked' : ''}></td>`
      ).join('');
      tbody += `<tr data-nid="${node.id}">
        <td class="ng-id">${node.id}</td>
        <td class="ng-coord"><input class="ng-x" type="number" value="${+node.x.toFixed(4)}" step="0.1" data-nid="${node.id}" data-f="x"></td>
        <td class="ng-coord"><input class="ng-y" type="number" value="${+node.y.toFixed(4)}" step="0.1" data-nid="${node.id}" data-f="y"></td>
        <td class="ng-coord"><input class="ng-z" type="number" value="${+node.z.toFixed(4)}" step="0.1" data-nid="${node.id}" data-f="z"></td>
        ${cbs}
        <td class="ng-del"><button data-nid="${node.id}" title="Eliminar">×</button></td>
      </tr>`;
    }

    wrap.innerHTML = `<table class="nodes-grid">
      <thead><tr>
        <th>#</th><th>X</th><th>Y</th><th>Z</th>
        <th>Ux</th><th>Uy</th><th>Uz</th><th>Rx</th><th>Ry</th><th>Rz</th><th></th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;

    // Bind coordinate inputs
    wrap.querySelectorAll('input[data-f]').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = +inp.dataset.nid;
        const field = inp.dataset.f;
        const val = parseFloat(inp.value) || 0;
        this.app.snapshot();
        this.app.model.updateNode(id, { [field]: val });
        const node = this.app.model.nodes.get(id);
        if (node) this.app.viewport.refreshNode(node);
        this.app.markDirty();
      });
    });

    // Bind restraint checkboxes
    wrap.querySelectorAll('input[data-dof]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = +cb.dataset.nid;
        const dof = cb.dataset.dof;
        this.app.snapshot();
        const node = this.app.model.nodes.get(id);
        if (node) {
          node.restraints[dof] = cb.checked ? 1 : 0;
          this.app.viewport.refreshNode(node);
          this.app.markDirty();
        }
      });
    });

    // Bind delete buttons
    wrap.querySelectorAll('.ng-del button').forEach(btn => {
      btn.addEventListener('click', () => {
        this.app.deleteNode(+btn.dataset.nid);
        this.renderNodesGrid();
      });
    });
  }

  _addNodeRow() {
    this.app.snapshot();
    const b = this.app.model.getBounds();
    const node = this.app.model.addNode(b.center.x, b.center.y, 0);
    this.app.viewport.addNodeMesh(node);
    this.app.markDirty();
    this.renderNodesGrid();
    setTimeout(() => {
      const row = document.querySelector(`#nodes-grid-wrap tr[data-nid="${node.id}"]`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      row?.querySelector('.ng-x')?.focus();
    }, 60);
  }

  // ── Elements grid ──────────────────────────────────────────────────────────
  renderElemsGrid() {
    const wrap = document.getElementById('elems-grid-wrap');
    if (!wrap) return;
    const model = this.app.model;
    const res   = this.app._results;

    if (model.elements.size === 0) {
      wrap.innerHTML = '<p class="panel-hint">No hay elementos. Créelos en la vista 3D (tecla E).</p>';
      return;
    }

    const mats = [...model.materials.values()];
    const secs = [...model.sections.values()];

    const matOpts = id => mats.map(m =>
      `<option value="${m.id}" ${m.id === id ? 'selected' : ''}>${m.name}</option>`
    ).join('');
    const secOpts = id => secs.map(s =>
      `<option value="${s.id}" ${s.id === id ? 'selected' : ''}>${s.name}</option>`
    ).join('');

    // Force column (max abs value at either end)
    const fCol = (f, key1, key2 = null) => {
      if (!f) return '<td class="eg-f">—</td>';
      const v = key2 ? (Math.abs(f[key1]) > Math.abs(f[key2]) ? f[key1] : f[key2]) : f[key1];
      const col = Math.abs(v) < 1e-10 ? '' : v > 0 ? ' style="color:#ef5350"' : ' style="color:#42a5f5"';
      return `<td class="eg-f"${col}>${Math.abs(v) < 1e-10 ? '—' : v.toExponential(2)}</td>`;
    };

    let hasRes = false;
    let tbody = '';
    for (const el of model.elements.values()) {
      const f = res ? res.getElemForces(el.id) : null;
      if (f) hasRes = true;
      tbody += `<tr data-eid="${el.id}">
        <td class="eg-id">${el.id}</td>
        <td class="eg-node"><input type="number" class="eg-n1" value="${el.n1}" min="1" data-eid="${el.id}" data-f="n1"></td>
        <td class="eg-node"><input type="number" class="eg-n2" value="${el.n2}" min="1" data-eid="${el.id}" data-f="n2"></td>
        <td class="eg-sel"><select class="eg-mat" data-eid="${el.id}">${matOpts(el.matId)}</select></td>
        <td class="eg-sel"><select class="eg-sec" data-eid="${el.id}">${secOpts(el.secId)}</select></td>
        ${res ? `${fCol(f,'N')}${fCol(f,'Vy1','Vy2')}${fCol(f,'My1','My2')}${fCol(f,'Mz1','Mz2')}` : ''}
        <td class="ng-del"><button data-eid="${el.id}" title="Eliminar">×</button></td>
      </tr>`;
    }

    const resHeader = res
      ? '<th class="eg-f">N</th><th class="eg-f">Vy</th><th class="eg-f">My</th><th class="eg-f">Mz</th>'
      : '';

    wrap.innerHTML = `<table class="elems-grid">
      <thead><tr>
        <th>#</th><th>N1</th><th>N2</th><th>Mat.</th><th>Sec.</th>${resHeader}<th></th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;

    // Bind node inputs
    wrap.querySelectorAll('input[data-f]').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = +inp.dataset.eid;
        const field = inp.dataset.f;
        const val = parseInt(inp.value) || 1;
        this.app.snapshot();
        this.app.model.updateElement(id, { [field]: val });
        this.app.viewport.refreshElem(this.app.model.elements.get(id));
        this.app.markDirty();
      });
    });

    // Bind material/section selects
    wrap.querySelectorAll('.eg-mat').forEach(sel => {
      sel.addEventListener('change', () => {
        const id = +sel.dataset.eid;
        this.app.snapshot();
        this.app.model.updateElement(id, { matId: +sel.value });
        this.app.markDirty();
      });
    });
    wrap.querySelectorAll('.eg-sec').forEach(sel => {
      sel.addEventListener('change', () => {
        const id = +sel.dataset.eid;
        this.app.snapshot();
        this.app.model.updateElement(id, { secId: +sel.value });
        this.app.markDirty();
      });
    });

    // Bind delete buttons
    wrap.querySelectorAll('.ng-del button').forEach(btn => {
      btn.addEventListener('click', () => {
        this.app.deleteElement(+btn.dataset.eid);
        this.renderElemsGrid();
      });
    });
  }

  // ── Diaphragm membership + tributary mass for a node ──────────────────────
  _nodeDiaphragmHTML(node) {
    const model = this.app.model;
    const rows  = [];

    for (const d of model.diaphragms.values()) {
      if (!d.nodes.includes(node.id)) continue;

      const isMaster = (d.masterId === node.id) ||
                       (!d.masterId && d.nodes[0] === node.id);
      const floorNodes = d.nodes.map(id => model.nodes.get(id)).filter(Boolean);
      let massRow = '';

      if (d.mass?.m > 0 && floorNodes.length >= 1) {
        const weights = computeTributaryWeights(floorNodes, model, d.z);
        const w       = weights.get(node.id) ?? 0;
        const mNode   = w * d.mass.m;
        massRow = `<div class="prop-row">
          <div class="prop-field"><label>Masa tributaria</label>
            <span class="prop-val">${mNode.toFixed(3)} ton
              (${(w*100).toFixed(1)} % de ${d.mass.m} ton)</span>
          </div>
        </div>`;
      }

      rows.push(`
        <div class="prop-section" style="border-top:1px solid #00bcd433;margin-top:6px;padding-top:6px">
          <div class="prop-title" style="color:#00bcd4">
            Diafragma #${d.id} — ${d.name}${isMaster ? ' &nbsp;<span style="color:#00e5ff;font-weight:bold">[Nodo CR]</span>' : ''}
          </div>
          <div class="prop-row">
            <div class="prop-field"><label>Z piso</label>
              <span class="prop-val">${d.z} m</span>
            </div>
            <div class="prop-field"><label>CM</label>
              <span class="prop-val">(${+(d.cm?.x??0).toFixed(3)}, ${+(d.cm?.y??0).toFixed(3)})</span>
            </div>
            <div class="prop-field"><label>CR</label>
              <span class="prop-val">(${+(d.cr?.x??0).toFixed(3)}, ${+(d.cr?.y??0).toFixed(3)})</span>
            </div>
          </div>
          ${massRow}
        </div>`);
    }

    if (rows.length === 0) return '';
    return `<div class="prop-group">${rows.join('')}</div>`;
  }

  // ── Node form ──────────────────────────────────────────────────────────────
  _nodeHTML(node) {
    const r  = node.restraints;
    const nm = node.nodeMass || { mx: 0, my: 0, mz: 0 };
    const sp = node.springs  || { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 };
    const hasSp = Object.values(sp).some(k => k > 0);
    const is2D = this.app.model.mode === '2D';
    const outOfPlane = new Set(['uy', 'rx', 'rz']);   // restringidos auto en 2D
    const dof = ['ux','uy','uz','rx','ry','rz'];
    const labels = ['UX','UY','UZ','RX','RY','RZ'];
    const checks = dof.map((d, i) => {
      const dis = is2D && outOfPlane.has(d);
      return `<div class="restraint-cell" ${dis ? 'style="opacity:0.4" title="Modelo 2D: este GDL fuera del plano se restringe automáticamente"' : ''}>
        <input type="checkbox" data-dof="${d}" ${(r[d] || dis) ? 'checked' : ''} ${dis ? 'disabled' : ''}>
        <span>${labels[i]}</span>
      </div>`;
    }).join('');

    const hasNM = nm.mx > 0 || nm.my > 0 || nm.mz > 0;

    return `
      <div class="prop-id">Nodo #${node.id}</div>

      <div class="prop-section">
        <div class="prop-title">Coordenadas</div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>X</label><input type="number" id="n-x" value="${+node.x.toFixed(6)}" step="0.01"></div>
          <div class="prop-field"><label>Y</label><input type="number" id="n-y" value="${is2D ? 0 : +node.y.toFixed(6)}" step="0.01" ${is2D ? 'disabled title="Modelo 2D: todos los nodos están en el plano Y=0"' : ''}></div>
          <div class="prop-field"><label>Z</label><input type="number" id="n-z" value="${+node.z.toFixed(6)}" step="0.01"></div>
        </div>
      </div>

      <div class="prop-section restraints-section">
        <div class="prop-title">Restricciones (1 = fijo)</div>
        <div class="restraint-grid">${checks}</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
          <button class="btn-secondary" id="btn-fix-all" style="font-size:11px;" title="Fija las 6 GDL (3 traslaciones + 3 giros): empotramiento, resiste fuerzas y momentos.">Fijar Todo (empotramiento total)</button>
          <div style="display:flex;gap:6px;">
            <button class="btn-secondary" id="btn-free-all" style="flex:1;font-size:11px;">Liberar Todo</button>
            <button class="btn-secondary" id="btn-pin" style="flex:1;font-size:11px;" title="Apoyo articulado: fija traslaciones, libera giros (no resiste momentos).">Pin (rótula)</button>
          </div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title" style="${hasSp ? 'color:var(--teal)' : ''}">
          Apoyo Elástico — Resortes${hasSp ? ' ●' : ''}
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>kUX (kN/m)</label>
            <input type="number" id="ns-kux" value="${sp.kux ?? 0}" step="100" min="0">
          </div>
          <div class="prop-field"><label>kUY (kN/m)</label>
            <input type="number" id="ns-kuy" value="${sp.kuy ?? 0}" step="100" min="0">
          </div>
          <div class="prop-field"><label>kUZ (kN/m)</label>
            <input type="number" id="ns-kuz" value="${sp.kuz ?? 0}" step="100" min="0">
          </div>
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>kRX (kN·m/rad)</label>
            <input type="number" id="ns-krx" value="${sp.krx ?? 0}" step="100" min="0">
          </div>
          <div class="prop-field"><label>kRY (kN·m/rad)</label>
            <input type="number" id="ns-kry" value="${sp.kry ?? 0}" step="100" min="0">
          </div>
          <div class="prop-field"><label>kRZ (kN·m/rad)</label>
            <input type="number" id="ns-krz" value="${sp.krz ?? 0}" step="100" min="0">
          </div>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
          Apoyo parcial: resorte en GDL global <b>libre</b> (no marque la
          restricción rígida de ese GDL). k = 0 → sin resorte. La reacción
          del resorte aparece al mostrar Reacciones.
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title" style="${hasNM ? 'color:#ffd54f' : ''}">
          Masa Nodal Concentrada${hasNM ? ' ●' : ''}
        </div>
        <div class="prop-row cols3">
          <div class="prop-field"><label>mx (ton)</label>
            <input type="number" id="nm-mx" value="${nm.mx ?? 0}" step="0.1" min="0">
          </div>
          <div class="prop-field"><label>my (ton)</label>
            <input type="number" id="nm-my" value="${nm.my ?? 0}" step="0.1" min="0">
          </div>
          <div class="prop-field"><label>mz (ton)</label>
            <input type="number" id="nm-mz" value="${nm.mz ?? 0}" step="0.1" min="0">
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:4px">
          <button class="btn-secondary" id="btn-nm-iso" style="flex:1;font-size:11px;">
            Copiar mx → my, mz
          </button>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
          Entra en matriz M (análisis modal). W [kN] → m = W/9.81 ton
        </div>
      </div>

      <div class="delete-btn-row">
        <button class="btn-danger" id="btn-del-node" style="width:100%;">Eliminar Nodo #${node.id}</button>
      </div>
    `;
  }

  _bindNodeEvents(node) {
    const sel = this._tabContents.sel;

    const numVal = id => parseFloat(sel.querySelector(id)?.value) || 0;

    const save = () => {
      this.app.snapshot();
      const x = numVal('#n-x'), y = numVal('#n-y'), z = numVal('#n-z');
      const restraints = {};
      sel.querySelectorAll('[data-dof]').forEach(cb => {
        restraints[cb.dataset.dof] = cb.checked ? 1 : 0;
      });
      const nodeMass = {
        mx: numVal('#nm-mx'),
        my: numVal('#nm-my'),
        mz: numVal('#nm-mz'),
      };
      const springs = {
        kux: numVal('#ns-kux'), kuy: numVal('#ns-kuy'), kuz: numVal('#ns-kuz'),
        krx: numVal('#ns-krx'), kry: numVal('#ns-kry'), krz: numVal('#ns-krz'),
      };
      this.app.model.updateNode(node.id, { x, y, z, restraints, nodeMass, springs });
      this.app.viewport.refreshNode(this.app.model.nodes.get(node.id));
      this.app.markDirty();
    };

    sel.querySelectorAll('input[type=number]').forEach(inp =>
      inp.addEventListener('change', save)
    );
    sel.querySelectorAll('[data-dof]').forEach(cb =>
      cb.addEventListener('change', save)
    );

    // Quick presets
    sel.querySelector('#btn-fix-all')?.addEventListener('click', () => {
      sel.querySelectorAll('[data-dof]').forEach(cb => cb.checked = true);
      save();
    });
    sel.querySelector('#btn-free-all')?.addEventListener('click', () => {
      sel.querySelectorAll('[data-dof]').forEach(cb => cb.checked = false);
      save();
    });
    sel.querySelector('#btn-pin')?.addEventListener('click', () => {
      // Fix translations, free rotations
      ['ux','uy','uz'].forEach(d => { sel.querySelector(`[data-dof="${d}"]`).checked = true; });
      ['rx','ry','rz'].forEach(d => { sel.querySelector(`[data-dof="${d}"]`).checked = false; });
      save();
    });

    // Isotropic shortcut: copy mx to my and mz
    sel.querySelector('#btn-nm-iso')?.addEventListener('click', () => {
      const mxEl = sel.querySelector('#nm-mx');
      const val  = mxEl?.value ?? '0';
      sel.querySelector('#nm-my').value = val;
      sel.querySelector('#nm-mz').value = val;
      save();
    });

    sel.querySelector('#btn-del-node')?.addEventListener('click', () => {
      this.app.deleteNode(node.id);
    });
  }

  // ── Element form ───────────────────────────────────────────────────────────
  _elemHTML(elem) {
    const model = this.app.model;
    const matOptions = [...model.materials.values()].map(m =>
      `<option value="${m.id}" ${m.id === elem.matId ? 'selected' : ''}>${m.name}</option>`
    ).join('');
    const secOptions = [...model.sections.values()].map(s =>
      `<option value="${s.id}" ${s.id === elem.secId ? 'selected' : ''}>${s.name}</option>`
    ).join('');

    // Liberaciones etiquetadas por ESFUERZO (coinciden con los diagramas de
    // resultados): liberar Mz ⇒ el momento Mz vale 0 en ese extremo, etc.
    const relDefs = [
      { i: 0, lbl: 'N',  tip: 'fuerza axial' },
      { i: 1, lbl: 'Vy', tip: 'corte local y' },
      { i: 2, lbl: 'Vz', tip: 'corte local z' },
      { i: 3, lbl: 'T',  tip: 'torsión' },
      { i: 4, lbl: 'My', tip: 'flexión en plano local x–z' },
      { i: 5, lbl: 'Mz', tip: 'flexión en plano local x–y' },
    ];

    // Pista de orientación: a qué dirección GLOBAL corresponde cada flexión
    // (depende de la orientación del elemento — local ≠ global)
    let orientHint = '';
    {
      const n1 = model.nodes.get(elem.n1);
      const n2 = model.nodes.get(elem.n2);
      if (n1 && n2) {
        try {
          const { ey, ez } = localAxes(n1, n2);
          const gname = v => {
            const ax = ['X', 'Y', 'Z']; let b = 0;
            for (let k = 1; k < 3; k++) if (Math.abs(v[k]) > Math.abs(v[b])) b = k;
            return ax[b] + (b === 2 ? ' (gravedad)' : '');
          };
          orientHint = `<b>Mz</b> = flexión por cargas según <b>${gname(ey)}</b> global &nbsp;·&nbsp; <b>My</b> = por cargas según <b>${gname(ez)}</b> global`;
        } catch { /* elemento degenerado */ }
      }
    }

    const relHalf = (label, offset) => {
      const boxes = relDefs.map(d =>
        `<div class="releases-cell" title="Liberar ${d.lbl} (${d.tip}): el esfuerzo ${d.lbl} vale 0 en este extremo">
          <input type="checkbox" data-rel="${offset + d.i}" ${elem.releases[offset + d.i] ? 'checked' : ''}>
          <span>${d.lbl}</span>
        </div>`
      ).join('');
      return `<div class="releases-half">
        <div class="releases-half-title">${label}
          <span class="rel-presets">
            <button type="button" class="rel-btn" data-rel-pin="${offset}" title="Rótula clásica: libera My y Mz en este extremo">Rótula</button>
            <button type="button" class="rel-btn" data-rel-clear="${offset}" title="Quitar todas las liberaciones de este extremo">Limpiar</button>
          </span>
        </div>
        <div class="releases-grid">${boxes}</div>
      </div>`;
    };

    return `
      <div class="prop-id">Elemento #${elem.id}</div>

      <div class="prop-section">
        <div class="prop-title">Nodos</div>
        <div class="prop-row">
          <div class="prop-field"><label>Nodo 1</label><input type="number" id="e-n1" value="${elem.n1}" min="1"></div>
          <div class="prop-field"><label>Nodo 2</label><input type="number" id="e-n2" value="${elem.n2}" min="1"></div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title">Material</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Material</label>
            <select id="e-mat">${matOptions}</select>
          </div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title">Sección</div>
        <div class="prop-row cols1">
          <div class="prop-field"><label>Sección</label>
            <select id="e-sec">${secOptions}</select>
          </div>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title">Liberaciones (rótulas)</div>
        ${orientHint ? `<p class="rel-hint">${orientHint}</p>` : ''}
        ${relHalf(`Extremo 1 — nodo ${elem.n1}`, 0)}
        ${relHalf(`Extremo 2 — nodo ${elem.n2}`, 6)}
        <p class="rel-warn">⚠ Liberar en exceso crea mecanismos (estructura inestable): el análisis lo detectará y avisará.</p>
      </div>

      <div class="prop-section">
        <div class="prop-title">Herramientas Didácticas</div>
        <button class="btn-add" id="btn-elem-matrices" style="width:100%"
          title="Ver Ke local, T, Ke global y Me de este elemento — para comparar con el cálculo manual del curso">
          Σ Ver Matrices (Ke · T · Me)
        </button>
        <button class="btn-add" id="btn-elem-dcl" style="width:100%;margin-top:4px"
          title="Diagrama de cuerpo libre: fuerzas de extremo que actúan sobre el elemento + verificación ΣF=0 ΣM=0 (requiere análisis F5)">
          ⊟ Ver DCL del elemento
        </button>
      </div>

      <div class="prop-section">
        <div class="prop-title">Discretizar</div>
        <div class="prop-row">
          <div class="prop-field"><label>Nº de partes</label>
            <input type="number" id="disc-n" value="4" min="2" step="1">
          </div>
          <div class="prop-field" style="justify-content:flex-end">
            <button class="btn-add" id="btn-disc-n" style="width:100%" title="Divide este elemento en N tramos iguales">Dividir en N</button>
          </div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>Tramo (m)</label>
            <input type="number" id="disc-len" value="0.5" min="0.01" step="0.25">
          </div>
          <div class="prop-field" style="justify-content:flex-end">
            <button class="btn-add" id="btn-disc-len" style="width:100%" title="Divide este elemento en tramos de ≈ esta longitud">Dividir c/L</button>
          </div>
        </div>
        <p class="rel-warn" style="color:var(--text-muted)">Para volver a unir: seleccione los tramos con Ctrl+clic y use Editar → Unir Elementos Seleccionados (o Ctrl+Z).</p>
      </div>

      <div class="delete-btn-row">
        <button class="btn-danger" id="btn-del-elem" style="width:100%;">Eliminar Elemento #${elem.id}</button>
      </div>
    `;
  }

  _bindElemEvents(elem) {
    const sel = this._tabContents.sel;

    const save = () => {
      this.app.snapshot();
      const n1    = +sel.querySelector('#e-n1').value;
      const n2    = +sel.querySelector('#e-n2').value;
      const matId = +sel.querySelector('#e-mat').value;
      const secId = +sel.querySelector('#e-sec').value;
      const releases = Array(12).fill(0);
      sel.querySelectorAll('[data-rel]').forEach(cb => {
        releases[+cb.dataset.rel] = cb.checked ? 1 : 0;
      });
      this.app.model.updateElement(elem.id, { n1, n2, matId, secId, releases });
      this.app.viewport.refreshElem(this.app.model.elements.get(elem.id));
      this.app.markDirty();
    };

    sel.querySelectorAll('input[type=number]:not(#disc-n):not(#disc-len), select').forEach(inp =>
      inp.addEventListener('change', save)
    );
    sel.querySelectorAll('[data-rel]').forEach(cb =>
      cb.addEventListener('change', save)
    );

    // Visor de matrices del elemento
    sel.querySelector('#btn-elem-matrices')?.addEventListener('click', () => {
      this.app.showElementMatrices(elem.id);
    });
    // DCL del elemento (requiere resultados)
    sel.querySelector('#btn-elem-dcl')?.addEventListener('click', () => {
      this.app.showElementDCL(elem.id);
    });

    // Discretización del elemento
    sel.querySelector('#btn-disc-n')?.addEventListener('click', () => {
      const n = parseInt(sel.querySelector('#disc-n')?.value) || 0;
      if (n >= 2) this.app.discretizeElement(elem.id, { parts: n });
      else this.app.toast('Ingrese 2 o más partes', 'warn');
    });
    sel.querySelector('#btn-disc-len')?.addEventListener('click', () => {
      const l = parseFloat(sel.querySelector('#disc-len')?.value) || 0;
      if (l > 0) this.app.discretizeElement(elem.id, { length: l });
      else this.app.toast('Ingrese una longitud válida', 'warn');
    });

    // Presets de liberaciones por extremo
    sel.querySelectorAll('[data-rel-pin]').forEach(btn =>
      btn.addEventListener('click', () => {
        const off = +btn.dataset.relPin;
        [4, 5].forEach(i => {           // rótula clásica: My + Mz
          const cb = sel.querySelector(`[data-rel="${off + i}"]`);
          if (cb) cb.checked = true;
        });
        save();
      })
    );
    sel.querySelectorAll('[data-rel-clear]').forEach(btn =>
      btn.addEventListener('click', () => {
        const off = +btn.dataset.relClear;
        for (let i = 0; i < 6; i++) {
          const cb = sel.querySelector(`[data-rel="${off + i}"]`);
          if (cb) cb.checked = false;
        }
        save();
      })
    );

    sel.querySelector('#btn-del-elem')?.addEventListener('click', () => {
      this.app.deleteElement(elem.id);
    });
  }

  // ── Load input for nodes ───────────────────────────────────────────────────
  // Selector de caso de carga embebido — evita ir al overlay del viewport
  _lcSelectHTML(domId) {
    const opts = [...this.app.model.loadCases.values()].map(l => {
      const label = l.type === 'spectrum'
        ? `〜 ${l.name} [esp]`
        : l.name + (l.selfWeight ? ' ⊕PP' : '');
      return `<option value="${l.id}" ${l.id === this.app._activeLcId ? 'selected' : ''}>${label}</option>`;
    }).join('');
    return `<select id="${domId}" class="lc-inline-select" title="Caso de carga al que se asigna esta carga (⊕PP = incluye peso propio; 〜 = espectral, no admite cargas)">${opts}</select>`;
  }

  // Nota mostrada cuando el caso activo es espectral (no admite cargas)
  _spectralLoadNote(domId) {
    return `<div class="load-section">
      <div class="prop-title load-title-row">Cargas ${this._lcSelectHTML(domId)}</div>
      <p class="rel-hint" style="margin-top:6px">〜 Caso <b>espectral</b>: no admite cargas
        asignadas. Su resultado (envolvente sísmica) se calcula con Análisis Modal (F6)
        + Espectro de Respuesta (F7). Cambie a un caso estático para asignar cargas.</p>
    </div>`;
  }

  _nodeLoadsHTML(node) {
    const lcId = this.app._activeLcId;
    const lc   = this.app.model.loadCases.get(lcId);
    if (lc?.type === 'spectrum') return this._spectralLoadNote('loads-lc-node');
    const ex   = lc ? lc.loads.find(l => l.type === 'nodal' && l.nodeId === node.id) : null;
    const F    = ex ? ex.F : [0,0,0,0,0,0];
    return `<div class="load-section">
      <div class="prop-title load-title-row">Cargas Nodales ${this._lcSelectHTML('loads-lc-node')}</div>
      <div class="prop-row cols3">
        <div class="prop-field"><label>Fx</label><input type="number" data-lf="0" value="${F[0]}" step="1"></div>
        <div class="prop-field"><label>Fy</label><input type="number" data-lf="1" value="${F[1]}" step="1"></div>
        <div class="prop-field"><label>Fz</label><input type="number" data-lf="2" value="${F[2]}" step="1"></div>
      </div>
      <div class="prop-row cols3">
        <div class="prop-field"><label>Mx</label><input type="number" data-lf="3" value="${F[3]}" step="0.1"></div>
        <div class="prop-field"><label>My</label><input type="number" data-lf="4" value="${F[4]}" step="0.1"></div>
        <div class="prop-field"><label>Mz</label><input type="number" data-lf="5" value="${F[5]}" step="0.1"></div>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-primary" id="btn-apply-load" style="flex:1;font-size:11px;">Aplicar Carga</button>
        <button class="btn-secondary" id="btn-clear-load" style="flex:1;font-size:11px;">Limpiar</button>
      </div>
    </div>`;
  }

  _bindNodeLoadsEvents(node) {
    const sel = this._tabContents.sel;
    sel.querySelector('#loads-lc-node')?.addEventListener('change', e => {
      this.app._activeLcId = +e.target.value;
      this.app._renderLcSelector();
      this.app.refreshLoads();
      this.showNode(node);   // re-renderiza con las cargas del caso elegido
    });
    sel.querySelector('#btn-apply-load')?.addEventListener('click', () => {
      this.app.snapshot();
      const lc = this.app.model.loadCases.get(this.app._activeLcId);
      if (!lc) { this.app.toast('No hay caso de carga activo', 'warn'); return; }
      const F = [0,1,2,3,4,5].map(i => parseFloat(sel.querySelector(`[data-lf="${i}"]`)?.value) || 0);
      const idx = lc.loads.findIndex(l => l.type === 'nodal' && l.nodeId === node.id);
      const load = { type: 'nodal', nodeId: node.id, F };
      if (idx >= 0) lc.loads[idx] = load; else lc.loads.push(load);
      this.app.markDirty();
      this.app.refreshLoads();
      this.app.toast('Carga aplicada', 'ok');
    });
    sel.querySelector('#btn-clear-load')?.addEventListener('click', () => {
      this.app.snapshot();
      const lc = this.app.model.loadCases.get(this.app._activeLcId);
      if (!lc) return;
      lc.loads = lc.loads.filter(l => !(l.type === 'nodal' && l.nodeId === node.id));
      [0,1,2,3,4,5].forEach(i => { const inp = sel.querySelector(`[data-lf="${i}"]`); if (inp) inp.value = 0; });
      this.app.markDirty();
      this.app.refreshLoads();
      this.app.toast('Carga eliminada', '');
    });
  }

  _elemLoadsHTML(elem) {
    const lcId = this.app._activeLcId;
    const lc   = this.app.model.loadCases.get(lcId);
    if (lc?.type === 'spectrum') return this._spectralLoadNote('loads-lc-elem');
    const ex   = lc ? lc.loads.find(l => l.type === 'dist' && l.elemId === elem.id) : null;
    return `<div class="load-section">
      <div class="prop-title load-title-row">Carga Distribuida ${this._lcSelectHTML('loads-lc-elem')}</div>
      <div class="prop-row">
        <div class="prop-field"><label>Dirección</label>
          <select id="dist-dir">
            <option value="gravity" ${(ex?.dir==='gravity'||ex?.dir==='globalZ'||!ex?.dir)?'selected':''}>Gravedad ↓ (w&gt;0 = abajo)</option>
            <option value="globalX" ${ex?.dir==='globalX'?'selected':''}>Global +X</option>
            <option value="globalY" ${ex?.dir==='globalY'?'selected':''}>Global +Y</option>
            <option value="localY"  ${ex?.dir==='localY' ?'selected':''}>Local y</option>
            <option value="localZ"  ${ex?.dir==='localZ' ?'selected':''}>Local z</option>
          </select>
        </div>
        <div class="prop-field"><label>w (kN/m)</label>
          <input type="number" id="dist-w" value="${ex?.w ?? 0}" step="1">
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn-primary" id="btn-apply-dist" style="flex:1;font-size:11px;">Aplicar</button>
        <button class="btn-secondary" id="btn-clear-dist" style="flex:1;font-size:11px;">Limpiar</button>
      </div>
    </div>`;
  }

  _bindElemLoadsEvents(elem) {
    const sel = this._tabContents.sel;
    sel.querySelector('#loads-lc-elem')?.addEventListener('change', e => {
      this.app._activeLcId = +e.target.value;
      this.app._renderLcSelector();
      this.app.refreshLoads();
      this.showElement(elem);   // re-renderiza con las cargas del caso elegido
    });
    sel.querySelector('#btn-apply-dist')?.addEventListener('click', () => {
      this.app.snapshot();
      const lc = this.app.model.loadCases.get(this.app._activeLcId);
      if (!lc) { this.app.toast('No hay caso de carga activo', 'warn'); return; }
      const w   = parseFloat(sel.querySelector('#dist-w')?.value) || 0;
      const dir = sel.querySelector('#dist-dir')?.value || 'globalZ';
      const idx = lc.loads.findIndex(l => l.type === 'dist' && l.elemId === elem.id);
      const load = { type: 'dist', elemId: elem.id, dir, w };
      if (idx >= 0) lc.loads[idx] = load; else lc.loads.push(load);
      this.app.markDirty();
      this.app.refreshLoads();
      this.app.toast('Carga distribuida aplicada', 'ok');
    });
    sel.querySelector('#btn-clear-dist')?.addEventListener('click', () => {
      this.app.snapshot();
      const lc = this.app.model.loadCases.get(this.app._activeLcId);
      if (!lc) return;
      lc.loads = lc.loads.filter(l => !(l.type === 'dist' && l.elemId === elem.id));
      this.app.markDirty();
      this.app.refreshLoads();
    });
  }

  _nodeResultsHTML(node, results) {
    const d  = results.getNodeDisp(node.id);
    const rx = results.getReaction(node.id);
    const hasReact = Object.values(node.restraints).some(v=>v);
    const fv = v => `<span class="result-val ${Math.abs(v)<1e-10?'zero':v>0?'pos':'neg'}">${v.toExponential(4)}</span>`;
    let html = `<div class="prop-section" style="border:1px solid var(--success);border-radius:4px;padding:8px;margin-bottom:8px;">
      <div class="prop-title" style="color:var(--success)">Desplazamientos</div>
      <table class="results-table">
        <tr><th>DOF</th><th>Valor</th></tr>
        ${['Ux','Uy','Uz','Rx','Ry','Rz'].map((n,i)=>`<tr><td>${n}</td><td>${fv(d[i])}</td></tr>`).join('')}
      </table>`;
    if (hasReact) {
      html += `<div class="prop-title" style="color:var(--danger);margin-top:8px;">Reacciones</div>
      <table class="results-table">
        <tr><th>DOF</th><th>Valor</th></tr>
        ${['Rx','Ry','Rz','Rmx','Rmy','Rmz'].map((n,i)=>`<tr><td>${n}</td><td>${fv(rx[i])}</td></tr>`).join('')}
      </table>`;
    }
    return html + '</div>';
  }

  _elemResultsHTML(elem, results) {
    const f = results.getElemForces(elem.id);
    if (!f) return '';
    const fv = v => `<td class="${Math.abs(v)<1e-6?'':''}${v>0?'pos':'neg'}">${v.toExponential(4)}</td>`;
    return `<div class="prop-section" style="border:1px solid var(--success);border-radius:4px;padding:8px;margin-bottom:8px;">
      <div class="prop-title" style="color:var(--success)">Fuerzas Internas</div>
      <table class="results-table">
        <tr><th>Fuerza</th><th>Nodo 1</th><th>Nodo 2</th></tr>
        <tr><td>N</td>${fv(f.N)}<td>—</td></tr>
        <tr><td>Vy</td>${fv(f.Vy1)}${fv(f.Vy2)}</tr>
        <tr><td>Vz</td>${fv(f.Vz1)}${fv(f.Vz2)}</tr>
        <tr><td>T</td>${fv(f.T)}<td>—</td></tr>
        <tr><td>My</td>${fv(f.My1)}${fv(f.My2)}</tr>
        <tr><td>Mz</td>${fv(f.Mz1)}${fv(f.Mz2)}</tr>
      </table>
    </div>`;
  }

  // ── Materials tab ──────────────────────────────────────────────────────────
  renderMaterials() {
    const container = document.getElementById('mat-list');
    container.innerHTML = '';
    for (const mat of this.app.model.materials.values()) {
      container.appendChild(this._matCard(mat));
    }
  }

  _matCard(mat) {
    const card = document.createElement('div');
    card.className = 'mat-card';
    card.dataset.id = mat.id;
    card.innerHTML = `
      <div class="mat-card-head">
        <span class="mat-card-id">${mat.id}</span>
        <span class="mat-card-name">${mat.name}</span>
        <span class="mat-card-chevron">▶</span>
      </div>
      <div class="mat-card-body">
        <div class="prop-row">
          <div class="prop-field"><label>Nombre</label><input type="text" data-f="name" value="${mat.name}"></div>
          <div class="prop-field"><label>ρ (ton/m³)</label><input type="number" data-f="rho" value="${mat.rho}" step="0.01"></div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>E (kN/m²)</label><input type="number" data-f="E" value="${mat.E}" step="1e5"></div>
          <div class="prop-field"><label>G (kN/m²)</label><input type="number" data-f="G" value="${mat.G}" step="1e5"></div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>ν</label><input type="number" data-f="nu" value="${mat.nu}" step="0.01" min="0" max="0.5"></div>
        </div>
        <div class="card-actions">
          <button class="btn-danger btn-del-mat" style="flex:1;">Eliminar</button>
        </div>
      </div>
    `;
    card.querySelector('.mat-card-head').addEventListener('click', () => {
      card.classList.toggle('open');
    });
    card.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('change', () => {
        this.app.snapshot();
        const updates = {};
        card.querySelectorAll('[data-f]').forEach(i => {
          updates[i.dataset.f] = i.type === 'number' ? +i.value : i.value;
        });
        this.app.model.updateMaterial(mat.id, updates);
        // Update card name
        card.querySelector('.mat-card-name').textContent = updates.name || mat.name;
        this.app.markDirty();
      });
    });
    card.querySelector('.btn-del-mat').addEventListener('click', () => {
      const res = this.app.model.removeMaterial(mat.id);
      if (res.ok === false) { this.app.toast(res.reason, 'warn'); return; }
      this.app.markDirty();
      this.renderMaterials();
    });
    return card;
  }

  _addMaterial() {
    this.app.snapshot();
    this.app.model.addMaterial({ name: 'Nuevo Material' });
    this.app.markDirty();
    this.renderMaterials();
  }

  // ── Combinations tab ───────────────────────────────────────────────────────
  renderCombinations() {
    const container = document.getElementById('combo-list');
    if (!container) return;
    container.innerHTML = '';
    for (const c of this.app.model.combinations.values()) {
      container.appendChild(this._comboCard(c));
    }
  }

  _comboCard(combo) {
    const card = document.createElement('div');
    card.className = 'combo-card';
    card.dataset.id = combo.id;

    const head = document.createElement('div');
    head.className = 'combo-card-head';
    head.innerHTML = `
      <span class="mat-card-id" style="background:rgba(210,153,34,0.2);color:var(--warn)">${combo.id}</span>
      <span style="flex:1;font-size:13px;font-weight:600;color:var(--warn)">${combo.name}</span>
      <span class="mat-card-chevron">▶</span>`;
    head.addEventListener('click', () => card.classList.toggle('open'));

    const body = document.createElement('div');
    body.className = 'combo-card-body';

    const render = () => {
      body.innerHTML = '';

      // Name field
      body.insertAdjacentHTML('beforeend', `
        <div class="prop-row cols1" style="margin-bottom:8px">
          <div class="prop-field">
            <label>Nombre</label>
            <input type="text" class="combo-name-inp" value="${combo.name}">
          </div>
        </div>`);
      body.querySelector('.combo-name-inp').addEventListener('change', e => {
        combo.name = e.target.value;
        head.querySelector('span:nth-child(2)').textContent = combo.name;
        this.app.markDirty();
      });

      // Factor rows — includes static load cases AND available spectral results
      const lcs = [...this.app.model.loadCases.values()];
      const specEntries = [...(this.app._spectrumResults?.entries() || [])].map(([key, { params }]) => ({
        id: key,
        name: `[ESP] Dir-${params.direction} ${params.method}`
      }));
      body.insertAdjacentHTML('beforeend',
        '<div class="prop-title" style="margin-bottom:6px">Factores</div>');
      const factorsDiv = document.createElement('div');
      body.appendChild(factorsDiv);

      const renderFactors = () => {
        factorsDiv.innerHTML = '';
        combo.factors.forEach((fac, idx) => {
          const row = document.createElement('div');
          row.className = 'combo-factor-row';
          const staticOpts = lcs.map(lc =>
            `<option value="${lc.id}" ${String(lc.id) === String(fac.lcId) ? 'selected' : ''}>${lc.name}${lc.selfWeight ? ' ⊕PP' : ''}</option>`
          ).join('');
          const specOpts = specEntries.length
            ? `<optgroup label="── Espectral ──">${specEntries.map(s =>
                `<option value="${s.id}" ${s.id === fac.lcId ? 'selected' : ''}>${s.name}</option>`
              ).join('')}</optgroup>`
            : '';
          // El peso propio ya no se marca por factor: es propiedad del caso
          // de carga (editable con ✎ junto al selector de casos).
          row.innerHTML = `
            <select class="fac-lc">${staticOpts}${specOpts}</select>
            <input type="number" class="fac-val" value="${fac.factor}" step="0.1" placeholder="factor">
            <button class="combo-del-factor" title="Eliminar">×</button>`;
          row.querySelector('.fac-lc').addEventListener('change', e => {
            const v = e.target.value;
            combo.factors[idx].lcId = /^\d+$/.test(v) ? parseInt(v) : v;
            this.app.markDirty();
          });
          row.querySelector('.fac-val').addEventListener('change', e => {
            combo.factors[idx].factor = parseFloat(e.target.value) || 0;
            this.app.markDirty();
          });
          row.querySelector('.combo-del-factor').addEventListener('click', () => {
            combo.factors.splice(idx, 1);
            renderFactors();
            this.app.markDirty();
          });
          factorsDiv.appendChild(row);
        });
      };
      renderFactors();

      // Add factor button
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-add';
      addBtn.style.marginTop = '4px';
      addBtn.textContent = '＋ Agregar Factor';
      addBtn.addEventListener('click', () => {
        const firstId = lcs[0] ? lcs[0].id : (specEntries[0] ? specEntries[0].id : null);
        combo.factors.push({ lcId: firstId, factor: 1.0 });
        renderFactors();
        this.app.markDirty();
      });
      body.appendChild(addBtn);

      // Run + Delete buttons
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      actions.style.marginTop = '10px';
      actions.innerHTML = `
        <button class="combo-run-btn" style="flex:1">▶ Ejecutar</button>
        <button class="btn-danger" style="flex:1">Eliminar</button>`;
      actions.querySelector('.combo-run-btn').addEventListener('click', () => {
        this.app.runCombination(combo.id);
      });
      actions.querySelector('.btn-danger').addEventListener('click', () => {
        this.app.snapshot();
        this.app.model.removeCombination(combo.id);
        this.app.markDirty();
        this.renderCombinations();
        this.app._renderLcSelector();
      });
      body.appendChild(actions);
    };

    render();
    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  _addCombination() {
    this.app.snapshot();
    this.app.model.addCombination({ name: `Combo ${this.app.model.combinations.size + 1}` });
    this.app.markDirty();
    this.renderCombinations();
    this.app._renderLcSelector();
  }

  // ── Sections tab ───────────────────────────────────────────────────────────
  renderSections() {
    const container = document.getElementById('sec-list');
    container.innerHTML = '';
    for (const sec of this.app.model.sections.values()) {
      container.appendChild(this._secCard(sec));
    }
  }

  _secCard(sec) {
    const card = document.createElement('div');
    card.className = 'sec-card';
    card.dataset.id = sec.id;

    const fld = (label, key, step = '0.0001') =>
      `<div class="prop-field"><label>${label}</label><input type="number" data-f="${key}" value="${sec[key]}" step="${step}"></div>`;

    card.innerHTML = `
      <div class="sec-card-head">
        <span class="sec-card-id">${sec.id}</span>
        <span class="sec-card-name">${sec.name}</span>
        <span class="sec-card-chevron">▶</span>
      </div>
      <div class="sec-card-body">
        <div class="prop-row cols1">
          <div class="prop-field"><label>Nombre</label><input type="text" data-f="name" value="${sec.name}"></div>
        </div>
        <div class="prop-row">
          ${fld('A (m²)', 'A')}
          ${fld('J (m⁴)', 'J')}
        </div>
        <div class="prop-row">
          ${fld('Iz (m⁴)', 'Iz')}
          ${fld('Iy (m⁴)', 'Iy')}
        </div>
        <div class="prop-row">
          ${fld('Avy (m²)', 'Avy')}
          ${fld('Avz (m²)', 'Avz')}
        </div>
        <div class="prop-row">
          ${fld('κy', 'kappay', '0.001')}
          ${fld('κz', 'kappaz', '0.001')}
        </div>
        <div class="card-actions">
          <button class="btn-danger btn-del-sec" style="flex:1;">Eliminar</button>
        </div>
      </div>
    `;
    card.querySelector('.sec-card-head').addEventListener('click', () => {
      card.classList.toggle('open');
    });
    card.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('change', () => {
        this.app.snapshot();
        const updates = {};
        card.querySelectorAll('[data-f]').forEach(i => {
          updates[i.dataset.f] = i.type === 'number' ? +i.value : i.value;
        });
        this.app.model.updateSection(sec.id, updates);
        card.querySelector('.sec-card-name').textContent = updates.name || sec.name;
        this.app.markDirty();
      });
    });
    card.querySelector('.btn-del-sec').addEventListener('click', () => {
      const res = this.app.model.removeSection(sec.id);
      if (res.ok === false) { this.app.toast(res.reason, 'warn'); return; }
      this.app.markDirty();
      this.renderSections();
    });
    return card;
  }

  // ── P3-9: Section calculator dialog ───────────────────────────────────────
  _sectionCalculatorDialog() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Calculadora de Sección';
    document.getElementById('modal-cancel').style.display = '';

    // Standard section database (values in SI: A [m²], Iz/Iy [m⁴], J [m⁴])
    const IPE = {
      'IPE100':{A:10.3e-4,Iz:171e-8,  Iy:15.9e-8, J:1.20e-8},
      'IPE120':{A:13.2e-4,Iz:318e-8,  Iy:27.7e-8, J:1.74e-8},
      'IPE140':{A:16.4e-4,Iz:541e-8,  Iy:44.9e-8, J:2.45e-8},
      'IPE160':{A:20.1e-4,Iz:869e-8,  Iy:68.3e-8, J:3.60e-8},
      'IPE180':{A:23.9e-4,Iz:1317e-8, Iy:100.9e-8,J:4.79e-8},
      'IPE200':{A:28.5e-4,Iz:1943e-8, Iy:142e-8,  J:6.98e-8},
      'IPE220':{A:33.4e-4,Iz:2772e-8, Iy:205e-8,  J:9.07e-8},
      'IPE240':{A:39.1e-4,Iz:3892e-8, Iy:284e-8,  J:12.7e-8},
      'IPE270':{A:45.9e-4,Iz:5790e-8, Iy:420e-8,  J:15.9e-8},
      'IPE300':{A:53.8e-4,Iz:8356e-8, Iy:604e-8,  J:20.1e-8},
      'IPE330':{A:62.6e-4,Iz:11770e-8,Iy:788e-8,  J:28.2e-8},
      'IPE360':{A:72.7e-4,Iz:16270e-8,Iy:1043e-8, J:37.3e-8},
      'IPE400':{A:84.5e-4,Iz:23130e-8,Iy:1318e-8, J:51.1e-8},
      'IPE450':{A:98.8e-4,Iz:33740e-8,Iy:1676e-8, J:66.9e-8},
      'IPE500':{A:116e-4, Iz:48200e-8,Iy:2142e-8, J:89.3e-8},
    };
    const HEB = {
      'HEB100':{A:26.0e-4,Iz:450e-8,  Iy:167e-8,  J:9.25e-8},
      'HEB120':{A:34.0e-4,Iz:864e-8,  Iy:318e-8,  J:13.8e-8},
      'HEB140':{A:43.0e-4,Iz:1509e-8, Iy:550e-8,  J:20.1e-8},
      'HEB160':{A:54.3e-4,Iz:2492e-8, Iy:889e-8,  J:31.2e-8},
      'HEB180':{A:65.3e-4,Iz:3831e-8, Iy:1363e-8, J:42.2e-8},
      'HEB200':{A:78.1e-4,Iz:5696e-8, Iy:2003e-8, J:59.3e-8},
      'HEB220':{A:91.0e-4,Iz:8091e-8, Iy:2843e-8, J:76.6e-8},
      'HEB240':{A:106e-4, Iz:11260e-8,Iy:3923e-8, J:102e-8},
      'HEB260':{A:118e-4, Iz:14920e-8,Iy:5135e-8, J:124e-8},
      'HEB280':{A:131e-4, Iz:19270e-8,Iy:6595e-8, J:144e-8},
      'HEB300':{A:149e-4, Iz:25170e-8,Iy:8563e-8, J:185e-8},
    };

    const ipeOpts = Object.keys(IPE).map(k=>`<option value="${k}">${k}</option>`).join('');
    const hebOpts = Object.keys(HEB).map(k=>`<option value="${k}">${k}</option>`).join('');

    document.getElementById('modal-body').innerHTML = `
      <div class="prop-row cols1" style="margin-bottom:8px">
        <div class="prop-field">
          <label>Forma de sección</label>
          <select id="sc-shape">
            <option value="rect">Rectangular (b × h)</option>
            <option value="circ">Circular sólida (D)</option>
            <option value="hrect">Rectangular hueca</option>
            <option value="hcirc">Tubular circular</option>
            <option value="ipe">Perfil IPE (tabla)</option>
            <option value="heb">Perfil HEB (tabla)</option>
          </select>
        </div>
      </div>
      <div id="sc-inputs" style="margin-bottom:8px"></div>
      <div id="sc-results" style="background:rgba(255,255,255,0.03);padding:8px;
          border-radius:4px;font-size:11px;font-family:monospace;color:var(--text)">
        — Selecciona una forma —
      </div>`;

    overlay.classList.remove('hidden');

    const shapeEl   = document.getElementById('sc-shape');
    const inputsEl  = document.getElementById('sc-inputs');
    const resEl     = document.getElementById('sc-results');
    let   lastData  = null;

    const shapes = {
      rect: `
        <div class="prop-row">
          <div class="prop-field"><label>b (m)</label>
            <input type="number" id="sc-b" value="0.30" step="0.01" min="0.001"></div>
          <div class="prop-field"><label>h (m)</label>
            <input type="number" id="sc-h" value="0.50" step="0.01" min="0.001"></div>
        </div>`,
      circ: `
        <div class="prop-row cols1">
          <div class="prop-field"><label>D (m)</label>
            <input type="number" id="sc-D" value="0.40" step="0.01" min="0.001"></div>
        </div>`,
      hrect: `
        <div class="prop-row">
          <div class="prop-field"><label>b (m)</label>
            <input type="number" id="sc-b" value="0.40" step="0.01" min="0.01"></div>
          <div class="prop-field"><label>h (m)</label>
            <input type="number" id="sc-h" value="0.60" step="0.01" min="0.01"></div>
          <div class="prop-field"><label>t espesor (m)</label>
            <input type="number" id="sc-t" value="0.06" step="0.005" min="0.001"></div>
        </div>`,
      hcirc: `
        <div class="prop-row">
          <div class="prop-field"><label>D ext (m)</label>
            <input type="number" id="sc-D" value="0.40" step="0.01" min="0.01"></div>
          <div class="prop-field"><label>t espesor (m)</label>
            <input type="number" id="sc-t" value="0.02" step="0.005" min="0.001"></div>
        </div>`,
      ipe:  `<div class="prop-field"><label>Perfil IPE</label>
               <select id="sc-ipe">${ipeOpts}</select></div>`,
      heb:  `<div class="prop-field"><label>Perfil HEB</label>
               <select id="sc-heb">${hebOpts}</select></div>`,
    };

    const g = id => parseFloat(document.getElementById(id)?.value) || 0;
    const kappa = 5 / 6;

    const calc = () => {
      const shape = shapeEl.value;
      let A, Iz, Iy, J, Avy, Avz, name;

      if (shape === 'rect') {
        const b = g('sc-b'), h = g('sc-h');
        A = b * h; Iz = b * h ** 3 / 12; Iy = h * b ** 3 / 12;
        J = (b < h ? b : h) ** 3 * (b > h ? b : h) / 3 * (1 - 0.63 * Math.min(b,h)/Math.max(b,h));
        Avy = kappa * b * h; Avz = kappa * b * h;
        name = `Rect ${(b*100).toFixed(0)}×${(h*100).toFixed(0)}cm`;
      } else if (shape === 'circ') {
        const r = g('sc-D') / 2;
        A = Math.PI * r ** 2; Iz = Iy = Math.PI * r ** 4 / 4;
        J = Math.PI * r ** 4 / 2; Avy = Avz = 0.9 * A;
        name = `Circ Ø${(r*200).toFixed(0)}cm`;
      } else if (shape === 'hrect') {
        const b = g('sc-b'), h = g('sc-h'), t = g('sc-t');
        const bi = b-2*t, hi = h-2*t;
        A = b*h - bi*hi; Iz = (b*h**3 - bi*hi**3)/12; Iy = (h*b**3 - hi*bi**3)/12;
        J = 2*t*(b-t)**2*(h-t)**2/(b+h-2*t);
        Avy = Avz = 2*h*t;
        name = `Rect ${(b*100).toFixed(0)}×${(h*100).toFixed(0)}×${(t*100).toFixed(1)}cm`;
      } else if (shape === 'hcirc') {
        const D = g('sc-D'), t = g('sc-t'), ro = D/2, ri = D/2 - t;
        A = Math.PI*(ro**2 - ri**2); Iz = Iy = Math.PI*(ro**4 - ri**4)/4;
        J = Math.PI*(ro**4 - ri**4)/2; Avy = Avz = A * 0.5;
        name = `Tubo Ø${(D*100).toFixed(0)}×${(t*100).toFixed(1)}cm`;
      } else if (shape === 'ipe') {
        const p = document.getElementById('sc-ipe')?.value || 'IPE200';
        const d = IPE[p]; if (!d) return;
        ({A,Iz,Iy,J} = d); Avy = Avz = A * 0.5; name = p;
      } else if (shape === 'heb') {
        const p = document.getElementById('sc-heb')?.value || 'HEB200';
        const d = HEB[p]; if (!d) return;
        ({A,Iz,Iy,J} = d); Avy = Avz = A * 0.5; name = p;
      }

      if (!A || A <= 0) { resEl.innerHTML = '<span style="color:var(--warn)">⚠ Dimensiones inválidas</span>'; return; }
      lastData = { name, A, Iz, Iy, J, Avy: Avy||kappa*A, Avz: Avz||kappa*A, kappay: kappa, kappaz: kappa };

      resEl.innerHTML = `<table style="width:100%;border-collapse:collapse">
        ${[
          ['Nombre', `<b>${name}</b>`],
          ['A  (m²)', A.toExponential(4)],
          ['Iz (m⁴)', Iz.toExponential(4)],
          ['Iy (m⁴)', Iy.toExponential(4)],
          ['J  (m⁴)', J.toExponential(4)],
          ['Avy (m²)', (Avy||kappa*A).toExponential(4)],
          ['Avz (m²)', (Avz||kappa*A).toExponential(4)],
        ].map(([l,v]) =>
          `<tr><td style="color:var(--text-muted);padding:2px 8px 2px 0">${l}</td>
               <td>${v}</td></tr>`
        ).join('')}
      </table>`;
    };

    const rebind = () => {
      inputsEl.querySelectorAll('input,select').forEach(el => el.addEventListener('input', calc));
      calc();
    };

    inputsEl.innerHTML = shapes[shapeEl.value] || '';
    rebind();
    shapeEl.addEventListener('change', () => {
      inputsEl.innerHTML = shapes[shapeEl.value] || '';
      rebind();
    });

    overlay._resolve = () => {
      if (!lastData) return;
      this.app.snapshot();
      this.app.model.addSection(lastData);
      this.app.markDirty();
      this.renderSections();
      this._switchTab('sec');
      this.app.toast(`Sección "${lastData.name}" creada`, 'ok');
    };
    overlay._reject = () => {};
  }

  _addSection() {
    this.app.snapshot();
    this.app.model.addSection({ name: 'Nueva Sección' });
    this.app.markDirty();
    this.renderSections();
  }

  // ── Results tabs ───────────────────────────────────────────────────────────
  renderResults() {
    this.renderModalResults();
    this.renderStaticResults();
  }

  renderModalResults() {
    const body = document.getElementById('res-modal-body');
    const hint = document.getElementById('res-modal-hint');
    if (!body) return;
    const modal = this.app._modalResults;
    if (!modal) {
      body.innerHTML = '';
      if (hint) hint.style.display = '';
      return;
    }
    if (hint) hint.style.display = 'none';
    body.innerHTML = '';

    body.insertAdjacentHTML('beforeend', '<div class="res-section-title">Participación de masas (%)</div>');
    const th = '<tr><th>M.</th><th>f(Hz)</th><th>T(s)</th>' +
               '<th>%X</th><th>%Y</th><th>%Rz</th>' +
               '<th>ΣX%</th><th>ΣY%</th><th>ΣRz%</th></tr>';
    let rows = '';
    const { rows: prows } = modal.getParticipation();
    for (const r of prows) {
      const okX = r.cumPct[0] >= 90, okY = r.cumPct[1] >= 90, okRz = r.cumPct[2] >= 90;
      const cx  = okX  ? 'cum-ok' : r.cumPct[0] > 60 ? 'cum-warn' : '';
      const cy  = okY  ? 'cum-ok' : r.cumPct[1] > 60 ? 'cum-warn' : '';
      const crz = okRz ? 'cum-ok' : r.cumPct[2] > 60 ? 'cum-warn' : '';
      rows += `<tr>
        <td>${r.mode}</td>
        <td>${r.freq.toFixed(3)}</td>
        <td>${r.period.toFixed(3)}</td>
        <td>${r.pct[0].toFixed(1)}</td>
        <td>${r.pct[1].toFixed(1)}</td>
        <td>${r.pct[2].toFixed(1)}</td>
        <td class="${cx}">${r.cumPct[0].toFixed(1)}</td>
        <td class="${cy}">${r.cumPct[1].toFixed(1)}</td>
        <td class="${crz}">${r.cumPct[2].toFixed(1)}</td>
      </tr>`;
    }
    body.insertAdjacentHTML('beforeend',
      `<table class="res-table"><thead>${th}</thead><tbody>${rows}</tbody></table>`);
  }

  renderStaticResults() {
    const body = document.getElementById('res-static-body');
    const hint = document.getElementById('res-static-hint');
    if (!body) return;
    const res = this.app._results;
    if (!res) {
      body.innerHTML = '';
      if (hint) hint.style.display = '';
      return;
    }
    if (hint) hint.style.display = 'none';
    body.innerHTML = '';

    // Show spectral header when result is a SpectrumResults (has .meta)
    const meta = res.meta;
    if (meta) {
      body.insertAdjacentHTML('beforeend',
        `<div class="res-section-title" style="color:var(--accent);margin-bottom:6px">
          Espectro Dir-${meta.direction} | ${meta.method} | ζ=${(meta.zeta * 100).toFixed(0)}% | ${meta.nModes} modos
        </div>`);
    }

    const fv = v => {
      const a = Math.abs(v);
      const cls = a < 1e-10 ? '' : v > 0 ? ' vp' : ' vn';
      return `<td class="${cls.trim()}">${a < 1e-10 ? '—' : v.toExponential(3)}</td>`;
    };

    body.insertAdjacentHTML('beforeend', '<div class="res-section-title">Fuerzas en Elementos</div>');
    const thE = '<tr><th>El.</th><th>N</th><th>Vy</th><th>Vz</th><th>T</th><th>My</th><th>Mz</th></tr>';
    let rowsE = '';
    for (const elem of this.app.model.elements.values()) {
      const f = res.getElemForces(elem.id);
      if (!f) continue;
      const Vy = Math.abs(f.Vy1) > Math.abs(f.Vy2) ? f.Vy1 : f.Vy2;
      const Vz = Math.abs(f.Vz1) > Math.abs(f.Vz2) ? f.Vz1 : f.Vz2;
      const My = Math.abs(f.My1) > Math.abs(f.My2) ? f.My1 : f.My2;
      const Mz = Math.abs(f.Mz1) > Math.abs(f.Mz2) ? f.Mz1 : f.Mz2;
      rowsE += `<tr><td>${elem.id}</td>${fv(f.N)}${fv(Vy)}${fv(Vz)}${fv(f.T)}${fv(My)}${fv(Mz)}</tr>`;
    }
    body.insertAdjacentHTML('beforeend',
      `<table class="res-table"><thead>${thE}</thead><tbody>${rowsE}</tbody></table>`);

    body.insertAdjacentHTML('beforeend', '<div class="res-section-title">Desplazamientos Nodales</div>');
    const thN = '<tr><th>Nd.</th><th>Ux</th><th>Uy</th><th>Uz</th><th>|δ|</th></tr>';
    let rowsN = '';
    for (const node of this.app.model.nodes.values()) {
      const d = res.getNodeDisp(node.id);
      const mag = Math.hypot(d[0], d[1], d[2]);
      rowsN += `<tr><td>${node.id}</td>${fv(d[0])}${fv(d[1])}${fv(d[2])}${fv(mag)}</tr>`;
    }
    body.insertAdjacentHTML('beforeend',
      `<table class="res-table"><thead>${thN}</thead><tbody>${rowsN}</tbody></table>`);
  }

  // ── Diaphragms tab ─────────────────────────────────────────────────────────
  renderDiaphragms() {
    const container = document.getElementById('dia-list');
    if (!container) return;
    container.innerHTML = '';

    if (this.app.model.diaphragms.size === 0) {
      container.innerHTML = '<p class="panel-hint">No hay diafragmas definidos. Use "Auto-detectar Pisos" o agregue uno manualmente.</p>';
      return;
    }

    // Sort by Z
    const sorted = [...this.app.model.diaphragms.values()].sort((a,b) => a.z - b.z);
    for (const d of sorted) container.appendChild(this._diaCard(d));
  }

  _diaCard(d) {
    const card = document.createElement('div');
    card.className = 'mat-card'; // reuse mat-card styles
    card.dataset.id = d.id;

    const nodeCount  = d.nodes.length;
    const masterNode = this.app.model.nodes.get(d.masterId || d.nodes[0]);
    const hasMass    = d.mass && (d.mass.m > 0 || d.mass.Icm > 0);

    card.innerHTML = `
      <div class="mat-card-head">
        <span class="mat-card-id" style="background:rgba(0,188,212,0.2);color:#00bcd4">${d.id}</span>
        <span class="mat-card-name" style="color:#00bcd4">${d.name}</span>
        <span style="font-size:10px;color:var(--text-muted);margin-left:auto">${nodeCount} nodos | Z=${d.z}</span>
        <span class="mat-card-chevron">▶</span>
      </div>
      <div class="mat-card-body">
        <div class="prop-row cols1">
          <div class="prop-field"><label>Nombre</label>
            <input type="text" data-df="name" value="${d.name}">
          </div>
        </div>
        <div class="prop-row">
          <div class="prop-field"><label>Z piso (m)</label>
            <input type="number" data-df="z" value="${d.z}" step="0.1">
          </div>
          <div class="prop-field"><label>Nodo CR (master) ID</label>
            <input type="number" data-df="masterId" value="${d.masterId || d.nodes[0]}" step="1" min="1">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Centro de Rigidez (CR) — calculado</div>
        <div class="prop-row">
          <div class="prop-field"><label>CR x (m)</label>
            <input type="number" data-df="cr.x" value="${+(d.cr?.x ?? 0).toFixed(4)}" step="0.01" readonly style="opacity:.6">
          </div>
          <div class="prop-field"><label>CR y (m)</label>
            <input type="number" data-df="cr.y" value="${+(d.cr?.y ?? 0).toFixed(4)}" step="0.01" readonly style="opacity:.6">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Centro de Masa (CM) — calculado</div>
        <div class="prop-row">
          <div class="prop-field"><label>CM x (m)</label>
            <input type="number" data-df="cm.x" value="${+(d.cm?.x ?? 0).toFixed(4)}" step="0.01" readonly style="opacity:.6">
          </div>
          <div class="prop-field"><label>CM y (m)</label>
            <input type="number" data-df="cm.y" value="${+(d.cm?.y ?? 0).toFixed(4)}" step="0.01" readonly style="opacity:.6">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Masa Concentrada</div>
        <div class="prop-row">
          <div class="prop-field"><label>m (ton)</label>
            <input type="number" data-df="mass.m" value="${d.mass?.m ?? 0}" step="1" min="0">
          </div>
          <div class="prop-field"><label>Icm (ton·m²)</label>
            <input type="number" data-df="mass.Icm" value="${d.mass?.Icm ?? 0}" step="1" min="0">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Excentricidad Accidental</div>
        <div class="prop-row">
          <div class="prop-field"><label>eₓ (m)</label>
            <input type="number" data-df="ecc.ex" value="${d.eccentricity?.ex ?? 0}" step="0.01">
          </div>
          <div class="prop-field"><label>eᵧ (m)</label>
            <input type="number" data-df="ecc.ey" value="${d.eccentricity?.ey ?? 0}" step="0.01">
          </div>
        </div>
        <div class="prop-title" style="margin-top:8px;">Nodos del Piso</div>
        <div class="prop-row cols1">
          <div class="prop-field">
            <label>IDs (separados por coma)</label>
            <input type="text" data-df="nodes" value="${d.nodes.join(', ')}">
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-recalc-dia" style="flex:1">⟳ Recalcular CM/CR</button>
          <button class="btn-danger btn-del-dia" style="flex:1">Eliminar</button>
        </div>
      </div>
    `;

    // Toggle expand
    card.querySelector('.mat-card-head').addEventListener('click', () => card.classList.toggle('open'));

    // ── helpers ────────────────────────────────────────────────────────────
    const get    = sel => card.querySelector(`[data-df="${sel}"]`)?.value;
    const getNum = sel => parseFloat(get(sel)) || 0;
    const setVal = (sel, v) => {
      const el = card.querySelector(`[data-df="${sel}"]`);
      if (el) el.value = typeof v === 'number' ? +v.toFixed(4) : v;
    };

    // Recompute CM and CR from current node list; update read-only fields
    const recalcCMCR = (nodeIds, floorZ) => {
      const model      = this.app.model;
      const floorNodes = nodeIds.map(id => model.nodes.get(id)).filter(Boolean);
      if (floorNodes.length < 2) return {};

      const weights = computeTributaryWeights(floorNodes, model, floorZ);
      const cm      = computeFloorCM(floorNodes, weights);
      const cr      = computeFloorCR(model, new Set(nodeIds), floorZ);

      setVal('cm.x', cm.x); setVal('cm.y', cm.y);
      if (cr) { setVal('cr.x', cr.x); setVal('cr.y', cr.y); }
      return { cm, cr };
    };

    // ── Save on any field change ────────────────────────────────────────────
    const saveCard = () => {
      this.app.snapshot();
      const nodesStr = get('nodes') || '';
      const nodeIds  = nodesStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      const floorZ   = getNum('z');

      this.app.model.diaphragms.set(d.id, {
        ...d,
        name:         get('name') || d.name,
        z:            floorZ,
        masterId:     parseInt(get('masterId')) || nodeIds[0],
        cm:           { x: getNum('cm.x'), y: getNum('cm.y') },
        cr:           { x: getNum('cr.x'), y: getNum('cr.y') },
        mass:         { m: getNum('mass.m'), Icm: getNum('mass.Icm') },
        eccentricity: { ex: getNum('ecc.ex'), ey: getNum('ecc.ey') },
        nodes:        nodeIds,
      });
      this.app.viewport.refreshDiaphragms();
      this.app.markDirty();
    };

    // Auto-recalc CM/CR when the nodes list changes
    card.querySelector('[data-df="nodes"]').addEventListener('change', () => {
      const nodesStr = get('nodes') || '';
      const nodeIds  = nodesStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      recalcCMCR(nodeIds, getNum('z'));
      saveCard();
    });

    // Other inputs just save
    card.querySelectorAll('input:not([data-df="nodes"])').forEach(inp =>
      inp.addEventListener('change', saveCard)
    );

    // Recalculate button
    card.querySelector('.btn-recalc-dia').addEventListener('click', () => {
      const nodesStr = get('nodes') || '';
      const nodeIds  = nodesStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      const { cm, cr } = recalcCMCR(nodeIds, getNum('z'));
      if (!cm) { this.app.toast('Necesitas ≥ 2 nodos válidos', 'warn'); return; }
      saveCard();
      this.app.toast('CM y CR recalculados', 'ok');
    });

    card.querySelector('.btn-del-dia').addEventListener('click', () => {
      this.app.snapshot();
      this.app.model.removeDiaphragm(d.id);
      this.app.viewport.refreshDiaphragms();
      this.app.markDirty();
      this.renderDiaphragms();
    });

    return card;
  }
}
