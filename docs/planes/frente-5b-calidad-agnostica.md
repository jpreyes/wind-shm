# Frente 5B — Módulo de calidad **contratista-agnóstico** (fundamento normativo + importador configurable)

**Estado:** plan · **Depende de:** Frente 5 (motor SACYR ya construido: reader/writer/derived/dashboard/edición).

**Objetivo en una línea:** que ReWind gestione **calidad de obra** para *cualquier* contrato —
importando el Excel que sea— sin código nuevo por cada contratista. El Excel de SACYR
(Camán) sigue funcionando como está; pasa a ser **un perfil más**, no *el* formato.

---

## 1. La tesis: el modelo canónico ya ES el estándar

El Excel de SACYR no inventa nada: es una **implementación particular** (su Plan de
Aseguramiento de Calidad, PAC) de un marco normativo que es **el mismo en todas partes**.
Por eso el modelo canónico que ya tenemos (`protocolo → ciclos → estado`; `ensayo`)
coincide con ese marco y **generaliza solo**. Lo único específico de cada contratista es
la **piel** del Excel (nombres de hoja, columnas, literales de estado).

```
   ┌─────────────────────────── NORMATIVO (estable, compartido) ───────────────────────────┐
   │  Modelo canónico ReWind  ≈  ISO 9001 · ISO 19650 · ISO 21500/21502 · ensayos ASTM/EN/NCh │
   └────────────────────────────────────────────────────────────────────────────────────────┘
                    ▲                                                   │
       IMPORTAR (perfil por contratista)                 EXPORTAR / DASHBOARD / 4D (genérico)
                    │                                                   ▼
   ┌── Excel SACYR ──┐  ┌── Excel Contratista B ──┐  ┌── Plantilla estándar ReWind ──┐
```

### Fundamento normativo (documentado)

| Concepto en ReWind | Norma / marco | Notas |
|---|---|---|
| Protocolo, control documental, no conformidad, registros | **ISO 9001** — información documentada (7.5), control de producción y liberación (8.5/8.6), salidas no conformes (8.7) | La sombrilla del sistema de calidad. |
| **Ciclo de revisión** (transmittal TML, envío→retorno, estado, idoneidad) | **ISO 19650** — gestión de información, estados de revisión/aprobación, CDE; también EN/ISO 19650-2 (fase de entrega) | El ciclo SACYR⇄ITO es su workflow de *review & authorize*. |
| Avance / hitos de pago | **ISO 21500 / 21502** (dirección de proyectos) | El *método* (avance = % protocolos aprobados) es del proyecto, no de la norma. |
| **Ensayos de hormigón** | Compresión probetas: **NCh1037 ≈ ASTM C39 ≈ EN 12390-3**; muestreo/curado: **NCh1017 ≈ ASTM C31 ≈ EN 12390-2**; asentamiento/slump: **NCh1019 ≈ ASTM C143 ≈ EN 12350-2** | Edades 3/7/14/28/56 d. |
| Áridos / granulometría | **NCh165 ≈ ASTM C136 ≈ EN 933-1** | |
| Suelos / compactación | Proctor: **NCh1534 ≈ ASTM D698/D1557 ≈ EN 13286-2**; densidad in situ (cono arena): **NCh1516 ≈ ASTM D1556** | |

> *Equivalencias habituales en obra civil; verificar la edición vigente por contrato.
> Lo importante: los tres cuerpos (ASTM/EN/NCh) miden lo mismo → el modelo de `ensayo`
> es único y la norma citada es solo un atributo (`e.norma`).*

### Vocabulario de estado controlado (normalizado, ISO-flavored)

El literal de cada contratista se mapea a una **lista controlada** única:

| Canónico | ISO 19650 (aprox.) | Literales SACYR observados |
|---|---|---|
| `aprobado` | autorizado / sin observaciones | «Sin Comentarios», «Sin comentarios», «Enviado - OK» |
| `conComentarios` | aprobado con comentarios / revisar y reenviar | «Con comentarios», «Enviado - Con comentarios» |
| `enRevision` | en revisión | «Revisión ITO …», «Revisión QAQC» |
| `rechazado` | rechazado | «Rechazado» |
| `nulo` / `informativo` | (fuera de flujo) | «Nulo», «Informativo» |

Ya existe `normEstado()` haciendo justo esto; se generaliza con el `statusMap` del perfil.

---

## 2. Arquitectura agnóstica: **perfiles de importación**

Hoy `sacyr_reader.mjs` es **un adaptador cableado**. La generalización: un **reader genérico**
`readByProfile(workbook, profile) → modelo canónico`, y el SACYR pasa a ser el **perfil
built-in "SACYR Camán"**. Cero comportamiento perdido (el test actual sigue verde).

### El perfil (JSON, guardado en localStorage / backend)

