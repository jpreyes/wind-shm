# ReWind — Estado actual / Handoff de sesión

> Documento vivo para **retomar el trabajo en otra sesión** sin perder contexto.
> Última actualización: **2026-07-11** · versión desplegada: **v318** (GitHub Pages).
> **Plan activo:** [`docs/roadmap-maestro.md`](roadmap-maestro.md) (ordenado por prioridad:
> auth → GUI → estructuras/fases → sensor real; integra la auditoría externa).
> Detalle de módulos por fase: [`docs/planes/frente-6-gestion-ciclo-vida.md`](planes/frente-6-gestion-ciclo-vida.md).

---

## 1. Dónde estamos (una pantalla)

ReWind (`jpreyes/wind-shm`) es una herramienta SHM + gestión de obra del parque
Camán I, sobre PÓRTICO. **Sitio estático en GitHub Pages** (`main` → deploy
automático al push). App en `/app.html`, landing en `/`.

**Esta sesión** cerró: módulo de **hitos/WBS** (calidad → 4D por partida), **import
contratista-agnóstico**, **catálogo normativo**, y un **backend Supabase Sprint 0**
(mock-first) que JP está **conectando a su proyecto real ahora**. Se abrió el
**Frente 6** (reorganizar la app por fases del ciclo de vida).

**Versión:** v318 · REWIND_VER `v318` · `sw.js` CACHE `v273`.

> **Fase 1 (Auth) — código listo (v313).** Login Supabase correo+clave
> (`js/shm/auth.js` + `auth_ui.js`), token del usuario en los headers de
> `backend.js`, gate que bloquea el boot con Supabase real sin sesión, rol
> `viewer`→solo-lectura, chip de usuario en la barra. Sin backend real
> (sim/mock) **no** pide login. **Falta el cierre operativo que hace JP en
> Supabase:** desactivar signup público, crear usuarios + fila en `members`,
> correr `backend/supabase/rls_close.sql`, fijar duración de sesión. Detalle en
> [`roadmap-maestro.md`](roadmap-maestro.md) Fase 1.

---

## 2. Lo construido esta sesión (por commit, más nuevo abajo)

| v | Commit | Qué |
|---|---|---|
| v297 | `ef3ee05` | «Cargar parque» vs «Actualizar» en el 4D + quitar marca SACYR de la UI |
| v298 | `8933ebb` | Elegir cargar/actualizar antes del panel + reset real del 4D |
| v299 | `0ce9550` | **Hitos/WBS Fase A**: avance 4D POR PARTIDA (no un % por torre) — `tools/wbs.js` |
| v300 | `3cd61bf` | **HUD de partidas** editable + consolidador de nomenclatura (Fase B) |
| v301 | `423c58c` | Gestionar hitos y protocolos **sin Excel** (asignar partida al crear + «＋ protocolo») |
| v302 | `a5ca3c0` | «Calidad por hito» en la ficha de torre (Selección) + informe |
| v303 | `4d1df1f` | **Import agnóstico (R-41b)**: asistente de mapeo + perfiles — `tools/quality_profile.mjs` |
| v304 | `b591a25` | **Catálogo normativo ⚖** + SACYR como perfil built-in — `tools/norms_catalog.mjs` |
| v305 | `bd784ad` | **Backend Supabase Sprint 0**: `backend/supabase/schema.sql` + `js/shm/backend.js` (mock↔Supabase) + `DataSource` modo backend |
| v306 | `561d851` | Persistencia de calidad a Postgres — `js/shm/backend_sync.js` (push/pull, upsert) |
| v307 | `608c866` | Panel de conexión (click en «Fuente» de la barra) — `js/shm/backend_ui.js` |
| v308 | `51dbf27` | Sembrar `structures` al conectar + relajar FKs para import |
| v309 | `af7bf17` | Throttle de ingesta a 1/min (no spamear Supabase) |
| v310 | `240934f` | **Frente 6 · Fase 6.0**: conteo de filas por tabla en el panel («que se vea que entra») |

Módulos nuevos clave: `tools/wbs.js`, `tools/quality_profile.mjs`,
`tools/norms_catalog.mjs`, `js/shm/backend.js`, `backend_sync.js`, `backend_ui.js`.
Tests: `tools/test_wbs.mjs`, `test_quality_profile.mjs`. `backend/supabase/`
(schema.sql, rls_pilot.sql, README.md).

---

## 3. Backend Supabase — estado y cómo conectarlo

- **Modelo:** Supabase = Postgres + Realtime + Storage + Auth. **NO Influx**
  (memoria [[backend-supabase]]). Serie temporal en tabla `features`; ventanas
  crudas → Storage.
- **Cómo activarlo:** `app.html?backend=mock` (mock en memoria) · `?backend=url|key`
  o el panel «Fuente» (abajo) · `shmBackendConfig(url, key)` en consola.
  **Default sin config = `sim`** (cero cambio).
- **Proyecto de JP:** `https://xenujkmogaxxkrnpgbmg.supabase.co`. Usa la **publishable
  key** (`sb_publishable_...`), no el JWT legacy — funciona.
