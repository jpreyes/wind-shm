# Bugs / limitaciones del MOTOR — para corregir en structweb3d (upstream)

Detectadas trabajando el SHM de torres eólicas, pero viven en el **motor compartido**
(`js/model/model.js`, `js/solver/assembler.js`, `js/solver/modal_solver.js`), así que
**también afectan a PÓRTICO original**. Documento autocontenido para llevarlas a
`structweb3d` (remote `upstream`). No incluye nada específico de wind-shm.

Severidad: 🔴 correctitud · 🟡 limitación de fidelidad · 🟢 mejora.
Verificado contra el código en commit `#86` (v199).

---

## E1 · 🟡 Masa nodal sólo traslacional (sin inercia rotacional)

**Dónde.** `model.js:66` define `nodeMass: { mx, my, mz }`. `assembler.js:98-106` la
ensambla **sólo** en los GDL de traslación (Ux/Uy/Uz):

```js
M[b*nDOF     + b    ] += nm.mx || 0;   // Ux
M[(b+1)*nDOF + (b+1)] += nm.my || 0;   // Uy
M[(b+2)*nDOF + (b+2)] += nm.mz || 0;   // Uz
// no se tocan los GDL rx/ry/rz
```

**Impacto.** Cualquier masa concentrada con **inercia rotacional** propia (equipo en una
losa, masa excéntrica, RNA de una torre, tanque sobre pedestal) queda con inercia rotacional
= 0. Los modos de cabeceo/torsión locales salen mal. Hoy hay que emularlo con masas
traslacionales sobre un brazo rígido (`addLink`), lo cual es indirecto.

**Fix propuesto.** Extender `nodeMass` con `Irx/Iry/Irz` (ton·m²) y poblar la diagonal de M:

```js
M[(b+3)*nDOF + (b+3)] += nm.Irx || 0;   // Rx
M[(b+4)*nDOF + (b+4)] += nm.Iry || 0;   // Ry
M[(b+5)*nDOF + (b+5)] += nm.Irz || 0;   // Rz
```

Tocar también `model.js` (default `{mx,my,mz,Irx:0,Iry:0,Irz:0}`), `updateNode`, el
`serializer.js` (.s3d) y la UI de masa nodal. ~10 líneas en total.

---

## E2 · 🔴 Modos espurios por `eps` cuando hay GDL con masa nula

**Dónde.** `modal_solver.js:63-66`. Para evitar singularidad en M cuando un GDL libre no
tiene masa, se le inyecta un `eps`:

```js
const eps = maxMd * 1e-8;
for (let i = 0; i < nF; i++) if (Math.abs(Mff[i][i]) < eps) Mff[i][i] = eps;
```

**Impacto.** Es un parche razonable, pero los GDL rotacionales sin masa (consecuencia
directa de **E1**) reciben `eps` y pueden aparecer como **modos espurios de muy alta
frecuencia** mezclados con los estructurales, o desplazar el conteo de modos. Con masa
rotacional real (E1) el parche deja de ser necesario en esos GDL.

**Fix propuesto.** Resolver E1 reduce la dependencia del `eps`. Adicional: marcar/condensar
los GDL sin masa (condensación estática de Guyan sobre los GDL másicos) o filtrar los modos
cuyo factor de participación de masa sea ~0 antes de reportarlos.

---

## E3 · 🟡 Resortes de apoyo sólo en la diagonal (sin acople)

**Dónde.** `model.js:69` `springs: { kux, kuy, kuz, krx, kry, krz }`; `assembler.js:72-82`
los suma **sólo a la diagonal** de K:

```js
const ks = [sp.kux, sp.kuy, sp.kuz, sp.krx, sp.kry, sp.krz];
for (let i = 0; i < 6; i++) if (ks[i] > 0) K[(b+i)*nDOF + (b+i)] += ks[i];
```

**Impacto.** No se puede representar la rigidez de apoyo **acoplada** (términos fuera de
diagonal), p.ej. el acople lateral–rocking K_LR de una fundación flexible, o un apoyo
elástico con rigidez no alineada a los ejes globales. Limita SSI y apoyos elastoméricos.

**Fix propuesto.** Permitir una matriz de resorte 6×6 opcional por nodo
(`node.springMatrix`, simétrica) y ensamblar el bloque completo. Mantener el `springs`
diagonal como atajo. Alternativa de bajo costo ya disponible: modelar el apoyo con un
**elemento corto** equivalente (su matriz de rigidez sí acopla).

---

## E4 · 🟡 No hay resortes nodales unilaterales (tension/compression-only)

**Dónde.** `el.compressionOnly` / `el.cable` existen a nivel de **elemento**
(`model.js:149-156`), pero `node.springs` es **lineal** (siempre activo en tracción y
compresión).

**Impacto.** No se puede modelar directamente un apoyo que **sólo trabaja en compresión**
(despegue/uplift de fundación, contacto unilateral, neopreno que no tracciona). Hoy se
emula con barras cortas `compressionOnly`, que es funcional pero indirecto.

**Fix propuesto.** Bandera por GDL en el resorte (`springs.compressionOnly = {uz:true,…}`)
resuelta en el camino no lineal (igual que `compressionOnly` de barra). Útil para SSI con
gapping y para apoyos de contacto.

---

## E5 · 🟢 Curvas de suelo no lineales (p–y / t–z / q–z)

**Dónde.** Ya está en el roadmap de macromodelos (`docs/macromodelos.md`, fila "Suelo /
interacción suelo-estructura" y §"Capacidades NL transversales"). Aún no implementado.

**Impacto / fix.** Resorte no lineal con curva calibrada (API arena/arcilla), integrado al
motor NL como capacidad reusable; los macromodelos sólo la referencian por flag. Habilita
SSI no lineal realista (sísmico, daño de fundación).

---

## Resumen de archivos a tocar

| Ítem | model.js | assembler.js | modal_solver.js | serializer.js | UI |
|---|---|---|---|---|---|
| E1 inercia rotacional nodal | ✔ (66, updateNode) | ✔ (98-106) | — | ✔ | ✔ |
| E2 modos espurios | — | — | ✔ (63-66) | — | — |
| E3 resorte acoplado 6×6 | ✔ (69) | ✔ (72-82) | — | ✔ | ✔ |
| E4 resorte unilateral | ✔ | ✔ (camino NL) | — | ✔ | ✔ |
| E5 p–y no lineal | — | — | — | — | (ver macromodelos.md) |

> Bug específico de wind-shm (no upstream): el `??`/NaN en `macros/turbine.js`, ya corregido
> y registrado en `docs/wind-shm-issues.md`. Ese archivo **no existe** en structweb3d.
