# PÓRTICO — Roadmap de mejoras

Plan de mejoras detectadas en uso práctico (análisis y diseño), agrupadas por
similaridad. `[#]` referencia el pedido original. Estado: ⬜ pendiente · 🟡 en curso · ✅ hecho.

---

## G1 · Panel de análisis y acceso a resultados ✅
*El cuello de botella del flujo: lanzar análisis y reusar resultados.*
- ✅ **Ventana flotante de análisis** (Centro de análisis): el botón "Análisis" de la barra lateral abre un panel con TODOS los análisis (Estático, Modal, Espectro + 6 avanzados NL-lite), cada uno con botón Ejecutar. `[#4]`
- ✅ **Acceso a resultados ya corridos**: badges ✓/sin-ejecutar por análisis y botón **Ver** que re-muestra sin recalcular (estático, modal, y cada caso espectral listado). **Indicador permanente** en la barra de estado (`#sb-results`): resume qué análisis tienen resultados (✓ Estático · Modal · N esp · Pandeo), en verde, y abre el hub al clic; se actualiza tras correr/limpiar cualquier análisis. `[#1]`
- ✅ **Analizar seleccionados (batch)**: casilla por análisis en el Centro de análisis + botón **Analizar seleccionados** (`_runBatch`) que corre la secuencia marcada en orden lógico (estático → modal → espectro → NL-lite); el espectro se antepone con modal si falta. `runAnalysis`/`runSpectrum` ahora devuelven promesa (se envuelve el `setTimeout`) para esperar fin antes del siguiente. `[#24]`
- ✅ **Modal/progreso**: el modal **sale del modo resultados antes de correr**; la **estructura original** se dibuja como **fantasma tenue** (0.28); la **caja flotante de progreso** aparece en estático, **Modal**, **Espectro** y los NL-lite síncronos sin diálogo (No lineal / P-Delta / Pandeo, vía `_runByAction` con yield). Los NL-lite con diálogo (form-finding/plástico/pushover-DC) gestionan su propio flujo. `[#2]`

## G2 · Motor modal y rendimiento ✅
- ✅ **Método modal alternativo + selector**: además de la iteración inversa (Stodola, modo a modo), nueva **iteración de subespacio (Bathe)** que extrae los modos menores en bloque (rápida con muchos modos), con un eigensolver generalizado pequeño (Cholesky + Jacobi). Selector en la ventana modal. Verificado: subspace ≡ Stodola en frecuencias (portal 3D: 6.21, 6.21, 7.02, 9.94 Hz idénticas) y eigensolver pequeño exacto vs solución analítica. `[#3]`

## G3 · Navegación y legibilidad del viewport *(quick wins)* ✅
- ✅ **PAN (manito)** además de orbitar. Herramienta en la barra lateral (modo `pan`): arrastrar con la izquierda panea, restaura orbit al salir. `[#8]`
- ✅ **Grillas más tenues** (opacidad 0.7→0.38) → los elementos resaltan. `[#9]`
- ✅ **Ocultar los ejes**: Vista → Ejes XYZ (`toggleAxes`). `[#10]`

## G4 · Modelado e interacción de edición ✅ *(completo)*
- ✅ **Crear elementos sin nodos previos + imán a nodos cercanos (toggle).** En modo Elemento, clic en la grilla crea el nodo; con Imán (casilla en la barra superior, por defecto ON) el extremo se pega al nodo cercano (lo reutiliza); apagando el imán crea uno nuevo aunque haya otro al lado. `[#6]`
- ✅ **Herramienta "Área" en la barra lateral** (Nodo/Elem/**Área**/Apoyo): clic en 3 (CST) o 4 (QUAD) nodos; el 4º crea el QUAD, Enter crea el CST, Esc reinicia. Usa las últimas opciones (espesor/comportamiento) y se ajustan luego en el panel del área. `[#nuevo]`
- ✅ **Acciones + Mover/Copiar con un solo elemento** seleccionado (antes solo con multi-selección). `[#7]`
- ✅ **Copiar elemento = copiar también sus cargas (dist/temp), cable/L0, y grupos.** `[#11]`
- ✅ **Nodo + elemento en un solo clic**: el clic crea el nodo (si hace falta) y lo deja como extremo inicial sin un segundo clic; tras cerrar un tramo, el extremo recién creado inicia el siguiente → **cadena continua** (poligonal con un clic por tramo, Esc para terminar). `[#26]`
- ✅ **Fuerza nodal a multi-selección**: formulario de carga nodal (Fx..Mz) en el panel de selección múltiple de nodos + `setCargaNodalSelected(F, lcId)` que la asigna idéntica a todos los nodos seleccionados (y "Limpiar todos"). `[#32]`
- ✅ **Limpiar cargas huérfanas**: `model.removeNode`/`removeElement` purgan de todos los casos las cargas (nodales / dist / temp) que referencian lo borrado (`_purgeNodeLoads`/`_purgeElemLoads`); los `delete*` de la app llaman `refreshLoads()` → las flechas desaparecen de la vista y del modelo. `[#31]`

