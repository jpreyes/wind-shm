# Frente 5 — Módulo «Calidad de obra» (`R-41`): ingesta y export del Log de protocolos

**Estado:** plan · **Origen:** el proyecto Camán se gestiona con un libro Excel
(«Log protocolos SACYR.xlsx», ~25 hojas) que es **el formato de facto del
proyecto**. ReWind debe poder **ingerirlo**, gestionarlo (dashboard de calidad +
integración con Obra/CMMS) y **exportar un Excel cuya INFORMACIÓN coincida**:
mismas hojas, mismas cabeceras, **mismos valores en las mismas celdas**.

> **Alcance del round-trip (acordado):** lo que debe coincidir es **la
> información — los valores de las celdas**. NO es necesario reproducir
> fórmulas, gráficos, formatos condicionales ni estilos (los gráficos serían
> «ideal, no necesario»). Donde el original tiene una fórmula, el export escribe
> **el valor calculado**.

> **Anexo de construcción (no versionado, contiene estructura interna del
> proyecto):** `auditoria/SPEC-sacyr-xlsx-2026-07-02.md` — mapa columna-a-columna
> verbatim de cada hoja (cabecera, fila de datos, qué columnas son fórmula en el
> original, fórmulas de ejemplo, valores de estado observados y el catálogo de la
> hoja «Listas»). Ese anexo + este plan = espec completa.

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

- **Reader** (`tools/sacyr_reader.mjs`, JS puro sobre el zip): lee el libro con
  **valores calculados** (el xlsx guarda el último valor de cada fórmula en el
  XML, no hace falta motor de cálculo) según el mapa del anexo → **JSON
  canónico**. Corre igual en Node (tests) y en el navegador (`fflate`
  vendorizado en `lib/`, mismo patrón que numeric/leaflet).
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
- **Criterio de aceptación (diff de INFORMACIÓN)** — `tools/sacyr_diff.mjs`:
  compara **valores celda a celda** (normalizando tipo: fecha-serial vs fecha,
  número vs texto numérico) entre el export y el original:
  1. Round-trip **sin cambios** → 0 diferencias de valor en las hojas de datos,
     y en las derivadas dentro del alcance.
  2. **Con cambios** → difieren exactamente las celdas esperadas (+ los
     agregados derivados afectados).
  3. El export abre en Excel/LibreOffice sin advertencias.

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
| ⬜ 5.1 | **Reader** + JSON canónico + tests Node con el archivo real | 2 días | 1.437 + 2.501 + ensayos parseados; spot-checks; días hábiles recalculados ≈ archivo. |
| ⬜ 5.2 | **Writer de valores** + **diff de información** | 1–2 días | Round-trip sin cambios → 0 diffs de valor en hojas de datos; abre sin advertencias. |
| ⬜ 5.3 | **Derivados en JS** (matriz por WTG, KPIs turnaround, pendientes) + validación cruzada contra los valores del archivo | 1–2 días | Nuestros agregados == valores del archivo original. |
| ⬜ 5.4 | **Pestaña «Calidad»** (import navegador + dashboard + drill) | 3 días | El xlsx real se importa y navega; KPIs coinciden con la hoja KPI´s. |
| ⬜ 5.5 | **Integración** Obra/HUD/CMMS (avance real opt-in, ensayos hormigón) | 2 días | El 4D puede mostrar % real de protocolos por torre. |
| ⬜ 5.6 | **Edición + export** (ciclos/protocolos nuevos → writer en navegador) | 1–2 días | Un ciclo registrado en ReWind aparece en el Excel exportado; el resto de la información, idéntica. |
| ⬜ 5.7 | **Backend (con Frente 4, fase 3.5b)**: Postgres (`protocolos/ciclos/ensayos_*`), upload de versiones (upsert idempotente por código+correlativo), export server-side, historial | 3 días | Dos usuarios ven el mismo log; export desde BD. |

*(Total v1 ≈ 1½ semanas — bajó desde ~2 al soltar la fidelidad de archivo.)*

## 6. Riesgos y mitigaciones
- **El original evoluciona** (columnas/hojas nuevas): el reader valida cabeceras
  contra el anexo y **falla ruidoso con reporte claro** si el layout cambió;
  actualizar anexo+mapas es un cambio corto.
- **Agregados que no cuadran** (nuestras fórmulas vs las del archivo): la
  validación cruzada de 5.3 es la puerta; ante discrepancia, manda el archivo
  (se documenta la regla real y se ajusta el cálculo JS).
- **Confidencialidad**: el xlsx y el anexo NO se versionan en este repo público
  (`auditoria/` gitignoreada; el archivo vive fuera del repo / en el backend).
  La UI no expone nombres de personas.
- **Gráficos (mejora opcional v1.1)**: si se quisieran, la vía es usar el
  archivo original como plantilla solo para las hojas con gráficos — sin
  compromiso en v1.
