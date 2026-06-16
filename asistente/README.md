# Asistente IA de PÓRTICO — diseño

Convierte una instrucción en lenguaje natural (ej.: *"edificio de 3 niveles de
3 m, planta 10×10 que pasa a 10×8, vigas IPE300, pilares HEB200, diafragmas
rígidos, sismo + sobrecarga de colegio + viento en Valdivia"*) en un modelo
`.s3d` listo para abrir en PÓRTICO.

## Arquitectura: el LLM traduce, el código construye

1. **LLM → ficha estructurada (JSON pequeño).** Solo rellena campos acotados
   (niveles, alturas, plantas, perfiles, diafragmas, lista de cargas, ciudad).
   No genera geometría ni inventa valores de ingeniería.
2. **Generador determinista.** Ficha + reglas + bibliotecas → `.s3d`. Es la
   fuente de verdad de la ingeniería (auditable, repetible).
3. **Funciones reutilizables en la app.** Cada paso (importar biblioteca,
   aplicar carga de área, generar combinaciones) es además un **botón** propio;
   el asistente solo los invoca.

## Bibliotecas (CSV, ampliables)

- **`perfiles.csv`** — 90 perfiles I (IPE, HEA, HEB, HEM) según EN 10365, con
  todas las propiedades (h, b, tw, tf, r, masa, A, Av_y, Av_z, Iy, Wel/Wpl,
  i, Iz, It, Iw). Verificado contra IPE300/HEB200. Se amplía agregando filas.
  *Pendiente:* tubos CHS/RHS/SHS y perfiles IPN/UPN/L.
- **`materiales.csv`** — aceros (S235/S275/S355, A270ES, A630-420H) y hormigones
  (H20–H40). E, G, ν, ρ, fy/fc.
- Convención: `Iy` = eje fuerte (mayor), `Iz` = eje débil (menor). El generador
  mapea al sistema local de PÓRTICO y convierte cm²/cm⁴ → m²/m⁴.

## Sistema de cargas

- **Cargas de área (kN/m²)** — sobrecarga de uso (NCh1537), nieve (NCh431),
  peso de losa. El generador las reparte a las vigas por **ancho tributario**:
  `w = q × ancho_tributario`. También definen la **masa sísmica** (CM + % CV)
  en los diafragmas → alimenta el caso espectral.
- **Viento (NCh432)** y **sísmica (NCh433)** — dependen de la ubicación. Se
  codificarán **desde los Excel del profesor** (fuente de verdad), no inventados.
  Sísmica → casos espectrales (dir X e Y), que PÓRTICO ya soporta.
- **Nieve (NCh431)** — el profesor no la tiene aún; se arma con la norma y valida.

## Combinaciones (botón + asistente)

- Botón **"Generar combinaciones"**: materializa plantillas NCh3171
  (gravitacional / sísmica / con eventuales) como combos reales sobre los casos
  existentes (CM, CV, SismoX/Y, Viento, Nieve).
- El asistente lo invoca: pedir *"agrega las cargas eventuales"* crea los casos
  faltantes (viento, nieve, sismo) **y** sus combinaciones.

## LLM recomendado (PC sin GPU/poca RAM, sin exponer credenciales)

- Sin modelos locales. **LLM gratis en la nube** (Gemini Flash o Groq) con la
  **credencial del lado del servidor** (n8n cifrado o un Cloudflare Worker como
  proxy). La llave nunca toca el navegador ni tu PC.

## Archivos

- **`reglas.json`** (v0.5) — normas codificadas: sobrecargas NCh1537, sismo
  NCh433/DS61, combinaciones NCh3171, viento NCh432, nieve NCh431.
- **`ficha.schema.json`** — JSON Schema (draft-07) de la ficha que rellena el LLM.
- **`generador.js`** — generador determinista (ES module puro, Node + navegador):
  `generarModelo(ficha, { reglas, perfiles, materiales, sobrecargas }) → .s3d`.
- **`ejemplo_ficha.json`** / **`ejemplo_salida.s3d`** — ejemplo (colegio 3 niveles,
  planta variable 10×10→10×8, Valdivia).
- **`test_generador.mjs`** — test Node: conteos, mapeo de secciones y EQUILIBRIO
  con el solver estático real (`node asistente/test_generador.mjs`).

### Qué hace el generador hoy

- Grilla (ejes explícitos o subdivisión por `separacion_maxima_vano_m`).
- Multinivel con planta interpolada linealmente (taperizado).
- Nodos, apoyos (empotrado/rotulado), pilares y vigas (X e Y); diafragmas rígidos.
- Mapeo perfil EN → sección PÓRTICO con conversión cm→m e **intercambio de ejes**
  (`Iz←Iy_EN` fuerte, `Avy←Avz_EN` alma) verificado contra `timoshenko.js`.
- Cargas de área (CM + sobrecarga NCh1537) → líneas en vigas por **ancho
  tributario** (escalado con la planta variable); conserva la resultante.
- Masa sísmica en diafragmas (CM + fracción CV); casos espectrales Sismo X/Y.
- Combinaciones NCh3171 (LRFD) sobre los casos generados.

## Pendiente

1. Magnitudes de viento/nieve/sismo: los casos quedan creados como geometría;
   falta poblar presiones de viento (NCh432) y el espectro (NCh433) con los
   parámetros de la ficha (`sismo`, `ubicacion`).
2. Botones en la app: importar biblioteca CSV, aplicar carga de área, generar
   combinaciones (reutilizar `generador.js` desde la UI).
3. Flujo n8n (chat → LLM → ficha → `generador.js`).
4. Completar bibliotecas: tubos CHS/RHS/SHS, IPN/UPN/L.
