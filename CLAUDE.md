# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## wind-shm: what this fork is

This repo (`jpreyes/wind-shm`) is a **fork of structweb3d/PÓRTICO** being repurposed into a **Structural Health Monitoring (SHM) tool for wind turbines**. `origin` → `wind-shm`, `upstream` → `structweb3d` (pull PÓRTICO improvements from upstream; ship SHM work to origin). The shared base below still applies verbatim — same vanilla-JS + Three.js engine, no build step, Spanish UI/commits.

**The pivot, in one line:** stop *building* models; start *monitoring a fleet*. Plan:
- **Keep & reuse** (already in the codebase, useful as the physics-based **digital twin**): static, dynamic/time-history (feed measured accelerograms), modal (`subspace.js` is the OMA-ready eigen core), nonlinear P-Delta (`geometric.js`) and nonlinear compression (`nl_lite.js`). The new commit `#86` added a **pluggable MACROMODELOS registry** — that is the intended hook for the wind-turbine model.
- **Add:** a `Turbine` macro-model (mast + nacelle + spinning blades + wind); a multi-turbine field (`InstancedMesh` + LOD + frustum culling → ~100 turbines at 60fps); cinematic select-and-zoom (others dimmed); a **liveness layer** (sensors + gateways as one `THREE.Points`/instanced layer, blink = heartbeat via shader time-uniform + per-instance phase, color = active/stale/offline — must show for **all on-screen turbines**, not just the selected one); an SHM dashboard in the right panel (Señal · Datos · Estado estructural · Movimiento · Avanzado); ML across the fleet (population-based SHM); a hybrid **`DataSource`** abstraction (`SimulatedSource` ↔ `LiveSource`, same schema) with the real path being gateway → Cloudflare Worker + Durable Object → WebSocket → browser.
- **Remove later** (Juan Patricio will specify which): modeling toolbar (node/element/area/mesh/support creation), response spectrum, rigid diaphragms, load combinations, CSV geometry editing.

Each turbine carries **2 MEMS accelerometers** (top + mid mast) + a gateway → the 2-node config is intentional (enough for the first 2 bending modes + an ML feature vector).

## What this is (shared base from structweb3d)

**PÓRTICO** — a browser-based 3D structural analysis (FEM) + teaching app for the Instituto de Obras Civiles, Universidad Austral de Chile (Dr. Juan Patricio Reyes). Vanilla JS ES modules + Three.js + a small `numeric.js`. **No build step, no bundler, no framework, no `package.json`** — `index.html` loads `js/app.js` directly via an importmap. UI text, code comments, and git commit messages are in **Spanish**; match that.

The app must run from a static server with no install. It is also a PWA (installable/offline) and is deployed as a Cloudflare Worker that serves the static assets *and* an LLM-backed assistant API.

## Commands

- **Run locally:** `python serve.py [port]` (default 8765) — a no-cache static server that sets correct UTF-8 / `.webmanifest` MIME types. `python -m http.server 8765` also works but lacks those headers.
- **Syntax-check an ES module:** `node --input-type=module --check < js/path/file.js`. **Do NOT use plain `node --check file.js`** — it treats `.js` as CommonJS and silently passes invalid ESM (e.g. bad `import`s).
- **Run a verification test:** tests are standalone Node scripts, e.g. `node test_plate.mjs`, `node test_shell.mjs`, `node test_buckling.mjs` (subespacio vs Euler), `node test_formfind.mjs` (FDM acotado), `node asistente/test_generador.mjs`. They import solver/generator modules directly and assert against **analytical solutions / global equilibrium** (ΣReactions = ΣLoads). There is no test runner — each file is its own entry point. (Los `test_*.mjs` de la raíz no están versionados en git, sólo los de `asistente/`.)
- **Deploy (Cloudflare):** `npx wrangler deploy` (config in `wrangler.jsonc`, entry `worker/asistente.js`). Production auto-deploys from GitHub `main`. Worker secrets (`OPENAI_API_KEY` / `OPENROUTER_API_KEY`, etc.) are set in the Cloudflare dashboard, never in code.

## Versioned imports — the cache-busting convention (important)

Every internal import and worker URL carries a query string, e.g. `import { Model } from './model/model.js?v=199'`. This is a **global app version** used to bust browser/SW caches. When you ship a change to shipped JS/CSS, **bump it across all files at once** (current version: **v199**):

```bash
files=$(grep -rl "v=199" --include=*.js --include=*.html js index.html sw.js)
for f in $files; do sed -i 's/v=199/v=200/g' "$f"; done   # ~20 files
```

Gotchas:
- The bare integer `cx="104"` in `index.html` (an SVG coordinate) is **not** a version — `sed 's/v=106/.../'` only matches `v=NNN`, so it's safe; never blanket-replace the raw number.
- `js/solver/modal_worker.js` and other worker scripts are loaded by URL with `?v=` from `app.js` — they must be bumped too.
- `sw.js` also has its own `CACHE_VERSION` constant (network-first SW); bump it on release per the comment in that file.

