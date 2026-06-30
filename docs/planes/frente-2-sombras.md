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
   izquierda** + panel flotante con sliders **Hora/Día** + animación del día + lectura alt/az.
3. **Worst-case cuantitativo** — proyección del disco del rotor a puntos receptores →
   horas/año, min/día; **ráster de flicker** sobre el terreno.
4. **Real-case estadístico** — % de sol + rosa de vientos + horas de operación.
5. **Reporte de cumplimiento** (30 h / 30 min) + mitigación (calendario de parada).
6. **(Difer.)** sombreado inter-turbina con estimación de pérdida energética.

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
