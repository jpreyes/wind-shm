# ReWind — Roadmap

**ReWind (`wind-shm`)** es una herramienta de **SHM (Structural Health
Monitoring) de parques eólicos**: flota viva 3D georreferenciada, capa de
sensores, avance de obra 4D, dashboard e informe de estado estructural por torre.

Estado: ⬜ pendiente · 🟡 en curso · ✅ hecho. Los ítems se numeran `R-*`.

> **▶ Foco inmediato (en lo que trabajamos ahora):** planes detallados en [`docs/planes/`](planes/).
> 1. ✅ **`R-18` — Etapas constructivas / avance de obra** (HUD tipo Stark + 4D por componente + dashboard de parque con curva-S/Gantt) — **hecho (v250)** — [plan](planes/frente-1-avance-obra.md).
> 2. ✅ **`R-19` — Análisis de sombras** de los aerogeneradores según el sol — **hecho (v241)** — [plan](planes/frente-2-sombras.md).
> 3. 🟡 **`R-31` — Gemelo de construcción** (frecuencia predicha-vs-medida por etapa; el buque insignia, encaja con Camán en construcción) — **núcleo hecho (v256–v257)**; falta f₁ MEDIDA real (OMA `R-21`) + sensores en vivo (`R-10`) — [plan](planes/frente-3-gemelo-construccion.md).
>
> Los tres se apoyan en el modelo 4D que ya estamos modificando.

> **Base FEM heredada (gemelo digital).** ReWind nació como fork de
> **PÓRTICO** (`structweb3d`), una app de análisis estructural FEM 3D. Tras la
> limpieza **`R-20`** el repo es **solo ReWind**: del motor FEM se conservan solo
> los 10 solvers que el **gemelo digital** necesita (modal/estático → f₁/f₂ y
> deformadas). Todo el resto de PÓRTICO (mallador, diseño multinorma, espectro,
> no-lineal, puentes, UI de modelado, asistente LLM, import/export multi-motor,
> IFC…) **se eliminó del código**. El historial de aquellas capacidades vive en el
> repo **upstream `jpreyes/structweb3d`**, no aquí.

---

## ✅ Hechos

- ✅ **Figuras del informe (estado estructural)** `[R-1]` (v208): la **deformada** del informe pasó de una silueta extruida con quiebres a (a) un **dibujo limpio** con eje de altura, referencia sin deformar, silueta con degradado por desplazamiento, marcas de sensores y barra de color en mm; y (b) una **deformada CÚBICA de voladizo** ajustada por mínimos cuadrados a lo MEDIDO (`w(ζ)=c₂ζ²+c₃ζ³`, empotrada: `w(0)=0,w'(0)=0`) → curva suave. Esquemas (turbina/torre AT) redibujados como SVG nítidos.
- ✅ **Velocímetro de estado en el informe** `[R-2]` (v208): el «Estado» pasa de texto a un **medidor tipo manómetro** (arco verde→rojo + aguja) que apunta de **más sano a más dañado** (clase ML 0–4) con el índice de daño %.
- ✅ **Quitar el selector de Unidades** `[R-3]` (v208): no tiene sentido en ReWind; se eliminó `#unit-select` del `index.html`.
- ✅ **Árbol lateral multiparque Parque ▸ Zona ▸ Torre** `[R-4]` (v208): `js/shm/parks.js` (store + UI) — varios parques (cada uno con su flota y layout), zonas dentro de cada parque (enfoque con atenuación + encuadre), asignación de torres a zonas, CRUD, persistencia en `localStorage`.
- ✅ **Torres AT seleccionables, movibles y borrables** `[R-5]` (v208): el picking sube por el árbol de la escena → las torres AT se seleccionan, arrastran y borran como las turbinas.
- ✅ **Desactivar (por ahora) la Configuración** `[R-9]` (v209): el botón ⚙ se oculta en ReWind hasta rehacerlo específico para SHM. *(También se movió el botón «Árbol» al tope del toolbar.)*
- ✅ **Avance de obra / etapas constructivas (HUD tipo Stark + dashboard de parque)** `[R-18]` (v242–v251): modelo de **partidas por componente** (fundación·fuste·góndola·rotor·cableado) con cronograma sintético editable (plan/real, responsable, fotos mockup, crosslink al gemelo); **HUD «Stark»** (callouts ancladas con línea-guía + semáforo/% + giro de cámara + «Abrir partida» con galería/bitácora/informe; auto-despliegue, layout compacto); **llenado 4D por componente** en la malla; **pestaña «Obra»** con editor por torre + dashboard de parque (veredicto, KPIs, **curva-S**, % por componente, atrasos, **Gantt por torre**, informe DPR). → [plan](planes/frente-1-avance-obra.md).
- ✅ **Análisis de sombras (shadow-flicker)** `[R-19]` (v215–v241): efemérides NOAA + sombras 3D sobre el relieve y 2D en el mapa; estudio horario/diario; worst-case y real-case (meteo del sitio) cuantitativos; **mapa de flicker** (2D+3D); receptores por clic o **importados (CSV/KML/KMZ/GeoJSON/SHP)**; **informe imprimible** con mapa de iso-sombra y calendario mes×hora; sombreado inter-turbinas; pestaña «Shadow flicker». → [plan](planes/frente-2-sombras.md).
- ✅ **Depurar del código todo lo que no sea de ReWind (no solo ocultarlo)** `[R-20]` (v213): se eliminaron `js/app.js` (ReWind se auto-bootea), `js/design/`, `js/io/`, `js/ui/`, `js/utils/`, el mallador (`mesh_*`, `mesher`, `discretize`, `macromodel`, `matching`, `model_ops`), `js/api/`, los solvers no usados por el gemelo (geometric, spectrum, formfind, nl_*, buckling, subspace, staged, tendon, moving_load, timehistory, sparse, linsolve + workers), `worker/asistente.js` y el markup PÓRTICO de `index.html` (menús, barra de modelado, panel FE, overlays/modales/ayuda) — **~24.900 líneas**. Se conserva el closure de ReWind (`js/shm/*` + `model`/`serializer`/`macro_registry`/`macros.turbine` + 10 solvers del gemelo + `asistente/generador.js`). El resize del panel se repuso en `shm_mode.js`.

