// ─────────────────────────────────────────────────────────────────────────────
// core/shell_dom.js — shell compartido de las 3 apps (Proyecto/Obra/Operación).
//
// Frente C, paso 4b (dedup): el <body> común (menubar, árbol, toolbar, viewport,
// panel, statusbar, portada, aviso de rotación, tooltip) vivía COPIADO en las 3
// entradas HTML. Ahora se inyecta desde acá y cada HTML queda mínima: head per-app
// + este script + las libs + shm_mode.
//
// Es un script CLÁSICO (no módulo) cargado con <script src> ANTES de shm_mode: se
// ejecuta sincrónicamente durante el parseo, así los mount points existen cuando el
// módulo shm_mode bootea (y antes del primer paint → sin flash). Además cablea el
// toggle de tema, el cierre de la portada, el motor de tooltips y el registro del SW
// (todo lo que antes estaba inline y duplicado en cada HTML).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var SHELL_HTML = `
<!-- a11y: salto directo al contenido (visible sólo con foco de teclado) -->
<a href="#main" class="skip-link">Saltar al contenido</a>
<div id="app">
  <!-- a11y: título de página persistente (la portada se elimina tras cargar) -->
  <h1 class="sr-only">ReWind — Monitoreo de salud estructural, parque Camán</h1>

  <!-- MENUBAR -->
  <header id="menubar">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
        <line x1="12" y1="22" x2="12" y2="12" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/>
        <g stroke="var(--accent)" stroke-width="2" stroke-linecap="round" fill="none">
          <line x1="12" y1="11" x2="12" y2="3"/>
          <line x1="12" y1="11" x2="19" y2="15"/>
          <line x1="12" y1="11" x2="5" y2="15"/>
        </g>
        <circle cx="12" cy="11" r="1.7" fill="var(--teal)"/>
      </svg>
      ReWind <span class="brand-park">Camán</span>
    </div>

    <!-- Switcher de módulo (Frente C): saltar a otra app desde la barra, sin volver
         a la landing. Lo rellena shell_dom según <html data-app> y el rol. -->
    <div id="rw-switch"></div>

    <div class="menubar-right">
      <button id="btn-theme" type="button" title="Cambiar tema claro/oscuro"
        style="background:var(--bg4);border:1px solid var(--border2);color:var(--text);border-radius:6px;cursor:pointer;font-size:14px;line-height:1;padding:4px 8px;margin-right:10px">🌙</button>
    </div>
  </header>

  <!-- MAIN CONTENT -->
  <div id="main" role="main" tabindex="-1">

    <!-- ReWind: árbol lateral Parque ▸ Zona ▸ Torre (1.ª columna; sólo en body.shm) -->
    <aside id="park-tree" aria-label="Parques y zonas"></aside>

    <!-- LEFT TOOLBAR -->
    <aside id="toolbar"></aside>

    <!-- VIEWPORT AREA -->
    <div id="viewport-wrap">
      <div id="viewport-container"></div>
      <!-- ReWind: vista 2D del parque (Leaflet); se muestra sobre el canvas en modo mapa -->
      <div id="map-container" aria-label="Mapa del parque"></div>
    </div>

    <!-- PANEL RESIZE HANDLE -->
    <div id="panel-resize-handle" title="Arrastrar para redimensionar"></div>

    <!-- RIGHT PANEL -->
    <aside id="panel"></aside>

    <!-- Fondo para cerrar los cajones (árbol/panel) en móvil tocando fuera -->
    <div id="drawer-backdrop"></div>

  </div><!-- /#main -->

  <!-- STATUSBAR -->
  <footer id="statusbar"></footer>

</div><!-- /#app -->

