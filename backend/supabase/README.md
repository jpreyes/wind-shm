# ReWind · Backend Supabase (Sprint 0)

Backend **simple** para ReWind sobre **Supabase** (PostgreSQL gestionado + Realtime
+ Storage + Auth). Reemplaza el WS `/live` casero por infra gestionada, cero ops.
Supabase **no tiene InfluxDB**: la serie temporal va en la tabla `features`
(indexada por `structure_id, ts`); las ventanas crudas del ADXL355 van a **Storage**
(bucket `waves`), no a la BD.

## Arranque mock (sin Supabase, ya funciona)

Sin configuración, ReWind usa un **backend mock** en memoria: el simulador local
actúa de ingestor, persiste cada tick y lo re-emite al dashboard — prueba el loop
completo `producir → persistir → suscribir → render` sin nada externo. `DataSource`
lo detecta solo (`getBackendConfig()` → null → mock).

## Conectar Supabase real

1. Crear un proyecto gratis en [supabase.com](https://supabase.com).
2. En **SQL Editor**, pegar y correr [`schema.sql`](schema.sql) (tablas de
   telemetría + calidad + CMMS + auth/roles + RLS + Realtime de `features`).
3. En **Storage**, crear el bucket `waves` (privado).
4. Copiar de *Project Settings → API* la **Project URL** y la **anon key** (ambas
   públicas; la anon key va en el front).
5. Configurar el front (una vez), desde la consola del navegador:
   ```js
   shmBackendConfig('https://TU-PROYECTO.supabase.co', 'TU_ANON_KEY')
   ```
   o por URL: `app.html?backend=https://TU-PROYECTO.supabase.co|TU_ANON_KEY`.
   Recargar: `DataSource` pasa a `backend:supabase` (features vía PostgREST +
   polling cada 5 s).

## Ingestor

En Sprint 0 el **simulador del navegador** hace de ingestor (escribe `features`).
En producción lo hace el **Pi/ESP32** (o una Edge Function que reciba MQTT/HTTP),
insertando en `features` con la `service_role` key (bypassa RLS) o un usuario
`editor`. El esquema y el contrato de `features` ya están fijados.

## Roles / auth

`members(user_id, role)` con `viewer | editor | admin` sobre `auth.users`; RLS:
lectura para autenticados, escritura para `editor/admin`. El login real (magic
link / OAuth) lo hace el usuario en su propia sesión de Supabase — ReWind no
maneja contraseñas en claro. Los roles de UI (`?role=viewer`, R-38) ya existen.

## Estado

- ✅ Esquema completo (telemetría · calidad · CMMS · auth).
- ✅ Cliente `js/shm/backend.js` (mock + Supabase PostgREST/polling).
- ✅ `DataSource` enruta la telemetría por el backend (mock verificado).
- ⬜ Persistir calidad/CMMS a Postgres (adaptadores `insert`/`select` listos en el
  cliente; falta cablearlos en `calidad.js`/inspección).
- ⬜ Realtime nativo (hoy polling) · Edge Function de ingesta · login UI.
