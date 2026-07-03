# Frente 5 — Módulo «Calidad de obra» (`R-41`): ingesta y export del Log de protocolos

**Estado:** plan · **Origen:** el proyecto Camán se gestiona con un libro Excel
(«Log protocolos SACYR.xlsx», ~25 hojas) que es **el formato de facto del
proyecto**. ReWind debe poder **ingerirlo**, gestionarlo (dashboard de calidad +
integración con Obra/CMMS) y **exportar un Excel cuya INFORMACIÓN coincida**:
mismas hojas, mismas cabeceras, **mismos valores en las mismas celdas**.

> **Contrato #1 — round-trip de INFORMACIÓN sin pérdida (lo único obligatorio):**
> toda la información del Excel debe poder **subirse a ReWind** (leerse al modelo
> canónico sin perder nada) y ReWind debe poder **volver a sacarla** en un Excel
> legible. **NO** se requiere fidelidad de archivo: ni byte-a-byte, ni fórmulas,
> ni gráficos, ni formatos condicionales, ni estilos (gráficos = «ideal, no
> necesario»). Donde el original tiene una fórmula, el export escribe el **valor**.
> **Layout secundario (solo por familiaridad):** el export usa las mismas hojas,
> cabeceras y celdas que el original para que a quien lo abra le resulte conocido
> — pero si algo se moviera, lo que importa es que **la información esté completa**.

> **Anexo de construcción (no versionado, contiene estructura interna del
> proyecto):** `auditoria/SPEC-sacyr-xlsx-2026-07-02.md` — mapa columna-a-columna
> verbatim de cada hoja (cabecera, fila de datos, qué columnas son fórmula en el
> original, fórmulas de ejemplo, valores de estado observados y el catálogo de la
> hoja «Listas»). Ese anexo + este plan = espec completa.

> **➡ Continúa en [Frente 5B — módulo contratista-agnóstico](frente-5b-calidad-agnostica.md):**
> el motor construido aquí (reader/writer/derived/dashboard/edición) opera sobre un
> **modelo canónico que ES el estándar ISO 9001 / 19650 / 21500-21502 + ensayos
> ASTM/EN/NCh**. El Frente 5B lo vuelve **agnóstico al contratista** (importar
> cualquier Excel vía **perfiles de importación** + asistente de mapeo), dejando el
> Excel de SACYR como un perfil built-in más. La agnosticidad se concentra en la
> capa de importación; el resto ya es genérico por construcción.

---

## 1. Qué contiene el libro (análisis del archivo real)

| Hoja | Filas×Cols | Rol |
|---|---|---|
| `LOG PTL Parque y SSEE` | 1.437×72 | **Log maestro**: protocolos QA/QC con hasta 4 ciclos de revisión SACYR⇄ITO (CyD) — fechas envío/retorno, TML, estado, días corridos/hábiles |
| `Resumen` (oculta) | 2.501×49 | Log histórico/paralelo de protocolos |
| `Matriz Fundaciones` / `Matriz LAT` / `Matriz SSEE Camán` / `Matriz SET Huichahue` | 46×245 … | **Derivadas (fórmulas)**: completitud por estructura — total/aprobados/con comentarios/pendientes/% por WTG y por protocolo |
| `Ensayos Hormigón` | 483×48 | Probetas (día 3/7/14/28/56), planta, grado, rupturas |
| `Ensayos Áridos y Calicatas` · `Mortero de Nivelación` · `Inf. Geotécnicos` | 200/59/74 | Ensayos de materiales e informes |
| `Resúmen KPI´s` · `Estatus` · `Estadística` | — | **Derivadas (fórmulas + 17 gráficos)**: KPIs de turnaround, estatus semanal |
| `Resúmen hitos fundaciones` | 16.453×27 | Informe documental maquetado por WTG×hito de pago (soporte de estados de pago) |
| `Emisión TML` · `Protocolos pendientes` · `Listas` (catálogos) · varias `HojaN` ocultas | — | Auxiliares |

Datos duros que condicionan la ingesta: literales inconsistentes
(`Sin Comentarios`×886 vs `Sin comentarios`×370, typo `Revición` en el catálogo),
filas `Nulo`, fechas como texto (`Sin Definir`), cabeceras multilínea con celdas
combinadas, vínculos externos a otros 2 libros. **Nada de esto hay que
reproducirlo — hay que leerlo bien.**