- **⚠ Gotchas que ya nos mordieron (resueltos):**
  1. URL cortada (`.supabase.c` en vez de `.co`) → `ERR_NAME_NOT_RESOLVED`.
  2. **RLS**: con anon key sin login, las políticas `to authenticated` de
     `schema.sql` bloquean todo (401). **Solución piloto: correr
     [`backend/supabase/rls_pilot.sql`](../backend/supabase/rls_pilot.sql)** (abre
     anon). Para producción → login + volver a `to authenticated`.
- **Setup real (checklist):** crear proyecto → correr `schema.sql` → correr
  `rls_pilot.sql` → crear bucket `waves` → panel «Fuente» → pegar URL + anon key →
  Conectar. El boot siembra 43 `structures`. El panel muestra el **conteo de filas**
  por tabla (Fase 6.0) para verificar que entra.
- **Ingestor Sprint 0:** el simulador del navegador (throttle 1/min). En producción,
  el Pi/ESP32 o una Edge Function.

---

## 4. Frente 6 — el plan grande EN CURSO

Reorganizar ReWind **del proyecto a la operación** en módulos por fase, anclados a
normas. Decidido con JP: **arrancar por 6.0 (ingesta/visibilidad)** y estructurar
con un **selector de FASE** arriba. Detalle: [`frente-6-gestion-ciclo-vida.md`](planes/frente-6-gestion-ciclo-vida.md).

**Módulos objetivo:** Proyecto (ISO 21502; shadow flicker ya) · **Obra** *(rename de
Calidad; ISO 9001/19650/21502)* · **Operación** *(ISO 55000, IEC 61400-25/26/28,
ISO 17359, RCM/CBM; SHM+inspección van acá)* · **Administración** *(ISO 55000 +
**RDS-PP** como identificador transversal)*.

**Pendiente (en orden):**
- **6.0 (resto):** ampliar el *pull* — hoy `pullQuality` solo trae protocolos;
  falta traer WBS (`wbs_config`) y perfiles (`import_profiles`) al bootear con
  backend activo, para que se recuperen en otro navegador. + indicador de sync en
  la barra de estado (usar `lastPushAt()` ya expuesto).
- **6.1:** rename **Calidad → Obra** + **selector de fase** (filtra el panel).
- **6.2:** **WBS drill-down** — click en partida (p.ej. «Fundación») → su vista
  (protocolos/avance/fechas/fotos/ensayos) + «‹ Volver». Reusar «Abrir partida» de
  `avance_hud.js`. *(Hoy clic en partida no hace nada — queja de JP.)*
- **6.3:** **gestión de tipos de estructura** (hoy solo turbine/hv; agregar
  subestación, LAT, vialidad, plataformas…) cada uno con su WBS.
- **6.4:** módulo **Operación** (reagrupar SHM + reubicar inspección + KPI
  disponibilidad IEC 61400-26).
- **6.5:** módulo **Administración** (ISO 55000 + RDS-PP: registro de activos,
  KPIs, costos, vida remanente).
- **6.6:** módulo **Proyecto** (encuadrar shadow flicker + línea base de diseño).

**Otros pendientes de backend (Frente 4):** Realtime nativo (hoy polling 5 s),
Edge Function de ingesta, **login UI** (Supabase Auth → cerrar RLS), cablear
`pushInspection` en el CMMS, retención de `features`.

---

## 5. Convenciones críticas (no romper)

- **Versionado:** cada deploy sube `v=NNN` en todos los imports + `REWIND_VER`
  (shm_mode.js) + `CACHE_VERSION` (sw.js, independiente). Bump:
  `files=$(grep -rl "v=NNN" --include=*.js --include=*.html js app.html sw.js); for f in $files; do sed -i 's/v=NNN/v=MMM/g' "$f"; done`
  + editar a mano `REWIND_VER = 'vNNN'` y `CACHE_VERSION`.
- **Deploy:** push a `main` → GitHub Pages republica solo. Verificar build:
  `gh api repos/jpreyes/wind-shm/pages/builds/latest --jq '.status,.commit'`.
- **Módulos tools/lib (Node+navegador):** imports **planos sin `?v=`** (para poder
  testearlos en Node). Los `js/shm/*` **sí** llevan `?v=`.
- **No PowerShell Get/Set-Content** para editar (corrompe UTF-8). Usar Edit o sed.
- **Nunca `git add -A`** (excel/, referencias/, auditoría/ y el xlsx de SACYR son
  confidenciales/gitignored; `bridge/` y `firmware/` untracked a propósito).
- **Verificación en preview:** screenshots se cuelgan (WebGL rAF) → usar
  `preview_eval`. Para probar inputs de archivo (asistente de import) se inyecta un
  `File` vía `DataTransfer` interceptando `document.createElement('input')` (ver
  transcript). Estructuras reales de la flota: T01..T67 con huecos (**no** existen
  T05, T07); AT-01..AT-10.

---

## 6. Cómo retomar

1. Leer este archivo + [`frente-6-gestion-ciclo-vida.md`](planes/frente-6-gestion-ciclo-vida.md).
2. `git log --oneline -15` para ver los últimos commits.
3. Si se sigue con backend: `python serve.py 8765`, abrir `app.html?backend=mock`
   para probar sin Supabase, o el panel «Fuente» con la config real.
4. Próximo paso sugerido: **terminar 6.0** (ampliar pull WBS/perfiles + indicador
   de sync) o saltar a **6.1** (rename Obra + selector de fase) — a confirmar con JP.
5. Al terminar, **actualizar este archivo** y el ROADMAP.
