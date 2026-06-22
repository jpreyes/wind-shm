# Capacidades de PÓRTICO frente a los ejemplos de verificación

Mapa honesto de **qué hace PÓRTICO**, qué hace **parcialmente** y qué **no hace**, contrastado con
la suite de verificación de análisis de CSI/SAP2000 (`referencias/verifications/`). Sirve para saber
qué casos se pueden materializar tal cual, cuáles requieren una sub-capacidad nueva y cuáles quedan
fuera. Complementa [`verificaciones-disponibles.md`](verificaciones-disponibles.md).

Estado: ✅ completo · 🟡 parcial · ⛔ no disponible.

---

## ✅ Capacidades completas (verificables directamente)

- **Estático lineal** de pórticos 3D: barra/viga/columna **Timoshenko** (flexión + corte + axial +
  torsión). *(Verificado: 1-018, dif 0.000 %.)*
- **Cargas**: nodales, distribuidas uniformes y **trapezoidales**, **térmicas** (ΔT en barra y área),
  peso propio; proyección de carga con ejes locales rotados.
- **Liberaciones de extremo** (rótulas) totales por GDL (release 0/1).
- **Resortes nodales** (apoyos elásticos) y restricciones de **diafragma rígido** (penalti) con masa
  y centro de rigidez de piso.
- **Modal**: autovalores/períodos, formas modales, masa participante; iteración de **subespacio**
  (Bathe) o Stodola. *(Verificado: 1-014 dif 0.024 %, 1-021 modo 1 +0.05 %.)*
- **Espectro de respuesta** (combinación **CQC / SRSS**).
- **Time-history modal lineal** (Duhamel / Nigam-Jennings; excitación uniforme en la base).
- **NL-lite**: P-Delta, **pandeo lineal** (autovalores K+λKg), **cables** tension-only y pretensado,
  **form-finding** (FDM), **rótulas plásticas / pushover** (control de carga y de desplazamiento).
- **Elementos de área**: membrana CST/QUAD, placa **MITC4 / DKT**, cáscara (membrana+placa),
  tensiones de von Mises; postproceso de áreas y modelos sólo-área (muros/losas).

---

## 🟡 Capacidades parciales (requieren adaptar o falta una sub-capacidad)

| Tema | Qué hay | Qué falta | Caso CSI |
|---|---|---|---|
| **Fijación parcial de extremo** | release total 0/1 | resorte de fijación parcial (rigidez de extremo finita) | 1-008 |
| **Resorte de línea / viga sobre fundación** | resortes **nodales** | resorte distribuido (se aproxima discretizando + resortes nodales) | 1-013 |
| **Continuo plano** | membrana en **tensión plana** | **deformación plana** (plane-strain) y plane-stress puro de un continuo | 3-001/3-004 |
| **Modal con rigidez geométrica** | modal sobre K elástica | incluir **Kg** de pretensión en el modal (cuerda/cable tenso) | 1-017 |
| **Pandeo** | pandeo de **barras** (Kg de pórtico) | **pandeo de cáscara/área** (out-of-plane / in-plane) | 2-016/2-017 |
| **Time-history — esfuerzos** | historia nodal + esfuerzos de **barra** | **historia de tensiones de área** (von Mises σ(t)) | (#51) |
| **NL geométrico** | barra/cable **corotacional** | **gran rotación con flexión** (viga corotacional) y NL de área | 1-029, 2-018/2-019 |
| **Pushover control-δ** | idealiza **reticulado** (sólo axial) | pushover a **flexión** por control de desplazamiento (para eso están las rótulas) | — |
| **Térmica en área** | ΔT constante en el espesor | **gradiente** de temperatura a través del espesor | 2-014 |

---

## ⛔ Capacidades no disponibles (según los ejemplos de verificación)

**Modelado de barra / sección**
- **Desplazamiento prescrito de apoyo / asentamiento** impuesto (1-005).
- **Secciones no prismáticas** (variación A/I a lo largo) (1-006).
- **Pretensado por tendones** (perfil parabólico, fuerza de tesado) (1-009).
- **End offsets / brazos rígidos** de extremo (1-010).
- **Insertion point / cardinal point** (excentricidad de inserción) (1-011).

**Procesos / cargas avanzadas**
- **Construcción por etapas** (staged construction) (1-027).
- **Cargas móviles** (moving loads / líneas de influencia) (1-030, CSiBridge).

**Elementos LINK** (6-xxx) — PÓRTICO sólo tiene resortes lineales nodales:
- Amortiguadores (lineales y no lineales, exponente de velocidad) (6-005/6-006/6-007).
- Aisladores: **goma** y **péndulo de fricción** (6-010/6-011).
- **Gap** (sólo compresión) y **hook** (sólo tracción) (6-003/6-004).
- **Wen plástico** / kinemático (6-008/6-009) y link **dependiente de frecuencia** (6-012).

**Áreas / materiales**
- **Materiales ortótropos** (2-015).
- **No linealidad de área** (grandes desplazamientos 2-018/2-019), **pretensado de área** (2-020).
- **Presión de poros / acoplamiento** hidromecánico (3-005).

**Dinámica avanzada**
- **Time-history NO lineal incremental** (con formación de rótulas) — diferido `[#48b]`.

**Diseño (todo el grupo Design/Steel/Concrete/Cold-Formed/Vibration-AISC)**
- **Chequeo de diseño por código** (AISC, ACI, EC, AS, BS, CSA, IS, KBC, NTC, NZS…): razones D/C,
  refuerzo, vibración de piso por norma. PÓRTICO es **analizador, no diseñador**. *(La parte de
  ANÁLISIS de esos ejemplos sí es verificable — ver verificaciones-disponibles.md.)*

---

## Resumen

PÓRTICO cubre con solidez el **análisis estático, modal, espectral, time-history lineal y un set
NL-lite** sobre **barras y áreas (cáscara)**. Las brechas se concentran en: **elementos especiales**
(links/aisladores/amortiguadores), **procesos** (etapas constructivas, cargas móviles, pretensado),
**no linealidad avanzada** (gran rotación con flexión, NL de área, time-history NL) y el **diseño por
código** (deliberadamente fuera de alcance). Ninguna brecha impide verificar el **núcleo de análisis**
ni modelar **edificios y puentes** a nivel de análisis estático/modal/espectral.
