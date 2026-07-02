# Frente 5 — Módulo «Calidad de obra» (`R-41`): ingesta y round-trip del Log de protocolos

**Estado:** plan · **Origen:** el proyecto Camán se gestiona con un libro Excel
(«Log protocolos SACYR.xlsx», ~25 hojas) que es **el formato de facto del proyecto
y NO se puede modificar**. ReWind debe poder **ingerirlo**, gestionarlo (dashboard
de calidad + integración con Obra/CMMS) y **exportar un Excel de salida
EXACTAMENTE igual** al original — mismas hojas, cabeceras, fórmulas, gráficos,
formatos condicionales, vínculos y layout — con los datos actualizados.

> **Anexo de construcción (no versionado, contiene estructura interna del
> proyecto):** `auditoria/SPEC-sacyr-xlsx-2026-07-02.md` — mapa columna-a-columna
> verbatim de cada hoja de entrada (cabecera, fila de datos, columnas con fórmula,
> fórmulas de ejemplo, autofiltros/freeze/merges, valores distintos observados y
> el catálogo de la hoja «Listas»). Ese anexo + este plan = espec completa.

---

## 1. La restricción dura y lo que implica

El análisis del libro real arrojó que **regenerarlo desde cero es inviable**:

- **21 gráficos** (11 en KPI´s, 5 en Estatus, 3 en Actividades, 1 en Estadística,
  1 en hitos) — openpyxl/exceljs los destruyen o degradan al reescribir.
- **~900 reglas de formato condicional** (215 en cada Matriz, 77 en Estatus…),
  varias con **extensiones** que openpyxl ya advierte que «will be removed».
- **Vínculos externos** a otros 2 libros (Log Pruebas FAT.xlsx en unidad
  compartida; una Matriz .xlsm) que deben quedar intactos.
- **Data validation** con extensiones no soportadas.
- Hojas **ocultas** (Resumen, Estatus, Listas, Actividades…), tab colors,
  freeze panes, autofiltros, cientos de celdas combinadas.
- **Las hojas derivadas son FÓRMULAS**: las Matrices (Fundaciones/LAT/SSEE/SET),
  KPI´s, Estatus y Estadística se calculan desde los logs. No hay que
  reproducir su lógica: hay que **alimentar los logs y dejar que Excel recalcule**.

### Decisión de arquitectura: **plantilla + parche quirúrgico del XML**

Un `.xlsx` es un ZIP de XML. La única forma de garantizar «exactamente igual»:

1. **La plantilla ES el archivo original** (una copia prístina, versionada fuera
   del repo público — p. ej. `data-privada/` o el propio backend). Nunca se
   genera un libro nuevo.
2. El **writer** abre el ZIP y modifica **únicamente** los valores de celdas de
   DATOS en las hojas de entrada (`xl/worksheets/sheetN.xml` + `sharedStrings.xml`),
   **sin tocar ningún otro part** (charts, styles, condFmt, externalLinks,
   drawings, tema, validaciones quedan **byte-idénticos**).
3. Se marca `fullCalcOnLoad="1"` en `xl/workbook.xml` (`<calcPr>`) para que Excel
   recalcule TODAS las fórmulas al abrir → matrices, KPIs, gráficos y estatus se
   actualizan solos con los datos nuevos.
4. **Node puro, sin dependencias de runtime** en la app: el writer vive en
   `tools/`+backend (allí sí puede usar `fflate`/`jszip` como dep de tooling,
   igual que los otros `tools/*.mjs`).

### Reglas del writer (invariantes)

- **Jamás escribir una columna marcada `[F]`** (fórmula) en el anexo. Solo
  columnas de datos. Si un valor entrante colisiona con una columna `[F]`, se
  ignora (la fórmula manda).
- **Fila nueva** (protocolo/ensayo nuevo): se **clona la última fila de datos**
  de la hoja a nivel XML — celdas de datos con los valores nuevos, celdas `[F]`
  con la fórmula de la fila clonada **reindexada** a la fila nueva (ajuste de
  referencias relativas; si la celda usa *shared formula* `t="shared"`, se
  materializa como fórmula explícita al clonar). Extender `ref` del autofiltro
  y de la `dimension` de la hoja.
- **Literales intactos:** el reader guarda `rawValue` de cada celda; el writer
  escribe el literal ORIGINAL, no el normalizado (ej.: coexisten
  `Sin Comentarios`×886 y `Sin comentarios`×370 — se preservan tal cual;
  normalizar solo la copia interna). Fechas: conservar el serial numérico y el
  estilo de la celda original (no re-formatear).
