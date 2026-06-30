# ReWind — Roadmap

**ReWind (`wind-shm`)** es una herramienta de **SHM (Structural Health
Monitoring) de parques eólicos**: flota viva 3D georreferenciada, capa de
sensores, avance de obra 4D, dashboard e informe de estado estructural por torre.

Estado: ⬜ pendiente · 🟡 en curso · ✅ hecho. Los ítems se numeran `R-*`.

> **▶ Foco inmediato (en lo que trabajamos ahora):** planes detallados en [`docs/planes/`](planes/).
> 1. **`R-18` — Etapas constructivas / avance de obra** (HUD tipo Stark + dashboard de parque) — [plan](planes/frente-1-avance-obra.md).
> 2. **`R-19` — Análisis de sombras** de los aerogeneradores según el sol — [plan](planes/frente-2-sombras.md).
> 3. **`R-31` — Gemelo de construcción** (frecuencia predicha-vs-medida por etapa; el buque insignia, encaja con Camán en construcción) — [plan](planes/frente-3-gemelo-construccion.md).
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
- ✅ **Depurar del código todo lo que no sea de ReWind (no solo ocultarlo)** `[R-20]` (v213): se eliminaron `js/app.js` (ReWind se auto-bootea), `js/design/`, `js/io/`, `js/ui/`, `js/utils/`, el mallador (`mesh_*`, `mesher`, `discretize`, `macromodel`, `matching`, `model_ops`), `js/api/`, los solvers no usados por el gemelo (geometric, spectrum, formfind, nl_*, buckling, subspace, staged, tendon, moving_load, timehistory, sparse, linsolve + workers), `worker/asistente.js` y el markup PÓRTICO de `index.html` (menús, barra de modelado, panel FE, overlays/modales/ayuda) — **~24.900 líneas**. Se conserva el closure de ReWind (`js/shm/*` + `model`/`serializer`/`macro_registry`/`macros.turbine` + 10 solvers del gemelo + `asistente/generador.js`). El resize del panel se repuso en `shm_mode.js`.

---

## ⬜ Pendientes — industrialización de ReWind

- ⬜ **Internacionalización ES/EN (multilingüe)** `[R-6]`: extraer los textos de la UI/informe a un diccionario y un conmutador de idioma (español/inglés). *(Base: el CSV `docs/textos_ui.csv` puede servir de inventario de strings.)*
- ⬜ **Adecuar el menú superior a ReWind** `[R-7]`: hoy se ocultan ítems heredados vía `shm.css`; falta un **menú nativo de SHM** (parque, informe, fuentes de datos, exportar telemetría…).
- ⬜ **Quitar toda referencia a «PÓRTICO»** `[R-8]`: marca, textos, títulos, comentarios visibles y `console` → todo «ReWind». *(El núcleo de cálculo puede seguir internamente; lo visible no debe nombrar PÓRTICO.)*
- 🟡 **Persistencia/`DataSource` industrial + API publicada** `[R-10]`: que la herramienta sirva a la industria conectándose a una **base de datos de torres del parque** o funcionando de forma **autónoma**. Capas: `localStorage` (demo) → IndexedDB/SQLite local (autónomo, sin red) → BD del parque. **Publicar una API** (esquema común `DataSource` simulado ↔ en vivo) para que terceros consuman la misma telemetría. *(Primer trozo hecho v235: `js/shm/meteo_caman.js` — fuente de datos meteo del sitio —sol mensual, rosa de vientos, operación— que consume el real-case de sombra; falta la BD/API/telemetría industrial.)*
- ⬜ **Empaquetado Electron + serie temporal InfluxDB + estándares eólicos** `[R-11]`: llevar ReWind a **Electron** (app de escritorio para el centro de control del parque). Decidir el **stack de ingesta de InfluxDB** (cliente Python / C++ / Rust — definir el lenguaje base del backend) y alinear el modelo de datos con los **estándares eólicos** (IEC 61400, OPC-UA/IEC 61850 para la subestación). *(Ver `bridge/` para la cadena ESP32 → MQTT → InfluxDB ya prototipada.)*
- ⬜ **Quitar el render/pantalla inicial heredado de PÓRTICO** `[R-16]`: lo primero que se ve aún corresponde a PÓRTICO (landing/splash antes de que monte ReWind). Reemplazarlo por un arranque propio de ReWind. *(Relacionado con `[R-8]`.)*
- ⬜ **Gestión de avance de obra completa (ventana dedicada)** `[R-18]`: el parque está en **etapa constructiva**, así que el seguimiento debe crecer más allá de la pestaña «Avance» actual (etapas + % por torre). Abrir una **ventana completa**: cronograma/Gantt por torre y zona, hitos y fechas reales (planificado vs. real), responsables, **fotografías** de obra (requiere BD, ver `[R-10]`), curva-S de avance del parque, % por componente (fundación, fuste, góndola, rotor, cableado/colectora), filtros y exportación de reportes. **Diseño acordado: visor HUD tipo «Stark» por torre** (callouts ancladas en 3D con flecha por partida + giro de cámara al clic + ventana expandible con datos/fotos/informe y **botón «Abrir partida»**) **+ dashboard de avance de parque**. → **[plan completo](planes/frente-1-avance-obra.md)**.
- ⬜ **Análisis de sombras de los aerogeneradores según la posición del sol** `[R-19]`: proyección de sombras del rotor/fuste según la **posición solar** (fecha, hora, lat/lon — ya georreferenciado) sobre el terreno y entre torres. Útil para *shadow flicker* (parpadeo hacia viviendas/vecinos) y sombreado entre máquinas. En 3D: luz direccional = sol (azimut/elevación por efemérides) + sombras proyectadas; control de fecha/hora con animación del día. *(Three.js ya tiene `castShadow`/`receiveShadow`.)* → **[plan completo](planes/frente-2-sombras.md)**.

