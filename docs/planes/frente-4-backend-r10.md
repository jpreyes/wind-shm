# Frente 4 — Backend de datos reales (`R-10`/`R-11`)

**Estado:** plan · **Hardware real:** ADXL355 (acelerómetro MEMS 20-bit, bajo ruido) +
inclinómetro, **gateway Raspberry Pi**, 2–3 sensores por gateway. Hoy ~10 sensores
(~4 gateways); piloto ~200 sensores (~70–100 gateways).

---

## 1. Brechas que este backend resuelve (consolidado roadmap + auditoría)

| Brecha | Cómo la resuelve |
|---|---|
| **`R-10`** DataSource industrial + API | El núcleo de este frente: MQTT→Influx→API→WS con el MISMO esquema que `SimulatedSource` (el front ya soporta `?live=wss://` sin cambios). |
| **`R-11`** (parcial) stack de ingesta | Queda decidido: **Node.js** en servidor (continuidad con `bridge/`), **Python** en la Pi. Electron queda aparte. |
| **`R-21`** OMA (habilitador) | Las **ventanas crudas** archivadas alimentan el módulo ultramétrico de JP; su f₁ real cierra la curva medida de **`R-31`**. |
| **`R-23`** alarmas + notificación | Motor de reglas server-side + notificador (email/Telegram). El **LWT de MQTT** da la alarma «gateway offline» gratis. |
| **`R-24`** tilt/asentamiento | El inclinómetro entra como canal de 1 Hz; tendencia de desplome en Influx. |
| **`R-25`/`R-26`/`R-30`** RUL · benchmarking · gemelo de cargas | Pasan de sim a datos: fatiga con historia real, z-score de flota sobre features reales. |
| **`R-28`** reportes programados | Cron en el servidor genera el DPR/salud y lo envía. |
| **`R-32`** CMMS con persistencia real | Inspecciones/OT/fotos migran de `localStorage` a **Postgres + almacenamiento de archivos** → multiusuario, roles (V10), auditoría. |
| **`R-33`** instrumentación (cierre) | El registro de sensores/gateways vive en Postgres (fuente de verdad) y provisiona a la Pi. |
| Auditoría **V1** (histórico persistente) | Influx ES el histórico: tendencia de f₁/RMS entre sesiones. |
| Auditoría **V6** (replay) | «Reproducir el día» = query de rango a Influx vía API. |
| Auditoría **A4/A5** (cuota fotos / parse) | Fotos a disco/objeto + metadatos en Postgres; el rollup consulta SQL. |
| Auditoría **A2** | Al activar LiveSource real hay que implementar reconexión WS en el cliente (pendiente del front). |
| **NO resuelve** | `R-27` (curva de potencia — necesita SCADA), `R-29` (drivetrain — más sensórica), Electron (`R-11` empaquetado). |

---

## 2. Arquitectura

```
   TORRE (×N)                    GATEWAY Raspberry Pi (×~100)              SERVIDOR (1 caja piloto)
┌──────────────┐   SPI      ┌────────────────────────────────┐        ┌─────────────────────────────────┐
│ ADXL355 #1   ├───────────►│ sampler.py (systemd)           │  MQTT  │ Mosquitto (TLS, auth/gateway,   │
│ ADXL355 #2   ├───────────►│  · FIFO DRDY @ fs=125 Hz       │  QoS1  │  LWT → gateway offline)         │
│ Inclinómetro ├───────────►│  · timestamp chrony (NTP)      ├───────►│        │                        │
│ (2–3/gateway)│            │  · trama binaria v2 (µg, XYZ)  │  TLS   │        ▼                        │
└──────────────┘            │  · tilt/temp JSON 1 Hz         │        │ rewind-bridge (Node)            │
                            │  · store&forward (cola SQLite  │        │  · decodifica tramas            │
                            │    en SD si se corta el enlace)│        │  · features 1/min → Influx      │
                            │  · salud: batería/RSSI/CPU     │        │  · crudo → ring Influx (48 h)   │
                            └────────────────────────────────┘        │  · ventanas crudas → archivos   │
                                                                      │    (para OMA ultramétrico R-21) │
                                                                      │        │                        │
                                                                      │        ▼                        │
                                                                      │ InfluxDB v2   PostgreSQL        │
                                                                      │  · accel_raw   · parks/structs  │
                                                                      │    (RP 48 h)   · sensors/gws    │
                                                                      │  · features    · CMMS (R-32)    │
                                                                      │    (RP 2 años) · alarm rules/   │
                                                                      │  · gw_health     events, users  │
                                                                      │        │                        │
                                                                      │        ▼                        │
                                                                      │ rewind-api (Node)               │
                                                                      │  · REST (metadatos, queries,    │
                                                                      │    CMMS, replay)                │
                                                                      │  · WS /live → MISMO esquema     │
                                                                      │    {type:'tick',summaries,waves}│
                                                                      │  · motor de alarmas + notifier  │
                                                                      │  · cron reportes (R-28)         │
                                                                      │        │                        │
                                                                      │ Caddy/nginx (TLS) ──► navegador │
                                                                      │   sirve app + wss://…/live      │
                                                                      └─────────────────────────────────┘
```