<!-- PORTADA — pantalla de carga (oculta: se boota directo, sin splash) -->
<div id="landing" style="display:none">
  <button id="landing-theme" type="button" title="Cambiar tema claro/oscuro"
    style="position:fixed;top:14px;right:16px;z-index:9100;background:var(--bg4,#e2e8f1);border:1px solid var(--border2,#bcc8d8);color:var(--text,#1b2533);border-radius:8px;cursor:pointer;font-size:17px;line-height:1;padding:6px 10px">🌙</button>
  <div class="landing-card">
  <div class="landing-hero" role="presentation">
    <svg id="hero-frame" viewBox="0 0 360 240" aria-hidden="true">
      <line x1="30" y1="212" x2="330" y2="212" stroke="var(--border2)" stroke-width="1.5"/>
      <g stroke="var(--teal)" stroke-width="2.5" stroke-linecap="round">
        <line x1="30" y1="72" x2="78" y2="72">
          <animate attributeName="x1" values="30;300" dur="2.6s" begin="0s" repeatCount="indefinite"/>
          <animate attributeName="x2" values="78;348" dur="2.6s" begin="0s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0;0.7;0.7;0" keyTimes="0;0.15;0.7;1" dur="2.6s" begin="0s" repeatCount="indefinite"/>
        </line>
        <line x1="30" y1="96" x2="82" y2="96">
          <animate attributeName="x1" values="30;300" dur="2.6s" begin="1.2s" repeatCount="indefinite"/>
          <animate attributeName="x2" values="82;352" dur="2.6s" begin="1.2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0;0.7;0.7;0" keyTimes="0;0.15;0.7;1" dur="2.6s" begin="1.2s" repeatCount="indefinite"/>
        </line>
        <line x1="30" y1="120" x2="76" y2="120">
          <animate attributeName="x1" values="30;300" dur="2.6s" begin="2.0s" repeatCount="indefinite"/>
          <animate attributeName="x2" values="76;346" dur="2.6s" begin="2.0s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0;0.7;0.7;0" keyTimes="0;0.15;0.7;1" dur="2.6s" begin="2.0s" repeatCount="indefinite"/>
        </line>
      </g>
      <path d="M172 212 L177 100 H183 L188 212 Z" fill="var(--accent)" fill-opacity="0.16"
            stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
      <g transform="translate(180,96)">
        <rect x="-6" y="-5" width="20" height="10" rx="3" fill="var(--accent)" fill-opacity="0.5" stroke="var(--accent)" stroke-width="1.5"/>
        <g>
          <g stroke="var(--accent)" stroke-width="4.5" stroke-linecap="round">
            <line x1="0" y1="0" x2="0" y2="-62"/>
            <line x1="0" y1="0" x2="54" y2="31"/>
            <line x1="0" y1="0" x2="-54" y2="31"/>
          </g>
          <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="7s" repeatCount="indefinite"/>
        </g>
        <circle cx="0" cy="0" r="6" fill="var(--teal)"/>
      </g>
    </svg>

    <div class="hero-park">Camán</div>
    <div class="hero-title">ReWind</div>
    <p class="hero-tag">Monitoreo de salud estructural de torres eólicas</p>
    <div id="load-wrap">
      <div id="load-bar-bg"><div id="load-bar"></div></div>
      <div id="load-row"><span id="load-status">Iniciando…</span><span id="load-pct">0%</span></div>
    </div>
  </div>

  <footer class="landing-credit">
    ReWind · Plataforma de monitoreo de salud estructural (SHM) para aerogeneradores.
  </footer>
  </div><!-- /.landing-card -->
</div>

<!-- Aviso de rotación: banner inferior NO bloqueante -->
<div id="rotate-hint">
  <span class="rotate-ico">⟲📱</span>
  <span class="rotate-txt"><b>Mejor en horizontal</b> — ReWind se ve mejor apaisado, pero puedes seguir usándolo en vertical.</span>
  <button type="button" class="rotate-close" onclick="this.parentElement.style.display='none'" aria-label="Cerrar aviso">✕</button>
</div>

