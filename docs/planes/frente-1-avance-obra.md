# Frente 1 — Etapas constructivas / avance de obra (`R-18`)

**Estado:** plan para discutir · **Objetivo:** seguimiento visual del avance de obra
del parque (en construcción), con un **visor HUD tipo Stark** por torre y un
**dashboard de avance** a nivel parque.

---

## Estado del arte
El estándar es **4D BIM** (Navisworks, Synchro): 3D + cronograma, **planned-vs-actual**,
Gantt, **curva-S**, reportes diarios (DPR). En eólico, las plataformas de ciclo de
vida (**Sitemark**, **DroneDeploy**, **DJI Progress**) integran **foto de dron → GIS**
con avance, QC y commissioning. Se da por sentado: cronograma con línea base, % por
componente, evidencia fotográfica y dashboard GIS.

## Lo que necesitamos tener (table stakes)
- Cronograma con **línea base** (plan) + fechas reales por partida → medir atraso.
- **Curva-S** del parque (avance acumulado plan vs real).
- **Gantt** por torre y por zona.
- **% por componente** (fundación, fuste, góndola, rotor, cableado/colectora).
- **Reportes exportables** (DPR / semanal, PDF/HTML).
- **Evidencia fotográfica** por hito (requiere almacenamiento → depende de `R-10`).

## Lo que nos diferencia
- **El 4D ya es 3D georreferenciado sobre el relieve real**: el cliente ve el parque
  llenándose sobre el terreno, no un Gantt abstracto ni un ortomosaico plano.
- **Avance acoplado al gemelo estructural** (puente a `R-31`): cada partida muestra
  «% construido **Y** verificado» (f₁ en banda). Ningún 4D BIM acopla avance con física.
- **Vista de flota completa** (curva-S + atrasos de todo el parque) en una escena
  georreferenciada, gratis en navegador.
- **Continuidad construcción → operación**: el mismo 4D se vuelve la vista de SHM.

---

## Diseño / UX

### A) Vista DETALLE de torre — HUD tipo «Stark»
La torre seleccionada aparece **construyéndose** (4D: sólido abajo, fantasma arriba).
Alrededor, **ventanas laterales (callouts) ancladas en 3D**, una por partida, cada una
con una **flecha (línea-guía)** que apunta a su componente:

- Partidas ancladas a su altura: **fundación** (base) · **fuste** (medio) ·
  **góndola** (tope) · **rotor/aspas** (tope) · **cableado/colectora** (base).
- Cada callout colapsada muestra: ícono, nombre, **semáforo** (verde hecho / ámbar en
  ejecución / gris pendiente) y **%**.
- **Clic en una callout →** la cámara hace un **giro/encuadre suave (tween Three.js,
  «el girito»)** hacia ese componente y la ventana **se expande** mostrando:
  - avance % + barra, **fechas plan vs real**, **responsable**;
  - **verificación estructural** (crosslink `R-31`: «Gemelo: f₁ 0.31 Hz · en banda ✓»);
  - **fotos** de la partida (miniaturas) e **informe** descargable;
  - **un botón de acción** en la ventana → **«Abrir partida»** (vista completa de la
    partida: galería de fotos, informes, bitácora, hitos). Acción secundaria en el
    encabezado: **«Ver avance del parque ↗»** (salta al dashboard, vista B).
- Estética HUD: líneas finas, monospace en los números, color de acento, corner-ticks;
  un indicador sutil de «giro de cámara al seleccionar».

*(Mockup de referencia acordado en la conversación — esta es la base visual.)*

### B) Vista PARQUE — dashboard de avance
Resumen agregado (lo que hace «completo» al frente):
- **Curva-S** del parque (acumulado plan vs real) + % global y **atraso (slippage)**.
- **Gantt** por torre y por zona (con hitos y ruta crítica).
- **% por componente** agregado del parque (fundación/fuste/góndola/rotor/cableado).
- **Semáforo de torres atrasadas** (lista + resaltado en la escena/mapa).
- **Exportar** DPR / reporte semanal (PDF/HTML).

