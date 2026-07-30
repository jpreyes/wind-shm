// ---------------------------------------------------------------------------
// workspaces/operacion.js -- espacio de trabajo OPERACION (parte 1: INSPECCION).
//
// Extraido del modulo-dios (refactor B2). Micro-CMMS: inspecciones, hallazgos,
// fotos, ensayos, documentos y ordenes de trabajo de la estructura YA construida.
// Lee la torre seleccionada del store compartido (core/selection); las deps del
// shell (refrescar rollup, abrir informe) se inyectan con initInspection(ctx).
// (renderSHM/senal/live se mudaran en un slice posterior.)
// ---------------------------------------------------------------------------
import * as Insp from '../shm/inspection.js?v=332';
import * as Selection from '../core/selection.js?v=332';
import { t, getLang } from '../shm/i18n.js?v=332';
import { esc, safeUrl } from '../shm/util.js?v=332';

const ihash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
let inspSel = null;                       // inspeccion abierta (estado local del sub-modulo)
let _ctx = { onChange: () => {}, openReport: () => {} };

// Inyeccion de dependencias del shell (shm_mode): refrescar el rollup del parque
// tras editar, y abrir el informe imprimible.
export function initInspection(ctx) { _ctx = { ..._ctx, ...ctx }; }
// Al cambiar de torre, olvida la inspeccion abierta (se re-elige la mas reciente).
Selection.subscribe(() => { inspSel = null; });

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