### Decisiones y por qué

- **Gateway = Raspberry Pi (pivote desde el ESP32 del prototipo).** La Pi corre Python,
  disciplina reloj con chrony, bufferea a SD cuando se cae el enlace y habla MQTT/TLS
  nativo. El `.ino` de `firmware/` queda como referencia; si algún día un nodo remoto
  no justifica una Pi, un ESP32 puede colgarse de la Pi como digitalizador, no del broker.
- **Trama binaria v2 (evolución de `bridge/accel_frame.mjs`).** La v1 es 1 eje y
  cuantiza a **mili-g (int16)** — el ADXL355 resuelve ~3.9 µg/LSB y las torres vibran
  a 1–30 mg: 1 mg/LSB destruye la señal. **v2:** `u8 axes(1|3)` + muestras **int32 en µg**
  intercaladas XYZ (o int24 empacado si se quiere ahorrar; int32 = simple).
  A 125 Hz × 3 ejes × 4 B ≈ **1.5 KB/s por sensor** — trivial para Pi y broker.
  Lote de ~1 s por trama (125 muestras) → 1 msg/s/sensor; 200 sensores = 200 msg/s. Nada.
- **ADXL355 por SPI** (I²C queda corto), FIFO interno + interrupción DRDY, ODR 125 Hz
  (filtro interno), rango ±2 g, y **usar su sensor de temperatura** (canal gratis, sirve
  para compensar deriva térmica de f₁). 2–3 sensores en la MISMA Pi comparten reloj →
  **fase coherente dentro de la torre** (lo que las formas modales de 2 sensores necesitan).
- **Tiempo:** chrony/NTP en cada Pi (vía el enlace del parque). Si el parque no tiene
  internet: un NTP local en el servidor, o un hat GPS-PPS en una Pi como stratum-1.
  Para modos < 20 Hz, el jitter de NTP (~ms) importa poco ENTRE torres; dentro de la
  torre manda el reloj común de la Pi.
- **Dos velocidades de almacenamiento (la decisión clave de SHM):**
  1. **Features a Influx (1/min, retención larga ~2 años):** RMS, σ, pico, kurtosis,
     candidato f₁ (Welch en el bridge), tilt X/Y, temperatura, salud del gateway.
     Esto alimenta dashboard, tendencias, alarmas y benchmarking. 200 sensores ×
     ~10 campos/min = insignificante.
  2. **Crudo:** *(a)* un **ring corto en Influx (24–48 h, retention policy propia)**
     para la vista «Señal» y el replay reciente; *(b)* **ventanas archivadas a
     archivos** (binario propio o Parquet: `raw/<park>/<struct>/<sensor>/<fecha>.bin`)
     para el OMA ultramétrico de JP (R-21) — reprocesables para siempre, baratas de
     respaldar, fuera de la base.
  - **Ciclo de trabajo recomendado:** crudo continuo con 200 sensores ≈ 5.2·10⁹
    puntos/día — posible pero incómodo para una caja. **10 min de ventana cada 30 min**
    (suficiente para OMA con f₁≈0.3 Hz: ~180 ciclos por ventana) reduce 3× y sobra.
    Con 10 sensores: continuo sin pestañear.
- **PostgreSQL para todo lo que no es serie temporal:** registro de parques/estructuras/
  **sensores/gateways (R-33 como fuente de verdad)**, CMMS completo (R-32), fotos
  (metadatos; el archivo a disco/objeto), reglas y eventos de alarma, usuarios/roles,
  líneas base de commissioning (R-31). SQLite serviría para el piloto de 10, pero
  Postgres desde el día 1 cuesta lo mismo en Docker.
- **Mosquitto** como broker (simple, sobrado ×1000 para 200 msg/s); TLS + usuario/clave
  **por gateway** (o mTLS); **LWT** en `rewind/gw/<id>/status` → alarma de gateway caído.
- **Servicio único `rewind-api` en Node** (misma lengua que `bridge/`, cero cambio de
  contexto): REST para metadatos/CMMS/queries + **WebSocket `/live` que emite el MISMO
  mensaje del worker** (`{type:'tick', t, summaries, waves}`) — el front **ya** lo
  consume con `?live=wss://…` sin tocar una línea (así se diseñó `DataSource`).
  El bridge puede ser un proceso aparte o un módulo del mismo servicio (piloto: mismo
  proceso, menos partes móviles).

### Esquema de datos (bosquejo)