## Architecture

**`js/app.js`** is the central `App` orchestrator (very large). It owns `this.model`, wires the UI, and drives every analysis. UI is split into three pieces it coordinates:
- **`js/model/model.js`** — the in-memory `Model`: `Map`s of nodes, elements, areas, materials, sections, diaphragms, loadCases, combinations. Plain data; `Serializer` round-trips it to the `.s3d` JSON format (and CSV).
- **`js/ui/viewport.js`** — Three.js scene, picking, modes (select/node/elem/area/support/pan), result rendering (deformed shape, force diagrams, mode shapes).
- **`js/ui/properties.js`** — right-hand panel: super-tabs (Modelo / Asistente / Resultados / Diseño) and their sub-tabs; `js/ui/menu.js` is the top menu + left toolbar.

**Solver pipeline** (`js/solver/`):
- `assembler.js` assembles global `K` (and mass `M`); `timoshenko.js` holds the element stiffness/mass, local-axis transforms, end-release condensation, and `fixedEndForces` for distributed loads.
- `static_solver.js` (`StaticSolver.solve` → returns a `Results`), `modal_solver.js`, `spectrum_solver.js`. Heavy solves run in **Web Workers** (`static_worker.js`, `modal_worker.js`, `buckling_worker.js`) to keep the UI responsive; `app.js` also calls `StaticSolver` directly in some paths.
- `postprocess.js` — `Results` class: nodal disps/reactions, element end forces, and `getDiagramData`/`getElemAtXi` for N/V/M(x) along members. **This is the source of truth for internal-force diagrams; never infer loads from end shears.**
- **Autovalores por iteración de subespacio (Bathe):** `subspace.js` es el **núcleo compartido** (`smallGenEig` q×q + helpers de banda). El **modal** lo usa vía `modal_worker.js`; el **pandeo** vía `buckling.js` (`solveBuckling`, resuelve `(K+λKg)φ=0` reduciendo con Cholesky sobre `Kᵣ` SPD porque `−Kg` es indefinida) + `buckling_worker.js`. Verificado equivalente a Euler (`test_buckling.mjs`).
- Specialized physics: `membrane.js` + `plate.js` (CST/QUAD membrane, MITC4 + DKT plate bending, shell = membrane+plate), `geometric.js` (Kg / P-Delta / buckling; `assembleKg` devuelve `{Kg, Nmax, Nby}` con el axial por elemento), `nl_lite.js` (nonlinear/cables, plastic hinges, displacement control), `formfind.js` (FDM, acepta `axes` para acotar a la vertical), `diaphragm.js` (rigid diaphragm constraints + floor CR), `sparse.js`/`linsolve.js` (banded Cholesky). Docs por funcionalidad en `docs/` (`form-finding.md`, `pushover.md`).

**Assistant subsystem** (LLM-backed, deterministic execution):
- `worker/asistente.js` (Cloudflare Worker) exposes `POST /api/asistente` (NL description → *ficha* JSON via OpenAI/OpenRouter cascade → model) and `POST /api/asistente/modificar` (NL order → structured **operations**). The LLM only produces structured data; **the model is always built/mutated client-side by deterministic code**, which is what makes the LLM path safe.
- `asistente/generador.js` — pure ES module that turns a *ficha* into a `.s3d` model (geometry, sections, NCh loads, combos). Reusable in Node + browser + Worker; tested in `asistente/test_generador.mjs`.
- `js/model/model_ops.js` — `aplicarOperaciones(model, ops, ctx)` executes assistant operations on the existing model (`add_load`, `add_story`, `add_bay`, `set_modifiers`, `set_mass`); `app.js` `aplicarOperacionesModelo` applies and refreshes.

## Engineering conventions (read before touching the solver)

- **Coordinates:** Z-up, matching SAP2000/ETABS. Three.js mapping is `model(x,y,z) → three(x, z, y)`.
- **Element DOF order (12):** `[ux1,uy1,uz1,rx1,ry1,rz1, ux2,uy2,uz2,rx2,ry2,rz2]`. Element `releases` is a 12-array of 0/1 (1 = released hinge at that DOF).
- **Distributed load `dir`:** `'gravity'` and legacy `'globalZ'` both mean global −Z (`w>0` = downward), with axial projection for inclined/vertical members; also `globalX/Y`, `localY/Z/X`. Trapezoidal loads carry an optional `w2` (intensity at the j-end).
- **Section stiffness modifiers** live on `sec.mod = {A, Iy, Iz, J}` (cracked-section factors). To modify a subset of elements, clone the section (see `model_ops.js`) so you don't affect others sharing it.
- Validate any solver change against an analytical case (the `test_*.mjs` pattern), not just that it runs.

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

`docs/ROADMAP.md` is the live, group-based (G1–G11) plan of improvements detected in real use, mapped to user requests with ✅/🟡/⬜ status. Update it when closing items.
