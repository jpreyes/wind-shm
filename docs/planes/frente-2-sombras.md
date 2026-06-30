# Frente 2 — Análisis de sombras / shadow flicker (`R-19`)

**Estado:** plan para discutir · **Objetivo:** evaluar y visualizar la proyección de
sombras del rotor/fuste según la posición solar, para *shadow flicker* hacia
vecinos y sombreado entre máquinas.

---

## Estado del arte
El estándar de facto es **WindPRO (módulo SHADOW)**, aceptado por autoridades. Dos
métodos: **worst-case astronómico** (siempre soleado, siempre girando, aspas
perpendiculares) y **real-case estadístico** (probabilidad de sol + rosa de vientos +
horas de operación). Salidas: **horas/año, días, máx min/día por receptor**, mapas de
flicker y calendario. Límite común: **≤30 h/año y ≤30 min/día** (guía alemana LAI).
Mitigación: módulos de parada (shutdown). Open-source emergente: WIMBY SF.

## Lo que necesitamos tener (table stakes)
- **Posición solar por efemérides** (fecha/hora, lat/lon — ya georreferenciado).
- **Receptores** (viviendas/vecinos) como puntos.
- **Cálculo worst-case**: horas/año y min/día por receptor.
- **Mapa de flicker** (isolíneas de horas/año) + **calendario** por receptor.
- **Chequeo de cumplimiento** vs límite (30 h / 30 min) + reporte.
- **Real-case** (opcional): % de sol + rosa de vientos + horas operativas.

## Lo que nos diferencia
- **Sombra en 3D real, no un contorno 2D**: ya tienes la escena con relieve y torres →
  `castShadow`/`receiveShadow` de Three.js con el **DEM real**, animando el día y el
  año. Herramienta de comunicación con la comunidad que WindPRO (mapas) no da.
- **Sombreado entre máquinas** (turbina sobre turbina → pérdida energética): WindPRO se
  centra en receptores; ReWind también muestra el sombreado máquina-a-máquina.
- **What-if instantáneo**: mover una torre y ver el flicker recalcularse en vivo, en el
  mismo modelo ya cargado, gratis en navegador.
- **Acoplado a operación**: el calendario de parada por sombra puede alimentar el
  dashboard operacional (qué torres curtailar y cuándo).

> Honesto: para grado-autoridad hay que **validar contra WindPRO**. Posicionar como
> **planificación/visualización + screening**, con camino a cumplimiento certificable.

---

## Plan por fases (mapeo al código actual)
1. ✅ **Efemérides solares** (v215) — `js/shm/solar.js`: algoritmo NOAA (azimut/elevación por
   fecha/hora/lat-lon), `sunSceneDir` al sistema de la escena, verificado en Node
   (`node js/shm/solar.js` → solsticios exactos, sol al norte en hemisferio sur).
2. ✅ **Sombras visuales 3D** (v215) — sol = `DirectionalLight` posicionado por la efeméride en
   `fleet_view.js` (`setSunEnabled`/`applySunTime`), PCF soft, intensidad/tinte cálido por
   elevación, noche bajo el horizonte. **Sombras SOBRE el relieve** vía malla receptora que
   comparte la geometría del DEM con `ShadowMaterial` (el ShaderMaterial conceptual no recibe
   sombras); cazador plano de respaldo con el relieve apagado. **Botón «Sol» en la barra lateral
   izquierda** + panel flotante con slider **Hora**, **selector de fecha (con año)** + animación
   del día + lectura alt/az.
   - ✅ **Escala real** (v216): al activar Sol se pasa a proporción 1:1 (torres ×2.2→×0.35,
     relieve vex 1.5→1) para que la **sombra sea físicamente fiel** (y más corta → no se sale del
     relieve); al apagar Sol vuelve a la vista esquemática. Checkbox «Escala real» en el panel.
     *Tradeoff aceptado:* a escala real las torres se ven pequeñas → el encuadre acerca al grupo
     en obra y el 2D será la mejor vista de comparación.
3. ✅ **2D (Leaflet) con sombra + atenuar mapa** (v222) — `MapView.setSunShadows(on, sun)`: por torre,
   sombra en planta (línea del fuste en dir anti-solar, largo = altura erigida/tan(elev), + disco del
   rotor si está montado), **físicamente 1:1** (metros reales). En modo Sol **oculta los divIcons**
   y **atenúa el basemap** (filtro CSS `.mv-sun .leaflet-tile-pane`); sombra en **índigo `#1b2e6b`**
   (igual que en 3D). Se sincroniza con el control de Sol (hora/fecha/animación) vía `window.shmMap`.
