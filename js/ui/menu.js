// ──────────────────────────────────────────────────────────────────────────────
// MenuBar — top menu + left toolbar wiring
// ──────────────────────────────────────────────────────────────────────────────

export class MenuBar {
  constructor(menuEl, app) {
    this.menu = menuEl;
    this.app  = app;
    this._init();
  }

  _init() {
    // ── Dropdown menu actions ─────────────────────────────────────────────────
    this.menu.querySelectorAll('[data-action]').forEach(item => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        const action = e.currentTarget.dataset.action;
        this._handleAction(action);
        // Close dropdown
        document.querySelectorAll('.menu-root').forEach(r => r.classList.remove('open'));
      });
    });

    // Open / close dropdowns on click (for mobile / accessibility)
    this.menu.querySelectorAll('.menu-root').forEach(root => {
      root.querySelector('.menu-label')?.addEventListener('click', () => {
        const isOpen = root.classList.contains('open');
        document.querySelectorAll('.menu-root').forEach(r => r.classList.remove('open'));
        if (!isOpen) root.classList.add('open');
      });
    });

    // Close on outside click
    document.addEventListener('click', () => {
      document.querySelectorAll('.menu-root').forEach(r => r.classList.remove('open'));
    });

    // ── Left toolbar ──────────────────────────────────────────────────────────
    document.querySelectorAll('.tool[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.app.viewport.setMode(btn.dataset.mode);
      });
    });

    document.getElementById('btn-zoomext')?.addEventListener('click', () => {
      this.app.viewport.zoomExtents();
    });

    // ── Unit selector ─────────────────────────────────────────────────────────
    document.getElementById('unit-select').addEventListener('change', e => {
      this.app.model.units = e.target.value;
      document.getElementById('sb-units').textContent = e.target.value.replace('-', ' — ');
      this.app.markDirty();
    });
  }

  _handleAction(action) {
    const a = this.app;
    switch (action) {
      case 'new':         a.newFile();        break;
      case 'open':        a.openFile();       break;
      case 'save':        a.saveFile();       break;
      case 'saveas':      a.saveFileAs();     break;
      case 'importcsv':   a.importCSV();      break;
      case 'exportcsv':   a.exportCSV();      break;
      case 'template':    a.downloadTemplate(); break;
      case 'undo':        a.undo();           break;
      case 'redo':        a.redo();           break;
      case 'selectall':   a.viewport.selectAll(); break;
      case 'delete':      a.deleteSelected(); break;
      case 'view-iso':    a.viewport.setView('iso');   break;
      case 'view-top':    a.viewport.setView('top');   break;
      case 'view-front':  a.viewport.setView('front'); break;
      case 'view-side':   a.viewport.setView('side');  break;
      case 'toggle-grid':    a.viewport.toggleGrid();        break;
      case 'zoom-extents':   a.viewport.zoomExtents();       break;
      case 'run':            a.runAnalysis(false);           break;
      case 'run-sw':         a.runAnalysis(true);            break;
      case 'run-modal':      a.runModal();                   break;
      case 'run-spectrum':   a.runSpectrum();                break;
      case 'run-combo':      a.runCombinationDialog();       break;
      case 'res-deformed':   a.setResultType('deformed');    break;
      case 'res-N':          a.setResultType('N');           break;
      case 'res-Vy':         a.setResultType('Vy');          break;
      case 'res-Vz':         a.setResultType('Vz');          break;
      case 'res-T':          a.setResultType('T');           break;
      case 'res-My':         a.setResultType('My');          break;
      case 'res-Mz':         a.setResultType('Mz');          break;
      case 'export-results': a.exportResults();              break;
      case 'export-modal':   a.exportModalResults();         break;
      case 'export-spectrum': a.exportSpectrumResults();     break;
      case 'clear-results':  a.clearResults();               break;
    }
  }
}