```jsonc
{
  "name": "SACYR Camán",
  "protocols": {
    "sheet": "LOG PTL Parque y SSEE", "headerRow": 6, "dataRow": 7,
    "columns": { "code":"E", "area":"F", "element":"G", "description":"H",
                 "document":"I", "milestone":"J", "discipline":"K", "status":"P" },
    "cycles": {                       // dos modos soportados:
      "mode": "stride",               //  a) bloques repetidos (SACYR)
      "base": "W", "stride": 10, "count": 5,
      "offsets": { "sentDate":1, "status":2, "returnDate":6, "comments":7, "workdays":9 }
      // "mode": "columns" → listas explícitas por ciclo (otros layouts)
    }
  },
  "concreteTests": { "sheet":"Ensayos Hormigón", "headerRow":4, "dataRow":5,
                     "columns": { "n":"D","grade":"H","element":"I","d28":"O","status":"R" } },
  "catalogs": { "sheet":"Listas", "areas":"B", "statuses":"D" },
  "statusMap": { "Sin Comentarios":"aprobado", "Con comentarios":"conComentarios", "…":"…" },
  "elementMap": { "pattern":"WTG\\s*0*(\\d+)", "template":"T$1" }  // element→estructura 3D (opcional)
}
```

- **Un motor, muchos perfiles.** El writer, los derivados, el dashboard y la integración 4D
  **no cambian** (operan sobre el modelo canónico). Solo se generaliza la lectura.
- **`elementMap` opcional:** el vínculo `elemento → estructura ReWind (Tnn)` es lo único
  "eólico". En un proyecto no-eólico, el elemento queda como etiqueta libre y el enganche
  al 3D (avance real, calidad por torre) simplemente no aplica — todo lo demás funciona.

### Onboarding de un contratista nuevo (sin programar): **asistente de mapeo**

Al importar un Excel desconocido, ReWind abre un wizard:

1. **Elegí la hoja** de protocolos (y la de ensayos, si hay).
2. **Mapear columnas**: ReWind lista las cabeceras detectadas y **propone** el mapeo por
   heurística de sinónimos (diccionario ES/EN: *estado/status/estatus*, *código/code/doc*,
   *fecha envío/sent/emisión*, *área/area/zona*, *especialidad/discipline*…). El usuario
   ajusta con desplegables.
3. **Mapear estados**: ReWind muestra los **valores distintos** hallados en la columna de
   estado y el usuario los asigna al vocabulario controlado (con default vía `normEstado`).
4. **Ciclos**: elegir modo `stride` (detecta el patrón repetido) o `columns`.
5. **Guardar como perfil** con nombre → reutilizable; el próximo Excel igual entra sin tocar nada.

### Alternativa complementaria: **plantilla estándar ReWind**

Ofrecer un **workbook limpio ISO-9001/19650** (nuestro formato) que cualquier contratista
pueda adoptar. Si lo usan, el import es **zero-config** (perfil built-in "ReWind estándar").
Dos caminos que conviven: *adaptarnos a su Excel* (perfiles) **o** *que adopten el nuestro*.

---

## 3. Fases

| # | Entregable | Esfuerzo | Criterio de cierre |
|---|---|---|---|
| ⬜ 5B.1 | **Refactor a perfiles**: `readByProfile(wb, profile)` + extraer el perfil built-in «SACYR Camán» de `sacyr_reader.mjs` (sin cambio de conducta) | 1–2 d | El test SACYR actual sigue verde leyendo vía perfil; 0 regresiones. |
| ⬜ 5B.2 | **Store de perfiles** (localStorage/backend) + selector de perfil al importar | 0.5 d | Se elige perfil al importar; el built-in SACYR aparece por defecto. |
| ⬜ 5B.3 | **Asistente de mapeo** (elegir hoja · mapear columnas con heurística de sinónimos · mapear estados · modo de ciclos · guardar perfil) | 3 d | Importar un Excel *distinto* de prueba → poblar el dashboard sin tocar código. |
| ⬜ 5B.4 | **Catálogo normativo** built-in (vocabulario de estado ↔ ISO 19650; tipos de ensayo ↔ ASTM/EN/NCh) + `e.norma` en el modelo | 1 d | El módulo muestra la norma del ensayo; estados etiquetados con su equivalente ISO. |
| ✅ 5B.5 | **Plantilla estándar ReWind** (`tools/rewind_template.mjs`) + **autodetección de formato** (`readQuality`) | 1 d | **HECHO:** workbook limpio (Instrucciones · Protocolos · **Ciclos normalizados** · Ensayos Hormigón · Catálogos ISO); lectura por nombre de cabecera (sinónimos ES/EN); descarga desde el menú «Calidad»; `readQuality` autodetecta **SACYR ↔ plantilla ReWind**; datos creados/editados se exportan en formato ReWind, SACYR prístino se devuelve sin pérdida. Test `tools/test_rewind_template.mjs` (round-trip) + SACYR sin regresión. |

*(Recomendado arrancar por 5B.1: es el refactor habilitante, de bajo riesgo — deja el SACYR
como perfil y desbloquea todo lo demás. El modelo canónico ya está; no se toca.)*

> **Ya entregado (fuera de orden, pedido por el proyecto):** la **plantilla estándar ReWind
> (5B.5)** y la **autodetección** SACYR↔plantilla (`readQuality`). Estrategia adoptada: el
> contratista **adopta nuestro modelo** (descarga la plantilla, la llena, la sube); si trae
> un Excel propio distinto, para eso queda el **asistente de mapeo (5B.3)** — «el modificador
> de tablas». El import de SACYR se mantiene intacto (es el proyecto que motiva todo esto).

## 4. Qué NO cambia
El motor posterior al modelo (writer `modelToSheets`, `computeDerived`, dashboard, edición,
avance real 4D, barra de estado) es **agnóstico por construcción**: opera sobre el modelo
canónico. Toda la agnosticidad se concentra en la **capa de importación**.
