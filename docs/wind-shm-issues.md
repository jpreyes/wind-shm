# wind-shm — bugs y funcionalidades por cubrir

Bitácora viva de lo detectado al construir el SHM de torres eólicas sobre structweb3d.
Marcar ✅ al resolver. Severidad: 🔴 bloquea · 🟡 limita fidelidad · 🟢 mejora.

---

## 1. Bugs

| Estado | Sev | Dónde | Descripción | Fix |
|---|---|---|---|---|
| ✅ | 🔴 | `js/model/macros/turbine.js` | `const eRNA = +p.eRNA ?? 2.0` no aplicaba el default: `+undefined` = `NaN` y `??` **no** atrapa `NaN` (solo null/undefined). Metía `NaN` en la posición de la RNA → el brazo rígido propagaba `NaN` a K (ry, rz del nodo tope) → modal NaN. | Resuelto con `Number.isFinite(+p.eRNA) ? +p.eRNA : 2.0` (preserva el `0` válido). |
| — | — | (auditoría) | Se buscó el mismo patrón `+x ?? def` y `parseFloat(x) ?? def` en todo `js/`: **sin otras ocurrencias**. | — |

---

## 2. Brechas del motor (limitan la fidelidad del gemelo digital)

> ⚠️ Estas viven en el **motor compartido** → también afectan a PÓRTICO original.
> Documentadas con archivo/línea/repro/fix para llevar a structweb3d en
> **[docs/engine-issues-upstream.md](engine-issues-upstream.md)** (E1–E5).

| Estado | Sev | Tema | Situación actual | Propuesta |
|---|---|---|---|---|
| ⬜ | 🟡 | **Inercia rotacional de masa nodal** | `node.nodeMass = {mx,my,mz}` es **solo traslacional**; el ensamblador no puebla los GDL rx/ry/rz de M. La inercia rotacional de la RNA se emula hoy con el **truco del brazo rígido** (masa excéntrica + link). | Añadir `nodeMass.Irx/Iry/Irz` y poblarlos en `assembler.js` (líneas ~98-106). 3 líneas. Permitiría inercia de RNA explícita y limpia para los modos de cabeceo. |
| ⬜ | 🟡 | **Resortes de fundación acoplados (K_LR)** | `node.springs` solo agrega rigidez en la **diagonal** (kux…krz). El término **cruzado lateral–rocking** de los "coupled springs" no entra. | Hoy se aproxima con la **pila enterrada** (`baseType=1`, lo genera natural) o con el modelo diagonal (suficiente para f₁). Mejora: permitir términos fuera de diagonal en `node.springs` o un macro de cabeza de fundación. |
| ⬜ | 🟡 | **Resortes verticales compression-only (gapping)** | `el.compressionOnly` existe a nivel **de elemento** (barra), pero `node.springs` son **lineales**. Para el despegue/rocking con levantamiento de una fundación de gravedad hace falta una **cama de resortes verticales solo-compresión**. | Modelar la cama como barras verticales cortas `compressionOnly` bajo la base (ya soportado), o agregar `node.springs.compressionOnly` por GDL. Va a la vista Avanzado (daño). |
| ⬜ | 🟢 | **Curvas p–y no lineales (suelo)** | El roadmap de macromodelos ya lo lista; aún no hay capacidad NL de resorte p–y/t–z/q–z. | Integrar como capacidad reusable del motor NL (ver `docs/macromodelos.md` §"Capacidades NL transversales"). Para estudio de daño en Avanzado. |
| ⬜ | 🟢 | **Masa rotacional nula en nodo esclavo** | El nodo RNA tiene masa solo traslacional; sus GDL rotacionales quedan con M≈0. El modal le suma un `eps` (ok), pero es un parche. | Se resuelve solo al implementar la inercia rotacional nodal (fila 1 de esta tabla). |

---

## 3. Funcionalidades SHM por implementar (backlog de construcción)

No son bugs: es lo nuevo que falta construir sobre el gemelo digital ya verificado.

- ⬜ 🔴 **Capa `DataSource`** (abstracción) con `SimulatedSource` (señal sintética desde los modos reales) y `LiveSource` (nube). El dashboard/ML no deben saber cuál usan.
- ⬜ 🔴 **Visual Three.js de la torre** sobre el macro `turbine`: fuste cónico, góndola, aspas girando, viento.
- ⬜ 🔴 **Flota multi-torre** con `InstancedMesh` + LOD + frustum culling (~100 torres) y selección con zoom cinematográfico (las demás atenuadas).
- ⬜ 🔴 **Capa de vida** (sensores MEMS + gateway): puntos parpadeantes vía shader (uniform de tiempo + fase por instancia), color = activo/intermitente/caído. Debe verse en **todas** las torres en cámara.
- ⬜ 🟡 **Dashboard SHM** en el panel derecho: Señal · Datos · Estado estructural · Movimiento · **Avanzado** (diagramas N/V/M + análisis no lineal de daño escondidos aquí).
- ⬜ 🟡 **Enganche acelerogramas medidos → time-history modal** del gemelo (model updating / detección de daño por caída de frecuencia).
- ⬜ 🟡 **ML / Population-Based SHM**: línea base por torre + aprendizaje entre torres de la flota.
- ⬜ 🟢 **Reorientar el Cloudflare Worker** (hoy asistente LLM) a **ingesta de telemetría** (gateway → Worker → Durable Object → WebSocket) y a **Asistente SHM** en lenguaje natural.

---

## 4. Recortes pendientes (spec keep/remove acordada)

Ver `CLAUDE.md` §"wind-shm". Estrategia: **ocultar tras flag, no borrar** mientras se construye lo nuevo. Pendiente ejecutar el recorte (toolbar de modelado, espectro, diafragmas, combos, diseño, etc.) y mover a "Avanzado" los análisis no lineales de daño + diagramas de fuerza.