export function renderInsp() {
    const host = document.getElementById('shm-insp'); const o = Selection.getCurrent();
    if (!host) return;
    if (!o) { host.innerHTML = `<div class="empty">${t('empty.select')}</div>`; return; }
    let inspections = Insp.getInspections(o.id);
    if (!inspections.length) {
      if (Insp.wasSeeded(o.id)) {   // R-40b: ya se sembró/vació antes → NO re-sembrar demo
        host.innerHTML = `<div class="shm-body ins-body"><div class="ins-head">Inspección · ${esc(o.label)}</div>
          <div class="ins-empty">${t('ins.empty')}<button id="ins-first" class="ins-btn">${t('ins.newFirst')}</button></div></div>`;
        host.querySelector('#ins-first').addEventListener('click', () => { const ni = Insp.addInspection(o.id, {}); inspSel = ni.id; renderInsp(); });
        return;
      }
      seedInspection(o); Insp.markSeeded(o.id); inspections = Insp.getInspections(o.id);
    }
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
      const strip = np ? `<div class="ins-dmg-photos">${d.photos.map(p => `<div class="ins-dphoto" data-d="${esc(d.id)}" data-p="${esc(p.id)}" style="background-image:url('${safeUrl(p.url)}')"><button class="ins-px" data-del-dmgphoto title="${t('ins.rmPhoto')}">✕</button></div>`).join('')}</div>` : '';
      return `<div class="ins-dmg-wrap">
        <div class="ins-dmg">
          <span class="ins-dmg-sc ${b.cls}">${sc.toFixed(0)}</span>
          <span class="ins-dmg-v"><b>${esc(d.damage_type)}</b><br><span class="ins-mut">${esc(d.severity)} · ${esc(d.damage_cause)}${d.extent ? ' · ' + esc(d.extent) : ''}${d.location ? ' · ' + esc(d.location) : ''}</span></span>
          <button class="ins-dmg-cam" data-dmg-addphoto="${esc(d.id)}" title="${t('ins.addPhotoFinding')}">📷${np ? ' ' + np : ''}</button>
          <button class="ins-ot" data-ot="${esc(d.id)}" title="${t('ins.otTip')}">→ OT</button>
          <button class="ins-x" data-del-dmg="${esc(d.id)}" title="${t('ins.rmFinding')}">✕</button>
        </div>${strip}</div>`;
    }).join('') : `<div class="ins-mut">${t('ins.noFindings')}</div>`;

    const listRows = inspections.map(i => {
      const sc = Insp.inspectionScore(i.damages), b = Insp.scoreBand(sc);
      return `<button class="ins-row ${i.id === inspSel ? 'active' : ''}" data-insp="${i.id}">
        <span class="ins-dot ${Insp.conditionFromScore(sc)}"></span>
        <span class="ins-row-d">${esc(i.date)}</span><span class="ins-row-i">${esc(i.inspector)}</span>
        <span class="ins-row-h" title="hallazgos">${i.damages.length}⚐</span>
        <span class="ins-row-s ${b.cls}">${sc.toFixed(0)}</span></button>`;
    }).join('');

    host.innerHTML = `
      <div class="shm-body ins-body">
        <div class="ins-head">Inspección · ${esc(o.label)}
          <span class="ins-cond ${esc(sel.condition)}">${Insp.conditionLabel(sel.condition)}</span></div>
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
          <div class="ins-card-h">${esc(sel.date)} · <b>${esc(sel.inspector)}</b>
            <span class="ins-score ${band.cls}" title="${t('ins.scoreTitle')}">${score.toFixed(0)} <small>${band.label}</small></span></div>
          <div class="ins-meta">
            <label>${t('ins.fDate')}<input type="date" id="ins-date" value="${esc(sel.date)}"></label>
            <label>${t('ins.fInsp')}<input type="text" id="ins-insp" value="${esc(sel.inspector)}"></label>
            <label>${t('ins.fCond')}<select id="ins-cond">${condOpt}</select></label>
            <label>${t('ins.fLoc')}<input type="text" id="ins-loc" value="${esc(sel.location || '')}"></label>
            <label>${t('ins.fNext')}<input type="date" id="ins-next" value="${esc(sel.nextDate || '')}"></label>
          </div>
          <label class="ins-sumlbl">${t('ins.summary')}<textarea id="ins-sum" rows="2">${esc(sel.summary || '')}</textarea></label>

          <div class="shm-sub2">${t('ins.photos')} · ${(sel.photos || []).length}</div>
          <div class="ins-photos">${(sel.photos || []).map(p => `<div class="ins-photo" data-photo="${esc(p.id)}" style="background-image:url('${safeUrl(p.url)}')"><button class="ins-px" data-del-photo="${esc(p.id)}" title="${t('ins.rmPhoto')}">✕</button></div>`).join('') || `<div class="ins-mut">${t('ins.noPhotos')}</div>`}</div>
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
          <div class="ins-mini">${sel.tests.map(t2 => { const c = Insp.classifyTest(t2.test_type); return `<div class="ins-li"><span class="ins-tbadge ${c.ndt ? 'ndt' : ''}">${c.label}</span> <b>${esc(t2.test_type)}</b> — ${esc(t2.result_summary || '—')} <button class="ins-x" data-del-test="${esc(t2.id)}">✕</button></div>`; }).join('') || `<div class="ins-mut">${t('ins.noTests')}</div>`}</div>
          <div class="ins-add"><input type="text" id="nt-type" placeholder="${t('ins.pTestType')}"><input type="text" id="nt-res" placeholder="${t('ins.pTestResult')}"><button id="ins-addtest" class="ins-btn" title="${t('ins.addTest')}">＋</button></div>

          <div class="shm-sub2">${t('ins.docs')} · ${sel.documents.length}</div>
          <div class="ins-mini">${sel.documents.map(dc => `<div class="ins-li">📎 <b>${esc(dc.title)}</b> <span class="ins-mut">(${esc(dc.category)})</span> <button class="ins-x" data-del-doc="${esc(dc.id)}">✕</button></div>`).join('') || `<div class="ins-mut">${t('ins.noDocs')}</div>`}</div>
          <div class="ins-add"><input type="text" id="ndc-title" placeholder="${t('ins.pDocTitle')}"><input type="text" id="ndc-cat" placeholder="${t('ins.pDocCat')}" value="informe"><button id="ins-adddoc" class="ins-btn" title="${t('ins.addDoc')}">＋</button></div>

          <div class="shm-sub2">${t('ins.wos')} · ${(sel.workOrders || []).length}</div>
          <div class="ins-mini">${(sel.workOrders || []).map(w => { const dd = Insp.dueState(w.due); return `<div class="ins-wo">
            <button class="ins-wost s-${esc(String(w.status).replace(/ /g, ''))}" data-wo="${esc(w.id)}" title="${t('ins.woStateTip')}">${esc(w.status)}</button>
            <span class="ins-wo-v"><b>${esc(w.title)}</b><br><span class="ins-mut">${esc(w.assignee || t('ins.unassigned'))} · ${t('ins.prio')} ${esc(w.priority)}${w.due ? ` · ${t('ins.dueWord')} ${esc(w.due)}${dd.overdue ? ' ⚠' : ''}` : ''}</span></span>
            <button class="ins-x" data-del-wo="${esc(w.id)}">✕</button></div>`; }).join('') || `<div class="ins-mut">${t('ins.noWos')}</div>`}</div>
          <div class="ins-add ins-add-wo"><input type="text" id="nw-title" placeholder="${t('ins.pWoTitle')}"><input type="text" id="nw-assignee" placeholder="${t('ins.pWoAssignee')}"><select id="nw-prio">${Insp.WO_PRIORITY.map(p => `<option value="${p}"${p === 'media' ? ' selected' : ''}>${p}</option>`).join('')}</select><button id="ins-addwo" class="ins-btn" title="${t('ins.addWo')}">＋</button></div>

          <div class="ins-foot"><button id="ins-report" class="ins-btn">${t('ins.report')}</button>
            <button id="ins-del" class="ins-del">${t('ins.del')}</button></div>
        </div>
        <div class="note" style="font-size:10px">${t('ins.note')}</div>
      </div>`;

    const save = (re = true) => { Insp.updateInspection(o.id, sel); _ctx.onChange?.(); if (re) renderInsp(); };
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
      sel.damages.push({ id: Insp.uid(), damage_type: host.querySelector('#nd-type').value, damage_cause: host.querySelector('#nd-cause').value, severity: host.querySelector('#nd-sev').value, extent: host.querySelector('#nd-ext').value.trim(), location: host.querySelector('#nd-loc').value.trim(), comments: '' });
      sel.condition = Insp.conditionFromScore(Insp.inspectionScore(sel.damages)); save();
    });
    host.querySelector('#ins-addtest').addEventListener('click', () => { const tt = (host.querySelector('#nt-type').value || '').trim(); if (!tt) { host.querySelector('#nt-type').focus(); return; } const r = (host.querySelector('#nt-res').value || '').trim(); sel.tests.push({ id: Insp.uid(), test_type: tt, result_summary: r, executed_at: new Date().toISOString().slice(0, 10) }); save(); });
    host.querySelector('#ins-adddoc').addEventListener('click', () => { const tt = (host.querySelector('#ndc-title').value || '').trim(); if (!tt) { host.querySelector('#ndc-title').focus(); return; } const c = (host.querySelector('#ndc-cat').value || 'otro').trim(); sel.documents.push({ id: Insp.uid(), title: tt, category: c, issued_at: new Date().toISOString().slice(0, 10) }); save(); });
    host.querySelectorAll('[data-del-test]').forEach(b => b.addEventListener('click', () => { sel.tests = sel.tests.filter(t => t.id !== b.dataset.delTest); save(); }));
    host.querySelectorAll('[data-del-doc]').forEach(b => b.addEventListener('click', () => { sel.documents = sel.documents.filter(d => d.id !== b.dataset.delDoc); save(); }));
    // Órdenes de trabajo
    host.querySelector('#ins-addwo').addEventListener('click', () => {
      const title = (host.querySelector('#nw-title').value || '').trim(); if (!title) { host.querySelector('#nw-title').focus(); return; }
      const assignee = (host.querySelector('#nw-assignee').value || '').trim();
      const priority = (host.querySelector('#nw-prio').value || 'media').trim().toLowerCase();
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
    host.querySelectorAll('.ins-photo').forEach(d => d.addEventListener('click', (e) => { if (e.target.closest('.ins-px')) return; const p = (sel.photos || []).find(x => x.id === d.dataset.photo); if (p) { const w = window.open('', '_blank'); if (w) w.document.write(`<img src="${safeUrl(p.url)}" style="max-width:100%">`); else alert(t('alert.popupBlocked')); } }));
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
      if (p) { const w = window.open('', '_blank'); if (w) w.document.write(`<img src="${safeUrl(p.url)}" style="max-width:100%">`); else alert(t('alert.popupBlocked')); }
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
    _ctx.openReport?.(html, 'informe-inspeccion-rewind.html');
  }