- **`sharedStrings.xml`:** los strings nuevos se AÑADEN al final (índices
  existentes no se reordenan); actualizar `count`/`uniqueCount`.
- Hojas **derivadas, ocultas y de informe** (Matrices, KPI´s, Estatus,
  Estadística, Emisión TML, Resúmen hitos, Hoja1/3/4/5, Actividades,
  Actualización de vínculos): **prohibido tocarlas**. Cambian solas al recalcular.

### Hojas de ENTRADA (las únicas que el writer escribe)

| Hoja | HDR@ | Rol |
|---|---|---|
| `LOG PTL Parque y SSEE` | F6 | Log maestro de protocolos del parque+SSEE (1.437 filas; ciclos de revisión SACYR⇄ITO) |
| `Resumen` | F4 (oculta) | Log histórico/paralelo de protocolos (2.501 filas) |
| `Ensayos Hormigón` | F4 | Probetas (día 3/7/14/28/56), planta, grado, rupturas |
| `Ensayos Áridos y Calicatas` | F4 | Ensayos de áridos y calicatas |
| `Mortero de Nivelación` | F4 | Ensayos de mortero |
| `Inf. Geotécnicos` | F4 | Informes geotécnicos |
| `Listas` | (oculta) | Catálogos del workflow — solo lectura para la app (fuente de los combos) |

*(El mapa columna-a-columna con qué es dato y qué es fórmula está en el anexo.)*

---

## 2. Modelo de datos canónico (interno de ReWind)

```
protocolo {
  id, codigoDocumento, codigoSharepoint, hyperlink,
  area,                 // Fundación | Subestación Camán | Subestación Huichahue | LAT | Plataforma | Vial…
  elemento,             // WTG NN | vial | equipo   ← se mapea a la estructura de ReWind
  descripcion, documento, especialidad,   // Topografía | Civil | Eléctrico | Calidad | Registro | Informativo
  hitoPago,             // 1er | 2do | 3er | código de hito (p.ej. 19.17)
  fechaDocumento,
  estadoActual,         // normalizado: aprobado | conComentarios | enRevision | nulo | informativo
  estadoActualRaw,      // literal original (round-trip)
  ciclos: [ { n, tmlEnvio, fechaEnvio, tmlRetorno, fechaRetorno,
              estado, estadoRaw, comentarios, diasCorridos, diasHabiles } ],
  _origen: { hoja, fila }        // ancla exacta para el writer
}
ensayoHormigon { id, planta, grado, elemento, trabajo, fechas{d3,d7,d14,d28,d56},
                 resistencias, estado…, _origen }
ensayoAridos / mortero / informeGeotecnico { …, _origen }
catalogos { areas[], estadosRevision[], … }        // desde «Listas»
```

**Normalización (solo interna):** mapa de estados tolerante a
mayúsculas/acentos/typos (`Sin Comentarios`/`Sin comentarios` → `aprobado`;
`Con comentarios` → `conComentarios`; `Nulo`/`NULO` → `nulo`; incluye el typo
`Revición ITO…` del catálogo). `elemento` «WTG NN» → id de estructura ReWind
(`Tnn`); áreas → componente del 4D (Fundación→fundación; Vial→cableado;
Subestación→torres AT). Fechas: serial Excel → ISO; textos `Sin Definir` → null
(pero `rawValue` conserva el texto).

---

## 3. Los tres pilares del módulo

### 3.1 Reader (`tools/sacyr_reader.mjs`, reutilizado por el backend)
Node: abre el xlsx (zip), parsea `sharedStrings` + hojas de entrada según el
mapa del anexo → emite el JSON canónico + un **índice de round-trip**
(`hoja/fila/col → rawValue`) que el writer usa. Tolerante: filas `Nulo`, celdas
vacías, cabeceras multilínea. **Test Node** con el archivo real: nº de filas
por hoja, spot-checks de 10 protocolos conocidos, idempotencia
(leer→escribir sin cambios→leer = igual).

### 3.2 Writer (`tools/sacyr_writer.mjs`)
Entrada: plantilla (el xlsx original o la última versión) + el JSON canónico con
cambios (celdas editadas / filas nuevas). Salida: xlsx nuevo. Aplica las reglas
de la sección 1. **Criterio de aceptación (el contrato):** un **diff-harness**
(`tools/sacyr_diff.mjs`) que compara salida vs original:
1. **Sin cambios aplicados** → los parts NO tocados deben ser **byte-idénticos**
   (hash por part del zip) y las hojas tocadas, **celda-a-celda idénticas**
   (valor, tipo, estilo-id).
