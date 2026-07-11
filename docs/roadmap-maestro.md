# ReWind — Roadmap Maestro (2026 H2)

> **Plan activo y ordenado por prioridad de JP.** Integra: (a) las prioridades de JP,
> (b) los hallazgos válidos de las **auditorías externas** (Integral / Técnica, jul-2026),
> y (c) los frentes propios (`ROADMAP.md` R-*, `frente-4-backend`, `frente-6-ciclo-vida`).
> Supersede el *orden* de esos docs; el detalle fino sigue en ellos. Ver estado en
> [`ESTADO.md`](ESTADO.md).

## Orden pedido por JP (el hilo conductor)
1. **Backend con Auth** (login correo/clave) → cerrar seguridad.
2. **Mejorar la GUI**.
3. **Más estructuras / fases constructivas** (p.ej. caminos como tipo de estructura).
4. **Sensor real**: un "sensor" en Python (repo aparte) que emite datos a un
   endpoint/webhook; la web se conecta y prueba la arquitectura de ingesta real.

## Principios / decisiones
- **Se mantiene el stack sin build** (vanilla JS, `?v=NNN`), *pero* se acepta la crítica
  del audit sobre el monolito y las 79 requests → partir `shm_mode.js` y evaluar un
  **bundler opcional (Vite) más adelante**, NO una migración a framework (reescribir una
  app que funciona no vale la pena). Decisión revisable.
- **Backend = Supabase** ([[backend-supabase]]): Postgres + Auth + Realtime + Storage.
- El **sensor vive en otro repo**; acá se define y congela **el contrato de ingesta**
  para que interoperen sin acoplarse.

---

## FASE 0 — Higiene barata (quick-wins del audit) · ~½ día
*Se puede intercalar / hacer junto con la Fase 1. Alto ROI, cero riesgo.*
- [ ] `lang="en"` → `lang="es"` en `app.html`/`index.html` (5 min, top-ROI del audit).
- [ ] `LICENSE` en el repo (desbloquea adopción).
- [ ] Landing: `meta description` + Open Graph (`og:title/description/image`).
- [ ] `<meta http-equiv="Content-Security-Policy">` básica (GitHub Pages no da headers).
- [ ] **CI mínimo**: GitHub Action que corra `node tools/test_*.mjs` + `asistente/test_*.mjs`
  y `--check` de ESM en cada push (responde al "sin CI/sin tests" del audit; los tests
  YA existen, solo faltaba correrlos en CI).

## FASE 1 — Backend Auth + cierre de seguridad · 3–5 días  *(prioridad #1 de JP)* — **✅ código listo (v313); falta el cierre operativo en Supabase)**
Cierra el gap "sin auth / RLS abierto" y el "sin backend" que el audit marca como crítico.
Modelo elegido con JP: **"provisioning cerrado"** — JP crea los usuarios y reparte las
claves (sin signup público); duración de sesión **configurable por JP** (Supabase Auth →
token expiry). Sesión en localStorage; token firmado con expiración → caduca solo.
- [x] **Supabase Auth**: login por **correo + clave**, logout, sesión persistente con
  refresh proactivo — `js/shm/auth.js` (sin supabase-js, fetch a `/auth/v1/token`).
- [x] Pasar el token de sesión a `backend.js` (Authorization: Bearer del usuario, no la
  anon key sola) → los requests corren como `authenticated`. Headers dinámicos.
- [x] **Gate de login** que bloquea el boot con Supabase real sin sesión; chip de
  usuario (correo·rol) en la barra → cerrar sesión — `js/shm/auth_ui.js`.
- [x] **Roles** `members(role)`: rol `viewer` de la sesión activa el modo solo-lectura
  (además del `?role=viewer` manual, R-38). `rls_close.sql` restaura `read_auth` /
  `write_editor`.
- [ ] **(operativo, lo hace JP en Supabase):** desactivar signup público (Auth → Email
  → *Allow new users to sign up* OFF), crear usuarios + su fila en `members(role)`,
  correr [`backend/supabase/rls_close.sql`](../backend/supabase/rls_close.sql) para
  cerrar el RLS piloto. Fijar la duración de sesión (Access/Refresh token expiry).
