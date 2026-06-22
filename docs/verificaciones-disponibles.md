# Casos de verificación disponibles — barrido de `referencias/verifications/`

Evaluación de los **242 PDF** de `referencias/verifications/` (suite de verificación de
análisis de **CSI/SAP2000** «Problem N-XXX», más manuales SOFiSTiK) según **qué capacidad
actual de PÓRTICO** puede verificarse o ejemplificarse con cada uno. Alimenta G9 / `[#19]`
(convertir casos de la literatura a `.s3d`, comparar/documentar, dejar como Ejemplos).

Leyenda: ⭐ = caso ideal (respuesta analítica/independiente, geometría chica) · ✅ directo ·
🟡 parcial (requiere adaptar o una sub-capacidad que falta) · ⛔ fuera de alcance hoy.

Las familias por número CSI: `1-xxx` Frames · `2-xxx` Shells · `3-xxx` Planes ·
`6-xxx` Links · `7-xxx` Cables.

## Estado de avance (materialización)

Pipeline batcheado en `tools/run_verifs.mjs` (solver headless + figura SVG + comparador +
MD/PDF con membrete IOC). Las figuras de los PDF se leen con **poppler** (`pdftoppm`,
instalado en `%LOCALAPPDATA%\poppler`) → la geometría de cualquier caso es reconstruible.

| Caso | Capacidad | Estado | Dif. máx vs. referencia |
|---|---|---|---|
| **1-014** | Modal — viga en voladizo | ✅ hecho | 0.024 % |
| **1-021** | Modal — pórtico Bathe-Wilson 10×9 | ✅ hecho | modo 1 +0.05 %, modos 2-3 <1.3 % |
| **1-018** | Estático — flexión+corte+axial | ✅ hecho | **0.000 %** |

Documentos en `docs/verificaciones/<slug>.{md,pdf}`, modelos en `examples/verif_*.s3d`.

---

## 1. Análisis estático lineal — pórticos (barra/viga/columna)

| Caso | Qué prueba | Uso |
|---|---|---|
| **1-001** Frame — general loading | 3 barras, 7 casos (dist + puntual) → desplazamientos y esfuerzos | ⭐ humo general del estático |
| **1-018** Bending, shear & axial deformations in a rigid frame | marco rígido; **incluye deformación por corte** | ✅ **HECHO** (dif 0.000 %) — valida `timoshenko.js` |
| **1-003** Distributed & concentrated moments | torsión en un eje (momentos torsores) | ✅ torsión / GL rz |
| **1-004** Rotated local axes | cargas con ejes locales 2-3 girados | ✅ ejes locales + proyección de carga |
| **1-007** Frame end releases | rótulas en extremos (releases) | ⭐ valida `applyReleases` |
| **1-002** Frame temperature loading | ΔT uniforme y gradiente en barra | ✅ carga térmica (`type:'temp'`) |
| **1-013** Beam on elastic foundation | resorte de línea | 🟡 aprox. discretizando + resortes nodales |
| **1-008** Partial fixity end releases | rótulas de **fijación parcial** (resorte de extremo) | 🟡 PÓRTICO sólo tiene release total 0/1 |
| **1-005** Displacement loading (settlement) | asentamiento/giro impuesto en apoyo | ⛔ no hay desplazamiento prescrito de apoyo |
| 1-006 no-prismático · 1-009 pretensado tendón · 1-010 end offsets · 1-011 insertion point · 1-027 etapas constructivas · 1-030 moving loads | features no soportadas | ⛔ |

## 2. Análisis modal (frecuencias, formas, masa participante)

| Caso | Qué prueba | Uso |
|---|---|---|
| **1-014** Frame — eigenvalue (viga en voladizo) | frecuencias de viga | ✅ **HECHO** (dif 0.024 %) |
| **1-021** Bathe & Wilson eigenvalue (10 vanos, 9 pisos) | benchmark clásico de subespacio | ✅ **HECHO** (modo 1 +0.05 %) |
| **1-023** ASME eigenvalue (marco 3D) | modal 3D con masas | ✅ modal 3D |
| **2-008** Shell — cantilever plate eigenvalue | modal de placa/cáscara | ✅ modal con elementos de área |
| **1-017** Vibration of a string under tension | modos con **rigidez geométrica** (cuerda tensa) | 🟡 el modal no incluye Kg de pretensión |

## 3. Espectro de respuesta (CQC / SRSS)

| Caso | Qué prueba | Uso |
|---|---|---|
| **1-020** Response spectrum — marco 2D | espectro 5 %, combinación modal | ⭐ verificación de espectro |
| **1-024** Response spectrum — marco 3D | CQC en 3D, desplaz. del centro de masa | ⭐ espectro 3D + diafragma |
| **1-025** Response spectrum — marco 3D arriostrado en L | CQC, torsión | ✅ espectro con irregularidad |

## 4. Time-history modal lineal (G12, nuevo)

