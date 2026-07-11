// ─────────────────────────────────────────────────────────────────────────────
// auth.js — sesión de usuario (Supabase Auth) sin dependencias ni supabase-js.
//
// Modelo "provisioning cerrado": el signup público se desactiva en Supabase; el
// admin (JP) crea los usuarios y reparte las claves. El usuario solo hace LOGIN
// (correo + clave) → recibe un JWT firmado con expiración (`expires_at`). La
// sesión se guarda en localStorage; su vigencia la decide la config de Supabase
// (Auth → Access/Refresh token expiry). El access token se refresca solo mientras
// haya refresh_token vigente; cuando caduca de verdad → vuelve la pantalla de login.
//
// backend.js NO importa este módulo (evita ciclo): lee el token directo de
// localStorage (`SESSION_KEY`) al armar los headers. Aquí solo importamos la
// config del backend (URL + anon/publishable key) para pegarle a `/auth/v1/*`.
// ─────────────────────────────────────────────────────────────────────────────
import { getBackendConfig } from './backend.js?v=320';

export const SESSION_KEY = 'rewind.auth.v1';
const SKEW_MS = 30000;   // refresca 30 s antes del vencimiento (margen de reloj/red)

// Config del endpoint de Auth: base + apikey pública. null si no hay Supabase real.
function authCfg() {
  const c = getBackendConfig();
  if (!c || !c.url || c.mock) return null;
  return { base: c.url.replace(/\/$/, ''), key: c.anonKey || '' };
}

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* */ }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* */ }
}

// ¿La app requiere login? Solo con Supabase real configurado (mock/sim no).
export function authRequired() { return !!authCfg(); }

// ¿Hay una sesión con access token aún vigente (no vencido)?
export function sessionValid() {
  const s = getSession();
  return !!(s && s.access_token && (s.expires_at * 1000) > Date.now());
}

// ¿Podemos operar? (sesión vigente, o refresh_token para renovarla).
export function loggedIn() {
  const s = getSession();
  if (!s) return false;
  if ((s.expires_at * 1000) > Date.now()) return true;
  return !!s.refresh_token;   // vencido pero renovable
}

export function currentUser() { const s = getSession(); return s ? s.user : null; }
export function currentRole() { const s = getSession(); return (s && s.role) || 'viewer'; }
export function isEditor() { return ['editor', 'admin'].includes(currentRole()); }

// Guarda la respuesta de token de Supabase como sesión. `expires_at` viene en
// segundos epoch; si no, lo derivamos de `expires_in`.
function persistToken(data, prevUser) {
  const expires_at = data.expires_at || (Math.floor(Date.now() / 1000) + (data.expires_in || 3600));
  const user = data.user ? { id: data.user.id, email: data.user.email } : prevUser || null;
  const prev = getSession() || {};
  saveSession({ ...prev, access_token: data.access_token, refresh_token: data.refresh_token, expires_at, user });
  return getSession();
}

// ── Login: grant_type=password ────────────────────────────────────────────────
export async function signIn(email, password) {
  const c = authCfg();
  if (!c) throw new Error('Backend Supabase no configurado.');
  const res = await fetch(`${c.base}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.error || 'Credenciales inválidas');
  persistToken(data);
  await fetchRole().catch(() => {});
  scheduleRefresh();
  return getSession();
}

// ── Refresh: grant_type=refresh_token ─────────────────────────────────────────
export async function refresh() {
  const c = authCfg(); const s = getSession();
  if (!c || !s || !s.refresh_token) return null;
  try {
    const res = await fetch(`${c.base}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) { clearSession(); return null; }  // refresh vencido → forzar re-login
    const ns = persistToken(data, s.user);
    scheduleRefresh();
    return ns;
  } catch { return null; }   // red intermitente → reintenta en el próximo tick
}

// ── Logout ────────────────────────────────────────────────────────────────────
export async function signOut() {
  const c = authCfg(); const s = getSession();
  if (c && s && s.access_token) {
    fetch(`${c.base}/auth/v1/logout`, { method: 'POST', headers: { apikey: c.key, Authorization: `Bearer ${s.access_token}` } }).catch(() => {});
  }
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  clearSession();
}

// ── Rol del usuario (tabla members) ───────────────────────────────────────────
export async function fetchRole() {
  const c = authCfg(); const s = getSession();
  if (!c || !s || !s.user) return 'viewer';
  const res = await fetch(`${c.base}/rest/v1/members?select=role&user_id=eq.${encodeURIComponent(s.user.id)}`, {
    headers: { apikey: c.key, Authorization: `Bearer ${s.access_token}` },
  });
  let role = 'viewer';
  if (res.ok) { const rows = await res.json().catch(() => []); if (rows[0] && rows[0].role) role = rows[0].role; }
  saveSession({ ...getSession(), role });
  return role;
}

// ── Refresco proactivo: renueva un poco antes del vencimiento ─────────────────
let _refreshTimer = null;
export function scheduleRefresh() {
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  const s = getSession();
  if (!s || !s.refresh_token) return;
  const ms = (s.expires_at * 1000) - Date.now() - SKEW_MS;
  _refreshTimer = setTimeout(() => { refresh(); }, Math.max(1000, ms));
}

// Al cargar el módulo con sesión viva, programa el refresco (mantiene el token fresco).
if (typeof window !== 'undefined' && authRequired() && getSession()) {
  if (sessionValid()) scheduleRefresh();
  else refresh();   // vencido al abrir: intenta renovar de una
  window.shmAuth = { getSession, currentUser, currentRole, signOut, refresh };
}
