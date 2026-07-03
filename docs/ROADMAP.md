# ReWind — Roadmap unificado

**ReWind (`wind-shm`)** es una herramienta de **SHM (Structural Health
Monitoring) de parques eólicos**: flota viva 3D georreferenciada, capa de
sensores, avance de obra 4D, dashboard e informe de estado estructural por torre.

Estado: ⬜ pendiente · 🟡 en curso · ✅ hecho. Los ítems se numeran `R-*`.
Este roadmap **unifica** los ítems históricos, las brechas de la auditoría interna
(2026-07-02) y las oportunidades de alto valor, ordenados en **fases ejecutables**.

> **▶ Fase actual: Fase 3 — Backend de datos reales** (`R-10`, [plan Frente 4](planes/frente-4-backend-r10.md)).
> Las fases 1–2 (endurecimiento + analítica local) pueden intercalarse: son
> independientes del backend y de medio día a 2 días cada ítem.
> **▶ Nuevo frente pedido por el proyecto:** `R-41` **módulo «Calidad de obra»** —
> ingesta del «Log protocolos SACYR.xlsx» (el formato de facto de Camán) y export
> con **round-trip a nivel de INFORMACIÓN** (mismas hojas/cabeceras/valores de
> celda; sin fórmulas/gráficos/estilos) — [plan Frente 5](planes/frente-5-calidad-obra.md).

> **Base FEM heredada (gemelo digital).** ReWind nació como fork de
> **PÓRTICO** (`structweb3d`), una app de análisis estructural FEM 3D. Tras la
> limpieza **`R-20`** el repo es **solo ReWind**: del motor FEM se conservan solo
> los 10 solvers que el **gemelo digital** necesita (modal/estático → f₁/f₂ y
> deformadas). El historial de aquellas capacidades vive en el repo
> **upstream `jpreyes/structweb3d`**, no aquí.

---

## Roadmap por fases

### Fase 1 — Endurecimiento y pulido (sin dependencias; ~1 semana en total)
*Cierra los fallos de la auditoría y el roce de UX. Todo client-side, ítems de horas.*

| ID | Qué | Esfuerzo | Criterio de cierre |
|---|---|---|---|
| ✅ `R-40a` | **Escapar HTML** en todos los sinks de texto libre — **HECHO**: util compartido `js/shm/util.js` (`esc` cubre `& < > " '` + `safeUrl` para `url()`/`src`); aplicado a `renderInsp` (inspector/resumen/ubicación/hallazgos/ensayos/docs/OT + fotos), al HUD de inspección (`avance_hud.js`: hallazgos + labels de componente/sensor), a los labels de estructura (lista/vencimientos/detalle/ficha), a la instrumentación y a los **nombres de receptores importados** (`map_view` popup/tooltip). `buildReport` ahora usa el mismo `esc`. Verificado en preview: inyección vía inspección/`.json` importado (inspector, damage_type, severity, test_type, OT, foto `javascript:`) → 0 ejecuciones, 0 elementos inyectados. | ½ día | ✅ Payloads renderizados como texto; comillas no rompen atributos. |
| ✅ `R-40b` | **Re-seed fantasma**: borrar la última inspección no debe sembrar una demo (flag `seeded` por estructura + empty-state con «＋ Nueva inspección»). | horas | Se puede tener una torre con 0 inspecciones. |
| ✅ `R-40c` | **Cuota de localStorage**: detectar `QuotaExceededError` en `saveAll` → aviso al usuario (exportar respaldo / liberar fotos). *(El fix definitivo llega con `R-10`: fotos a BD/disco.)* | horas | Guardado fallido ya no es silencioso. |
| ✅ `R-40d` | **Perf del rollup**: `Insp.getAll()` con un solo `JSON.parse` por rollup (hoy: parse del store completo × 43 estructuras). | horas | Pestaña Parque sin jank con fotos cargadas. |
| ✅ `R-40e` | **Coherencia física**: torres con `built < 0.97` no muestran fatiga «consumida» ni sensores «operando» (mensaje «torre en montaje — sin datos operacionales»; worker emite `standby`). | ½ día | Una torre en fundación no reporta vida consumida ni RMS. |
| ✅ `R-40f` | Menores: fuga de listener en «Acerca de» (remover en `close()`), aviso de popup bloqueado en todos los informes (helper común con fallback a descarga, copiar `_openReport`), orientación EXIF en `imageToThumb` (`createImageBitmap(file,{imageOrientation:'from-image'})`), `theme-color`/manifest claros (media query + JS en el toggle), `.gitignore` de `data/` con excepción `!data/*.json`, restaurar vista/selección tras cambiar idioma (`sessionStorage`). | 1 día | Checklist completo. |
| ✅ `R-36a` | **Formularios inline** para Ensayo/Documento/OT (reemplazar `prompt()` encadenados; replicar el patrón `.instr-add` ya estilado). | ½ día | Cero `prompt()` en el CMMS. |
| ✅ `R-36b` | **Confirmación al borrar con Supr** en modo edición (hoy borra directo) — o mejor, junto con `R-36c`. | horas | No se pierde una torre por un despiste. |
| ✅ `R-36c` | **Undo básico en edición**: pila de snapshots del store de parques (máx. 10) + Ctrl+Z. | ½ día | Mover/borrar/crear es reversible. |
| ✅ `R-36d` | **Tour de bienvenida** (vanilla, 4 pasos anclados: torre clicable → pestañas → modos del toolbar → informes; flag `rewind_tour_done`). | ½ día | Primer uso guiado. |
| ✅ `R-36e` | Accesibilidad: `aria-label` en botones icon-only (el motor de tooltips borra `title`), `aria-pressed` en toggles del toolbar, `role="dialog"`+focus-trap en modales, icono de tema 🌙⇄☀️ según estado. | ½–1 día | Navegable por teclado/SR en lo esencial. |
| ✅ `R-36f` | **Edición de sensores** de instrumentación (hoy solo agregar/quitar; `updateSensor` ya existe) + verificación de cajones/HUD **en móvil real**. | ½ día | Mover un sensor sin recrearlo. |