| Caso | Qué prueba | Uso |
|---|---|---|
| **1-022** 2D moment frame — static + dynamic (sismo) | historia en el tiempo modal ante sismo | ⭐ verificación directa del time-history |
| **1-015** Steady-state harmonic / periodic time history | respuesta a carga armónica | 🟡 PÓRTICO hace TH transitoria (no steady-state), pero el transitorio converge al régimen ⇒ comparable |

## 5. NL-lite (cables, P-Delta, pandeo, rótulas, form-finding)

| Caso | Qué prueba | Uso |
|---|---|---|
| **1-016** Tension stiffening using P-Delta | rigidización por tracción (P-Delta) | ⭐ valida `runPDelta` / `assembleKg` |
| **1-019** Buckling of a rigid frame | carga crítica de marco | ⭐ valida `solveBuckling` (ya verificado vs Euler) |
| **7-001** Cable — uniform & temperature | catenaria bajo carga uniforme | ⭐ cable NL / form-finding |
| **7-002** Cable — uniform & concentrated | cable con carga puntual | ✅ cable NL |
| **7-003** Prestressed cable net | red de cables pretensada | ⭐ form-finding (FDM) — análogo a `test_formfind` |
| **1-026** Moment and shear hinges (static nonlinear) | rótulas plásticas / pushover | ⭐ valida `runPlastic` (rótulas de momento) |
| **1-028** Large axial displacements (arco triarticulado) | snap-through geométrico | ⭐ valida `solveNonlinearDC` (control de desplaz.) |
| **1-012** No-tension / no-compression frame | barras sólo-tracción | 🟡 mapea al cable «tension-only» del NL-lite |
| **1-029** Large bending displacements (voladizo, momento) | gran rotación con **flexión** corotacional | ⛔ el NL-lite es de barra/cable (sin flexión corotacional) |

## 6. Elementos de área — membrana / placa / cáscara

| Caso | Qué prueba | Uso |
|---|---|---|
| **2-006** Scordelis-Lo roof | benchmark de cáscara por excelencia | ⭐⭐ valida shell = membrana+placa |
| **2-007** Hemispherical shell | membrana + flexión, modos rígidos | ⭐⭐ benchmark clásico de cáscara |
| **2-005** Rectangular plate — static | flexión de placa | ⭐ valida MITC4 / DKT |
| **2-012** Plate bending, shear significativo (placa gruesa) | bloqueo por corte | ⭐ valida MITC4 (sin shear-locking) |
| **2-002** Straight beam (shell) | viga modelada con cáscara | ✅ membrana/cáscara |
| **2-003** Curved beam · **2-004** Twisted beam | curvatura / alabeo | ✅ cáscara |
| **2-009** Plate on elastic foundation | placa + resortes | ✅ placa + resortes nodales |
| **2-013 / 2-014** Temperature (constante / gradiente en el espesor) | térmica en área | ✅ (gradiente en espesor = 🟡) |
| **2-010** Cylinder internal pressure · **2-011** Cooling tower (viento) | membrana de revolución | ✅ membrana (geometría grande) |
| **3-002** Plane — straight beam · **3-003** curved beam | continuo plano (≈ membrana) | 🟡 mapea a membrana CST/QUAD |
| **2-001 / 3-001** Patch test (desplaz. prescrito) | consistencia del elemento | 🟡 requiere desplaz. prescrito |
| **3-004** Thick-walled cylinder (deformación plana) | plane-strain | 🟡 la membrana de PÓRTICO es tensión plana |
| 2-015 ortótropo · 2-016/2-017 pandeo de cáscara · 2-018/2-019 grandes desplaz. · 2-020 pretensado · 3-005 presión de poros | material/no-lineal no soportado en áreas | ⛔ |

---

## Fuera de alcance (PÓRTICO es ANÁLISIS, no diseño de miembros)

- **Steel Frame (47)**, **Concrete Frame (42)**, **Cold Formed Steel Frame (17)**, **Design (53)**,
  **Concrete Shell** (ACI-350 diseño), **Vibration / AISC-DG11** (vibración de piso por norma):
  el **chequeo de diseño por código** (AISC/ACI/EC) queda fuera. ⛔ **Pero su parte de ANÁLISIS
  sí es verificable** (esfuerzos/desplazamientos del modelo antes del diseño) → ver
  «Verificación de análisis desde ejemplos de diseño» más abajo.
- **Links (6-xxx, 12)**: amortiguadores, aisladores (rubber / friction pendulum), gap, hook, Wen
  plástico, link dependiente de frecuencia. PÓRTICO sólo tiene **resortes lineales** nodales →
  sólo **6-001** (linear link) es 🟡 asimilable a un resorte; el resto ⛔.
- **Workshop_Madrid_2012 (SOFiSTiK)**: proyectos-demo (puentes, etapas constructivas, lanzamiento
  incremental, cable-stayed) en `.dat`; no son casos de verificación con respuesta cerrada.
  Algunos temas (05 lateral buckling, 06 pushover, 09 shell buckling) son **conceptualmente** afines
  al NL-lite pero no aptos como verificación numérica limpia.
