// ─────────────────────────────────────────────────────────────────────────────
// auth_ui.js — pantalla de login (gate) + chip de usuario en la barra de estado.
//
// Cuando el backend Supabase real está configurado y no hay sesión vigente, la
// app NO arranca: se muestra el gate a pantalla completa. Login OK → recarga y
// bootea normal. Botón "demo" → cae a backend mock (sin login) para presentar.
// ─────────────────────────────────────────────────────────────────────────────
import { signIn, signOut, currentUser, currentRole, authRequired, loggedIn } from './auth.js?v=317';
import { setBackendConfig } from './backend.js?v=317';

// ¿Hay que frenar el boot para pedir login? true = se mostró el gate; el caller aborta.
export function requireLogin() {
  if (!authRequired() || loggedIn()) return false;
  showLoginGate();
  return true;
}

export function showLoginGate() {
  if (document.getElementById('auth-gate')) return;
  document.body.classList.add('auth-gating');
  const ov = document.createElement('div');
  ov.id = 'auth-gate';
  ov.className = 'auth-gate';
  ov.innerHTML = `
    <form class="auth-card" novalidate>
      <div class="auth-logo">Re<span>Wind</span></div>
      <p class="auth-sub">Ingresá con tu correo y clave de acceso</p>
      <label class="auth-field">Correo
        <input type="email" id="auth-email" autocomplete="username" required placeholder="tu@correo.cl">
      </label>
      <label class="auth-field">Clave
        <input type="password" id="auth-pass" autocomplete="current-password" required placeholder="••••••••">
      </label>
      <div class="auth-err" id="auth-err" hidden></div>
      <button type="submit" class="auth-go" id="auth-go">Entrar</button>
      <button type="button" class="auth-alt" id="auth-mock">Entrar en modo demo (sin backend)</button>
    </form>`;
  document.body.appendChild(ov);

  const form = ov.querySelector('form');
  const err = ov.querySelector('#auth-err');
  const go = ov.querySelector('#auth-go');
  const showErr = (m) => { err.textContent = m; err.hidden = false; };
  ov.querySelector('#auth-email').focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = ov.querySelector('#auth-email').value.trim();
    const pass = ov.querySelector('#auth-pass').value;
    if (!email || !pass) { showErr('Completá correo y clave.'); return; }
    err.hidden = true; go.disabled = true; go.textContent = 'Entrando…';
    try {
      await signIn(email, pass);
      location.reload();
    } catch (ex) {
      showErr(ex.message || 'No se pudo iniciar sesión.');
      go.disabled = false; go.textContent = 'Entrar';
    }
  });

  // Demo: sin login, backend mock (útil para presentar sin credenciales).
  ov.querySelector('#auth-mock').addEventListener('click', () => {
    setBackendConfig({ mock: true });
    location.href = location.pathname + '?backend=mock';
  });
}

// ── Chip de usuario para la barra de estado ───────────────────────────────────
const ROLE_LABEL = { viewer: 'lectura', editor: 'editor', admin: 'admin' };

export function userChipHTML() {
  if (!authRequired() || !loggedIn()) return '';
  const u = currentUser();
  const role = currentRole();
  const email = (u && u.email) || 'usuario';
  return `<span class="shm-sb shm-sb-click" id="sb-user" title="Cerrar sesión">
    👤 ${email} · <b>${ROLE_LABEL[role] || role}</b></span>`;
}

export function wireUserChip(root) {
  const el = root.querySelector('#sb-user');
  if (!el) return;
  el.addEventListener('click', async () => {
    if (!confirm('¿Cerrar sesión?')) return;
    await signOut();
    location.reload();
  });
}