### Fase 2 — Analítica coherente (client-side; prepara y aprovecha el backend)
*El salto de «maqueta» a «monitoreo»: memoria, coherencia y comparación. Sin backend.*

| ID | Qué | Esfuerzo | Depende | Criterio de cierre |
|---|---|---|---|---|
| ✅ `R-34` 🌟 | **Histórico persistente de series** (`js/shm/history.js`, IndexedDB nativo) — **HECHO**: decimación 1 pto/min por estructura, retención rodante 60 días + purga en boot; se graba en el tick (f₁/RMS/viento/tilt). Nueva subpestaña **«Tendencia»** en SHM: f₁ vs tiempo + banda de la línea base del gemelo (±3 %), KPIs (actual/base/desviación/nº muestras). Verificado en preview: 0 diffs — el histórico **sobrevive al reload** (214 muestras + serie de prueba intacta; chart renderiza tras recargar). | 1–2 días | — | ✅ La deriva de f₁ sobrevive al reload; tendencia de días visible. |
| ✅ `R-35` 🌟 | **Índice de salud unificado (Health Index)**: fusión de las 4 fuentes (clasificador ML, score de inspección, vida de fatiga, defecto del gemelo R-31) → un HI 0–100 por torre con desglose de contribuciones. Sustituye el color del punto en lista/mapa y el gauge del informe. *Resuelve la contradicción actual: R-31 marca base defectuosa y el Estado dice «sin daño».* | 1 día | — | Módulo puro testeable en Node; tooltip con desglose. |
| ✅ `R-26` | **Benchmarking de flota**: z-score robusto (mediana/MAD) de f₁ y RMS por ventana de 5 min → card «Anomalías de flota» en la pestaña Parque (\|z\|>2.5). | ½ día | mejor con `R-34` | La torre anómala se destaca sin modelo previo. |
| ⬜ `R-37` 🌟 | **Replay / time-scrubber**: `ReplaySource` con la MISMA interfaz de `DataSource` leyendo el histórico y emitiendo ticks acelerados (En vivo ⇄ fecha/hora + velocidad en la barra de estado). *Demo killer y validación de la arquitectura para `R-10`.* | 1–2 días | `R-34` | «Reproducir ayer a 60×» funciona sin que el dashboard note la diferencia. |
| ✅ `R-23a` | **Alarmas configurables v1** (client-side): umbrales por métrica (RMS, Δf₁ %, viento, tilt) en localStorage + editor en la subpestaña Estado + registro de eventos + `Notification` API si la PWA está instalada. *(La notificación email/SMS y las reglas server-side son `R-23b`, Fase 3.)* | 1 día | mejor con `R-34` | Umbral editado dispara aviso/crítico y queda registrado. |
| ✅ `R-38` | **Roles viewer/editor v1**: `?role=viewer` (o toggle) oculta Editar/Crear/Borrar y pone el CMMS readonly. *(Auth real con `R-10`.)* | horas | — | Un enlace «solo lectura» compartible. |
| ✅ `R-39` | **Comparador de torres** lado a lado: elegir 2 → tabla de f₁ vs gemelo, RMS, HI, fatiga, score de inspección, avance. | 1 día | `R-35` | Comparación en 2 clics. |
| ✅ `R-33b` | **Marcador 3D** de los sensores de instrumentación (esfera «capa de vida» a `yFrac·H`, color por tipo; evento `instr-changed` para sincronizar). | ½ día | — | El sensor agregado se ve clavado en la torre. |
| ✅ `R-13x` | **Rosa de vientos viva** en la pestaña Parque (la rosa de `meteo_caman` + sector del viento actual resaltado). | horas | — | Golosina de demo. |
| ✅ `R-41` 🌟 | **Módulo «Calidad de obra»** (v1, fases 5.1–5.6 del [plan Frente 5](planes/frente-5-calidad-obra.md)) — **HECHO**: reader del «Log protocolos SACYR.xlsx» → JSON canónico; **writer de VALORES** + **diff de información** (round-trip 0 diffs / 72.338 celdas); **derivados en JS** (validados contra las fórmulas O/P del archivo 1364/1364); pestaña **«Calidad»** (dashboard + heatmap por estructura); **crear/editar sin Excel** + export desde el modelo; integración con Obra (avance real opt-in 4D + calidad por torre en la barra de estado). *(v2 con backend = sub-fase 3.5b.)* | ~1½ semanas | — | ✅ Round-trip sin pérdida; O/P reproducidas 1364/1364. |
| ⬜ `R-41b` 🌟 | **Calidad contratista-agnóstica** ([plan Frente 5B](planes/frente-5b-calidad-agnostica.md)): el modelo canónico ES el estándar **ISO 9001 / 19650 / 21500-21502 + ensayos ASTM/EN/NCh**; se generaliza la **importación** a **perfiles** (`readByProfile(wb, profile)`, SACYR = perfil built-in) + **asistente de mapeo** (columnas/estados/ciclos con heurística de sinónimos) + catálogo normativo + plantilla estándar ReWind. El motor posterior (writer/derivados/dashboard/4D) ya es agnóstico. | ~1 semana | `R-41` | Importar un Excel *distinto* de prueba pobla el dashboard sin tocar código. |

