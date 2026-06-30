# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## wind-shm: what this fork is

This repo (`jpreyes/wind-shm`) is a **fork of structweb3d/PÓRTICO** being repurposed into a **Structural Health Monitoring (SHM) tool for wind turbines**. `origin` → `wind-shm`, `upstream` → `structweb3d` (pull PÓRTICO improvements from upstream; ship SHM work to origin). The shared base below still applies verbatim — same vanilla-JS + Three.js engine, no build step, Spanish UI/commits.

**The pivot, in one line:** stop *building* models; start *monitoring a fleet*. The pivot is **done** — the repo was purged to ReWind-only in R-20 (see below). What ReWind is today:
- **Keeps & reuses** the FEM engine as the physics-based **digital twin**: static + modal (frequencies f₁/f₂ and deformed shapes from the measured displacements). Only the 10 solver modules the twin needs survive in `js/solver/` (see below).
- **Adds:** a `Turbine` macro-model (mast + nacelle + spinning blades); a georeferenced multi-turbine fleet on a **conceptual 3D relief** (contour lines + hypsometric tint, no satellite imagery) + roads; a **2D Leaflet map** (PiP / fullscreen); **4D construction progress** (each structure fills bottom-up by % via clipping planes; editable stages); a **liveness layer** (sensors + gateways blinking, color = active/stale/offline); an SHM dashboard in the right panel (Señal · Datos · Estado estructural · Movimiento) + a structural-state report; a lateral tree Parque ▸ Zona ▸ Torre; a hybrid **`DataSource`** abstraction (`SimulatedSource` ↔ `LiveSource`, same schema) with the real path being ESP32 → MQTT → InfluxDB → features backend → browser (see `bridge/`).

> **✅ Limpieza R-20 (hecha, v213+):** el repo está purgado a **solo ReWind**. Se eliminó `js/app.js` (ReWind se auto-bootea desde `js/shm/shm_mode.js`), todo `js/design/`, `js/io/`, `js/ui/`, `js/utils/`, el mallador (`js/model/mesh_*`, `mesher`, `discretize`, `macromodel`, `matching`, `model_ops`), `js/api/`, los solvers no usados por el gemelo (geometric, spectrum, formfind, nl_*, buckling, subspace, staged, tendon, moving_load, timehistory, sparse, linsolve y sus *workers*), `worker/asistente.js`, y el markup PÓRTICO de `index.html` (menús, barra de modelado, panel FE, overlays/modales/ayuda).
> **Lo que QUEDA (closure de ReWind):** `js/shm/*`; de `js/model/` solo `model.js`, `serializer.js`, `macro_registry.js`, `macros/turbine.js`; de `js/solver/` solo los 10 del **gemelo digital** (`assembler`, `timoshenko`, `static_solver`, `modal_solver`, `modal_results`, `postprocess`, `membrane`, `plate`, `diaphragm`, `links`); `asistente/generador.js` (+ `cargas.js`) para la celosía de torres AT; libs `three`, `numeric.js`, `leaflet`. **Las secciones de Arquitectura más abajo ya describen esta realidad ReWind**, no el PÓRTICO original.

Each turbine carries **2 MEMS accelerometers** (top + mid mast) + a gateway → the 2-node config is intentional (enough for the first 2 bending modes + an ML feature vector).

## What this is (the running app)

**ReWind** — a browser-based SHM tool for wind farms, built on the FEM engine inherited from PÓRTICO (Instituto de Obras Civiles, Universidad Austral de Chile, Dr. Juan Patricio Reyes). Vanilla JS ES modules + Three.js + Leaflet + a small `numeric.js`. **No build step, no bundler, no framework, no `package.json`** — `index.html` boots ReWind via an importmap; the app **self-boots** from `js/shm/shm_mode.js` (`startBoot()` on `load`), there is **no `app.js`** anymore.

The app must run from a static server with no install, and is a PWA (installable/offline). **This fork (`wind-shm`) is published on GitHub Pages** (static hosting) from `main` — it is a purely static site, so there is **no Cloudflare Worker / no server-side API** in this deploy. *(Upstream `structweb3d`/PÓRTICO deploys as a Cloudflare Worker; the inherited `wrangler.jsonc`/`worker/` are not part of the ReWind GitHub Pages deploy. The real-time telemetry backend lives in `bridge/` and is separate from the static site.)*

## Commands

