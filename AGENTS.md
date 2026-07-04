# AGENTS.md — ReWind (`wind-shm`)

Guía para agentes de código. Convención [agents.md](https://agents.md). Convive con
[`CLAUDE.md`](CLAUDE.md) (más detallado) y con [`docs/ESTADO.md`](docs/ESTADO.md)
(handoff vivo: qué se hizo, qué sigue). **Al retomar, leé `docs/ESTADO.md` primero.**

## Qué es

**ReWind** — herramienta web de **Structural Health Monitoring + gestión de obra**
del parque eólico **Camán I**, fork de **PÓRTICO** (`structweb3d`). Reusa el motor
FEM heredado como **gemelo digital** (modal/estático → f₁/f₂ y deformadas) y agrega:
flota 3D georreferenciada (Three.js), mapa 2D (Leaflet), avance de obra 4D, módulo de
calidad/hitos (WBS), shadow flicker, dashboard SHM e informes.

- **Vanilla JS (ES modules) + Three.js + Leaflet + numeric.js.** Sin build, sin
  bundler, sin framework, **sin `package.json`**. La app se auto-arranca desde
  `js/shm/shm_mode.js` (`startBoot()`), no hay `app.js` ni `window.app`.
- PWA (service worker network-first, instalable/offline).
- **Deploy: GitHub Pages** desde `main` (sitio estático; push = republica solo).
  App en `/app.html`, landing en `/`.
- Backend **opcional** en Supabase (`backend/`, mock-first) — la app funciona sin él.

## Comandos

| Tarea | Comando |
|---|---|
| Servir local | `python serve.py 8765` (no-cache, MIME correctos) o `python -m http.server 8765` |
| Chequear sintaxis de un ESM | `node --input-type=module --check < js/ruta/archivo.js` (⚠ **no** `node --check archivo.js`) |
| Tests (scripts Node sueltos, sin runner) | `node tools/test_wbs.mjs` · `node tools/test_quality_profile.mjs` · `node asistente/test_torre.mjs` · `node asistente/test_generador.mjs` |
| Deploy | `git push origin main` (Pages republica). Verificar: `gh api repos/jpreyes/wind-shm/pages/builds/latest --jq '.status,.commit'` |

No hay lint/format configurado. Los tests validan contra soluciones analíticas /
equilibrio global (ΣReacciones = ΣCargas), no solo que “corra”.

## Arquitectura (mapa rápido)

- **`js/shm/`** — la app: `shm_mode.js` (entry + UI), `fleet_view.js` (escena
  Three.js, 4D, picking), `map_view.js` (Leaflet), `calidad.js` (módulo
  calidad/hitos), `data_source.js` (abstracción de datos: sim ↔ live ↔ backend),
  `backend*.js` (Supabase mock-first), `parks.js` (árbol Parque▸Zona▸Torre),
  `inspection.js`/`fatigue.js`/`health.js`/`history.js`/`alarms.js` (SHM), `i18n.js`.
- **`js/model/`** (kept): `model.js`, `serializer.js` (`.s3d`), `macros/turbine.js`.
- **`js/solver/`** (10 módulos del gemelo): `assembler`, `timoshenko`,
  `static_solver`, `modal_solver`/`modal_results`, `postprocess`, `membrane`,
  `plate`, `diaphragm`, `links`.
- **`tools/` + `lib/`** — librerías compartidas Node+navegador (WBS, lectura/escritura
  xlsx, reader agnóstico, catálogo normativo). **Imports planos sin `?v=`** para
  poder testearlas en Node.
- **`asistente/`** — generador de celosía de torres AT (sin LLM).
- **`backend/supabase/`** — `schema.sql`, `rls_pilot.sql`, `README.md`.
- **`docs/`** — `ESTADO.md` (handoff), `ROADMAP.md`, `planes/frente-*.md`.

Coordenadas Z-up (SAP2000/ETABS); mapeo Three.js `model(x,y,z) → three(x,z,y)`.

## Convenciones que NO se rompen

1. **Versionado / cache-bust.** Cada import interno lleva `?v=NNN`. Al shipear JS/CSS,
   bump global + tres constantes:
   ```bash
   files=$(grep -rl "v=NNN" --include=*.js --include=*.html js app.html sw.js)
   for f in $files; do sed -i 's/v=NNN/v=MMM/g' "$f"; done
   ```
   y a mano: `REWIND_VER = 'vMMM'` (`js/shm/shm_mode.js`) y `CACHE_VERSION`
   (`sw.js`, **independiente**). El worker `shm_worker.js` también se bumpea.
2. **`tools/` y `lib/` con imports planos** (sin `?v=`); los `js/shm/*` sí llevan `?v=`.
3. **Nunca `git add -A`.** Untracked/ignored a propósito: `bridge/`, `firmware/`,
   `excel/`, `referencias/`, `auditoria/`, `node_modules/`, el xlsx de SACYR
   (confidencial), `test_*.mjs` de la raíz. Stagear rutas explícitas.
4. **No editar con PowerShell `Get-Content`/`Set-Content`** (corrompe UTF-8 con
   acentos). Usar la herramienta de edición o `sed`.
5. **Commits en español**, terminando con trailer `Co-Authored-By: Claude`.
   Commitear directo a `main` y push (solo cuando el usuario lo pida).
6. **Idioma:** UI/commits/comentarios en español (ES neutro, no voseo).

## Verificación en el navegador (preview)

- El **service worker deadlockea el preview CDP** → está guardado por
  `!navigator.webdriver`. Para probar solver/modelo desde `preview_eval`, importar
  dinámicamente `import('./js/...?v=NNN')` (recordá **recargar** tras editar, o probás
  código viejo).
- **Los screenshots se cuelgan** (WebGL rAF) → usar `preview_eval`/`preview_inspect`.
- Para probar inputs de archivo (asistente de import) se inyecta un `File` vía
  `DataTransfer` interceptando `document.createElement('input')`.
- IDs reales de la flota: `T01..T67` con huecos (**no** existen `T05`, `T07`); `AT-01..AT-10`.

## Backend (opcional, Supabase — mock-first)

- Default sin config = **simulación local** (`DataSource` modo `sim`).
- Activar: `app.html?backend=mock` (mock en memoria) · `?backend=url|key` · panel
  «Fuente» (barra de estado) · `shmBackendConfig(url, anonKey)` en consola.
- Setup real: crear proyecto Supabase → correr `backend/supabase/schema.sql` +
  `rls_pilot.sql` (abre `anon` para el piloto) → pegar URL + **anon key** (nunca la
  `service_role`). Ver `backend/supabase/README.md`.

## Roadmap / trabajo en curso

`docs/ROADMAP.md` (fases R-*) + `docs/planes/frente-*.md`. **En curso: Frente 6** —
reorganizar la app por fases del ciclo de vida (Proyecto·Obra·Operación·Administración),
ver `docs/planes/frente-6-gestion-ciclo-vida.md`. Al cerrar ítems, actualizar el
roadmap **y** `docs/ESTADO.md`.