## G5 · Cargas, normativa y asistente de modificación ✅
- ✅ **Casos de carga y combinaciones de la norma por defecto**: Análisis → "Crear casos y combos de norma (NCh3171)" → casos D (PP) y L, combos 1.4D y 1.2D+1.6L, y sísmicas ±1.4Ex/±1.4Ey si existen casos espectrales. Editables, idempotente (`crearCasosYCombosNorma`). `[#16]`
- ✅ **Asistente sobre el modelo ya construido (#5)**: pestaña Asistente → "Modificar el modelo actual": orden en lenguaje natural → el Worker/LLM la traduce a **operaciones** (`/api/asistente/modificar`) y un ejecutor determinista cliente (`js/model/model_ops.js`, `aplicarOperacionesModelo`) las aplica. Operaciones: `add_load` (cargas viva/uniforme/trapecial a selección/vigas/columnas), `add_story` (anexar piso encima), `add_bay` (anexar vano lateral ±x/±y), `set_modifiers` (factores de rigidez, sección clonada), `set_mass` (masa nodal). Verificado: pórtico → 2 pisos × 2 vanos resuelve con ΣRz = carga total (equilibrio); apoyos heredados en la base del vano nuevo evitan el mecanismo. `[#5]`
- ✅ **Asistente en la barra lateral derecha**: pestaña **Asistente** junto a Modelo/Resultados/Diseño (`vpanel-asistente`: generar modelo + modificar modelo). `[#23]`
- ✅ **Combos de servicio / tensiones admisibles**: `crearCasosYCombosNorma` agrega, además del LRFD, el set ASD (NCh3171·ASCE-7): D, D+L y por dirección sísmica D±0.7E, D+0.75L±0.525E, 0.6D±0.7E. `[#25a]`
- ✅ **Creación automática de combos accesible en dos lugares**: menú Análisis **y** botón "⚙ Crear casos y combos de norma" en la pestaña Combos de la barra lateral (`#btn-combos-norma`). `[#25b]`
- ✅ **Cargas trapeciales (trapezoidales)** en elementos: campo "w en j" en el panel del elemento (vacío = uniforme). FEF exacta (uniforme + triangular), diagramas V(x)/M(x) con q lineal y extremo por cuadrática, interpolación correcta al discretizar (auto-disc) y al unir/partir, round-trip JSON y CSV (w2 opcional). Verificado: viga SS con carga triangular → reacciones w₀L/6 y w₀L/3 exactas, M_max=w₀L²/(9√3)=10.264 en x=L/√3, idéntico con 1/4/10 sub-elementos. `[#35]`

## G6 · Diseño, memoria y reportes ✅
- ✅ **Tabla de diseño explorable**: wrapper con scroll (max-height 58vh) hasta el último elemento + columna **|δ| mm** (desplazamiento máx. de los nodos del elemento en el caso/combo mostrado). `[#12]`
- ✅ **Memoria de cálculo descargable en `.docx`**: generador Word **autocontenido** (`js/io/docx.js`, sin dependencias ni build — ZIP STORED + CRC32 + WordprocessingML, con encabezados, tablas e imágenes PNG embebidas). `app.generarMemoriaDocx` arma la misma memoria (portada, bases, materiales/secciones, cargas/combos, modal, figuras, D/C, flechas, derivas, limitaciones) y la descarga. Menú Análisis → "📝 Memoria de Cálculo (Word .docx)". Verificado: ZIP/XML bien formados (`test_docx.mjs`) e imágenes embebidas en navegador. `[#14]`
- ✅ **Quitar logos UACh de la memoria** cuando se cargue el logo profesional: con token PRO + logo de empresa cargado, ese logo **reemplaza** a los académicos (UACh/Facultad/IOC) y oculta el badge "Producto académico" en portada (HTML y `.docx`). Sin logo PRO se conservan los créditos. `[#18]`
- ✅ **Portada/landing flotante al entrar** (`#landing`): logo **PÓRTICO**, logos institucionales (UACh/Facultad/IOC), autor (Dr. Juan Patricio Reyes C.) y botones **Entrar** / **Manual de uso** / **Instalar app** (+ asistente de generación). `[#22]`
- ✅ **Quitar de la UI/ayuda referencias a editar archivos de config**: reformuladas las menciones a editar `asistente/diseno_params.json` → "valores normativos estándar". `[#13]`

## G7 · Gestión de proyecto multi-modelo
- ⬜ **Un proyecto con varios modelos** (edificio principal, cercha plana, viga de fundación…) que se integran en **una sola memoria**. `[#17]` *(cambio más arquitectónico: serializer, estado de la app, generador de memoria).*

## G8 · Robustez y diagnóstico ✅
- ✅ **Diagnóstico de inestabilidades**: `diagnoseInstability()` detecta los GDL libres con rigidez nula (diagonal de K ≈ 0) → nodo/GDL culpable. `runStabilityDiagnosis()` (menú Análisis → "Diagnosticar estabilidad") los **resalta en rojo, agranda y centra la vista**; se invoca **automáticamente** cuando un análisis falla por singular/mecanismo. Verificado: nodo aislado "invisible" detectado con sus 6 GDL y resaltado. `[#15]` *(Nota: cubre el caso común de rigidez nula; mecanismos multi-GDL acoplados se avisan pero no se localizan.)*

## G9 · Verificación documentada y documentación
- ⬜ **Casos de la literatura SAP2000** (en `referencias/`) → convertirlos a formato Pórtico, **comparar/verificar y documentar**; quedan en **Ejemplos** como casos de verificación. `[#19]`
- ⬜ **Mejorar UX de los análisis avanzados** (no lineales) + **ejemplo sencillo y `.md` por funcionalidad** (pandeo, form-finding, pushover). `[#20]` *(detalle técnico desglosado en G11.)*
- ⬜ **Documentación integral de toda funcionalidad**: qué hace, teoría mínima, cómo ejecutarla en la app. `[#21]`

## G10 · Completar la física de elementos (FEM / shell) ✅
*Continuación del trabajo de placa/shell.*
- ✅ **Contorno de tensiones de flexión de placa**: `plateMoments` (momentos Mx,My,Mxy en el centro, MITC4 y DKT) → tensión de superficie `σ=±6M/t²` → von Mises de **envolvente** max(cara sup, cara inf) en `getAreaStress` (`areaBendingStress`); el contorno y el suavizado nodal usan la envolvente para shells. Panel del área muestra vM superficie/membrana/sup/inf. Verificado: momento central placa SS quad −1.6% / tri −2.6% vs 0.0479·q·a²; contorno de voladizo shell flexión-dominado.
- ✅ **Torsión de St. Venant**: el `J` ya se auto-calcula de la geometría en todas las secciones paramétricas (rect, circular, huecas; IPE/HEB tabuladas). Mejorado: fórmula rectangular a la serie precisa de Roark `J=a·t³·[1/3−0.21(t/a)(1−(t/a)⁴/12)]`; corregido el `J` de la sección por defecto 30×30 (era 1.13e-4, 10× bajo → 1.14e-3).
- ✅ **Masa de área para el modal**: las áreas aportan `ρ·t·A` (lumped, repartida a los GDL de traslación) a la matriz de masas, en el ensamblaje denso y disperso (`assembleAreasMassInto`). Verificado: masa total por dirección = ρ·t·A.

## G11 · Análisis avanzados: corrección, rendimiento y UX ✅ *(uso profesional)*
*Cluster de incidencias detectadas usando los análisis no lineales en producción.*
- ✅ **Rótulas plásticas — panel en la barra derecha**: los resultados pasan de la ventana flotante (que usaba `var(--panel,#0f1830)` inexistente → fondo oscuro fijo + texto de tema = ilegible en claro) a una **pestaña «Rótulas» en Resultados** (`rtab-plastico`, `renderPlasticResults`), que respeta el tema por construcción. De paso se corrigió el mismo bug de tema en los overlays de pandeo, P-Delta y pushover-DC (→ `var(--bg4)`/`--border`/`--text`). `[#27a]`
- ✅ **Rótulas plásticas — selección por elemento**: el diálogo (`_plasticDialog`) permite un Mp por defecto y un **Mp distinto para los elementos seleccionados**, con opción **«sólo la selección rotula»** (el resto permanece elástico → capacidad ∞). El bucle usa la capacidad por elemento (`capByElem`) y la tabla muestra el Mp de cada rótula. `[#27b]`
- ✅ **Pandeo lineal — motor rápido tipo modal**: nueva **iteración de subespacio** para `(K + λKg)φ = 0` (`js/solver/buckling.js` + `buckling_worker.js`), reusando el núcleo extraído del modal (`js/solver/subspace.js`: `smallGenEig` + helpers de banda). Reduce con Cholesky sobre Kᵣ (SPD) ya que −Kg es indefinida; los |1/λ| dominantes dan los menores λcr. Verificado equivalente a **Euler** (columna biarticulada, `test_buckling.mjs` y en navegador): λ₁ −0.28%, λ₂ −1.1%, pares degenerados. Reemplaza el `numeric.eig` denso O(n³) que se colgaba. `[#28][#33a]`
- ✅ **Pandeo lineal — UI análoga a la modal**: `runBuckling` ahora **asíncrono**, con diálogo de N° de modos (`_buckNModesDialog`), **caja de progreso** y el eigensolver en **Web Worker** (no bloquea la UI). Resultados en el overlay: selector de **modo de pandeo + λcr**, escala y **carga de pandeo por elemento** (`N_cr = λcr·N_ref`, barras más comprimidas; `assembleKg` devuelve el axial por elemento `Nby`). `[#33b]`
- ✅ **Form-finding — bug de geometría**: `runFormFinding` ahora **acota la red a los elementos seleccionados** (los demás quedan fijos; los nodos frontera con estructura no participante actúan de ancla) y permite elegir **ejes a ajustar** (sólo Z por defecto, o 3D). Así formar sólo la viga **no destruye los pilares**. `formFind` acepta `axes` para no redistribuir las luces en planta. Verificado: `test_formfind.mjs` (pilares intactos, viga funicular simétrica, planta preservada; el caso "todo el modelo 3D" reproduce el colapso original → por eso se acota). `[#29]`
- ✅ **Form-finding — metodología documentada**: `docs/form-finding.md` — rol de la densidad de fuerza **Q**, anclas/objetivo y acotamiento, ejes, y el ejemplo viga cargada → funicular (y arco al invertir la carga). `[#30]`
- ✅ **Pushover — documentar ejecución**: `docs/pushover.md` — los dos pushover (control de desplazamiento geométrico y rótulas plásticas), paso a paso, qué decide el programa (GDL de control, objetivo, pasos), lectura de la curva λ–δ / secuencia de rótulas, y ejemplos (snap-through de cercha von Mises; colapso plástico de pórtico). `[#34]`

---

## Secuencia sugerida
1. **G3** y **G4** — quick wins de uso diario, bajo riesgo.
2. **G1** — alto impacto en el flujo; base para G2 y G9.
3. **G5** — productividad práctica (normativa + asistente).
4. **G8** — robustez.
5. **G2** + **G10/masa** — rendimiento y física modal.
6. **G6** — reportes (la `.docx` se apoya en la memoria).
7. **G9** + **G10/contorno** — verificación y documentación.
8. **G7** — multi-modelo al final (rediseño mayor).

## Decisiones pendientes
- **G2 (método modal)**: ¿qué método de las referencias (subespacio / Lanczos / el documentado allí)?
- **G7 (multi-modelo)**: ¿modelos solo unidos *en la memoria*, o vinculados geométricamente?
- **G9 (verificación SAP2000)**: ¿cuántos casos priorizar (sugerencia: viga, pórtico, muro/shell, modal)?