4. ✅ **Worst-case cuantitativo** (v227) — `js/shm/shadow_flicker.js`: `annualFlicker(turbines,
   receptor)` integra el año minuto a minuto (worst-case LAI: sol siempre despejado, rotor siempre
   girando) → **horas/año, máx min/día, días afectados** por receptor, considerando todas las
   turbinas operativas en alcance. Verificado en Node (`node js/shm/shadow_flicker.js`: cercano en
   la franja recibe flicker, lejos = 0). UI: en modo Sol, **clic en el mapa 2D coloca un receptor**
   (vivienda) y muestra su flicker + **cumplimiento ≤30 h/año y ≤30 min/día** (verde ✓ / rojo ✗),
   con opción de quitar. *(Pendientes opcionales abajo.)*
5. 🟡 **Real-case (estimación)** (v230) — `annualFlicker` devuelve también `hoursYearReal` =
   worst-case × `REAL_CASE_FACTOR` (≈0.15: P(sol)·P(operación)·P(orientación)); el popup y el
   informe muestran worst-case + estimación real. *Falta el real-case estadístico riguroso* (rosa
   de vientos + % de sol horario), que requiere meteo del sitio (`R-10`).
6. ✅ **Informe de cumplimiento + calendario de parada** (v230/v233) — `flickerReport()` + botón
   «📄 Informe de sombras»: ventana imprimible con todos los receptores (worst-case, min/día, real≈,
   cumplimiento). `annualFlicker` acumula una matriz **mes×hora**; `criticalWindow()` da la **ventana
   de parada sugerida** (meses + horas + pico), mostrada en el popup del receptor y en el informe →
   base de la mitigación por curtailment.
7. ✅ **Sombreado inter-turbina** (v233) — `interTurbineShading()` + botón «🌀 Sombra entre torres»:
   horas/año en que el rotor de cada turbina cae en la sombra de otra (proxy de pérdida por sombra
   mutua; aproxima el buje como receptor). Informe ordenado por turbina. *La pérdida energética fina
   requiere curva de potencia + viento (futuro).*
8. ✅ **Real-case estadístico riguroso** (v235) — `js/shm/meteo_caman.js` (primer trozo de `R-10`:
   una fuente de datos meteo del sitio) aporta % de sol mensual + rosa de vientos + operación.
   `annualFlicker(opt.realWeightFn)` pondera cada instante por **sol·operación·orientación del rotor**
   (cara hacia la línea sol→receptor según el viento) → `hoursYearReal` esperado. Reemplaza al factor
   fijo en los receptores (popup «Real (meteo)» + informe). *Datos estimados; refinar con TMY/estación
   (camino industrial de `R-10`).* Verificado en Node (worst 43.5 → real 5.9 h/año).
9. ✅ **Sombra del relieve mucho más tenue que la de las torres** (v236) — Three.js r164 filtra el
   casteo de sombra por la cámara principal (no por luz), así que no se pueden separar en dos mapas
   por tipo de objeto. Se resuelve en dos niveles: el relieve **deja de castear** al mapa y su sombra
   pasa a ser **hillshade del shader** siguiendo al sol real (`uLight`, normal en mundo) → tenue; las
   torres siguen con sombra proyectada, ahora más marcada (`ShadowMaterial` opacity 0.36→0.44).
10. ✅ **Pestaña «Shadow flicker» en el panel derecho** (v237) — los análisis migran al dashboard como
   3ª pestaña (Parque · Selección · Shadow flicker): mapa de flicker, informe de cumplimiento,
   sombreado entre torres y la **lista viva de receptores** (worst/real + quitar). Los controles de
   hora/fecha quedan en el HUD flotante sobre el visor. Activar «Shadow» abre la pestaña; agregar/
   quitar receptores en el 2D la refresca (`map_view.removeReceptor` + `window.shmDash.refreshShadow`).

## Dependencias
- Receptores (viviendas) como capa de datos del parque.
- Real-case: datos meteorológicos (% de sol, rosa de vientos) — encaja con `R-10`.

## Decisiones
- ⬜ ¿Receptores cargables manualmente (clic en el mapa) o importados (KMZ/CSV)?
- ⬜ ¿Worst-case primero (autocontenido) y real-case después? (recomendado).
- ⬜ Alcance v1: ¿solo visualización 3D + worst-case, dejando cumplimiento para v2?

## Fuentes
- [windPRO SHADOW module — EMD International](https://www.emd-international.com/software/windpro/modules/shadow)
- [Shadow flicker assessment — TÜV NORD](https://www.tuev-nord.de/en/company/energy/renewables/wind-energy/shadow-flicker-assessment/)
- [WIMBY — open-source shadow flicker tool](https://wimby.eu/resource/an-open-source-tool-to-assess-shadow-flicker-of-wind-turbines-the-wimby-sf-tool/)