---

## ⬜ Pendientes — industrialización de ReWind

- ✅ **Internacionalización ES/EN (multilingüe)** `[R-6]` (v262–v268): `js/shm/i18n.js` — diccionario ES/EN + `t(key)` + idioma en `localStorage` + **conmutador ES/EN** en el menú superior (recarga la app para rehacer los render). **Toda la app es bilingüe**: Fase 1 (marco: toolbar, menú superior, barra de estado, pestañas/subpestañas, portada, `<html lang>`); 2a (Selección + panes SHM + clasificación en vivo + rótulo/banner); 2b (Parque + micro-CMMS de Inspección); 2c (Obra + gemelo de construcción + Shadow flicker); **2d (informes imprimibles)**: certificado de commissioning, avance DPR, inspección, **salud SHM `buildReport`** (incluye etiquetas de canvas) y **shadow flicker** (`map_view.js`: informe completo, inter-turbinas, popup y calendario mes×hora), todos con `<html lang>` y fechas por locale. El **HUD flotante por componente** (`avance_hud.js`: callouts de avance/inspección/sensores, modal «Abrir partida» y ficha de partida imprimible) también quedó bilingüe (v273). **No se traducen los catálogos de dominio** (tipos/causas/severidades de daño, nombres de componentes) por ser claves de scoring/datos. *(El CSV `docs/textos_ui.csv` es el inventario viejo de PÓRTICO; no aplica.)*
- ✅ **Adecuar el menú superior a ReWind** `[R-7]` (v261): **menú nativo de SHM** en el `#menubar` (`buildMenubar`) con 3 desplegables — **Parque** (nueva torre/AT, exportar/importar parque .json), **Datos** (fuente sim/vivo en vivo, exportar telemetría .json, exportar/importar inspecciones .json), **Informe** (informe del parque, informe de la selección, «Acerca de ReWind»). Sin markup heredado de PÓRTICO (ya removido en R-20/R-8).
- ✅ **Quitar toda referencia a «PÓRTICO»** `[R-8]` (v258): marca, textos, títulos visibles, encabezados de exportación (CSV/resultados), banner de `serve.py` y `console` → todo «ReWind»; icono PWA (`aria-label`), caché del SW (`rewind-…`) y clave de tema en `localStorage` (`rewind_theme`, con lectura de respaldo del antiguo `portico_theme`) renombrados. *(El núcleo de cálculo `js/solver`/`js/model` puede seguir nombrando PÓRTICO en comentarios internos; lo visible al usuario ya no lo nombra. `CLAUDE.md` conserva las referencias a PÓRTICO porque documentan que esto es un fork.)*
- 🟡 **Persistencia/`DataSource` industrial + API publicada** `[R-10]`: que la herramienta sirva a la industria conectándose a una **base de datos de torres del parque** o funcionando de forma **autónoma**. Capas: `localStorage` (demo) → IndexedDB/SQLite local (autónomo, sin red) → BD del parque. **Publicar una API** (esquema común `DataSource` simulado ↔ en vivo) para que terceros consuman la misma telemetría. *(Primer trozo hecho v235: `js/shm/meteo_caman.js` — fuente de datos meteo del sitio —sol mensual, rosa de vientos, operación— que consume el real-case de sombra; falta la BD/API/telemetría industrial.)*
- ⬜ **Empaquetado Electron + serie temporal InfluxDB + estándares eólicos** `[R-11]`: llevar ReWind a **Electron** (app de escritorio para el centro de control del parque). Decidir el **stack de ingesta de InfluxDB** (cliente Python / C++ / Rust — definir el lenguaje base del backend) y alinear el modelo de datos con los **estándares eólicos** (IEC 61400, OPC-UA/IEC 61850 para la subestación). *(Ver `bridge/` para la cadena ESP32 → MQTT → InfluxDB ya prototipada.)*
- ✅ **Landing propia de ReWind** `[R-16]` (v252): `index.html` es ahora una **landing page editorial** propia de ReWind (hero, cómo funciona, el diferenciador de construcción, capacidades, demo); la app pasó a **`app.html`** (los CTA enlazan ahí). Service worker y `manifest` (start_url → `app.html`) ajustados; imágenes en `images/`. *(El splash heredado dentro de la app es aparte; pulir con `[R-8]`.)*
- ✅ **Inspección como micro-sistema de gestión (CMMS ligero) + histórico de evaluación rico** `[R-32]` (v252–v254): `js/shm/inspection.js` (port a JS del scoring determinista de structapp-base: severidad·causa·tipo·extensión → 0–100 por daño y por inspección, sin Python/servidor) + catálogos eólicos + almacén `localStorage` por estructura. La pestaña **Inspección** es un micro-CMMS completo: KPIs por inspección, **histórico de evaluación** (sparkline de score), lista de inspecciones, ficha editable, **hallazgos catalogados con score automático**, **fotos** (thumbnail), **ensayos genéricos con auto-clasificación NDT**, documentos, **órdenes de trabajo** (estado/prioridad/responsable/vencimiento + «→ OT» desde un hallazgo), **calendario** (próxima inspección + alertas de vencimiento), **informe imprimible**, **rollup de vencimientos a nivel parque** (pestaña Parque) y **exportar/importar JSON** (respaldo sin backend). La evaluación de inspección es distinta del estado por sensores (SHM). **Lo único que falta es propio de `[R-10]`** (no de R-32): persistencia en BD real, adjuntos/fotos en almacenamiento y la 2ª opinión por LLM. Detalle de capacidades futuras del management system (con backend):
  - **Histórico de evaluación rico:** línea de tiempo navegable con eventos fechados (inspección visual, OMA/medición, cambio de clasificación, reparación), severidad, adjuntos y nota; no solo la banda de clasificación ML.
  - **Órdenes de trabajo / hallazgos (work orders):** crear hallazgo → asignar responsable → estado (abierto/en curso/cerrado) → prioridad → vencimiento; checklist de inspección por tipo de estructura.
  - **Calendario / vencimientos:** próximas inspecciones y mantenimientos programados, alertas de vencido (encaja con `[R-23]`).
  - **Adjuntos:** fotos, informes y notas por evento/hallazgo (requiere almacenamiento, `[R-10]`).
  - **Reportes:** ficha de inspección por torre + resumen de hallazgos abiertos por parque (encaja con `[R-28]`).
  *Distinguir siempre **evaluación de inspección** (manual/periódica) del **estado por sensores** (live, pestaña SHM).* Depende de `[R-10]` para persistencia real.