- **`verification_manual.pdf` (SOFiSTiK 2014)**: manual extenso con benchmarks BE/AE; fuente
  secundaria rica para vigas/placas/dinámica si se quiere ampliar más allá de la suite CSI.

---

## Prioridad sugerida para materializar (orden de implementación de G9)

Siguiendo la decisión de **modal primero**, luego viga, pórtico y muro/cáscara:

1. **Modal**: `1-014` (voladizo) → `1-021` (Bathe-Wilson) → `1-023` (3D).
2. **Estático viga/pórtico**: `1-001` (humo) → `1-018` (corte+flexión+axial) → `1-007` (releases) → `1-002` (térmica).
3. **Espectro**: `1-020` (2D) → `1-024` (3D).
4. **Time-history**: `1-022` (sismo) → `1-015` (armónico).
5. **NL-lite**: `1-016` (P-Delta) · `1-019` (pandeo) · `1-026` (rótulas) · `1-028` (snap-through) · `7-001/7-003` (cables/form-finding).
6. **Áreas/cáscara**: `2-005` (placa) → `2-012` (placa gruesa) → `2-006` Scordelis-Lo → `2-007` (hemisferio).

Cada uno se convierte a `.s3d`, se corre en PÓRTICO, se compara contra el valor de referencia del
PDF (y/o la solución analítica) y se documenta + se deja en **Ejemplos** (`examples/`).

---

## Verificación de ANÁLISIS desde ejemplos de diseño *(solo la parte de análisis)*

Aunque PÓRTICO no hace el **chequeo de diseño** por código, cada ejemplo de diseño define un
**modelo + cargas** y reporta los **esfuerzos de análisis** (M, V, N) usados para el diseño. Esa
parte de análisis **sí se puede verificar**: se reconstruye el modelo, se corre el estático y se
comparan los esfuerzos contra los valores del ejemplo, **ignorando el chequeo de capacidad**. Suma
amplitud de verificación «gratis», aunque a escala de **miembro / marco chico**.

- **Concrete Frame (ACI/EC/BS/AS/CSA/IS/KBC… × 42)** y **Steel Frame (× 47)**: en su mayoría una
  viga o columna (o un marco de pocos miembros) bajo carga última; reportan **M_u, V_u** (o N, M de
  la columna). Verificación de análisis = reproducir el **diagrama de momento/cortante** del miembro.
  Ej.: *ACI 318 Ex001* = viga simplemente apoyada, q_u = 9.736 k/ft → comparar M_max, V_max.
- **Aluminum / Cold-Formed Frame**: idem, miembro bajo carga; verificable la solicitación.
- **Concrete Shell (ACI-350)**: el modelo de cáscara + su solicitación (Nx, My) — verificable con el
  postproceso de áreas una vez listo el runner de cáscara.

Estrategia: extraer del PDF (con la figura ya legible vía poppler) la **geometría + cargas**, correr
PÓRTICO y comparar **sólo los esfuerzos de análisis** (no el refuerzo / la razón D/C). Etiquetar
estos casos como *«análisis de ejemplo de diseño»* para distinguirlos de las verificaciones de
análisis puras.

## Estructuras medianas/grandes — edificios y puentes

El objetivo de verificar **estructuras realistas** (edificios, puentes) se cubre por tres vías:

1. **Edificios — ya en la suite CSI (Frames)**, con valores de referencia de análisis:
   - `1-020` pórtico 2D + **espectro de respuesta** (edificio de cortante).
   - `1-022` pórtico de **7 pisos** — estático + **dinámico (sismo)**.
   - `1-024` pórtico 3D de momento — **espectro 3D** (períodos, desplaz. del centro de masa, cortantes).
   - `1-025` edificio 3D en **L (3 pisos)** arriostrado — espectro, torsión.
   Son **medianos** y verifican el flujo edificio (modal + diafragma + espectro). **Prioridad alta**
   para «estructura real»: hacerlos tras cerrar modal/estático.
2. **Modelos propios representativos** (cuando no haya referencia cerrada): construir un **edificio
   de varios pisos** (pórtico de momento + diafragmas) y un **puente** (viga continua / pórtico de
   pila + tablero) y verificar por **equilibrio global** (ΣReacciones = ΣCargas), **hand-calc** de
   casos límite y **cruce** con la solución analítica de tramos. Es el patrón de los `test_*.mjs`.
3. **Puentes — referencias SOFiSTiK**: el `verification_manual.pdf` (SOFiSTiK 2014) y el
   Workshop_Madrid traen vigas continuas, tableros y pilas; útiles como **geometría + carga** para
   construir el modelo de puente, validando el análisis por equilibrio/hand-calc (no traen respuesta
   cerrada lista, pero sí la descripción del modelo).

> Nota: PÓRTICO no modela aún **etapas constructivas**, **pretensado por tendones**, **cargas
> móviles** ni **apoyos con desplazamiento prescrito** (ver `capacidades-portico.md`), por lo que los
> modelos de puente se acotan al **análisis estático/modal/espectral** de la estructura terminada.