2. **Con cambios** → solo difieren exactamente las celdas esperadas.
3. Abrir la salida en Excel/LibreOffice: cero reparaciones («Excel encontró
   contenido ilegible» = fallo), gráficos y matrices vivos, CF intacto.

### 3.3 UI — pestaña «Calidad» en ReWind (v1 client-side)
- **Importar**: file-picker del xlsx → el parse corre en el navegador con el
  MISMO módulo del reader (es JS puro sobre zip; `fflate` vendorizado en `lib/`
  como se hizo con numeric/leaflet) → store `rewind.calidad.v1`.
- **Dashboard**: matriz-heatmap protocolos×WTG (réplica visual de la Matriz,
  pero interactiva), KPIs de turnaround (días hábiles por ciclo, % con
  comentarios, pendientes por WTG), drill por estructura → lista de protocolos
  con sus ciclos; filtros por área/especialidad/hito.
- **Integración**: el % de protocolos aprobados por WTG/área alimenta (opcional,
  con toggle) el avance real del 4D; hallazgos «Con comentarios» crónicos →
  visibles en el HUD de Obra; **Ensayos Hormigón** se muestran en el CMMS
  (pestaña Ensayos) y la resistencia a 28 días queda disponible para la
  narrativa del gemelo de construcción (madurez de fundación, `R-31`).
- **Edición v1 (acotada)**: registrar un ciclo nuevo (envío/retorno/estado/
  comentarios) y protocolos nuevos → van al JSON canónico → **Exportar Excel**
  (v1: descarga el JSON de cambios + se ejecuta el writer en Node; v2: el
  backend lo hace server-side y devuelve el xlsx).

---

## 4. Fases

| # | Entregable | Esfuerzo | Criterio de cierre |
|---|---|---|---|
| ⬜ 5.1 | **Reader** Node + JSON canónico + tests con el archivo real | 2 días | Los 1.437 + 2.501 + ensayos parseados; spot-checks OK. |
| ⬜ 5.2 | **Writer** XML quirúrgico + **diff-harness** | 3–4 días | Round-trip sin cambios = byte-idéntico en parts no tocados; Excel abre sin reparar; caso «agregar 1 ciclo + 1 protocolo» pasa el diff y las Matrices/KPIs se actualizan al abrir. |
| ⬜ 5.3 | **Pestaña «Calidad»** (import navegador + dashboard + drill) | 3 días | El xlsx real se importa y navega; KPIs coinciden con la hoja KPI´s (validación cruzada). |
| ⬜ 5.4 | **Integración** con Obra/HUD/CMMS (avance real opt-in, ensayos hormigón) | 2 días | El 4D puede mostrar % real de protocolos por torre. |
| ⬜ 5.5 | **Edición + export** (ciclos/protocolos nuevos → writer) | 2 días | Un ciclo registrado en ReWind aparece en el Excel exportado, idéntico en todo lo demás. |
| ⬜ 5.6 | **Backend (con Frente 4, fase 3.5b)**: tablas Postgres (`protocolos`, `ciclos`, `ensayos_*`), upload de versiones del xlsx (upsert idempotente por código+correlativo), export server-side, historial de versiones | 3 días | Dos usuarios ven el mismo log; export descargable con datos de BD. |

## 5. Riesgos y mitigaciones
- **Fragilidad del XML quirúrgico** (shared formulas, dimension/autofilter al
  insertar filas): mitigado por el diff-harness como puerta de cada release y
  por preferir «editar celdas existentes» sobre «insertar filas» cuando se pueda.
- **El original evoluciona** (SACYR agrega columnas/hojas): el reader valida las
  cabeceras contra el anexo y **rechaza con reporte claro** si el layout cambió
  (mejor fallar ruidoso que corromper); actualizar anexo+mapas es un PR corto.
- **Confidencialidad**: el xlsx y el anexo con estructura interna NO se
  versionan en este repo público (gitignore `auditoria/`, plantilla en
  `data-privada/` o en el backend). La UI no expone nombres de personas.
- **Tamaño en localStorage** (v1): solo el JSON canónico (~2–4 MB sin estilos)
  — si aprieta, IndexedDB (mismo patrón que `R-34`).