- **Run locally:** `python serve.py [port]` (default 8765) — a no-cache static server that sets correct UTF-8 / `.webmanifest` MIME types. `python -m http.server 8765` also works but lacks those headers.
- **Syntax-check an ES module:** `node --input-type=module --check < js/path/file.js`. **Do NOT use plain `node --check file.js`** — it treats `.js` as CommonJS and silently passes invalid ESM (e.g. bad `import`s).
- **Run a verification test:** tests are standalone Node scripts that import the generator/solver modules directly and assert against **analytical solutions / global equilibrium** (ΣReactions = ΣLoads). The versioned ones live in `asistente/`: `node asistente/test_generador.mjs`, `node asistente/test_torre.mjs` (celosía 3D de torre AT). The root `test_*.mjs` (e.g. `test_turbine.mjs`) are ad-hoc and **not** versioned in git. There is no test runner — each file is its own entry point.
- **Deploy (GitHub Pages):** `wind-shm` se publica en **GitHub Pages** desde `main` (sitio estático, sin build): al hacer `git push` a `main`, GitHub Pages republica el sitio automáticamente. No usa Cloudflare ni `wrangler` (eso es de upstream `structweb3d`); ReWind no tiene API de servidor. *(Cuidado con rutas absolutas: bajo Pages el sitio puede colgar de un subpath `…github.io/wind-shm/`, por eso los imports usan rutas relativas `./…`.)*

## Versioned imports — the cache-busting convention (important)

Every internal import and worker URL carries a query string, e.g. `import { Model } from './model/model.js?v=216'`. This is a **global app version** used to bust browser/SW caches. When you ship a change to shipped JS/CSS, **bump it across all files at once** (current version: **v246**):

```bash
files=$(grep -rl "v=246" --include=*.js --include=*.html js index.html sw.js)
for f in $files; do sed -i 's/v=246/v=247/g' "$f"; done
```

Gotchas:
- The bare integer `cx="104"` in `index.html` (an SVG coordinate) is **not** a version — `sed 's/v=NNN/.../'` only matches `v=NNN`, so it's safe; never blanket-replace the raw number.
- `js/shm/shm_worker.js` is loaded by URL with `?v=` from `shm_mode.js` — it must be bumped too.
- **`REWIND_VER`** constant in `js/shm/shm_mode.js` (shown in the UI) — bump it to the same `vNNN` on release.
- `sw.js` also has its own **independent** `CACHE_VERSION` constant (network-first SW); bump it on release per the comment in that file.

## Architecture

ReWind **self-boots**: `index.html` imports `js/shm/shm_mode.js`, which on `load` runs `startBoot()` — builds the toolbar, dashboard, status bar, the `FleetView` (Three.js) and the `MapView` (Leaflet). There is **no `App` orchestrator** and no `window.app` PÓRTICO instance.

**ReWind app (`js/shm/`):**
- **`shm_mode.js`** — the entry point + UI glue: toolbar (Mapa/Avance/Relieve…), right-panel dashboard with lateral tabs (Parque ▸ árbol / Selección ▸ Datos·Estado·Movimiento), the Avance (4D progress) editor, the floating tower card, the status bar, panel resize, theming, `REWIND_VER`.
- **`fleet_view.js`** — the Three.js scene: fleet of turbines, picking (via invisible hitboxes carrying `turbineId`), camera, terrain mesh + grid, roads, the 4D construction clipping planes, floating-card screen projection, the render loop (`_animate` → `onFrame`, operational-only spin, sensor heartbeat).
- **`turbine_mesh.js`** / **`structures.js`** — turbine Group (mast + nacelle + rotor + ghost head + 2 sensors + gateway) and AT-tower / foundation meshes; ghost vs solid materials for 4D.
- **`terrain.js`** — conceptual 3D relief: `Terrain` ShaderMaterial (hypsometric tint + contour lines + hillshade + edge fade) over a zero-based heightmap (`data/caman_dem.json`).
- **`map_view.js`** + **`caman_roads.js`** — Leaflet 2D map (Esri imagery / OpenTopoMap, PiP/fullscreen, scale bar, turbine/AT divIcons, roads).
- **`parks.js`** + **`parks_data_caman.js`** — multi-park store (Parque ▸ Zona ▸ Torre), tree UI with inline rename + delete, `localStorage` persistence; Camán I real data (`toScene(lon,lat)`, turbines/HV towers, editable `stages`, `built`).
- **`data_source.js`** — the `DataSource` abstraction (`SimulatedSource` now; `LiveSource` later, same schema).
- **`digital_twin.js`** — wires the kept FEM solvers as the physics-based twin (assembles a turbine/tower model, runs static + modal → f₁/f₂ and deformed shape).
- **`shm_worker.js`** — Web Worker for the per-turbine SHM summaries (RMS, f₁, wind, ML class), loaded by URL `?v=` from `shm_mode.js`.

**Model layer (`js/model/`, kept):**
- **`model.js`** — in-memory `Model`: `Map`s of nodes, elements, areas, materials, sections, diaphragms, loadCases. **`serializer.js`** round-trips `.s3d` JSON.
- **`macro_registry.js`** + **`macros/turbine.js`** — the pluggable macro-model registry and the wind-turbine macro the twin builds from.