---

## 2. Arquitectura: round-trip a nivel de INFORMACIÓN

```
xlsx original ──► READER (Node/browser) ──► JSON canónico ──► UI «Calidad» + integración Obra/CMMS
                                                 │
                                                 ▼
                                    WRITER (valores) ──► xlsx de salida
                                                        (mismas hojas/cabeceras/celdas,
                                                         fórmulas → valores calculados)
```

- **Reader** (`tools/sacyr_reader.mjs` + `lib/xlsx_lite.mjs`, JS puro sobre el
  zip): lee el libro con **valores calculados** (el xlsx guarda el último valor
  de cada fórmula en el XML, no hace falta motor de cálculo) según el mapa del
  anexo → **JSON canónico**. **Sin dependencias externas**: descomprime con la
  API web `DecompressionStream('deflate-raw')`, global en Node ≥18 y en todo
  navegador evergreen — corre igual en Node (tests/CLI) y en el navegador
  (fase 5.4), sin vendorizar `fflate`.
  - **Dos capas** (`readSacyr` → `{ …, _raw }`): `_raw` captura VERBATIM cada
    celda con dato de las hojas de datos (backstop de cobertura + round-trip);
    el modelo estructurado (protocolos con ciclos, ensayos, catálogos) se
    **deriva** del raw → no pueden divergir. Los ciclos del LOG se leen con un
    stride uniforme de 10 columnas desde la col W (hasta 5 ciclos).
- **Writer** (`tools/sacyr_writer.mjs`): genera el xlsx de salida escribiendo
  **valores** en las mismas hojas/posiciones que el original:
  - **Hojas de datos** (logs + ensayos): fila a fila desde el JSON canónico,
    escribiendo el **literal original** (`rawValue`) en lo no editado — el
    export no «corrige» `Sin Comentarios`/`Sin comentarios`, los preserva.
  - **Hojas derivadas** (Matrices, KPI´s, Protocolos pendientes, Estatus básico):
    se escriben los **valores recalculados por el módulo** — las mismas
    agregaciones que la UI necesita de todos modos (completitud por WTG,
    turnaround por ciclo, pendientes). Validación cruzada: sobre el archivo
    original sin cambios, nuestros agregados deben **coincidir con los valores
    que trae el archivo**.
  - **Hojas informe/scratch** (`Resúmen hitos fundaciones`, `Actividades`,
    `HojaN`, `Actualización de vínculos`): fuera del alcance v1 (se re-emiten
    los valores leídos tal cual, o se omiten — decisión por hoja en el anexo).
  - Formato mínimo funcional: cabeceras en las mismas filas/columnas, fechas
    como fechas, números como números, autofiltro y freeze de las hojas de
    datos (barato y útil). Estilos/colores/gráficos: **no requeridos**;
    gráficos «ideal» → queda como mejora opcional (v1.1) re-incrustando la
    plantilla original solo para las hojas con gráficos, sin compromiso.
- **Criterio de aceptación (sin pérdida de información)** — `tools/sacyr_diff.mjs`:
  1. **Cobertura de lectura:** toda celda con dato del original queda
     representada en el JSON canónico (ninguna se «cae» en el parseo) — reporte
     de celdas no mapeadas = debe ser 0 en las hojas de datos.
  2. **Round-trip sin cambios:** original → JSON → export → JSON' ⇒ **`JSON == JSON'`**
     (igualdad de información, independiente de posición). Como verificación
     adicional cómoda, el diff celda-a-celda de las hojas de datos también da 0.
  3. **Con cambios:** difieren exactamente los datos editados (+ los agregados
     derivados afectados).
  4. El export abre en Excel/LibreOffice sin advertencias.

## 3. Modelo de datos canónico (interno)

```
protocolo {
  id, codigoDocumento, codigoSharepoint, hyperlink,
  area,                 // Fundación | Subestación Camán | Subestación Huichahue | LAT | Plataforma | Vial…
  elemento,             // WTG NN | vial | equipo   ← se mapea a la estructura de ReWind
  descripcion, documento, especialidad,   // Topografía | Civil | Eléctrico | Calidad | Registro | Informativo
  hitoPago,             // 1er | 2do | 3er | código de hito (p.ej. 19.17)
  fechaDocumento,
  estadoActual,         // normalizado: aprobado | conComentarios | enRevision | nulo | informativo
  estadoActualRaw,      // literal original (se escribe tal cual al exportar)
  ciclos: [ { n, tmlEnvio, fechaEnvio, tmlRetorno, fechaRetorno,
              estado, estadoRaw, comentarios, diasCorridos, diasHabiles } ],
  _origen: { hoja, fila }        // ancla para reconstruir la posición al exportar
}
ensayoHormigon { id, planta, grado, elemento, trabajo, fechas{d3,d7,d14,d28,d56},
                 resistencias, estado…, _origen }
