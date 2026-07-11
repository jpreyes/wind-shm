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

## FASE 1 — Backend Auth + cierre de seguridad · 3–5 días  *(prioridad #1 de JP)*
Cierra el gap "sin auth / RLS abierto" y el "sin backend" que el audit marca como crítico.
- [ ] **Supabase Auth**: login por **correo + clave** (y magic-link opcional), signup,
  logout, sesión persistente. UI de login en `js/shm/` (no manejar claves en claro
  fuera de Supabase Auth).
- [ ] Pasar el token de sesión al cliente `backend.js` (Authorization: Bearer del usuario,
  no la anon key sola) → los requests corren como `authenticated`.
- [ ] **Roles** `members(role)` viewer/editor/admin; **revertir `rls_pilot.sql`** a las
  políticas `to authenticated` de `schema.sql` (escritura solo editor/admin).
- [ ] Conectar los roles reales con el gating de UI que ya existe (`?role=viewer`, R-38).
- [ ] Indicador de usuario/rol/estado de sync en la barra.
- **Cierre:** dos usuarios con roles distintos; el viewer no puede escribir; RLS cerrado.

## FASE 2 — GUI / UX · 1–2 semanas  *(prioridad #2 de JP; = Frente 6 UX + audit a11y)*
- [ ] **Selector de FASE** arriba (Proyecto·Obra·Operación·Administración) que **filtra**
  el panel → menos saturación (Frente 6.1). Rename **Calidad → Obra**.
- [ ] **WBS drill-down**: click en partida (p.ej. «Fundación») → su vista
  (protocolos/avance/fechas/fotos/ensayos) + «‹ Volver» (Frente 6.2). *(Hoy no hace nada.)*
- [ ] **Accesibilidad (audit)**: encabezados `h1–h6` semánticos, `label` en los ~50 inputs,
  skip-link. Sube varias notas del informe.
- [ ] **Partir `shm_mode.js`** (god module 2.633 líneas) en módulos por responsabilidad
  (toolbar, statusbar, tower-card, reportes…) — deuda del audit + habilita lo demás.
- [ ] Terminar la visibilidad de datos del backend (pull ampliado: WBS/perfiles/estructuras
  se recuperan en otro navegador) — Fase 6.0 restante.

## FASE 3 — Estructuras y fases constructivas · 1–2 semanas  *(prioridad #3 de JP)*
- [ ] **Gestión de tipos de estructura** editable (hoy solo turbine/hv) — Frente 6.3.
- [ ] **Nuevo tipo «camino»** (estructura **lineal**): geometría 3D por tramos + su **WBS**
  (despeje · movimiento de tierras · sub-base · base · carpeta/sello) + avance 4D que
  "construye" el camino por tramos (no bottom-up como una torre).
- [ ] Otros tipos: **plataformas**, **zanjas/cableado (colectora)**, **subestación**, **LAT**.
  Cada uno con su WBS y su geom.
- [ ] **RDS-PP** (identificador transversal, IEC 81346): campo de designación por
  estructura/partida/componente → unifica Obra ↔ Operación ↔ Administración (Frente 6.5/6.7).
- **Cierre:** poblar Camán con caminos + plataformas y verlos avanzar en el 4D.

## FASE 4 — Sensor real y arquitectura de ingesta · 1–2 semanas  *(prioridad #4 de JP)*
El sensor está en **otro repo**; acá se cierra el loop de datos reales sin hardware final.
- [ ] **Contrato de ingesta (congelar):**
  - Trama de aceleración → ya definida en `bridge/accel_frame.mjs` (binaria) para el path
    hardware; para el "sensor Python de prueba" basta **JSON** con el esquema de `features`.
  - **Endpoint**: `POST` a una **Supabase Edge Function** `/ingest` (o REST directo a la
    tabla `features` con una key de servicio) que valida y escribe una fila 1/min por
    estructura: `{structure_id, ts, f1, f2, rms, wind, temp, tilt, cls}`.
- [ ] **Sensor Python (repo aparte)**: script que genera/lee una señal y hace `POST` al
  endpoint cada N segundos. Documentar el contrato para que el repo del sensor lo consuma.
- [ ] **La web ya consume `features`** (modo `backend:supabase`) → el dato del sensor
  aparece en el dashboard. Primero por **polling** (ya está), luego:
- [ ] **Realtime nativo** de Supabase (suscripción a INSERT de `features`) reemplazando el
  polling; **reconexión** en el cliente; **retención/limpieza** de `features` (cron).
- **Cierre:** corro el sensor Python → una torre se actualiza en la web en vivo, end-to-end.

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