---

## ⬜ Capacidades SHM que tienen las plataformas comerciales y a ReWind le faltan

*(Detectadas comparando con Bachmann SHM.Webportal, HBK/Brüel & Kjær, Romax
Insight, fos4X/Wölfel, Onyx InSight, ROMO Wind, SkySpecs. Ordenadas por valor/esfuerzo.)*

- ⬜ **OMA — identificación modal desde la señal MEDIDA** `[R-21]` *(DIFERIDO AL FINAL, junto con los sensores en vivo)*: extraer f₁, f₂, amortiguamiento (y forma modal con 2 sensores) **de los acelerómetros**, no del gemelo teórico, y **seguir su deriva en el tiempo**. El corrimiento de frecuencias es la señal temprana de daño / aflojamiento de pernos / asentamiento de fundación. **Decisión (JP):** se integrará un **módulo propio de interpretación con estrategias ultramétricas** (no el peak-picking/FFT genérico), así que se hace al cierre junto con la conexión de sensores reales (`R-10`/`R-11`). Habilita la f₁ MEDIDA de `R-31` y la base modal de `R-30`. *Es la prueba de que esto es SHM real y no una maqueta.*
- ✅ **Consumo de vida a fatiga / cargas equivalentes (DEL)** `[R-22]` (v260): `js/shm/fatigue.js` — conteo **rainflow** (ASTM E1049, 3 puntos) + curvas **S-N EN 1993-1-9** (bilineal m1=3/m2=5, categoría de detalle ΔσC) → **daño de Miner**, **vida de diseño/remanente (RUL)** y **DEL** (rango equivalente de daño). **Verificado en Node** (`js/shm/test_fatigue.mjs`): caso canónico de rainflow, amplitud constante (DEL=rango), continuidad S-N en los quiebres, linealidad de Miner, monotonía. **UI**: pestaña **Fatiga** en el panel SHM (KPIs vida consumida/RUL/daño-año/DEL + espectro de carga rainflow log-y con umbrales ΔσD/ΔσL). Historia de tensiones **sintética** (turbulencia + 1P/3P) hasta conectar galga/acelerómetro real; alimenta el futuro **🌟 `R-30`** y la RUL de `R-25`.
- ⬜ **Alarmas y umbrales configurables** `[R-23]`: umbrales por métrica (RMS, f₁, tilt, viento) con estados activo/aviso/crítico y notificación (email/SMS/push). Depende del `DataSource` (`[R-10]`).
- ⬜ **Inclinómetro / tilt del fuste y asentamiento de fundación** `[R-24]`: seguimiento del desplome y del settlement en el tiempo (complementa OMA para diagnóstico de fundación).
- ⬜ **Mantenimiento predictivo + vida útil remanente (RUL) por componente** `[R-25]`: curva de salud por torre/componente y estimación de RUL a partir de fatiga `[R-22]` + tendencias `[R-21]`.
- ⬜ **SHM poblacional (benchmarking de flota)** `[R-26]`: comparar torres entre sí para detectar la anómala (la población como referencia). Falta implementarlo (clustering / z-score de la flota).
- ⬜ **Desempeño: curva de potencia y disponibilidad** `[R-27]`: curva de potencia medida vs. garantizada, pérdidas por viento, disponibilidad. *(Requiere SCADA — encaja con `[R-10]`/`[R-11]`.)*
- ⬜ **Reportes programados + export automático** `[R-28]`: informes periódicos (PDF/Excel) por torre, zona y parque, agendados.
- ⬜ **Componentes más allá del fuste (drivetrain/palas)** `[R-29]` *(grande, requiere más sensórica)*: vibración de orden de caja/rodamientos y monitoreo de palas (grietas, hielo, desbalance) — opcionalmente inspección por dron/IA. Hoy ReWind monitorea solo la torre.