### Fase 3 — Backend de datos reales (`R-10` · Frente 4) 🏗️ **← FASE ACTUAL**
*Plan detallado: [frente-4-backend-r10.md](planes/frente-4-backend-r10.md). Hardware:
ADXL355 + inclinómetro, gateway Raspberry Pi, 2–3 sensores/gateway, 10 hoy → ~200 piloto.
Conectividad: **Starlink** (CGNAT → servidor on-prem + Cloudflare Tunnel/Tailscale).*

| # | Sub-fase | Esfuerzo | Criterio de cierre |
|---|---|---|---|
| ⬜ 3.1 | Banco local Docker (mosquitto+influx+postgres) + **trama v2** (3 ejes, µg/int32 — la v1 en mili-g tiraría la resolución del ADXL355) + bridge v2 + features 1/min, alimentado por el simulador. | 1–2 días | Influx llenándose desde el sim. |
| ⬜ 3.2 | **WS `/live`** en `rewind-api` emitiendo el MISMO esquema del worker (`{tick, summaries, waves}`) + **reconexión en el cliente** (auditoría A2). | 1–2 días | La app con `?live=wss://` muestra el banco sin tocar el front. |
| ⬜ 3.3 | **Pi de referencia**: `sampler.py` (SPI/DRDY/FIFO del ADXL355, chrony, trama v2, cola store-and-forward, tilt 1 Hz, LWT) + `provision.sh` + Tailscale. | 2–3 días | 2 sensores reales de una torre en el dashboard. |
| ⬜ 3.4 | **Features + archivo de ventanas crudas** (10/30 min → `raw/…` para el OMA de `R-21`) + retención/downsampling en Influx. | 1–2 días | Tendencia de f₁ real de una semana. |
| ⬜ 3.5 | **CMMS a Postgres** (`R-32` persistente): esquema + REST + adaptador en el front (localStorage como caché offline) + fotos a disco. *Cierra A4/A5 de raíz.* | 2–4 días | Inspecciones multiusuario que sobreviven al navegador. |
| ⬜ 3.5b | **Calidad de obra a Postgres** (`R-41` v2, fase 5.6 del Frente 5): tablas `protocolos/ciclos/ensayos_*`, upload de versiones del xlsx (upsert idempotente), export server-side con el writer, historial de versiones. | 3 días | Dos usuarios ven el mismo log; export desde BD idéntico al formato de facto. |
| ⬜ 3.6 | **Alarmas server-side (`R-23b`)** + notificador (SMTP/Telegram) + LWT→«gateway offline». **Tilt real (`R-24`)** entra por el mismo pipeline. | 1–2 días | Alarma real llega al teléfono. |
| ⬜ 3.7 | Endurecer piloto: TLS, túneles (Cloudflare/Tailscale), **backups probados**, doc de operación. **Reportes programados (`R-28`)** vía cron. | 2 días | Restauración de respaldo ensayada una vez. |