<!-- P2-7: motor de tooltips con estilo (reemplaza el title nativo) -->
<div id="sw-tooltip"></div>
`;

  // Inyecta el shell al inicio del body (antes de este propio <script>), de forma
  // que los mount points existan para shm_mode y para el cableado de abajo.
  document.body.insertAdjacentHTML('afterbegin', SHELL_HTML);

  // ── Toggle de tema (claro/oscuro) ──────────────────────────────────────────
  (function () {
    function applyThemeColor() {
      var dark = document.documentElement.dataset.theme === 'dark';
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute('content', dark ? '#0b1018' : '#eef2f6');
      // El icono muestra la ACCIÓN (a qué tema cambia): ☀️ en oscuro, 🌙 en claro.
      ['btn-theme', 'landing-theme'].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) { b.textContent = dark ? '☀️' : '🌙'; b.setAttribute('aria-label', dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'); }
      });
    }
    function toggle() {
      var d = document.documentElement, next = d.dataset.theme === 'dark' ? 'light' : 'dark';
      d.dataset.theme = next; try { localStorage.setItem('rewind_theme', next); } catch (e) {}
      applyThemeColor();
    }
    applyThemeColor();
    ['btn-theme', 'landing-theme'].forEach(function (id) {
      var b = document.getElementById(id); if (b) b.addEventListener('click', toggle);
    });
  })();

  // ── Portada: cierre + fallback de seguridad (shm_mode maneja el progreso) ────
  window.__rewindCloseLanding = function () {
    var l = document.getElementById('landing'); if (!l || l.classList.contains('exit')) return;
    l.classList.add('exit'); setTimeout(function () { l.remove(); }, 700);
  };
  setTimeout(function () { window.__rewindCloseLanding(); }, 25000);

  // ── Motor de tooltips (reemplaza el title nativo por uno con estilo) ─────────
  (function () {
    var tip = document.getElementById('sw-tooltip');
    var hideTimer = null;
    function formatText(raw) {
      var m = raw.match(/^(.*?)\s{2,}(\S.*)$/);
      if (m) return m[1].trim() + ' <span class="sw-tip-key">' + m[2].trim() + '</span>';
      return raw;
    }
    function show(el, e) {
      clearTimeout(hideTimer);
      var text = el._swTip;
      if (!text) return;
      tip.innerHTML = formatText(text);
      tip.classList.add('visible');
      reposition(e);
    }
    function reposition(e) {
      var margin = 12;
      var tw = tip.offsetWidth || 180;
      var th = tip.offsetHeight || 28;
      var x = e.clientX + 14;
      var y = e.clientY + 18;
      if (x + tw + margin > window.innerWidth) x = e.clientX - tw - 8;
      if (y + th + margin > window.innerHeight) y = e.clientY - th - 8;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }
    function hide() { hideTimer = setTimeout(function () { tip.classList.remove('visible'); }, 60); }
    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest('[title]');
      if (!el) return;
      el._swTip = el.getAttribute('title');
      el.removeAttribute('title');
      el.setAttribute('data-sw-tipped', '1');
      show(el, e);
    }, true);
    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest('[data-sw-tipped]');
      if (el) show(el, e);
    });
    document.addEventListener('mousemove', function (e) {
      if (tip.classList.contains('visible')) reposition(e);
    });
    document.addEventListener('mouseout', function (e) {
      if (e.target.closest('[data-sw-tipped],[title]')) hide();
    });
    document.addEventListener('mousedown', function () { tip.classList.remove('visible'); });
  })();

  // ── Switcher de módulo (Frente C): saltar a otra app desde la barra ──────────
  // Muestra en qué módulo estás y despliega los demás (según el rol) para ir
  // directo, sin volver a la landing. Se hereda en las 3 apps vía shell_dom.
  (function () {
    var APP = document.documentElement.dataset.app;
    var host = document.getElementById('rw-switch');
    if (!APP || !host) return;   // solo en las apps (la landing no tiene data-app)

    var MODS = [
      { ws: 'proyecto',  name: 'Proyecto',  dot: '#c8871a', sub: 'siting · sombra' },
      { ws: 'obra',      name: 'Obra',      dot: '#d95f18', sub: 'avance 4D · calidad' },
      { ws: 'operacion', name: 'Operación', dot: '#12889a', sub: 'SHM en vivo' },
    ];
    var WS_ROLES = {
      proyecto:  ['admin', 'gestor', 'visualizador'],
      obra:      ['admin', 'gestor', 'calidad_inspector', 'calidad_aprobador', 'visualizador'],
      operacion: ['admin', 'operador', 'inspector', 'visualizador'],
    };
    var isDemo = /(?:^|[?&])demo(?:$|&|=)/.test(location.search);
    var role = null;
    try { var s = JSON.parse(localStorage.getItem('rewind.auth.v1') || 'null'); if (s && s.role) role = s.role; } catch (e) {}
    var access = MODS.filter(function (m) { return (isDemo || !role) ? true : (WS_ROLES[m.ws] || []).includes(role); });
    var cur = MODS.filter(function (m) { return m.ws === APP; })[0] || MODS[0];
    var q = isDemo ? '?demo' : '';

    var st = document.createElement('style');
    st.textContent =
      '#rw-switch{display:flex;align-items:center;margin-left:14px;min-width:0;}' +
      '#rw-sw-btn{display:inline-flex;align-items:center;gap:8px;background:var(--bg4);border:1px solid var(--border2);color:var(--text);border-radius:999px;cursor:pointer;font:inherit;font-size:13px;font-weight:600;padding:5px 12px;line-height:1;white-space:nowrap;}' +
      '#rw-sw-btn .car{color:var(--text-muted);font-size:11px;margin-left:2px;}' +
      '#rw-sw-static{display:inline-flex;align-items:center;gap:8px;color:var(--text);font-size:13px;font-weight:600;padding:5px 4px;white-space:nowrap;}' +
      '.rw-sw-d{width:9px;height:9px;border-radius:50%;flex:none;}' +
      '#rw-sw-menu{position:fixed;display:none;z-index:9500;min-width:236px;background:var(--bg-elev,var(--bg4));border:1px solid var(--border2);border-radius:12px;box-shadow:0 18px 44px rgba(2,8,14,.34);padding:6px;}' +
      '#rw-sw-menu a,#rw-sw-menu .cur{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:9px;color:var(--text);text-decoration:none;font-size:13px;}' +
      '#rw-sw-menu a:hover,#rw-sw-menu a:focus{background:var(--bg3);outline:none;}' +
      '#rw-sw-menu .cur{opacity:.6;cursor:default;}' +
      '#rw-sw-menu .nm{font-weight:600;}' +
      '#rw-sw-menu .sub{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--text-muted);}' +
      '#rw-sw-menu .tag{margin-left:auto;font-family:"IBM Plex Mono",monospace;font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;}';
    document.head.appendChild(st);

    // Con ≤1 módulo accesible no hay a dónde saltar: etiqueta estática.
    if (access.length <= 1) {
      host.innerHTML = '<span id="rw-sw-static"><span class="rw-sw-d" style="background:' + cur.dot + '"></span>' + cur.name + '</span>';
      return;
    }

    host.innerHTML = '<button id="rw-sw-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Cambiar de módulo">' +
      '<span class="rw-sw-d" style="background:' + cur.dot + '"></span>' + cur.name + '<span class="car">▾</span></button>';

    var menu = document.createElement('div');
    menu.id = 'rw-sw-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = access.map(function (m) {
      var dot = '<span class="rw-sw-d" style="background:' + m.dot + '"></span>';
      var label = '<span><span class="nm">' + m.name + '</span><br><span class="sub">' + m.sub + '</span></span>';
      if (m.ws === APP) return '<div class="cur">' + dot + label + '<span class="tag">actual</span></div>';
      return '<a role="menuitem" href="' + m.ws + '.html' + q + '">' + dot + label + '<span class="tag">ir →</span></a>';
    }).join('');
    document.body.appendChild(menu);

    var btn = document.getElementById('rw-sw-btn');
    function place() {
      var r = btn.getBoundingClientRect();
      menu.style.display = 'block';
      var left = r.left; if (left + menu.offsetWidth > window.innerWidth - 12) left = window.innerWidth - menu.offsetWidth - 12;
      if (left < 12) left = 12;
      menu.style.left = left + 'px'; menu.style.top = (r.bottom + 8) + 'px';
    }
    var open = false;
    function show() { open = true; place(); btn.setAttribute('aria-expanded', 'true'); var a = menu.querySelector('a'); if (a) a.focus(); }
    function hide() { if (!open) return; open = false; menu.style.display = 'none'; btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open ? hide() : show(); });
    document.addEventListener('click', function (e) { if (open && !menu.contains(e.target) && e.target !== btn) hide(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', hide, { passive: true });
    window.addEventListener('resize', hide);
  })();

  // ── PWA: registrar el service worker (offline). No bajo automatización. ──────
  if ('serviceWorker' in navigator && !navigator.webdriver) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('No se pudo registrar el service worker:', err);
      });
    });
  }
})();
