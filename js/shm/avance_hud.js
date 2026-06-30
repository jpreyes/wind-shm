// ─────────────────────────────────────────────────────────────────────────────
// avance_hud.js — HUD «tipo Stark» de avance de obra por componente (Frente 1, R-18).
//
// Al seleccionar una torre (modo normal) se cuelgan callouts ancladas en 3D, una
// por partida (fundación · fuste · góndola · rotor · cableado), cada una con una
// línea-guía a su componente, semáforo y %. Clic en una callout → la cámara hace
// el «girito» (tween) hacia ese componente y la ventana se expande con fechas
// plan/real, responsable, verificación del gemelo (R-31), fotos (R-10) e informe,
// más un botón «Abrir partida» (vista completa). Sólo DOM/overlay; el 3D lo provee
// fleet_view (anchorScreenAt / focusComponent).
// ─────────────────────────────────────────────────────────────────────────────
import { TURBINE_COMPONENTS, HV_COMPONENTS, enrichStages } from './parks_data_caman.js?v=267';
import * as CTwin from './construction_twin.js?v=267';

const fmt = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y.slice(2)}`; };

// ── Foto MOCKUP por componente (SVG → data URI) ──────────────────────────────
// Hasta tener fotos reales (R-10), inventa una «foto de obra» plausible por
// partida: cielo + cerros + faena con la silueta del componente en construcción.
function compScene(component) {
  const crane = `<g stroke='#e0a93f' stroke-width='2.4' fill='none'><path d='M196 162 V70 M196 74 L240 74 M196 80 L168 74'/><line x1='232' y1='74' x2='232' y2='92' stroke-dasharray='3 3'/></g>`;
  switch (component) {
    case 'fundacion': return `<rect x='112' y='150' width='70' height='14' fill='#6e6457'/><g stroke='#c3ccd4' stroke-width='1.4'>${[120, 132, 144, 156, 168].map(x => `<line x1='${x}' y1='150' x2='${x}' y2='140'/>`).join('')}<line x1='118' y1='144' x2='172' y2='144'/></g><rect x='108' y='162' width='80' height='6' fill='#534a3b'/>`;
    case 'fuste': return `${crane}<polygon points='133,162 147,162 144,96 136,96' fill='#cdd9e4'/>`;
    case 'gondola': return `${crane}<polygon points='133,162 147,162 143,74 137,74' fill='#cdd9e4'/><rect x='128' y='64' width='26' height='11' rx='2' fill='#e6f1fb'/>`;
    case 'rotor': return `<polygon points='133,162 147,162 143,74 137,74' fill='#cdd9e4'/><rect x='128' y='64' width='26' height='11' rx='2' fill='#e6f1fb'/><g stroke='#eef4fa' stroke-width='3' stroke-linecap='round'><line x1='156' y1='69' x2='156' y2='40'/><line x1='156' y1='69' x2='182' y2='84'/><line x1='156' y1='69' x2='130' y2='84'/></g><circle cx='156' cy='69' r='3' fill='#9fb3c6'/>`;
    case 'cableado': return `<rect x='56' y='168' width='208' height='9' fill='#5b4f3a'/><path d='M64 173 Q140 166 256 173' stroke='#cf8f3c' stroke-width='2' fill='none'/><path d='M64 176 Q140 170 256 176' stroke='#b06a2a' stroke-width='2' fill='none'/>`;
    default: return `${crane}<polygon points='134,162 146,162 143,90 137,90' fill='#cdd9e4'/>`;
  }
}
function mockPhoto(component, caption) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200' viewBox='0 0 320 200'>
    <defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#9ec6e8'/><stop offset='1' stop-color='#e3edf3'/></linearGradient></defs>
    <rect width='320' height='200' fill='url(#s)'/>
    <circle cx='266' cy='38' r='15' fill='#fff2bf' opacity='0.9'/>
    <path d='M0 150 L70 118 L150 144 L230 112 L320 138 V200 H0 Z' fill='#aebf9c'/>
    <rect y='160' width='320' height='40' fill='#9b8b6b'/>
    ${compScene(component)}
    <rect x='0' y='176' width='320' height='24' fill='rgba(10,16,24,0.58)'/>
    <text x='9' y='192' fill='#e6edf3' font-family='sans-serif' font-size='12'>📷 ${caption}</text>
    <text x='312' y='192' text-anchor='end' fill='#a9bccd' font-family='sans-serif' font-size='10'>Camán I</text>
  </svg>`;
  // %27 para las comillas simples del SVG → seguro dentro de url('…') en CSS.
  return 'data:image/svg+xml,' + encodeURIComponent(svg).replace(/'/g, '%27');
}
// Fotos de una partida: reales si existen; si no y hay avance, mockups (término+avance
// si está completa, solo avance si está en ejecución). Pendiente sin avance = sin foto.
function photosFor(comp, stage) {
  if (stage.fotos?.length) return stage.fotos;
  if (!stage.pct) return [];
  const d = fmt(stage.actualEnd || stage.actualStart || stage.plannedStart);
  const caps = stage.pct >= 100 ? [`${comp.label} — término · ${d}`, `${comp.label} — avance · ${d}`] : [`${comp.label} — avance · ${d}`];
  return caps.map(c => mockPhoto(comp.component, c));
}
const daysBetween = (a, b) => (!a || !b) ? null : Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
// Semáforo por estado de la partida.
const sema = (s) => s.pct >= 100 ? { c: 'done', t: 'Completada' } : s.pct > 0 ? { c: 'wip', t: 'En ejecución' } : { c: 'pend', t: 'Pendiente' };
// Atraso real vs plan (fin): + = atrasada.
const slipDays = (s) => s.actualEnd ? daysBetween(s.plannedEnd, s.actualEnd) : (s.pct > 0 ? daysBetween(s.plannedEnd, new Date().toISOString().slice(0, 10)) : null);