*Al cerrar la Fase 3 quedan resueltos:* `R-10`, `R-23`, `R-24`, `R-28`, `R-32` (persistencia),
`R-33` (hardware real) y el stack de `R-11` (Influx/Node decididos).

### Fase 4 — Cierre técnico (lo diferido a propósito)
*Requiere Fase 3 operando y ventanas crudas acumuladas.*

| ID | Qué | Depende | Criterio de cierre |
|---|---|---|---|
| ⬜ `R-21` 🌟 | **OMA con el módulo ultramétrico propio de JP** sobre las ventanas crudas archivadas: f₁/f₂/amortiguamiento medidos + deriva en el tiempo. *(Decisión: NO peak-picking/FFT genérico.)* | 3.4 | f₁ medida real publicada como feature. |
| ⬜ `R-31b` 🌟 | **Cierre del gemelo de construcción**: la curva «medida» deja de ser simulada — f₁ real por etapa del montaje + certificado de commissioning con datos reales. | `R-21` | Certificado de una torre real de Camán. |
| ⬜ `R-25` | **RUL por componente**: fatiga (`R-22`) alimentada con historia real + tendencias de `R-21`. | `R-21`, 3.4 | RUL con banda de incertidumbre por torre. |
| ⬜ `R-30` 🌟 | **Gemelo de cargas / extensión de vida**: expansión modal (base modal viva de `R-21`) → tensión en hotspots sin sensor → rainflow/Miner → «certificado de salud y vida remanente». Validar contra una galga en torre piloto. | `R-21`, `R-25` | Informe de vida remanente defendible. |

### Fase 5 — Mayores (cuando el piloto lo pida)

| ID | Qué | Nota |
|---|---|---|
| ⬜ `R-11b` | **Electron** (app de escritorio para el centro de control) + alineación con estándares eólicos (IEC 61400, OPC-UA/IEC 61850). | El stack de datos ya quedó decidido en Fase 3. |
| ⬜ `R-27` | Curva de potencia y disponibilidad. | Requiere integración SCADA. |
| ⬜ `R-29` | Drivetrain/palas (vibración de caja, monitoreo de palas, dron/IA). | Requiere más sensórica. |
| ⬜ `R-38b` | Auth real multi-usuario (sobre los roles v1 y el backend). | |

---

## Detalle de ítems pendientes (referencia)