**Influx** (tags: `park, struct, sensor, axis`):
- `accel_raw` → `a` (µg) — bucket `rewind_raw`, RP 48 h.
- `features` → `rms, std, pk, kurt, f1, tilt_x, tilt_y, temp` — bucket `rewind`, RP 730 d.
- `gw_health` → `rssi, cpu, disk, vbat, uptime` — RP 90 d.

**Postgres:** `parks, structures, gateways(id, struct_id, key_hash, last_seen),
sensors(id, gw_id, type[acc|tilt], axis_map, y_frac, fs, calib), inspections, damages,
photos(meta, path), work_orders, alarm_rules, alarm_events, users(role), baselines`.

**Topics MQTT:** `rewind/accel/<structId>` (binario v2) · `rewind/tilt/<structId>` (JSON 1 Hz)
· `rewind/gw/<gwId>/status` (JSON + LWT `offline`).

### Dimensionamiento del servidor (piloto 200 sensores)

- **Caja única** (mini-PC on-prem o VM): 8 núcleos, 32 GB RAM, **NVMe 2 TB**.
  Con ciclo 10/30 min: crudo Influx ≈ decenas de GB en el ring de 48 h; archivos de
  ventanas ≈ 25–35 GB/mes (comprimido) — 2 TB da ~2–3 años de archivo.
  (Para los 10 sensores actuales: una Pi 5/N100 con SSD lo corre entero.)
- Docker Compose: `mosquitto`, `influxdb:2`, `postgres:16`, `rewind-api` (incluye
  bridge), `caddy` (TLS + sirve la app estática + proxy `/live`).
- **Respaldo:** `pg_dump` nocturno + `influx backup` semanal + rsync de `raw/` a un
  segundo disco/NAS. Sin esto no hay piloto serio.

---

## 3. Cómo montarlo — fases (cada una termina en algo demostrable)

1. **Banco local (sin hardware, 1–2 días).** `docker-compose.yml` con los 5 servicios;
   extender `accel_frame.mjs` a **v2 (3 ejes, µg/int32)** con test Node; adaptar
   `mqtt_influx_bridge` a v2 + cálculo de features 1/min; alimentar con
   `tools/virtual_sensor.mjs`/`bridge/esp32_sim.mjs`. Éxito: Influx llenándose y
   Grafana-less: query Flux a mano.
2. **WS `/live` (1–2 días).** `rewind-api` emite `{tick, summaries, waves}` a 1 Hz desde
   las features + ring crudo (waves solo de la estructura en foco). Abrir la app con
   `?live=wss://localhost/live` → **el dashboard real con datos del banco, sin tocar el
   front**. (Añadir en el front la reconexión — auditoría A2.)
3. **Pi de referencia (2–3 días con hardware en mano).** Raspberry Pi OS Lite +
   `sampler.py` (systemd): ADXL355 por SPI con DRDY/FIFO, timestamp chrony, trama v2,
   cola SQLite store-and-forward, tilt 1 Hz, LWT. Script `provision.sh` (id + credenciales
   desde Postgres). Éxito: 2 sensores reales de una torre en el dashboard.
4. **Features + archivo de ventanas (1–2 días).** Ventanas 10/30 min a `raw/…`;
   task de Influx para downsampling; retención configurada. Éxito: tendencia de f₁ real
   de una semana en la pestaña SHM.
5. **CMMS a Postgres (2–4 días).** Esquema + endpoints REST; en el front, un adaptador
   detrás de `inspection.js` (localStorage ⇄ API con el mismo contrato; localStorage
   queda como caché offline). Fotos a disco vía upload. Resuelve A4/A5 y habilita roles.
6. **Alarmas + salud (1–2 días).** Reglas en Postgres, evaluación en el stream,
   `alarm_events`, notificador (SMTP/Telegram), LWT→alarma gateway.
7. **Endurecer piloto.** TLS en todo, backups probados (restaurar una vez), monitoreo
   básico (systemd + healthchecks), documento de operación.

**Escala 10 → 200:** nada cambia arquitectónicamente; es provisionar más Pis (imagen
clonada + `provision.sh`) y vigilar el ring crudo (ajustar ciclo de trabajo o retención).
El primer cuello real sería el ring continuo a 200 sensores — por eso el ciclo 10/30.

## 4. Riesgos / decisiones abiertas
- **Conectividad del parque** (¿4G por gateway? ¿malla WiFi? ¿fibra de la subestación?)
  define QoS del enlace y el tamaño del buffer de la Pi. El store-and-forward cubre cortes.
- **Sincronización fina** si el OMA ultramétrico llegara a necesitar fase ENTRE torres
  (< 1 ms): GPS-PPS por gateway. Dentro de la torre ya está resuelto (misma Pi).
- **¿Continuo vs ciclo?** para R-21: preguntar a JP qué densidad de ventanas necesita
  su método; el ciclo es configurable por sensor desde Postgres.
- Cadena de custodia de datos (piloto con cliente): definir retención contractual.
