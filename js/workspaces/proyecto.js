// ─────────────────────────────────────────────────────────────────────────────
// workspaces/proyecto.js — espacio de trabajo PROYECTO (diseño).
//
// Primer workspace extraído del módulo-dios (refactor B2). Patrón: el renderer vive
// acá; `shm_mode.js` solo delega. `renderProyecto(host, fleet)` pinta el análisis de
// SHADOW-FLICKER en el panel derecho (cumplimiento, KPIs, parámetros solares, mapa de
// flicker, informes y lista de receptores). Es fleet-wide (no depende de la selección
// `current`), por eso es el más limpio de aislar. Las acciones de flicker viven en
// `window.shmMap` (MapView); los controles de hora/fecha, en el HUD solar sobre el visor.
// ─────────────────────────────────────────────────────────────────────────────
import { t } from '../shm/i18n.js?v=332';
import { esc } from '../shm/util.js?v=332';

export function renderProyecto(host, fleet) {
  if (!host) return;
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