export function buildAvanceHUD(vpwrap, fleet) {
  const wrap = vpwrap || document.body;
  const root = document.createElement('div');
  root.id = 'avance-hud'; root.style.display = 'none';
  root.innerHTML = `<svg class="ah-lines" xmlns="http://www.w3.org/2000/svg"></svg>`;
  wrap.appendChild(root);
  const svg = root.querySelector('.ah-lines');

  let cur = null, comps = [], stages = [], callouts = [], expanded = null;
  const lastExp = {};   // recuerda la última partida abierta por torre (id → component)

  function clear() {
    callouts.forEach(c => c.el.remove());
    callouts = []; svg.innerHTML = ''; expanded = null;
  }

  // Crosslink con el gemelo de construcción (R-31): por componente, la f₁ medida de
  // su etapa y si concuerda con la curva predicha (no por debajo).
  const _chk = (p) => p ? { f1: p.f1, enBanda: !p.below } : null;
  function buildTwinChecks(st, stages) {
    const f1 = (typeof window !== 'undefined' && window.shmTwin?.turbine) || 0.283;
    const win = CTwin.softStiffWindow(14);
    const mc = CTwin.measuredCurve(f1, stages, st.id);
    const pt = (i) => mc.points[i] || null;
    return {
      fuste: mc.reached >= 1 ? _chk(pt(Math.min(3, mc.reached - 1))) : null,
      gondola: _chk(pt(4)),
      rotor: _chk(pt(5)),
      fundacion: mc.reached >= 1 ? { f1: pt(mc.reached - 1).f1, enBanda: !mc.defect } : null,
      cableado: mc.reached >= 6 ? { f1, enBanda: CTwin.inBand(f1, win) && !mc.defect } : null,
    };
  }

  function show(st) {
    clear();
    if (!st || (st.type !== 'turbine' && st.type !== 'hv')) { root.style.display = 'none'; cur = null; return; }
    cur = st;
    comps = st.type === 'hv' ? HV_COMPONENTS : TURBINE_COMPONENTS;
    stages = enrichStages(st.stages, st.type, st.id);
    st.stages = stages;                                   // persiste el enriquecido en la estructura
    root.style.display = 'block';
    const twin = st.type === 'turbine' ? buildTwinChecks(st, stages) : null;   // crosslink gemelo de construcción (R-31)
    // Lados: base a la izquierda, cuerpo/tope a la derecha (se reparte para no chocar).
    comps.forEach((c, i) => {
      const stage = stages[i] || { pct: 0 };
      const side = c.yFrac >= 0.45 ? 'right' : 'left';
      const el = document.createElement('div');
      el.className = `ah-callout side-${side}`;
      el.dataset.component = c.component;
      const photos = photosFor(c, stage);               // reales o mockups (no se persisten)
      callouts.push({ el, comp: c, stage, side, photos, twin: twin ? twin[c.component] : null });
      el.addEventListener('click', (e) => { if (!e.target.closest('.ah-open')) toggle(c.component); });
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'ah-line');
      svg.appendChild(line);
      callouts[callouts.length - 1].line = line;
      root.appendChild(el);
    });
    // Auto-despliegue: la última abierta de esta torre → la que se está EJECUTANDO
    // (parcial) → el frente actual (primera incompleta) → la última si todo está hecho.
    // (Sin «girito» automático; el giro sólo al clic del usuario.)
    const wip = comps.find((c, i) => stages[i] && stages[i].pct > 0 && stages[i].pct < 100);
    const front = comps.find((c, i) => stages[i] && stages[i].pct < 100);
    const pick = (lastExp[st.id] && comps.some(c => c.component === lastExp[st.id]) ? lastExp[st.id] : null)
      || wip?.component || front?.component || comps[comps.length - 1]?.component;
    expanded = pick || null;
    renderCallouts();
    // En modo compacto, encuadra la torre corrida a la derecha para que la columna
    // izquierda de callouts no la tape (deja espacio a la torre).
    if (isCompact()) fleet.frameStructureRight?.(st);
    tick();
  }
  const isCompact = () => wrap.getBoundingClientRect().width < 720;

  function renderCallouts() {
    for (const co of callouts) {
      const s = co.stage, sm = sema(s), open = expanded === co.comp.component;
      const slip = slipDays(s);
      const slipTxt = slip == null ? '' : slip > 0 ? `<span class="ah-slip late">+${slip} d</span>` : `<span class="ah-slip ok">${slip <= 0 ? 'en plazo' : ''}</span>`;
      co.el.classList.toggle('open', open);
      co.el.innerHTML = `
        <div class="ah-head">
          <span class="ah-dot ${sm.c}"></span>
          <span class="ah-ico">${co.comp.icon}</span>
          <span class="ah-name">${co.comp.label}</span>
          <span class="ah-pct">${s.pct}%</span>
          <span class="ah-chev">${open ? '▾' : '▸'}</span>
        </div>
        <div class="ah-barwrap"><i class="ah-bar ${sm.c}" style="width:${s.pct}%"></i></div>
        ${open ? `
        <div class="ah-body">
          <div class="ah-state ${sm.c}">${sm.t}${slipTxt}</div>
          <table class="ah-kv">
            <tr><td>Plan</td><td>${fmt(s.plannedStart)} → ${fmt(s.plannedEnd)}</td></tr>
            <tr><td>Real</td><td>${fmt(s.actualStart)} → ${fmt(s.actualEnd)}</td></tr>
            <tr><td>Responsable</td><td>${s.responsable || '—'}</td></tr>
            <tr><td>Gemelo (R-31)</td><td>${co.twin ? `f₁ ${co.twin.f1.toFixed(3)} Hz · ${co.twin.enBanda ? 'concuerda ✓' : 'bajo lo predicho ✗'}` : '<span class="ah-mut">pendiente</span>'}</td></tr>
          </table>
          <div class="ah-foto-h">Fotos <span class="ah-mut">(${co.photos.length})</span></div>
          ${co.photos.length
            ? `<div class="ah-hero" style="background-image:url('${co.photos[0]}')"></div>`
            : '<div class="ah-mut ah-foto-note">Sin fotos aún · se cargarán con el almacenamiento (R-10)</div>'}
          <button class="ah-open" type="button">Abrir partida ›</button>
        </div>` : ''}`;
      if (open) co.el.querySelector('.ah-open')?.addEventListener('click', (e) => { e.stopPropagation(); openPartida(co); });
    }
  }

  function toggle(component) {
    expanded = expanded === component ? null : component;
    if (cur) lastExp[cur.id] = expanded;                 // recuerda lo dejado abierto
    if (expanded) { const co = callouts.find(c => c.comp.component === component); if (co) fleet.focusComponent?.(cur, co.comp.yFrac, isCompact() ? 0.2 : 0); }   // «el girito» (corrido a la derecha si compacto)
    renderCallouts(); tick();
  }

  // Reposiciona callouts y redibuja líneas-guía cada frame (lo llama fleet.onFrame).
  function tick() {
    if (cur && fleet.sunMode) { hide(); return; }      // en modo Shadow el HUD se oculta (manda el estudio de sombra)
    if (!cur || root.style.display === 'none') return;
    const wr = wrap.getBoundingClientRect();
    svg.setAttribute('width', wr.width); svg.setAttribute('height', wr.height);
    const off = 96, vis = [];
    for (const co of callouts) {
      const a = fleet.anchorScreenAt?.(cur, co.comp.yFrac);
      if (!a || a.behind) { co.el.style.display = 'none'; co.line.style.display = 'none'; continue; }
      co.el.style.display = 'block'; co.line.style.display = '';
      vis.push({ co, ax: a.x - wr.left, ay: a.y - wr.top, cw: co.el.offsetWidth || 178, ch: co.el.offsetHeight || 44 });
    }
    if (!vis.length) return;
    // ¿Hay espacio para anclar a los lados de la torre? Si el viewport es angosto o
    // la torre está cerca de un borde, NO: se pasa a columna vertical a la izquierda.
    const colW = Math.max(...vis.map(v => v.cw)) + off + 12;
    const towerX = vis[0].ax;
    const noSpace = wr.width < 720 || towerX < colW + 20 || towerX > wr.width - colW - 20;
    root.classList.toggle('ah-compact', noSpace);     // callouts más angostas en columna
    if (noSpace) layoutStacked(vis, wr); else layoutAnchored(vis, wr, off);
  }

  // Layout normal: callouts a los lados de la torre, ancladas a su altura.
  function layoutAnchored(vis, wr, off) {
    const placed = vis.map(v => ({ ...v, x: Math.max(6, Math.min(v.co.side === 'right' ? v.ax + off : v.ax - off - v.cw, wr.width - v.cw - 6)), y: v.ay - v.ch / 2 }));
    for (const side of ['left', 'right']) {
      const grp = placed.filter(p => p.co.side === side).sort((a, b) => a.y - b.y);
      for (let i = 1; i < grp.length; i++) { const min = grp[i - 1].y + grp[i - 1].ch + 8; if (grp[i].y < min) grp[i].y = min; }
    }
    for (const p of placed) {
      const y = Math.max(6, Math.min(p.y, wr.height - p.ch - 6));
      place(p.co, p.x, y, p.co.side === 'right' ? p.x : p.x + p.cw, p.ax, p.ay);
    }
  }

  // Layout compacto: columna vertical pegada a la IZQUIERDA, de arriba (tope de la
  // torre) hacia abajo, dejando el resto del visor libre para la torre.
  function layoutStacked(vis, wr) {
    vis.sort((a, b) => b.co.comp.yFrac - a.co.comp.yFrac);   // rotor/góndola arriba → fundación abajo
    const x = 8; let y = 8;
    for (const v of vis) {
      const yy = Math.min(y, wr.height - v.ch - 6);
      place(v.co, x, yy, x + v.cw, v.ax, v.ay);              // línea desde el borde derecho de la columna
      y = yy + v.ch + 8;
    }
  }

  function place(co, x, y, ex, ax, ay) {
    co.el.style.left = x + 'px'; co.el.style.top = y + 'px';
    const ey = y + Math.min((co.el.offsetHeight || 44) / 2, 22);
    co.line.setAttribute('x1', ex); co.line.setAttribute('y1', ey);
    co.line.setAttribute('x2', ax); co.line.setAttribute('y2', ay);
    co.line.classList.toggle('hot', expanded === co.comp.component);
  }

  function hide() { root.style.display = 'none'; clear(); cur = null; }

  // ── «Abrir partida»: vista completa (modal) — galería, fechas, bitácora ──────
  function openPartida(co) {
    const s = co.stage, sm = sema(s), slip = slipDays(s);
    const bitacora = [
      s.plannedStart && `Inicio planificado: ${fmt(s.plannedStart)}`,
      s.actualStart && `Inicio real: ${fmt(s.actualStart)}`,
      s.pct > 0 && s.pct < 100 && `Avance actual: ${s.pct}%`,
      s.actualEnd && `Término real: ${fmt(s.actualEnd)}`,
    ].filter(Boolean);
    const m = document.createElement('div');
    m.className = 'ah-modal';
    m.innerHTML = `
      <div class="ah-modal-card">
        <div class="ah-modal-h">
          <span class="ah-ico">${co.comp.icon}</span>
          <b>${cur.label} · ${co.comp.label}</b>
          <span class="ah-dot ${sm.c}"></span><span class="ah-mut">${sm.t}</span>
          <button class="ah-x" type="button" title="Cerrar">✕</button>
        </div>
        <div class="ah-modal-body">
          <div class="ah-prog"><div class="ah-prog-pct">${s.pct}%</div><div class="ah-barwrap big"><i class="ah-bar ${sm.c}" style="width:${s.pct}%"></i></div></div>
          <div class="ah-cols">
            <table class="ah-kv">
              <tr><td>Plan</td><td>${fmt(s.plannedStart)} → ${fmt(s.plannedEnd)}</td></tr>
              <tr><td>Real</td><td>${fmt(s.actualStart)} → ${fmt(s.actualEnd)}</td></tr>
              <tr><td>Desviación</td><td>${slip == null ? '—' : (slip > 0 ? `<b class="late">+${slip} días</b>` : 'en plazo')}</td></tr>
              <tr><td>Responsable</td><td>${s.responsable || '—'}</td></tr>
              <tr><td>Verificación gemelo</td><td>${co.twin ? `f₁ ${co.twin.f1.toFixed(3)} Hz · ${co.twin.enBanda ? 'concuerda ✓' : 'bajo lo predicho ✗'}` : '<span class="ah-mut">pendiente (R-31)</span>'}</td></tr>
            </table>
            <div class="ah-bitacora"><div class="ah-sub">Bitácora</div><ul>${bitacora.map(b => `<li>${b}</li>`).join('') || '<li class="ah-mut">Sin eventos</li>'}</ul></div>
          </div>
          <div class="ah-sub">Galería de fotos <span class="ah-mut">(${co.photos.length})</span></div>
          ${co.photos.length
            ? `<div class="ah-gallery">${co.photos.map(p => `<div class="ah-foto has-img" style="background-image:url('${p}')"></div>`).join('')}</div>
               ${s.fotos?.length ? '' : '<div class="ah-mut" style="margin-top:6px">Imágenes de referencia (mockup) — las fotos reales se integran con el almacenamiento (R-10).</div>'}`
            : '<div class="ah-mut">Sin fotos aún (partida sin avance). La carga real llega con el almacenamiento (R-10).</div>'}
        </div>
        <div class="ah-modal-foot">
          <button class="ah-report" type="button">📄 Ficha de partida</button>
          <button class="ah-x2" type="button">Cerrar</button>
        </div>
      </div>`;
    const close = () => m.remove();
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('.ah-x, .ah-x2')) close(); });
    m.querySelector('.ah-report')?.addEventListener('click', () => partidaReport(co));
    wrap.appendChild(m);
  }

  function partidaReport(co) {
    const s = co.stage, sm = sema(s), slip = slipDays(s);
    const html = `<!doctype html><meta charset=utf-8><title>Ficha de partida — ${cur.label} · ${co.comp.label}</title>
      <style>body{font:14px/1.5 system-ui,sans-serif;margin:34px;color:#1b2533}h1{font-size:19px;margin:0 0 2px}
      .mut{color:#64748b}table{border-collapse:collapse;margin-top:12px}td{border:1px solid #cbd5e1;padding:6px 10px}
      td:first-child{color:#64748b;background:#f8fafc}.bar{height:12px;background:#e2e8f0;border-radius:6px;overflow:hidden;width:280px;margin:10px 0}
      .bar i{display:block;height:100%;background:#0e7490}</style>
      <h1>Ficha de partida — ${co.comp.label}</h1>
      <div class="mut">${cur.label} · Parque Camán I · ${sm.t} · Generado ${new Date().toLocaleString('es-CL')}</div>
      <div class="bar"><i style="width:${s.pct}%"></i></div><b>${s.pct}%</b>
      <table>
        <tr><td>Plan (inicio → fin)</td><td>${fmt(s.plannedStart)} → ${fmt(s.plannedEnd)}</td></tr>
        <tr><td>Real (inicio → fin)</td><td>${fmt(s.actualStart)} → ${fmt(s.actualEnd)}</td></tr>
        <tr><td>Desviación</td><td>${slip == null ? '—' : (slip > 0 ? '+' + slip + ' días (atrasada)' : 'en plazo')}</td></tr>
        <tr><td>Responsable</td><td>${s.responsable || '—'}</td></tr>
        <tr><td>Verificación gemelo</td><td>${co.twin ? 'f₁ ' + co.twin.f1.toFixed(3) + ' Hz · ' + (co.twin.enBanda ? 'concuerda' : 'bajo lo predicho') : 'pendiente (R-31)'}</td></tr>
      </table>
      <p class="mut" style="margin-top:18px">Documento de avance generado por ReWind. Datos de cronograma sintéticos/editables; las fotos e informes reales se integran con el almacenamiento (R-10).</p>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  }

  return { show, hide, tick, isOpen: () => !!cur, current: () => cur };
}