---

## ⬜ Capacidades SHM que tienen las plataformas comerciales y a ReWind le faltan

*(Detectadas comparando con Bachmann SHM.Webportal, HBK/Brüel & Kjær, Romax
Insight, fos4X/Wölfel, Onyx InSight, ROMO Wind, SkySpecs. Ordenadas por valor/esfuerzo.)*

- ⬜ **OMA — identificación modal desde la señal MEDIDA** `[R-21]` *(alto valor, bajo costo — SIGUIENTE recomendado)*: extraer f₁, f₂, amortiguamiento (y forma modal con 2 sensores) **de los acelerómetros**, no del gemelo teórico, y **seguir su deriva en el tiempo**. El corrimiento de frecuencias es la señal temprana de daño / aflojamiento de pernos / asentamiento de fundación. Reusa el núcleo eigen del gemelo (`digital_twin.js`) y los 2 nodos MEMS por torre. *Es la prueba de que esto es SHM real y no una maqueta.*
- ⬜ **Consumo de vida a fatiga / cargas equivalentes (DEL)** `[R-22]`: conteo **rainflow** + curvas S-N → daño acumulado y vida remanente del fuste/uniones. Entregable estrella de Romax/Onyx. Núcleo numérico acotado y autónomo (verificable en Node).
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

- ⬜ **🌟 Gemelo de CONSTRUCCIÓN / puesta en marcha (SHM durante el montaje)** `[R-31]` ***(PRIORITARIO — Camán se está construyendo AHORA y ya trabajamos el 4D)***: la SHM clásica arranca en operación; **monitorear estructuralmente mientras se construye es un white space** (la literatura no cubre el seguimiento modal durante el montaje ni la captura de la línea base de puesta en marcha con gemelo). ReWind ya modela el estado constructivo (`built`/`stages`, planos de corte 4D), así que el paso natural es:
  - **Frecuencia esperada vs. medida por etapa.** A medida que sube el fuste, el gemelo predice f₁ en cada estado constructivo (voladizo de altura = fracción construida → f₁ baja por una curva conocida). **Desviación de la curva predicha = anomalía** (pretensado de pernos de brida insuficiente, fundación aún sin rigidez/curado, defecto de grout, base mal apoyada). Reusa `digital_twin.js` + `modal_solver` evaluados sobre el mástil parcial.
  - **Fundación en obra:** curado/madurez del hormigón (ganancia de rigidez), **asentamiento/tilt temprano**, jaula de anclaje/bolt-circle. Problemas caros y frecuentes (fundaciones agrietadas, fisuras por asentamiento plástico).
  - **Línea base («fingerprint») de puesta en marcha:** capturar f₁/f₂/amortiguamiento de cada torre recién montada **es lo que habilita toda la SHM operacional posterior** (es la referencia contra la que se comparará). Capturarla durante la construcción es el momento natural y casi nadie lo hace bien. Entrega: un **módulo de QA/commissioning** — predicho vs. medido por etapa, banderas verde/ámbar/rojo, y el fingerprint auto-generado que alimenta la SHM operacional.
  - *Encaje:* el más bajo en esfuerzo de los dos (no necesita 20 años de fatiga), da **valor inmediato en Camán**, y construye sobre el 4D que ya estamos modificando. → **[plan completo](planes/frente-3-gemelo-construccion.md)**.
- ⬜ **🌟 Gemelo de CARGAS — sensado virtual + fatiga para extensión de vida (operacional)** `[R-30]`: usar el gemelo + los 2 MEMS para **reconstruir el campo de tensión en los hotspots SIN sensor** (soldadura de base, brida atornillada, interfaz fuste–fundación) por **expansión modal** sobre las formas del gemelo, y de ahí **rainflow + curva S-N → daño Palmgren-Miner → vida consumida / RUL**. Caso de negocio: la flota mundial llega a sus ~20 años de diseño y la **extensión de vida** vale millones; hoy se decide con reevaluaciones genéricas, no con la historia de cargas real de *esa* máquina. Fusiona `[R-21]` (OMA da la base modal viva) + `[R-22]` (fatiga). Entrega: **«certificado de salud y vida remanente»** vivo por torre y flota. *Límites honestos:* 2 acelerómetros → ~2 modos resueltos; fatiga aproximada (banda de incertidumbre), conviene biaxial y, si hay, viento/potencia de SCADA; validar contra una galga en una torre piloto.

---

## Secuencia sugerida

**Foco inmediato (los tres, apoyados en el 4D):**
1. **`R-18` etapas constructivas / ventana de avance** — es lo que el cliente ve hoy (parque en construcción).
2. **`R-19` análisis de sombras** — visual, autocontenido, reusa el relieve y las torres ya en escena.
3. **🌟 `R-31` gemelo de construcción** — frecuencia predicha-vs-medida por etapa; el mejor encaje hoy. Se beneficia de `R-21` (OMA) para la f₁ medida.

**Después:**
4. **`R-21` OMA desde la señal medida** — habilita el sensado virtual (base modal viva).
5. **`R-22` fatiga / DEL** → **🌟 `R-30` gemelo de cargas / extensión de vida** — jugada operacional de alto valor (madura cuando haya horas de operación).
6. **`R-10` `DataSource` + `R-23` alarmas** — habilitan la conexión industrial y el resto.
7. **`R-8`/`R-16` quitar marca/arranque PÓRTICO** y **`R-6` i18n** — pulido de producto.
8. Mayores: `R-11` (Electron + InfluxDB), `R-25`–`R-29` (predictivo, flota, drivetrain).