### Modelo de datos
Extender `stages` de cada estructura a **partidas por componente**:
```js
stage = {
  id, component,            // 'fundacion'|'fuste'|'gondola'|'rotor'|'cableado'
  pct,                      // avance 0..100
  plannedStart, plannedEnd, // línea base
  actualStart, actualEnd,   // real (actualEnd null = en ejecución)
  responsable,
  fotos: [], informes: [],  // refs (placeholder hasta R-10)
  twinCheck: null           // crosslink R-31: {f1, enBanda} | null
}
```
`built` global = combinación ponderada de las partidas (para el llenado 4D).

---

## Plan por fases (mapeo al código actual)
1. ✅ **Datos por componente** (v242) — `parks_data_caman.js`: `TURBINE_COMPONENTS`/
   `HV_COMPONENTS` (yFrac+ícono) + `enrichStages()` (cronograma sintético realista y
   editable: plan/real, responsable, fotos/informes, `twinCheck`). Persistido en `stages`.
2. ✅ **4D por componente** (v249) — `turbine_mesh.js` expone `c4d` (mast/ghost, góndola,
   rotor sólido/fantasma) y `fleet_view._setTurbineProgress4D`: el fuste se erige por su %,
   góndola y rotor aparecen al completarse su partida (si no, silueta fantasma);
   `setConstructionMode(off)` restaura. `defaultStages` da % parcial a la partida en curso.
3. ✅ **HUD detalle de torre** (v242–v245) — `avance_hud.js`: callouts ancladas con
   línea-guía (`anchorScreenAt`), semáforo+%, expand con datos/fotos, **«Abrir partida»**
   (modal con galería/bitácora/informe). Auto-despliegue, fotos mockup, layout compacto.
4. ✅ **Tween de cámara** («el girito») (v242–v245) — `fleet_view.cameraTo`/`focusComponent`
   + branch `_tween` (ease-in-out ~0.68 s); sesgo a la derecha en modo compacto.
5. ✅ **Dashboard de parque** (v248–v249) — `avance_dashboard.js` (pestaña «Obra»):
   veredicto plan vs real, KPIs, **curva-S**, % por componente, torres atrasadas, informe DPR.
   *(Gantt por torre/zona: pendiente opcional.)*
6. **(Difer.)** crosslink `twinCheck` desde `R-31` (verificación estructural por partida).
7. **(Depende `R-10`)** fotos/informes reales (galería + almacenamiento).

## Estado
**Frente 1 — núcleo completo (v249).** HUD de detalle por componente (callouts, girito,
fotos, layout compacto), 4D por componente en la malla, y dashboard de parque (curva-S,
% por componente, atrasos, DPR). **Pendiente opcional:** Gantt por torre/zona en el
dashboard; **diferido:** crosslink real del gemelo (`R-31`) y fotos/almacenamiento (`R-10`).

## Dependencias
- `R-10` (`DataSource`/BD) para fotos/informes y persistencia industrial.
- `R-31` (gemelo de construcción) para el crosslink de verificación estructural.

## Decisiones
- ✅ **HUD flotante** (sobre la escena 3D), no en el panel lateral.
- ✅ **5 partidas** físicas: fundación · fuste · góndola · rotor · cableado/colectora.
- ✅ **Datos sintéticos primero**; fotos/informe como placeholder hasta `R-10`.
- ✅ **Dos vistas**: detalle de torre (HUD) y resumen de parque (dashboard), separadas.
- ✅ **Botón en la ventanita**: «Abrir partida» (vista completa) + «Ver avance del parque».
- ⬜ Abierto: sub-partidas por componente (p.ej. fundación = hormigonado/curado/anclaje)
  — por ahora, una partida por componente.

## Fuentes
- [4D BIM progress monitoring (planned vs actual, S-curve)](https://excelize.com/4d-progress-monitoring/)
- [Sitemark — wind farm lifecycle platform](https://www.sitemark.com/research/best-solar-inspection-software/)
- [DroneDeploy — construction progress + GIS](https://www.dronedeploy.com/solutions/construction)
