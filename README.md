# ReWind — Monitoreo de Salud Estructural (SHM) de parques eólicos

Herramienta web para **monitorear la salud estructural** de un parque de
aerogeneradores (y sus torres de alta tensión asociadas): una flota viva en 3D,
georreferenciada sobre el relieve real, con capa de sensores, seguimiento del
**avance de obra (4D)** e informe de estado estructural por torre.

Desarrollada por **Dr. Juan Patricio Reyes C.** — Instituto de Obras Civiles,
Facultad de Ciencias de la Ingeniería, Universidad Austral de Chile.

> **Parque de referencia:** *Camán I* (Región de Los Ríos, Chile), en etapa
> constructiva. Datos reales de coordenadas y trazado de caminos; el avance de
> obra y la telemetría de sensores son por ahora **sintéticos editables**.

No requiere instalación — solo un navegador moderno (Chrome, Edge, Firefox).

---

## Qué es ReWind

ReWind monitorea la salud estructural de un parque eólico. Combina una **flota
viva en 3D** con un **gemelo digital** físico por torre: un motor de elementos
finitos (modal/estático) que calcula las frecuencias propias f₁/f₂ y la deformada
a partir de los desplazamientos medidos.

Cada torre lleva **2 acelerómetros MEMS** (tope + centro del fuste) + un gateway.
La configuración de 2 nodos es intencional: alcanza para los **2 primeros modos
de flexión** + un vector de características para ML.

### Capacidades hoy

- **Flota 3D** del parque con turbinas reconocibles (góndola + rotor); las
  operativas giran, las no construidas se muestran como silueta «fantasma».
- **Georreferenciación** (lon/lat → ENU local) sobre un **relieve conceptual 3D**
  (curvas de nivel, tinte hipsométrico, sin paisaje satelital) + caminos.
- **Mapa 2D** estilo Google Earth liviano (Leaflet) en ventana PiP /
  pantalla completa, con íconos de torre eólica y torre AT.
- **Avance de obra 4D**: cada estructura se «llena» de abajo hacia arriba según
  su porcentaje; etapas editables con % y fecha por torre.
- **Árbol lateral** Parque ▸ Zona ▸ Torre (CRUD, renombrar inline, eliminar).
- **Dashboard SHM** en el panel derecho (Señal · Datos · Estado estructural ·
  Movimiento) + **informe** de vibración con deformada medida y velocímetro de
  estado (clasificación ML 0–4).
- **Capa de vida**: sensores y gateways parpadeantes (heartbeat) coloreados por
  estado (activo / rezagado / fuera de línea).

---

## Cómo abrir la aplicación

**Servidor local (recomendado):**

```bash
python serve.py 8765
```

Luego abrir **http://localhost:8765** en el navegador. `serve.py` es un servidor
estático sin caché que fija los MIME correctos (`UTF-8`, `.webmanifest`);
`python -m http.server 8765` también funciona pero sin esos encabezados.

**En producción:** ReWind se publica en **GitHub Pages** desde la rama `main`
(sitio estático puro, sin build). Cada `git push` a `main` republica el sitio.

---

## Arquitectura (resumen)

Vanilla JS (ES modules) + Three.js + Leaflet + un pequeño `numeric.js`.
**Sin build, sin bundler, sin framework, sin `package.json`** en la app:
`index.html` carga los módulos por importmap con cache-busting `?v=NNN`. PWA
instalable/offline. UI, comentarios y commits **en español**.

```
js/shm/            ← toda la app ReWind (flota, relieve, mapa, dashboard, gemelo)
js/model/          ← model.js, serializer.js, macro_registry.js, macros/turbine.js
js/solver/         ← 10 módulos del gemelo digital (assembler, timoshenko,
                     static/modal, postprocess, membrane, plate, diaphragm, links)
asistente/         ← generador.js (genera la celosía 3D de las torres AT)
lib/               ← three, numeric.js, leaflet (vendorizados)
bridge/            ← (futuro) ESP32 → MQTT → InfluxDB para telemetría real
data/              ← parque Camán I + DEM (heightmap) — no versionado
```