- [ ] (opcional) indicador de estado de sync en la barra (usar `lastPushAt()`).
- **Cierre:** dos usuarios con roles distintos; el viewer no puede escribir; RLS cerrado.

## FASE 2 — GUI / UX · 1–2 semanas  *(prioridad #2 de JP; = Frente 6 UX + audit a11y)*
- [x] **Selector de FASE** (v315): barra Proyecto·Obra·Operación que **filtra** las
  pestañas (Parque y Selección universales); navega a la vista principal de la fase
  y persiste la elección. Reduce la saturación 6→3-4 (Frente 6.1). *(Admin queda para
  cuando exista su módulo, Fase 5.)*
- [x] **WBS drill-down** (v314): click en partida (p.ej. «Fundación») → su vista
  (protocolos · estructura · estado · ciclo · última fecha · ensayos) + «‹ Volver».
  Fila clickeable con teclado (role=button). *(Frente 6.2 — era la queja «no hace nada».)*
- [x] **Accesibilidad (audit)** (v316): skip-link «Saltar al contenido», `<h1>` accesible
  persistente, `role="main"` (un solo landmark), pestañas `role=tab`/`tablist` +
  `aria-selected`, título de panel `<h2>`. *(Pendiente menor: `label`/`aria-label` en el
  resto de inputs dinámicos — se completa junto con el split.)*
- [~] **Partir `shm_mode.js`** (god module): **iniciado** (v317) — extraídos `dsp.js`
  (FFT) y `viewport_chrome.js` (5 overlays del visor); 2903→2768 líneas. **Falta el
  grueso:** `buildDashboard` (~1880 líneas, acoplado a boot vía closures) → refactor
  mayor, hacer aparte e incremental (toolbar/statusbar/tower-card/reportes/render-panel).
- [ ] Terminar la visibilidad de datos del backend (pull ampliado: WBS/perfiles/estructuras
  se recuperan en otro navegador) — Fase 6.0 restante.

## FASE 3 — Estructuras y fases constructivas · **✅ COMPLETA** (v318–v320)  *(prioridad #3 de JP)*
- [x] **Gestión de tipos** editable (v320): el editor de WBS (Calidad) ofrece los 5
  tipos (torre·AT·camino·zanja·plataforma); las partidas de cada uno son editables
  (`WBS_TYPES`/`WBS_TYPE_LABEL`). Frente 6.3 en su forma concreta (WBS por tipo).
- [x] **Nuevo tipo «camino»** (estructura **lineal**) (v318): cinta 3D que sigue el
  terreno (reusa la geometría real del KMZ, `CAMAN_ROADS`) + su **WBS** de capas
  (despeje · mov. tierras · sub-base · base · carpeta) + avance 4D que "construye" el
  camino **por tramos a lo largo de la longitud** (drawRange), no bottom-up. Seleccionable;
  migración no destructiva al parque Camán. `fleet_view.addRoad`/`_setRoadProgress4D`.
- [x] **Zanja (colectora)** y **plataforma** (v319): mismo motor lineal, distinto
  ancho/color/WBS (`LINEAR_TYPES`). Zanja de MT por el trazado vial; plataforma = pad
  corto y ancho subdividido para 4D gradual. *(Subestación como tipo propio y LAT
  dedicada: la LAT ya existe como torres AT + `overheadLine`; la subestación queda
  para cuando se necesite como recinto — no bloquea.)*
- [x] **RDS-PP** (identificador transversal, IEC 81346) (v320): designación por
  estructura (=WTG.NN · =LAT.NN · =CAM.NN · =ZAN.NN · =PLT.Tnn), mostrada en la ficha
  de Selección. Unifica Obra ↔ Operación ↔ Administración (Frente 6.5/6.7).
- **Cierre:** ✅ Camán poblado con camino + zanja + 3 plataformas avanzando en el 4D
  lineal; los 5 tipos con WBS editable y RDS-PP.