---

## 🚩 Buque insignia — diferenciadores de alto valor que pocos hacen

*Dos jugadas que usan lo que ReWind ya tiene (el gemelo FEM + 2 acelerómetros) para
ofrecer algo que las plataformas SHM «data-only» no pueden: inferir el estado
estructural en puntos SIN sensor. La mayoría del estado del arte es offshore y con
galgas caras; ReWind apunta a **onshore, con MEMS baratos y un gemelo físico en el
navegador**. Fundamentado en literatura 2025 (Devriendt & Weijtjens; WES 2025;
revisiones de extensión de vida).*

- 🟡 **🌟 Gemelo de CONSTRUCCIÓN / puesta en marcha (SHM durante el montaje)** `[R-31]` ***(núcleo hecho v256–v257)***: `js/shm/construction_twin.js` — voladizo equivalente (Rayleigh) calibrado a la f₁ del gemelo FEM (0.283 Hz), **curva f₁ predicha por etapa** (fuste 25/50/75/100 → +góndola → +rotor, validada vs voladizo analítico), **ventana soft-stiff** (1P/3P), y **medición simulada** con defecto de base determinista (~30% de torres). UI: tarjeta «Gemelo de construcción» en la pestaña **Obra** (curva predicha + puntos medidos verde/rojo + banda soft-stiff + veredicto + línea base) y **certificado de puesta en marcha** imprimible; **crosslink al HUD** del Frente 1 (cada partida muestra «f₁ X Hz · concuerda ✓ / bajo lo predicho ✗»). **Falta (lo más desafiante, al final):** f₁ **MEDIDA real** desde la señal (**OMA, `R-21`**) y **telemetría en vivo** (`R-10`/`R-11`) + tilt biaxial (`R-24`). Contexto del white space: la SHM clásica arranca en operación; **monitorear estructuralmente mientras se construye es un white space** (la literatura no cubre el seguimiento modal durante el montaje ni la captura de la línea base de puesta en marcha con gemelo). ReWind ya modela el estado constructivo (`built`/`stages`, planos de corte 4D), así que el paso natural es:
  - **Frecuencia esperada vs. medida por etapa.** A medida que sube el fuste, el gemelo predice f₁ en cada estado constructivo (voladizo de altura = fracción construida → f₁ baja por una curva conocida). **Desviación de la curva predicha = anomalía** (pretensado de pernos de brida insuficiente, fundación aún sin rigidez/curado, defecto de grout, base mal apoyada). Reusa `digital_twin.js` + `modal_solver` evaluados sobre el mástil parcial.
  - **Fundación en obra:** curado/madurez del hormigón (ganancia de rigidez), **asentamiento/tilt temprano**, jaula de anclaje/bolt-circle. Problemas caros y frecuentes (fundaciones agrietadas, fisuras por asentamiento plástico).
  - **Línea base («fingerprint») de puesta en marcha:** capturar f₁/f₂/amortiguamiento de cada torre recién montada **es lo que habilita toda la SHM operacional posterior** (es la referencia contra la que se comparará). Capturarla durante la construcción es el momento natural y casi nadie lo hace bien. Entrega: un **módulo de QA/commissioning** — predicho vs. medido por etapa, banderas verde/ámbar/rojo, y el fingerprint auto-generado que alimenta la SHM operacional.
  - *Encaje:* el más bajo en esfuerzo de los dos (no necesita 20 años de fatiga), da **valor inmediato en Camán**, y construye sobre el 4D que ya estamos modificando. → **[plan completo](planes/frente-3-gemelo-construccion.md)**.