- 🟡 **`R-10` Persistencia/`DataSource` industrial + API** — ver [plan Frente 4](planes/frente-4-backend-r10.md) (arquitectura completa: Pi/ADXL355 → Mosquitto → bridge → InfluxDB/Postgres → REST+WS; Starlink/CGNAT → on-prem + túneles). *(Primer trozo v235: `js/shm/meteo_caman.js`.)*
- ⬜ **`R-21` OMA** *(diferido: módulo ultramétrico propio de JP al cierre, con sensores reales)* — extraer f₁/f₂/amortiguamiento **de los acelerómetros** y seguir su deriva; habilita la f₁ medida de `R-31` y la base modal de `R-30`.
- ⬜ **`R-23` Alarmas** — v1 client-side en Fase 2 (`R-23a`), reglas+notificación server-side en Fase 3 (`R-23b`).
- ⬜ **`R-24` Tilt/asentamiento** — el inclinómetro real entra por el pipeline de Fase 3; tendencia de desplome complementa el diagnóstico de fundación.
- ⬜ **`R-25` RUL por componente** — fatiga `R-22` + tendencias `R-21` (Fase 4).
- ⬜ **`R-26` Benchmarking de flota** — z-score/MAD de la población (Fase 2).
- ⬜ **`R-27` Curva de potencia** — requiere SCADA (Fase 5).
- ⬜ **`R-28` Reportes programados** — cron del servidor (Fase 3.7).
- ⬜ **`R-29` Drivetrain/palas** — más sensórica (Fase 5).
- ⬜ **`R-30` 🌟 Gemelo de cargas / extensión de vida** — sensado virtual por expansión modal + rainflow/Miner → RUL de hotspots sin sensor; el caso de negocio es la **extensión de vida** de flotas llegando a sus 20 años. *Límites honestos: 2 acelerómetros → ~2 modos; validar contra galga piloto.* (Fase 4.)
- 🟡 **`R-31` 🌟 Gemelo de construcción** *(núcleo hecho v256–v257)* — `construction_twin.js`: curva f₁ predicha por etapa (validada vs voladizo analítico), ventana soft-stiff 1P/3P, medición simulada con defecto de base, tarjeta en Obra + certificado + crosslink al HUD. **Falta:** f₁ MEDIDA real (`R-21`) + telemetría (`R-10`) + tilt (`R-24`). El white space: nadie monitorea estructuralmente DURANTE el montaje ni formaliza la línea base de commissioning con gemelo. → [plan](planes/frente-3-gemelo-construccion.md).
- 🟡 **`R-33` Instrumentación editable** *(v1 hecho v276)* — sensores de usuario (tipo/etiqueta/altura) en panel + HUD con valor sintético. **Falta:** marcador 3D (`R-33b`, Fase 2), edición de posición de sensores de fábrica, gateway configurable, hardware real (Fase 3).
- ⬜ **`R-41` 🌟 Módulo «Calidad de obra» (round-trip de INFORMACIÓN del Log de protocolos)** — el proyecto Camán se gestiona con un Excel de facto (log de protocolos QA/QC con ciclos de revisión SACYR⇄ITO, matrices de completitud por WTG, ensayos de hormigón/áridos/mortero/geotecnia, hitos de pago, KPIs). ReWind lo ingiere, lo gestiona y **exporta un xlsx con la MISMA información** (mismas hojas/cabeceras/valores de celda; donde el original tiene fórmulas se escriben los valores calculados; gráficos/estilos NO requeridos — «ideal, no necesario»); los agregados derivados (matrices/KPIs) se recalculan en JS y se validan contra los valores del archivo. Encaje: el % de protocolos por WTG es el **avance real** del 4D; los ensayos de hormigón alimentan el CMMS y la narrativa del gemelo (`R-31`). → [plan Frente 5](planes/frente-5-calidad-obra.md) + anexo de construcción columna-a-columna en `auditoria/` (no versionado: estructura interna del proyecto).

---

## ✅ Hechos

- ✅ **`R-1`** Figuras del informe (deformada limpia + ajuste cúbico de voladizo a lo medido) (v208).
- ✅ **`R-2`** Velocímetro de estado en el informe (v208).
- ✅ **`R-3`** Quitar selector de unidades (v208).
- ✅ **`R-4`** Árbol lateral multiparque Parque ▸ Zona ▸ Torre (`parks.js`, localStorage) (v208).
- ✅ **`R-5`** Torres AT seleccionables/movibles/borrables (v208).
- ✅ **`R-6`** i18n ES/EN completa (v262–v273): `i18n.js` + conmutador; marco, 6 paneles, HUD y los 6 informes imprimibles bilingües; catálogos de dominio sin traducir (claves de scoring).
- ✅ **`R-7`** Menú superior nativo (Parque/Datos/Informe + Acerca de) (v261).
- ✅ **`R-8`** Sin marca «PÓRTICO» en lo visible (textos, exports, SW `rewind-*`, claves `rewind_*` con fallback) (v258).
- ✅ **`R-9`** Configuración desactivada hasta rehacerla SHM (v209).
- ✅ **`R-16`** Landing editorial propia; la app en `app.html` (v252).
- ✅ **`R-18`** Avance de obra 4D: partidas por componente, HUD Stark, curva-S/Gantt/DPR (v242–v251). → [plan](planes/frente-1-avance-obra.md).
- ✅ **`R-19`** Shadow flicker completo: worst/real case, mapa iso-sombra, receptores importables, informes (v215–v241). → [plan](planes/frente-2-sombras.md).
- ✅ **`R-20`** Purga PÓRTICO (~24.900 líneas); queda el closure de ReWind + 10 solvers del gemelo (v213).
- ✅ **`R-22`** Fatiga/DEL: rainflow ASTM E1049 + S-N EN 1993-1-9 + Miner → RUL/DEL, verificado en Node; pestaña Fatiga (v260).
- ✅ **`R-32`** Micro-CMMS de inspección: scoring determinista (port de structapp-base), hallazgos con fotos (por inspección y por hallazgo), ensayos NDT, documentos, OT, calendario/vencimientos, rollup de parque, export/import (v252–v254). *(Persistencia real → Fase 3.5.)*
- ✅ **HUD multi-modo + pulido del visor** (v259–v277): HUD con modos Avance/Inspección/Sensores anclado por componente/altura; gateway como callout y en el panel; `R-33` v1 (sensores de usuario); accesos del toolbar con estado activo; relieve aclarado en modo Shadow (`uShadow`); modo claro por defecto (app y landing).
