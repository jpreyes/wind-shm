# PÓRTICO — Roadmap de mejoras

Plan de mejoras detectadas en uso práctico (análisis y diseño), agrupadas por
similaridad. `[#]` referencia el pedido original. Estado: ⬜ pendiente · 🟡 en curso · ✅ hecho.

---

## G1 · Panel de análisis y acceso a resultados *(parcial)*
*El cuello de botella del flujo: lanzar análisis y reusar resultados.*
- ✅ **Ventana flotante de análisis** (Centro de análisis): el botón "Análisis" de la barra lateral abre un panel con TODOS los análisis (Estático, Modal, Espectro + 6 avanzados NL-lite), cada uno con botón Ejecutar. `[#4]`
- 🟡 **Acceso a resultados ya corridos**: badges ✓/sin-ejecutar por análisis y botón **Ver** que re-muestra sin recalcular (estático, modal, y cada caso espectral listado). Falta: indicador permanente fuera del hub. `[#1]`
- ✅ **Modal/progreso**: el modal **sale del modo resultados antes de correr**; la **estructura original** se dibuja como **fantasma tenue** (0.28) durante la animación; la **caja flotante de progreso** del estático (`_showProgress/_hideProgress`) ahora también aparece en **Modal** y **Espectro**. ⬜ Pendiente menor: los 6 NL-lite son síncronos (rápidos) — para mostrarles la caja habría que volverlos async. `[#2]`

## G2 · Motor modal y rendimiento
- ⬜ **Método modal alternativo** (el de las referencias) + **selector de método** en la ventana modal; el modal actual es lento. `[#3]`

## G3 · Navegación y legibilidad del viewport *(quick wins)* ✅
- ✅ **PAN (manito)** además de orbitar. Herramienta en la barra lateral (modo `pan`): arrastrar con la izquierda panea, restaura orbit al salir. `[#8]`
- ✅ **Grillas más tenues** (opacidad 0.7→0.38) → los elementos resaltan. `[#9]`
- ✅ **Ocultar los ejes**: Vista → Ejes XYZ (`toggleAxes`). `[#10]`

## G4 · Modelado e interacción de edición ✅
- ✅ **Crear elementos sin nodos previos + imán a nodos cercanos (toggle).** En modo Elemento, clic en la grilla crea el nodo; con Imán (casilla en la barra superior, por defecto ON) el extremo se pega al nodo cercano (lo reutiliza); apagando el imán crea uno nuevo aunque haya otro al lado. `[#6]`
- ✅ **Herramienta "Área" en la barra lateral** (Nodo/Elem/**Área**/Apoyo): clic en 3 (CST) o 4 (QUAD) nodos; el 4º crea el QUAD, Enter crea el CST, Esc reinicia. Usa las últimas opciones (espesor/comportamiento) y se ajustan luego en el panel del área. `[#nuevo]`
- ✅ **Acciones + Mover/Copiar con un solo elemento** seleccionado (antes solo con multi-selección). `[#7]`
- ✅ **Copiar elemento = copiar también sus cargas (dist/temp), cable/L0, y grupos.** `[#11]`

## G5 · Cargas, normativa y asistente de modificación
- ⬜ **Casos de carga y combinaciones de la norma por defecto** (creados automáticamente). `[#16]`
- ⬜ **Asistente sobre el modelo ya construido**: "agrega carga viva de 20 kN", viento, sismo, modificadores, desplazamiento de masa, anexar estructuras (encima/laterales) — acciones fáciles de interpretar y ejecutar. `[#5]`

## G6 · Diseño, memoria y reportes
- ⬜ **Tabla de diseño explorable**: scroll hasta el último elemento + mostrar **desplazamientos**. `[#12]`
- ⬜ **Memoria de cálculo descargable en `.docx`**. `[#14]`
- ⬜ **Quitar logos UACh de la memoria** cuando se cargue el logo profesional. `[#18]`
- ⬜ **Quitar de la UI/ayuda toda referencia a editar archivos de config** (json, etc.). `[#13]`

## G7 · Gestión de proyecto multi-modelo
- ⬜ **Un proyecto con varios modelos** (edificio principal, cercha plana, viga de fundación…) que se integran en **una sola memoria**. `[#17]` *(cambio más arquitectónico: serializer, estado de la app, generador de memoria).*

## G8 · Robustez y diagnóstico
- ⬜ **Diagnóstico de inestabilidades**: localizar y **resaltar el nodo/GDL culpable** (el caso del nodo "invisible"). `[#15]`

## G9 · Verificación documentada y documentación
- ⬜ **Casos de la literatura SAP2000** (en `referencias/`) → convertirlos a formato Pórtico, **comparar/verificar y documentar**; quedan en **Ejemplos** como casos de verificación. `[#19]`
- ⬜ **Mejorar UX de los análisis avanzados** (no lineales) + **ejemplo sencillo y `.md` por funcionalidad** (pandeo, form-finding, pushover). `[#20]`
- ⬜ **Documentación integral de toda funcionalidad**: qué hace, teoría mínima, cómo ejecutarla en la app. `[#21]`

## G10 · Completar la física de elementos (FEM / shell)
*Continuación del trabajo de placa/shell.*
- ⬜ **Contorno de tensiones de flexión de placa**: momentos `Mx,My,Mxy` desde curvaturas → tensiones de fibra sup./inf. `σ=±6M/t²` → von Mises de superficie, con selector (membrana / cara sup / cara inf) y suavizado nodal. *(Comparte con G1.)*
- ✅ **Torsión de St. Venant**: el `J` ya se auto-calcula de la geometría en todas las secciones paramétricas (rect, circular, huecas; IPE/HEB tabuladas). Mejorado: fórmula rectangular a la serie precisa de Roark `J=a·t³·[1/3−0.21(t/a)(1−(t/a)⁴/12)]`; corregido el `J` de la sección por defecto 30×30 (era 1.13e-4, 10× bajo → 1.14e-3).
- ✅ **Masa de área para el modal**: las áreas aportan `ρ·t·A` (lumped, repartida a los GDL de traslación) a la matriz de masas, en el ensamblaje denso y disperso (`assembleAreasMassInto`). Verificado: masa total por dirección = ρ·t·A.

---

## Secuencia sugerida
1. **G3** y **G4** — quick wins de uso diario, bajo riesgo.
2. **G1** — alto impacto en el flujo; base para G2 y G9.
3. **G5** — productividad práctica (normativa + asistente).
4. **G8** — robustez.
5. **G2** + **G10/masa** — rendimiento y física modal.
6. **G6** — reportes (la `.docx` se apoya en la memoria).
7. **G9** + **G10/contorno** — verificación y documentación.
8. **G7** — multi-modelo al final (rediseño mayor).

## Decisiones pendientes
- **G2 (método modal)**: ¿qué método de las referencias (subespacio / Lanczos / el documentado allí)?
- **G7 (multi-modelo)**: ¿modelos solo unidos *en la memoria*, o vinculados geométricamente?
- **G9 (verificación SAP2000)**: ¿cuántos casos priorizar (sugerencia: viga, pórtico, muro/shell, modal)?
