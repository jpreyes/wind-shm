# Frente 6 — ReWind del **proyecto a la operación**: módulos por fase del ciclo de vida

**Estado:** plan (feedback de JP, 2026-07). **No** rompe lo hecho; reorganiza y
extiende. **Depende de:** módulo de calidad/hitos (Frente 5/5B, hecho) + backend
Supabase (Sprint 0, hecho).

**Tesis en una línea:** ReWind deja de ser «SHM + calidad» y pasa a cubrir **el
ciclo de vida completo del parque** —Proyecto → Obra → Operación → Administración—
con un **módulo por fase**, cada uno anclado a su norma. Lo que ya existe se
reubica; casi nada se tira.

---

## 1. El disparador (feedback de JP)

1. «La información no se está ingresando bien, no veo muchas cosas.» → verificar la
   ingesta/visibilidad del backend (Fase 0).
2. «Es poco interactivo; no sé dónde ver las partidas ni lo que se ha hecho.»
3. «Debería haber un **filtro / modo operación-construcción y uno general**» para
   no saturar de información.
4. «Los HUD de calidad deberían ser más interactivos: si apreto **Fundación** debería
   **ir a Fundación** y poder **volver**. Hoy no hace nada.»
5. «En Partidas dice *tipo de estructura* y solo aparecen 2 (torre/AT); **debería poder
   gestionarlas**» (crear/editar tipos + su WBS: subestación, LAT, vialidad…).
6. «No me gusta que se llame **Calidad**; podría ser **Gestión de Obra**. Y podría
   haber **Gestión de Operación**, **Administración**, **Inspección de torres en
   operación**.»
7. «Llenar **desde el proyecto hasta la operación**. Para el proyecto ya tenemos
   shadow flicker. ISO para la **gestión completa de obras**, no solo el control de
   calidad.»

---

## 2. Marco normativo (investigado) — una norma por fase

| Fase | Módulo ReWind | Normas / metodologías | Ya en ReWind |
|---|---|---|---|
| **Proyecto** | **Proyecto** | ISO 21500/21502 (dirección de proyecto), IEC 61400-1 (diseño), shadow flicker | Shadow flicker (Frente 2) |
| **Construcción** | **Obra** *(ex-Calidad)* | ISO 9001 (calidad), **ISO 19650** (CDE / gestión de información), ISO 21502 (WBS/hitos), ensayos **NCh ≈ ASTM ≈ EN** | Calidad/hitos/4D (Frente 5) |
| **Operación** | **Operación (O&M)** | **ISO 55000/55001/55002** (gestión de activos), **IEC 61400-25** (SCADA/datos), **IEC 61400-26** (disponibilidad), **ISO 17359 + 13372/13379/13381** (monitoreo de condición / diagnóstico / pronóstico), **RCM/CBM**, **IEC TS 61400-28** (integridad estructural + inspección en operación) | SHM, fatiga, salud, alarmas, tendencia, inspección (R-32) |
| **Fin de vida** | *(dentro de Operación)* | **DNV-ST-0262/0263** (extensión de vida), IEC 61400-28, RUL/fatiga | R-22, R-30 (plan) |
| **Transversal** | **Administración / Activos** | **ISO 55000**, **RDS-PP / IEC 81346-10** (designación de referencia de componentes) | — |

**La idea unificadora — RDS-PP:** un sistema de designación (código) identifica **cada
estructura y componente** del parque. El mismo código es la partida en Obra, el activo
en Operación y la línea de costo en Administración. Adoptarlo (aunque sea un campo
`rds` opcional por estructura/partida) es lo que hace coherente «del proyecto a la
operación».

---

## 3. Reestructuración de la app: **navegación por fase**

Hoy el panel derecho mezcla Parque/Selección/Datos/Estado/Obra/Inspección. Se propone
un **selector de FASE** en la barra superior que filtra qué se muestra (resuelve el
punto 3 «modo/filtro» y el 2 «no sé dónde ver»):

```
[ Proyecto ]  [ Obra ]  [ Operación ]  [ Administración ]
```

- Cada fase **filtra** paneles y overlays → menos saturación.
- Coherente con el estado real de cada torre: `built<1` → sesga a **Obra**; operativa →
  **Operación**. (Ya existe `constructionMode`; se generaliza a «fase activa».)
- El toggle actual Avance-4D / SHM pasa a ser consecuencia de la fase.

### 3.1 Módulo **Proyecto**
- Shadow flicker (ya). Emplazamiento, restricciones, permisos (placeholder).
- Línea base de diseño (IEC 61400-1): f₁/f₂ objetivo del gemelo.

### 3.2 Módulo **Obra** *(renombrar «Calidad»)*
- **Rename** Calidad → Obra (menú, pestaña, textos). El control de calidad es *una
  parte* de la gestión de obra, no el todo.
- **WBS con drill-down (punto 4):** click en una partida (p.ej. «Fundación») → **vista
  de partida**: sus protocolos, % de avance, fechas plan/real, responsable, fotos,
  ensayos, crosslink al gemelo, con botón **‹ Volver**. (Reutiliza el patrón «Abrir
  partida» que ya existe en `avance_hud.js`.)