ensayoAridos / mortero / informeGeotecnico { …, _origen }
catalogos { areas[], estadosRevision[], especialidades[] }   // desde «Listas»
derivados { matrizPorWtg[], kpisTurnaround[], pendientesPorWtg[] }  // calculados en JS
```

**Normalización (solo interna):** estados tolerantes a mayúsculas/acentos/typos;
`WTG NN` → id de estructura ReWind (`Tnn`); áreas → componente del 4D
(Fundación→fundación, Vial→cableado, Subestación→torres AT); fechas serial→ISO;
`Sin Definir`→null (con `rawValue` conservado). Los **días hábiles** de los
ciclos se recalculan en JS (lun–vie) y se validan contra los del archivo.

## 4. UI — pestaña «Calidad» (v1 client-side)

- **Importar**: file-picker del xlsx → reader en el navegador → store
  `rewind.calidad.v1` (JSON canónico, ~2–4 MB; si aprieta, IndexedDB como `R-34`).
- **Dashboard**: matriz-heatmap protocolos×WTG (la Matriz, interactiva), KPIs de
  turnaround (días hábiles por ciclo, % con comentarios, pendientes por WTG),
  drill por estructura → protocolos con sus ciclos; filtros por
  área/especialidad/hito de pago.
- **Integración ReWind**: % de protocolos aprobados por WTG/área → **avance real
  del 4D** (opt-in con toggle); protocolos «Con comentarios» crónicos visibles en
  el HUD de Obra; **Ensayos Hormigón** en el CMMS (pestaña Ensayos) y la
  resistencia a 28 días disponible para la narrativa del gemelo de construcción
  (madurez de fundación, `R-31`).
- **Edición v1 (acotada)**: registrar ciclo nuevo (envío/retorno/estado/
  comentarios) y protocolos nuevos → JSON canónico → **Exportar Excel**
  (v1 en el navegador mismo — el writer es JS puro; v2 server-side).

## 5. Fases

| # | Entregable | Esfuerzo | Criterio de cierre |
|---|---|---|---|
| ✅ 5.1 | **Reader** (`lib/xlsx_lite.mjs` + `tools/sacyr_reader.mjs`) + JSON canónico + tests (`tools/test_sacyr_reader.mjs`) | 2 días | **Hecho:** 1.364 protocolos/1.949 ciclos, 455 ensayos, catálogos; distribuciones == SPEC verbatim (estados P, áreas F, grados/plantas); **días hábiles recalculados = archivo 1845/1845 (100%)**; spot-check fila 7; cobertura raw 46.852 celdas. |
| ✅ 5.2 | **Writer de valores** (`lib/xlsx_write.mjs` + `tools/sacyr_writer.mjs`) + **diff de información** (`tools/sacyr_diff.mjs`) | 1–2 días | **Hecho:** round-trip original→JSON→export→JSON' **sin pérdida** — 0 diffs en 72.338 celdas (7 hojas incl. «Listas») + JSON canónico idéntico; export (4 MB) abre en openpyxl/Excel sin advertencias (fechas reconocidas). Test autocontenido `tools/test_xlsx_roundtrip.mjs` (todos los tipos, sin archivo real). |
| ✅ 5.3 | **Derivados en JS** (`tools/sacyr_derived.mjs`): completitud por estructura/área/especialidad, KPIs de turnaround (días hábiles/ciclo), pendientes, resumen de ensayos + validación (`tools/test_sacyr_derived.mjs`) | 1–2 días | **Hecho:** partición íntegra (Σ estados = Σ áreas = 1364); **reproduce las fórmulas O «Ciclo Documento» y P «Estado Documento» del archivo 1364/1364**; turnaround (avg 3,74 dh, p90 8, max 51) con días hábiles == archivo. **Nota de alcance:** las hojas Matriz/KPI´s usan OTRO modelo (matriz de ~75 actividades planificadas × WTG, «planificado vs entregado»), NO derivable del LOG de eventos → se leen como referencia, no se recalculan; la validación cruzada real es O/P + partición + turnaround. |
| ✅ 5.4 | **Pestaña «Calidad»** (`js/shm/calidad.js` + menú «Calidad» + CSS): import del xlsx en el navegador, dashboard overlay (KPIs · por área · heatmap por estructura · pendientes · ensayos) y export | 3 días | **Hecho:** menú «Calidad» (Panel/Importar/Exportar); import del .xlsx en el navegador → modelo → `computeDerived` → overlay; export vía `writeSacyrXlsx` (round-trip F5.2). Verificado en preview: boot OK, cadena xlsx (write↔read con acentos/fecha) OK en el realm del navegador, dashboard poblado renderiza (KPIs, tablas, chips, ensayos). i18n ES/EN. |
| ✅ 5.5 | **Integración con Obra**: «avance real» opt-in (calidad → 4D) + resumen de calidad por torre en la barra de estado | 2 días | **Hecho:** `Calidad.applyToFleet` llena cada torre en el 4D según su % de protocolos aprobados (col P) vía `fleet.setProgress`, con backup/restauración y toggle «Reflejar en 4D ↔ Avance real: ON»; `structureSummary(id)` (derivado memoizado) alimenta la barra de estado al seleccionar («Calidad 67% (1 pend.)»). Verificado en preview. *(Ensayos de hormigón en el CMMS y comentarios crónicos en el HUD = v1.1.)* |
| ✅ 5.6 | **Edición + export sin Excel**: crear dataset vacío, crear/editar/borrar/renombrar protocolos (+ `addCiclo`) y **escritor desde el modelo** (`writeSacyrAuto`/`modelToSheets` en `sacyr_writer.mjs`) | 1–2 días | **Hecho:** menú «Nuevo (vacío, sin Excel)» + vista de gestión (formulario crear/editar + tabla con ✎/🗑). Verificado en preview: crear→editar→borrar→export; round-trip estructural modelo→xlsx→reimport idéntico (estructuraId/estado normalizados). Export elige ruta: `_raw` intacto → lossless (F5.2); editado → desde el modelo. *(UI de ciclos: `addCiclo` disponible; formulario de ciclos = mejora v1.1.)* |
| ⬜ 5.7 | **Backend (con Frente 4, fase 3.5b)**: Postgres (`protocolos/ciclos/ensayos_*`), upload de versiones (upsert idempotente por código+correlativo), export server-side, historial | 3 días | Dos usuarios ven el mismo log; export desde BD. |

*(Total v1 ≈ 1½ semanas — bajó desde ~2 al soltar la fidelidad de archivo.)*

## 6. Riesgos y mitigaciones
- **El original evoluciona** (columnas/hojas nuevas): el reader valida cabeceras
  contra el anexo y **falla ruidoso con reporte claro** si el layout cambió;
  actualizar anexo+mapas es un cambio corto.
- **Agregados que no cuadran** (nuestras fórmulas vs las del archivo): la
  validación cruzada de 5.3 es la puerta; ante discrepancia, manda el archivo
  (se documenta la regla real y se ajusta el cálculo JS). **Resuelto en 5.3:** las
  Matrices/KPI´s NO son derivables del LOG (modelo distinto: actividades
  planificadas × WTG) → se leen como referencia; lo validado contra el archivo es
  la reproducción de sus fórmulas O/P (1364/1364) y los días hábiles.
- **Confidencialidad**: el xlsx y el anexo NO se versionan en este repo público
  (`auditoria/` gitignoreada; el archivo vive fuera del repo / en el backend).
  La UI no expone nombres de personas.
- **Gráficos (mejora opcional v1.1)**: si se quisieran, la vía es usar el
  archivo original como plantilla solo para las hojas con gráficos — sin
  compromiso en v1.
