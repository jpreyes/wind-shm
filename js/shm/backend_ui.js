// ─────────────────────────────────────────────────────────────────────────────
// backend_ui.js — panel de conexión al backend (Supabase). Pegar URL + anon key,
// probar la conexión y conectar/desconectar. La app recarga para re-inicializar
// el DataSource con la fuente elegida.
//
// Sólo la **anon key** (pública, pensada para el navegador). NUNCA la service_role
// (secreta) — esa vive en el ingestor/servidor, no en el front.
// ─────────────────────────────────────────────────────────────────────────────
import { getBackendConfig, setBackendConfig } from './backend.js?v=309';
import { t } from './i18n.js?v=309';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Prueba de conexión: una consulta liviana a PostgREST. 2xx = ok; 401/403 =
// alcanzable pero sin permiso (URL/clave válidas, falta login/RLS); red = falla.
async function testConnection(url, anonKey) {
  const base = url.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/rest/v1/structures?select=id&limit=1`, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
    if (res.ok) return { ok: true, msg: t('be.ok') };
    if (res.status === 401 || res.status === 403) return { ok: true, msg: t('be.reachable') };
    return { ok: false, msg: `HTTP ${res.status}` };
  } catch (e) { return { ok: false, msg: t('be.unreachable') }; }
}

export function showBackendConfig() {
  document.getElementById('be-ov')?.remove();
  const cfg = getBackendConfig() || {};
  const ov = document.createElement('div'); ov.id = 'be-ov'; ov.className = 'mb-about cal-ov';
  const mode = cfg.mock ? 'mock' : (cfg.url ? 'supabase' : 'sim');
  ov.innerHTML = `<div class="mb-about-card cal-card be-card" role="dialog" aria-label="${esc(t('be.title'))}">
    <button class="mb-about-x" type="button" aria-label="✕">✕</button>
    <h2>${t('be.title')}</h2>
    <p class="cal-mut">${t('be.desc')}</p>
    <div class="be-status">${t('be.current')}: <b class="be-mode be-mode-${mode}">${mode}</b></div>
    <label class="wiz-fl"><span>${t('be.url')}</span><input class="be-url" placeholder="https://xxxx.supabase.co" value="${esc(cfg.url || '')}"></label>
    <label class="wiz-fl"><span>${t('be.key')}</span><input class="be-key" placeholder="eyJhbGci… (anon)" value="${esc(cfg.anonKey || '')}"></label>
    <div class="be-test"></div>
    <div class="cal-actions" style="margin-top:14px;justify-content:space-between;flex-wrap:wrap">
      <div><button class="cal-btn cal-import-alt be-mock" type="button" title="${esc(t('be.mockTip'))}">${t('be.mock')}</button>
           ${cfg.url || cfg.mock ? `<button class="cal-btn cal-import-alt be-off" type="button">${t('be.disconnect')}</button>` : ''}</div>
      <div><button class="cal-btn cal-import-alt be-testbtn" type="button">${t('be.test')}</button>
           <button class="cal-btn be-save" type="button">${t('be.connect')}</button></div>
    </div>
    <p class="cal-mut" style="margin-top:10px;font-size:11px">${t('be.warn')}</p>
  </div>`;
  const close = () => ov.remove();
  const $ = (s) => ov.querySelector(s);
  ov.addEventListener('click', async (e) => {
    if (e.target === ov || e.target.closest('.mb-about-x')) { close(); return; }
    if (e.target.closest('.be-testbtn')) {
      const box = $('.be-test'); box.textContent = '…';
      const r = await testConnection($('.be-url').value.trim(), $('.be-key').value.trim());
      box.innerHTML = `<span class="be-res ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'} ${esc(r.msg)}</span>`;
      return;
    }
    if (e.target.closest('.be-save')) {
      const url = $('.be-url').value.trim(), anonKey = $('.be-key').value.trim();
      if (!url) { $('.be-test').innerHTML = `<span class="be-res bad">✗ ${esc(t('be.needUrl'))}</span>`; return; }
      setBackendConfig({ url, anonKey }); location.reload();
      return;
    }
    if (e.target.closest('.be-mock')) { setBackendConfig({ mock: true }); location.href = location.pathname + '?backend=mock'; return; }
    if (e.target.closest('.be-off')) { setBackendConfig(null); location.href = location.pathname; return; }
  });
  addEventListener('keydown', function escFn(ev) { if (ev.key === 'Escape') { close(); removeEventListener('keydown', escFn); } });
  document.body.appendChild(ov);
}

if (typeof window !== 'undefined') window.shmShowBackendConfig = showBackendConfig;