- ⬜ **🌟 Gemelo de CARGAS — sensado virtual + fatiga para extensión de vida (operacional)** `[R-30]`: usar el gemelo + los 2 MEMS para **reconstruir el campo de tensión en los hotspots SIN sensor** (soldadura de base, brida atornillada, interfaz fuste–fundación) por **expansión modal** sobre las formas del gemelo, y de ahí **rainflow + curva S-N → daño Palmgren-Miner → vida consumida / RUL**. Caso de negocio: la flota mundial llega a sus ~20 años de diseño y la **extensión de vida** vale millones; hoy se decide con reevaluaciones genéricas, no con la historia de cargas real de *esa* máquina. Fusiona `[R-21]` (OMA da la base modal viva) + `[R-22]` (fatiga). Entrega: **«certificado de salud y vida remanente»** vivo por torre y flota. *Límites honestos:* 2 acelerómetros → ~2 modos resueltos; fatiga aproximada (banda de incertidumbre), conviene biaxial y, si hay, viento/potencia de SCADA; validar contra una galga en una torre piloto.

---

## Secuencia sugerida

**Foco inmediato (apoyados en el 4D):**
1. ✅ **`R-18` etapas constructivas / avance de obra** — hecho (HUD + 4D por componente + dashboard).
2. ✅ **`R-19` análisis de sombras** — hecho.
3. 🟡 **🌟 `R-31` gemelo de construcción** — **núcleo hecho** (curva predicha + soft-stiff + certificado + crosslink HUD). Se cierra con `R-21` (OMA) para la f₁ medida real + sensores en vivo.

**Después:**
4. **`R-21` OMA desde la señal medida** — habilita el sensado virtual (base modal viva).
5. **`R-22` fatiga / DEL** → **🌟 `R-30` gemelo de cargas / extensión de vida** — jugada operacional de alto valor (madura cuando haya horas de operación).
6. **`R-10` `DataSource` + `R-23` alarmas** — habilitan la conexión industrial y el resto.
7. **`R-8`/`R-16` quitar marca/arranque PÓRTICO** y **`R-6` i18n** — pulido de producto.
8. Mayores: `R-11` (Electron + InfluxDB), `R-25`–`R-29` (predictivo, flota, drivetrain).
