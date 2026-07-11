# Frente 4 · Contrato de ingesta (congelado v1)

> El sensor vive en **otro repo**. Este documento es la **frontera estable** entre el
> sensor y ReWind: si ambos lo respetan, interoperan sin acoplarse. Deriva del
> [plan del Frente 4](frente-4-backend-r10.md) pero con el **transporte pivoteado a
> Supabase** (no MQTT/Influx — eso era el modelo self-hosted, ver `bridge/`).

## 0. Principio de red

**El sensor solo hace peticiones de SALIDA (outbound) a Supabase por HTTPS.**
No expone puertos, no necesita `cloudflared` ni IP pública. Funciona detrás de
CGNAT/Starlink/NAT. El «on-demand» se resuelve por *command-polling* (§4), no por
webhooks entrantes.

- **Endpoint** = el proyecto Supabase (`https://<ref>.supabase.co`).
- **Host del proceso** = donde sea (VPS Hostinger con `systemd` para 24/7, o una Pi).
- **Credencial** = la **service_role key** SOLO en el sensor (servidor, nunca en el
  navegador). El front usa la anon/publishable key + sesión.

## 1. Muestreo y ventanas

| Parámetro | Valor v1 |
|---|---|
| Frecuencia de muestreo `fs` | **150 Hz** |
| Ejes | `ax, ay, az` (aceleración, m/s² o µg — declarar en `unit`) |
| Ventana cruda | **5 min** = `300 s × 150 Hz = 45.000` muestras/eje |
| Buffer en memoria | ring de ~6 min (margen sobre la ventana de 5) |
| Disparadores de envío | (a) **programado** cada 60 min · (b) **anomalía** (RMS>umbral) · (c) **on-demand** (§4) |

## 2. `features` — fila compacta (tabla `features`, 1 por evento/estructura)

El sensor calcula las *features* de la ventana y las inserta por REST:

```
POST {URL}/rest/v1/features
apikey: <service_role>       Authorization: Bearer <service_role>
Content-Type: application/json
Prefer: return=minimal
```
```json
{
  "structure_id": "T15",
  "ts": "2026-07-11T14:05:00Z",
  "f1": 0.284, "f2": 1.63,
  "rms": 0.0123,
  "wind": 8.4, "temp": 12.1, "tilt": 0.06,
  "cls": 0,
  "extra": { "trigger": "scheduled", "wave_path": "T15/2026-07-11T140500Z.npz" }
}
```
- Columnas reales de `features` (ver `schema.sql`): `structure_id, ts, f1, f2, rms,
  wind, temp, tilt, cls, extra(jsonb)`. `trigger` (scheduled|anomaly|ondemand) y el
  puntero a la ventana cruda van dentro de **`extra`** (no son columnas propias).
- `cls` ∈ 0..4 (Sin daño → Muy alto), coherente con el clasificador del front.
- `structure_id` referencia `structures.id` (FK relajada a texto).

## 3. Ventana cruda → Supabase Storage (bucket `waves`) + tabla `waves`

La serie temporal completa se sube como **objeto** (comprimido) y se registra un
puntero. Formato v1: **`.npz`** (numpy) o **CSV `.gz`**; declarar en `format`.

```
POST {URL}/storage/v1/object/waves/{structure_id}/{ts}.npz
apikey/Authorization: <service_role>   Content-Type: application/octet-stream
<bytes>
```
```
POST {URL}/rest/v1/waves        (puntero; `id` es autoincremental — no se envía)
{
  "structure_id": "T15",
  "ts": "2026-07-11T14:05:00Z",
  "fs": 150, "n": 45000,
  "storage_path": "T15/2026-07-11T140500Z.npz",
  "meta": { "axes": ["ax","ay","az"], "unit": "m/s2", "format": "npz",
            "bytes": 412300, "trigger": "scheduled" }
}
```
Columnas reales de `waves`: `structure_id, sensor, ts, fs, n, storage_path,
meta(jsonb)`. Lo demás (ejes/unidad/formato/bytes/trigger) va en **`meta`**.
Retención: cron/policy borra objetos > 90 días (ajustable). ~0,3–0,5 MB/ventana →
free tier (1 GB) ≈ 2.000 ventanas.

## 4. On-demand sin puertos: `sensor_commands` (command-polling)

La web pide una captura AHORA insertando una fila; el sensor la sondea y la cumple.

```
Web:    POST {URL}/rest/v1/sensor_commands
        { "structure_id":"T15", "kind":"window", "status":"pending" }

Sensor: GET {URL}/rest/v1/sensor_commands?structure_id=eq.T15&status=eq.pending
        → sube la ventana → PATCH status=done, wave_id=<...>
```
- `kind`: `window` (subir 5 min ya) · futuros: `reboot`, `set_fs`, …
- El sensor sondea cada ~5 s. Sin webhooks → cero configuración de red entrante.

## 5. Lo que ReWind ya consume

`js/shm/backend.js` (modo `backend:supabase`) ya hace **polling** de `features` cada
5 s y las enruta al dashboard con el mismo esquema del `SimulatedSource`. Próximo
paso del front: **Realtime nativo** (suscripción a `INSERT` de `features`) en vez de
polling, y un botón «pedir captura» que inserte en `sensor_commands`.

## 6. Estado

- [x] Contrato congelado (este doc).
- [x] Esquema: `features`/`waves` (ya en `schema.sql`) + `sensor_commands` + bucket
  `waves` (`backend/supabase/ingest.sql`).
- [x] **Simulador Python** (carpeta `sensor/`, para el repo aparte): ring buffer
  150 Hz + los 3 disparadores → Supabase. Probado contra mock (features + puntero
  `waves` + objeto crudo `.npz`, esquema OK).
- [ ] Front: Realtime nativo (hoy polling 5 s) + botón «pedir captura» → `sensor_commands`.
- [ ] (Real) firmware/Pi que respete este mismo contrato.