**Digital-twin solver pipeline (`js/solver/`, exactly 10 modules):**
- `assembler.js` assembles global `K` (and mass `M`); `timoshenko.js` holds the element stiffness/mass, local-axis transforms, end-release condensation, and `fixedEndForces`.
- `static_solver.js` (`StaticSolver.solve` → `Results`) and `modal_solver.js` + `modal_results.js` (frequencies, mode shapes, participation).
- `postprocess.js` — `Results`: nodal disps/reactions, element end forces, `getDiagramData`/`getElemAtXi` for N/V/M(x). **Source of truth for internal-force diagrams; never infer loads from end shears.**
- `membrane.js` + `plate.js` (CST/QUAD membrane, MITC4 + DKT plate, shell = membrane+plate), `diaphragm.js` (rigid-diaphragm constraints + floor CR), `links.js` (rigid links / constraints).
- *(Removed in R-20: subspace/buckling/geometric/nl_lite/formfind/spectrum/sparse/linsolve and all their workers — not used by the twin.)*

**AT-tower generator (`asistente/`, kept — no LLM):**
- `asistente/generador.js` — pure ES module that turns a *ficha* (`tipologia:"torre"`) into a `.s3d` lattice model (4 tapered legs, panels, X-bracing, crossarms, wind/cable+ice loads). Reusable in Node + browser; tested in `asistente/test_torre.mjs` / `asistente/test_generador.mjs`. `asistente/cargas.js` holds the normative load magnitudes (NCh) it uses.
- *(Removed in R-20: the LLM path — `worker/asistente.js`, n8n flow, and `js/model/model_ops.js`. The generator is invoked by ReWind directly with a ficha, not via an LLM.)*

## Engineering conventions (read before touching the solver)

- **Coordinates:** Z-up, matching SAP2000/ETABS. Three.js mapping is `model(x,y,z) → three(x, z, y)`.
- **Element DOF order (12):** `[ux1,uy1,uz1,rx1,ry1,rz1, ux2,uy2,uz2,rx2,ry2,rz2]`. Element `releases` is a 12-array of 0/1 (1 = released hinge at that DOF).
- **Distributed load `dir`:** `'gravity'` and legacy `'globalZ'` both mean global −Z (`w>0` = downward), with axial projection for inclined/vertical members; also `globalX/Y`, `localY/Z/X`. Trapezoidal loads carry an optional `w2` (intensity at the j-end).
- **Section stiffness modifiers** live on `sec.mod = {A, Iy, Iz, J}` (cracked-section factors). To modify a subset of elements, clone the section so you don't affect others sharing it.
- Validate any solver/generator change against an analytical case (the `test_*.mjs` pattern), not just that it runs.

## Browser verification workflow

Use the preview tools to verify UI/solver changes (serve on 8765). **The PWA service worker dead-locks the CDP-based preview**, so the SW registration is guarded by `!navigator.webdriver` — under automation it won't register. To exercise solver/model code from `preview_eval`, dynamically `import('./js/...?v=NNN')`.

**Cache gotcha:** `import('./...?v=NNN')` returns the *already-loaded* module from the page realm. After editing a `.js` file you must **reload the page** before re-importing, or you'll be testing the old code.

## Git & editing conventions

- **Remotes:** `origin` → `jpreyes/wind-shm` (push SHM work here), `upstream` → `jpreyes/structweb3d` (`git fetch upstream` / merge to pull PÓRTICO improvements).
- **Workflow:** commit directly to `main` and push. Commit messages in Spanish; this project ends them with a `Co-Authored-By: Claude` trailer.
- **Never `git add -A`.** Several large directories are intentionally untracked / git-ignored: `excel/` (instructor source spreadsheets), `referencias/` (verification PDFs/manuals), `node_modules/`, and `examples/portico_simple_v3.s3d`. Stage explicit paths instead.
- **Do not use PowerShell `Get-Content`/`Set-Content` for bulk text edits** — PS 5.1 corrupts UTF-8 accents (the codebase is full of `áéíóñ`). Use `sed` via the Bash tool, or the Edit tool.
- The Bash tool's working directory resets to the repo root (`C:\Respaldos\wind-shm`) between calls; prefer absolute paths, and `cd /c/Respaldos/wind-shm` at the start of compound commands if needed.

## Roadmap

`docs/ROADMAP.md` is the live ReWind plan, all items `R-*` (Hechos / Pendientes / SHM analytics gaps): R-6 i18n, R-7 native SHM menu, R-8/R-16 drop PÓRTICO branding/landing, R-10/R-11 industrial `DataSource`+API / Electron+InfluxDB, R-18 full construction window, R-19 shadow analysis, R-21+ SHM analytics (OMA from measured signal, fatigue/DEL, alarms). The inherited PÓRTICO/FEM history is **not** here — it lives in the upstream `structweb3d` repo. Update the roadmap when closing items.