Detalle completo de convenciones y arquitectura en **`CLAUDE.md`**.
Plan de trabajo y estado en **`docs/ROADMAP.md`** (ítems `R-*`).

---

## Convención de coordenadas

| Eje | Dirección |
|-----|-----------|
| **X** | Este – Oeste |
| **Y** | Norte – Sur |
| **Z** | Vertical (arriba) |

Mapeo a Three.js: `model(x,y,z) → three(x, z, y)`.
Georreferenciación: lon/lat (WGS84) → ENU local en metros desde el centro del
parque × factor de escala de layout.

---

## Desarrollo

- **Verificar sintaxis de un módulo ES:** `node --input-type=module --check < js/ruta/archivo.js`
  (no usar `node --check archivo.js`: trata `.js` como CommonJS y deja pasar ESM inválido).
- **Tests del generador:** `node asistente/test_generador.mjs`,
  `node asistente/test_torre.mjs` — comparan contra equilibrio global y
  soluciones analíticas. No hay runner; cada archivo es su propio entrypoint.
- **Versionado / deploy:** al publicar un cambio en JS/CSS, subir el `?v=NNN` en
  todos los archivos a la vez + `REWIND_VER` (`js/shm/shm_mode.js`) +
  `CACHE_VERSION` (`sw.js`, independiente). Luego `git push` a `main`.

---

## Generador de torres AT (`asistente/`)

Las **torres de alta tensión** del parque se generan como celosía 3D a partir de
una *ficha* JSON, por un generador **determinista** (sin LLM):

- **`asistente/generador.js`** — módulo ES puro (Node + navegador). Una ficha
  `tipologia:"torre"` (`torre:{altura_m, base_m, cima_m, paneles, arriostramiento,
  crucetas:[…]}`) → modelo `.s3d`: 4 patas cónicas en *n* paneles, anillos
  horizontales, diagonales en X por cara, crucetas/ménsulas para los conductores,
  apoyos en la base y cargas de viento/cable+hielo.
- **`asistente/cargas.js`** — magnitudes normativas (NCh) que usa el generador.
- **Tests:** `node asistente/test_torre.mjs` (geometría + estabilidad + ΣFz) y
  `node asistente/test_generador.mjs`. Validan contra equilibrio global / solución
  analítica.

---

## Datos en vivo — bridge ESP32 → InfluxDB (`bridge/`, futuro)

Hoy la app consume datos **simulados** vía la abstracción `DataSource`
(`js/shm/data_source.js`). El camino **en vivo** respeta el mismo esquema y vive
en `bridge/` (paquete aislado con su propio `package.json`; no afecta al sitio
estático). Cadena planificada:

```
ESP32 (100 Hz, int16 por lotes) --MQTT binario--> Mosquitto/EMQX
   --> mqtt_influx_bridge.mjs --> InfluxDB (serie cruda)
   --> backend de features (RMS·f₁·FFT·ML) --tick--> navegador
```

**Trama binaria** (`bridge/accel_frame.mjs`, mismo layout en el firmware C):
cabecera 20 B + `2·n` muestras `i16 LE` (mili-g). Campos: `magic 0xA5`, `version`,
`sensor`, `fs` (u16), `seq` (u32), `t0_us` (u64 epoch µs), `n` (u16). La
**estructura** va en el topic `rewind/accel/<structId>`; el **sensor**, en la trama.

**Correr** (sin hardware, simulador):
```bash
cd bridge
npm install
INFLUX_TOKEN=xxxx npm run bridge   # puente MQTT → InfluxDB
npm run sim                         # simula el ESP32 a 100 Hz (FAULT=WT-05/2 fuerza falla)
```
Variables: `MQTT_URL`, `INFLUX_URL`, `INFLUX_ORG`, `INFLUX_BUCKET`, `INFLUX_TOKEN`.

**Falta** (siguiente paso): el *backend de features* que consulta ventanas de
InfluxDB, calcula RMS/f₁/FFT/clase ML y emite los `tick` agregados que ya consume
`js/shm/data_source.js` (hoy lo cubre el stub `tools/virtual_sensor.mjs`). Ver los
ítems `R-10`/`R-11`/`R-21`/`R-22` del roadmap.