## FASE 4 — Sensor real y arquitectura de ingesta · 1–2 semanas  *(prioridad #4 de JP)*
El sensor está en **otro repo**; acá se cierra el loop de datos reales sin hardware final.
- [x] **Contrato de ingesta CONGELADO** → [`frente-4-contrato-ingesta.md`](planes/frente-4-contrato-ingesta.md).
  Transporte = **Supabase directo** (REST `features` + Storage `waves`), sin MQTT/Influx.
  **Red: solo salida (outbound)** → sin `cloudflared`, sin IP pública; el on-demand se
  resuelve por *command-polling* (`sensor_commands`), no por webhooks entrantes.
- [x] **Esquema**: `features`/`waves` (ya en `schema.sql`) + `sensor_commands` + bucket
  `waves` → `backend/supabase/ingest.sql`.
- [x] **Sensor Python (carpeta `sensor/`, para el repo aparte)**: ring buffer **150 Hz**
  + ventana de **5 min** por 3 disparadores (programado c/60min · anomalía RMS · on-demand
  pull). features → `features`; serie cruda `.npz` → Storage `waves/` + puntero. Probado
  contra mock (esquema OK). Corre 24/7 en el VPS (systemd) — el VPS es solo host, no endpoint.
- [ ] **La web ya consume `features`** (modo `backend:supabase`, polling 5 s). Falta: botón
  «pedir captura» que inserte en `sensor_commands`, y leer/mostrar las ventanas `waves`.
- [ ] **Realtime nativo** de Supabase (suscripción a INSERT de `features`) reemplazando el
  polling; **reconexión** en el cliente; **retención/limpieza** (cron 90 días).
- **Cierre:** corro el sensor Python en el VPS → una torre se actualiza en la web en vivo,
  end-to-end. *(Falta conectarlo al Supabase real de JP + los dos pendientes de front.)*

## FASE 5 — Operación & Administración (largo plazo) · según piloto
*Frente 6.4/6.5 + Fase 4/5 del ROADMAP original. Requiere Fases 1–4.*
- [ ] Módulo **Operación**: SHM (ya) + **disponibilidad** (IEC 61400-26) + **inspección en
  operación** (IEC 61400-28, reubicar el CMMS R-32) + mantenimiento RCM/CBM.
- [ ] Módulo **Administración / Activos** (ISO 55000): registro de activos con RDS-PP,
  KPIs de flota, costos O&M, **vida remanente** (DNV-ST-0262).
- [ ] Cierre técnico diferido: **OMA `R-21`** (módulo ultramétrico de JP, con datos reales),
  **gemelo de cargas `R-30`**, **RUL por componente `R-25`**.

---

## Deuda de la auditoría — mapeo (nada se pierde)
| Hallazgo del audit | Veredicto | Dónde se atiende |
|---|---|---|
| `lang="en"` con UI en español | Válido, trivial | Fase 0 |
| Sin `h1-h6` / inputs sin label / skip-link | Válido | Fase 2 (a11y) |
| Sin meta description / OG / LICENSE / CSP | Válido | Fase 0 |
| Sin auth / sin backend / datos simulados | Válido → **en curso** | Fases 1 y 4 (Supabase) |
| `shm_mode.js` monolítico | Válido | Fase 2 |
| Sin CI (aunque los tests existen) | Parcial | Fase 0 |
| «Sin Service Worker / no instalable» | **Falso** (guardado por `!navigator.webdriver`; la Integral lo elogia) | Sin acción; documentar |
| «Ninguna prueba» | **Falso** (`tools/test_*.mjs`, `asistente/test_*.mjs`) | Ampliar cobertura en Fase 0/2 |
| Migrar a React/Vue/TS + Vite | Discutible | Solo evaluar bundler opcional; **no** framework |
| 49 MB heap / posible fuga | A verificar | Perfilar en Fase 2 |

## Diferido a propósito
Migración a framework (no); SSR/SEO avanzado (B2B, baja prioridad); hardware final
(ESP32/Pi — el sensor Python de prueba lo sustituye para validar arquitectura); path
self-hosted MQTT/Influx (`bridge/`, queda si el volumen lo exige).