- **Gestión de tipos de estructura (punto 5):** hoy el WBS solo tiene `turbine`/`hv`.
  Permitir **crear/editar tipos** con su propio WBS: subestación, LAT/línea, vialidad,
  plataformas, caminos, obras civiles. Cada tipo → su lista de partidas + geoms.
- **Dónde veo lo hecho:** exponer mejor lo que ya existe (Gantt por torre/zona,
  curva-S, DPR en `avance_dashboard.js`) + tablero de obra por parque.
- Import agnóstico + catálogo normativo (ya) viven aquí.

### 3.3 Módulo **Operación (O&M)**
- **SHM** (ya): señal, estado, tendencia, fatiga, salud, alarmas, comparador,
  benchmarking → se agrupan bajo Operación.
- **Disponibilidad (IEC 61400-26):** KPI time-based y production-based por torre y
  flota (nuevo; se alimenta del backend cuando haya SCADA).
- **Inspección en operación (IEC 61400-28) (punto 6):** el micro-CMMS de inspección
  (R-32) se **reubica** aquí y se estructura por componente (pala · góndola · torre ·
  fundación) con periodicidad y hallazgos. «Inspección de torres en operación».
- **Mantenimiento (RCM/CBM):** órdenes de trabajo, condición → decisión, historial.

### 3.4 Módulo **Administración / Gestión de Activos (ISO 55000)**
- **Registro de activos** con designación **RDS-PP** por estructura/componente.
- KPIs de flota (disponibilidad, producción, salud), **costos O&M**, **vida remanente**
  (DNV-ST-0262), reportes ejecutivos.
- Roles/usuarios (se apoya en el login de Supabase Auth — ver Frente 4).

---

## 4. Fase 0 — arreglar ingesta/visibilidad (el «no veo cosas»)

Antes de reestructurar, cerrar la brecha de datos del backend:
- **Verificar** que `features`/`protocolos`/`structures` realmente entran (Table Editor)
  y que las políticas de lectura devuelven filas (RLS piloto ya).
- **Ampliar el pull:** hoy `pullQuality` solo trae protocolos (parcial, sin ciclos).
  Traer también structures, WBS y perfiles; poblar el dashboard **desde el backend** al
  bootear con backend activo.
- **Indicadores de sync** en la UI: última escritura, nº de filas, estado
  (conectado/escribiendo/error) — para que se **vea** que está entrando.
- Revisar que el dashboard muestre la telemetría del backend (hoy el mapeo feature→
  summary es parcial: sin sensores/olas; enriquecer o etiquetar «modo backend»).

---

## 5. Fases ejecutables

| # | Entregable | Esfuerzo | Nota |
|---|---|---|---|
| **6.0** | Fase 0: verificación + ampliación de la ingesta/pull + indicadores de sync | 1–2 d | Cierra el «no veo cosas» |
| **6.1** | **Rename** Calidad → Obra + **selector de FASE** (Proyecto/Obra/Operación/Admin) que filtra el panel | 1–2 d | Bajo riesgo, gran orden visual |
| **6.2** | **WBS drill-down** (click partida → vista de partida → volver) reusando «Abrir partida» | 1–2 d | Punto 4, alta visibilidad |
| **6.3** | **Gestión de tipos de estructura** + su WBS (más allá de torre/AT) | 2 d | Punto 5 |
| **6.4** | Módulo **Operación**: reagrupar SHM + reubicar inspección (IEC 61400-28) + KPI disponibilidad (IEC 61400-26) | 2–3 d | — |
| **6.5** | Módulo **Administración** (ISO 55000): registro de activos + **RDS-PP** + KPIs/costos/reportes | 3 d | Necesita RDS-PP |
| **6.6** | Módulo **Proyecto**: encuadrar shadow flicker + línea base de diseño | 1 d | Reubicación |
| **6.7** | **RDS-PP** transversal: campo de designación por estructura/partida/componente | 1–2 d | Habilita 6.5 y unifica |

*(Recomendado arrancar por 6.0 → 6.1 → 6.2: cierran el feedback más urgente —ingesta,
orden por fase y HUD interactivo— con bajo riesgo.)*

---

## 6. Qué NO cambia
El motor (solvers del gemelo, modelo canónico de calidad, WBS, backend/DataSource,
shadow flicker) es agnóstico a esta reorganización — es capa de **navegación/UX** +
**nuevos KPIs** + **etiquetado RDS-PP**. Nada del cálculo se reescribe.

## 7. Fuentes (investigación)
- IEC 61400-25 (comunicaciones/SCADA), 61400-26 (disponibilidad), TS 61400-28:2025
  (integridad estructural en operación).
- ISO 55000/55001/55002 (gestión de activos); ISO 17359 + 13372/13379/13381
  (monitoreo de condición).
- ISO 21500/21502 (dirección de proyecto); ISO 19650 (gestión de información/CDE);
  ISO 9001 (calidad).
- DNV-ST-0262/0263 (extensión de vida); RDS-PP / IEC 81346-10 (designación de
  componentes de centrales); RCM/CBM (metodologías de mantenimiento).
