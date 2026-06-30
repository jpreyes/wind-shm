# Frente 3 — Gemelo de construcción (`R-31`) 🌟

**Estado:** plan para discutir · **Objetivo:** mientras la torre se erige, el gemelo
**predice la f₁ que debería tener en cada etapa** y la compara con lo medido por los
acelerómetros → detecta defectos de obra **antes** de la puesta en marcha y captura la
**línea base de commissioning**.

---

## Estado del arte
Las torres se diseñan **soft-stiff**: la f₁ debe caer en una ventana estrecha **entre
1P y 3P, ≥10% lejos de cada una**, para evitar resonancia con el giro del rotor (1P) y
el paso de aspas (3P). La **rigidez de la fundación** afecta fuerte la f₁ (voladizo
sobre apoyo flexible). La SHM por seguimiento de frecuencia existe… **pero solo en
operación**. **Nadie sigue la frecuencia durante el montaje ni formaliza la captura de
la línea base de puesta en marcha con un gemelo** — ese es el white space.

## Lo que necesitamos tener (table stakes)
- El gemelo calcula la **f₁ de la torre terminada** y verifica la **ventana soft-stiff
  vs 1P/3P** (criterio de aceptación real de diseño).
- **Captura de la línea base de commissioning** (f₁/f₂/amortiguamiento) por torre — la
  referencia de toda la SHM operacional posterior.
- **Seguimiento de frecuencia** con límites de control.

## Lo que nos diferencia (el white space)
- **f₁ predicha-vs-medida POR ETAPA de montaje** (la curva mientras sube la torre):
  novedoso; reusa `built` del 4D + `modal_solver` sobre el voladizo truncado.
- **Detección temprana de defectos**: rigidez de fundación insuficiente (f₁ bajo lo
  predicho), pretensado de pernos/grout (firma de frecuencia/amortiguamiento),
  asentamiento (tendencia de tilt).
- **Acopla construcción → línea base → operación en un solo gemelo continuo.**
- **MEMS baratos + gemelo físico en navegador** vs galgas + nube propietaria.
- **Compuerta de aceptación**: cada torre obtiene un **«certificado de puesta en
  marcha» automático** (f₁ en ventana, baseline capturada, defectos señalados).

---

## La física (por qué funciona)
Una torre a medio montar es un **voladizo más corto y rígido** → f₁ alta. Al agregar
tramos, sube la masa y se alarga el voladizo → **f₁ baja por una curva monótona y
predecible**. Cada punto medido **fuera de la banda** del gemelo señala una causa:

| Síntoma | Causa probable en obra |
|---|---|
| f₁ medida **menor** que la predicha | base más flexible: pernos de brida sin pretensar, grout deficiente, fundación sin rigidez/curado |
| f₁ no sube al rigidizar la base | fundación/anclaje no trabaja como empotramiento |
| Amortiguamiento anómalo | junta que disipa → conexión floja |
| Tilt creciente entre hitos | asentamiento temprano de la fundación |

## Plan por fases (mapeo al código actual)
1. **Gemelo** — `digital_twin.js` calcula `f₁(built)` del voladizo parcial; **verificar
   vs solución analítica de voladizo** (test Node). Chequeo de ventana soft-stiff vs
   1P/3P (rango de RPM del rotor como parámetro).
2. **Datos** — f₁ medida por etapa (desde `SimulatedSource` ahora; `LiveSource` después).
3. **UI** — tarjeta «Construcción»: **curva predicha + puntos medidos + banderas
   verde/ámbar/rojo + banda soft-stiff**. (Integra con el HUD del Frente 1: el crosslink
   «Gemelo: f₁ en banda ✓» de cada partida sale de aquí.)
4. **Línea base** de commissioning + **exportar certificado** por torre.
5. **Calibración** — una torre patrón fija masa/rigidez nominales; extrapolar al tipo.
6. **(Después)** integración en vivo (`R-10`/`R-11`) + sensor de tilt biaxial (`R-24`).

## Dependencias
- `R-21` (OMA) para obtener la f₁ **medida** real desde la señal.
- Frente 1 (`R-18`) — comparte el modelo de etapas/`built` y alimenta su crosslink.
- `R-10`/`R-11` para datos en vivo; `R-24` para tilt.

## Decisiones
- ⬜ ¿Arrancar con `f₁(built)` + curva predicha y puntos **simulados**, dejando la f₁
  medida real para cuando esté `R-21`/`bridge`? (recomendado).
- ⬜ Modelo del voladizo parcial: ¿viga de Timoshenko equivalente (rápida) o el
  macro-modelo de turbina truncado? (empezar con el equivalente, validar contra
  analítico).
- ⬜ Formato del «certificado de puesta en marcha» (PDF/HTML) — alinear con el informe
  existente.

## Fuentes
- [Resonance analysis under 1P/3P loads (soft-stiff window)](https://www.mdpi.com/1996-1073/15/16/5787)
- [Type of towers – stiff, soft or soft-soft (BoP)](https://www.windfarmbop.com/type-of-towers-stiff-soft-or-soft-soft/)
- [Leveraging Digital Twins for Virtual Sensing & Fatigue (Devriendt & Weijtjens, 2025)](https://link.springer.com/chapter/10.1007/978-3-031-96110-6_102)
