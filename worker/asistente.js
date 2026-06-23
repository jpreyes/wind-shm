// ──────────────────────────────────────────────────────────────────────────────
// Cloudflare Worker — sirve la PWA (assets) y expone la API del asistente.
//   POST /api/asistente   body { mensaje }  → LLM (OpenRouter) → ficha → modelo
//                         body { ficha }    → genera directo (sin LLM)
//   resto de rutas        → assets estáticos (la app PÓRTICO)
//
// La API key de OpenRouter vive como SECRETO del Worker (env.OPENROUTER_API_KEY),
// nunca en el código ni en el navegador:
//   npx wrangler secret put OPENROUTER_API_KEY
// ──────────────────────────────────────────────────────────────────────────────
import { generarModelo } from '../asistente/generador.js';

// Modelos gratis de OpenRouter en cascada: si uno está rate-limited (429) o
// caído (5xx), se prueba el siguiente. env.OPENROUTER_MODEL fuerza uno solo.
const MODELS_FREE = [
  'deepseek/deepseek-chat-v3-0324:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'meta-llama/llama-3.1-8b-instruct:free',
];

const SYSTEM = `Eres un asistente que convierte la descripcion de una estructura en una FICHA JSON para PORTICO. Responde SOLO con el JSON de la ficha, sin texto ni markdown. Campos: proyecto, modo (2D|3D), ubicacion{ciudad,latitud_sur_deg,altitud_msnm,exposicion(B|C|D)}, geometria{niveles:[{altura_m,uso_NCh1537?,sobrecarga_uso_kN_m2?}],vanos_x?,vanos_y?,planta_inferior?{Lx_m,Ly_m},planta_superior?,pendiente_techo_deg?}, secciones{material,vigas,pilares}, apoyo_base(empotrado|rotulado), diafragma_rigido, cargas{muerta_adicional_kN_m2,uso_NCh1537,cierre_viento,nieve,viento,sismo}, sismo{zona(1|2|3),suelo(A..E),categoria(I..IV),R}. vanos_x/vanos_y: lista de luces [3,3,3,4] o uniforme {cantidad,luz_m} (ej. "4 vanos de 3 m en X" -> vanos_x:{cantidad:4,luz_m:3}). Cada nivel puede tener distinta altura y distinto uso (ej. nivel 1 Salas de Clases, nivel 3 Bodegas livianas) -> ponlo en niveles[k].uso_NCh1537. Omite lo no mencionado; no inventes valores de ingenieria. secciones.vigas/pilares: perfil de acero por nombre ('IPE300','HEB200') O seccion rectangular de hormigon {b_cm,h_cm} (ej. viga de HA 20x40cm -> {b_cm:20,h_cm:40}; pilar 30x30 -> {b_cm:30,h_cm:30}). material: acero (S235/S275/S355/A630-420H) u hormigon H20/H25/H30/H40 (fc en MPa -> H{fc}, ej. fc=30 MPa -> "H30"). Si las secciones son de hormigon, el material debe ser un Hxx.
TIPOLOGIA: por defecto "marco" (pilares+vigas de acero/hormigon). Para EDIFICACIONES DE MADERA con tabiques / pies derechos / entramado ligero usa tipologia:"muros_madera" y NO uses secciones.vigas ni secciones.pilares; en su lugar agrega: tabiques{escuadria,separacion_m,perimetro,interiores:[{nivel,dir(X|Y),pos_m,aberturas:[{tipo(puerta|ventana),ancho_m,alto_m,centro_m}]}]} y entrepisos{escuadria,separacion_m,dir(X|Y)}. Escuadrias EN PULGADAS como string: "2x4","2x6","2x8","2x10". La planta va en geometria.planta_inferior{Lx_m,Ly_m}. material:"Pino Radiata". Mapeos: "pie derecho/tabique 2x4 cada 40cm" -> tabiques.escuadria:"2x4", separacion_m:0.4 ; "viga de piso 2x8 cada 60cm" -> entrepisos.escuadria:"2x8", separacion_m:0.6 ; "tabique al centro" -> interiores[].pos_m = mitad de la dimension perpendicular ; "puerta de 80cm al centro del tabique" -> aberturas:[{tipo:"puerta",ancho_m:0.8}] con centro_m al medio ; "uso habitacional" -> cargas.uso_NCh1537:"Habitacionales/Viviendas". Las cerchas de techo aun no se generan: omitelas (se modela techo plano de viguetas).
STEEL FRAMING / METALCON: son los MISMOS tabiques pero en acero → usa tipologia:"muros_madera" con secciones.material:"acero" (o "S275"). Igual para cerchas de acero: material:"acero". Si el material es madera/pino usa "Pino Radiata".
TECHO del edificio de tabiques: por defecto plano. Para techo a dos aguas de cerchas Warren integrado, agrega techo:{tipo:"cercha", pendiente_pct (ej 10), separacion_m (ej 0.6), escuadria_cordon:"2x6", escuadria_diagonal:"2x4"}. "casa con techo a dos aguas de cerchas pendiente 10%" -> techo:{tipo:"cercha","pendiente_pct":10}.
PUENTE: tipologia:"puente" + puente:{largo_m, ancho_m, altura_pila_m, luz_pila_m (o n_pilas), tipo("tablero"|"viga_central")}. material del puente en secciones.material (hormigon "H50"/"fc=50" -> usa "H50"; acero S275). tipo "tablero" (2 vigas laterales): tipo_viga("viga"|"cercha"), tipo_celosia, canto_m, puente.escuadria_viga. tipo "viga_central" (UNA viga longitudinal central + vigas transversales perpendiculares + cepas): pon puente.escuadria_longitudinal{b_cm,h_cm}, puente.escuadria_transversal{b_cm,h_cm}, puente.escuadria_pila{b_cm,h_cm}, puente.separacion_transversal_m, puente.carga_transversal_kN_m (carga lineal SOLO en transversales). Secciones rectangulares de hormigon SIEMPRE como {b_cm,h_cm} (NO objetos anidados). Ejemplos: "puente de 100m, viga central de hormigon fc=50 de 50x200cm, transversales 30x80cm cada 2m de 10m de ancho, cepas 100x100cm cada 20m, carga 500 kN/m en transversales" -> {"modo":"3D","tipologia":"puente","secciones":{"material":"H50"},"puente":{"tipo":"viga_central","largo_m":100,"ancho_m":10,"altura_pila_m":5,"luz_pila_m":20,"escuadria_longitudinal":{"b_cm":50,"h_cm":200},"escuadria_transversal":{"b_cm":30,"h_cm":80},"escuadria_pila":{"b_cm":100,"h_cm":100},"separacion_transversal_m":2,"carga_transversal_kN_m":500}}. "puente de 100m de largo y 2m de ancho con pilas cada 20m" -> {"tipologia":"puente","puente":{"largo_m":100,"ancho_m":2,"luz_pila_m":20}}.
PUENTE ARCO/CABLE: para puentes en ARCO o de CABLE usa tipologia:"puente" con puente.tipo y (segun el caso) flecha_m, n_pendolas, altura_pilon_m/altura_torre_m, escuadria_arco/escuadria_pilon, escuadria_viga, ancho_m. Tipos: "arco" (arco de tablero superior con montantes, tipo Salginatobel), "arco_atirantado" (bowstring: arco sobre el tablero-tirante, pendolas verticales, apoyos solo verticales), "network" (bowstring con pendolas inclinadas CRUZADAS, tipo Brunn-Schanack/Barqueta), "atirantado" (pilon central + tirantes en abanico, cable-stayed tipo Treng Treng/Severin), "colgante" (cable parabolico colgante + torres + pendolas, suspension tipo Golden Gate). Ejemplos: "puente en arco atirantado de 80m, flecha 16m, 10 pendolas" -> {"modo":"2D","tipologia":"puente","secciones":{"material":"acero"},"puente":{"tipo":"arco_atirantado","largo_m":80,"ancho_m":10,"flecha_m":16,"n_pendolas":10}}. "puente colgante de 200m, torres de 40m, sagita 30m" -> {"tipologia":"puente","puente":{"tipo":"colgante","largo_m":200,"flecha_m":30,"altura_torre_m":40}}. "puente atirantado de 140m con pilon de 35m" -> {"tipologia":"puente","puente":{"tipo":"atirantado","largo_m":140,"altura_pilon_m":35}}. "arco network ferroviario de 100m, flecha 17m" -> {"tipologia":"puente","puente":{"tipo":"network","largo_m":100,"flecha_m":17}}.
GALPON/NAVE INDUSTRIAL: tipologia:"galpon" + galpon:{luz_m (ancho que salvan las cerchas), largo_m, altura_columna_m, separacion_marcos_m, pendiente_pct, tipo_celosia("warren"|"pratt"|"howe")}. "galpon de 20m de luz, 30m de largo, columnas de 6m, marcos cada 5m, cerchas pratt" -> galpon:{luz_m:20,largo_m:30,altura_columna_m:6,separacion_marcos_m:5,tipo_celosia:"pratt"}. Default material acero.
Las celosias (cercha/techo/puente/galpon) aceptan tipo_celosia warren|pratt|howe.
PRIMITIVAS (estructura LIBRE, para CUALQUIER cosa sin plantilla: torres de alta tension, mastiles, parrillas, puentes de N vigas, etc.): tipologia:"primitivas" + material_defecto + elementos[] + apoyos[]. Cada elemento: {tipo:"barra"|"vigas_repetidas", desde:[x,y,z], hasta:[x,y,z] (metros), seccion:{b_cm,h_cm}|"IPE300"|"2x4", material?, n? (subdivisiones), carga_kN_m? (carga lineal vertical)}. vigas_repetidas repite la barra base en paso_dir:"X|Y|Z" cada paso, n_repeticiones (o hasta_coord). apoyos: {en:[[x,y,z],...] o z:0 (toda esa cota), tipo:"empotrado"|"rotulado"|"rodillo"}. Las barras que comparten un punto se unen solas (mismo nodo). Usa primitivas cuando ninguna plantilla encaje, o cuando el usuario da coordenadas/conteos explicitos. Ejemplo puente de 3 vigas (2 laterales + 1 central) de 60m, ancho 8m, transversales cada 2m con 50kN/m, cepas cada 20m, hormigon H40: {"modo":"3D","tipologia":"primitivas","material_defecto":"H40","elementos":[{"tipo":"vigas_repetidas","desde":[0,-4,5],"hasta":[60,-4,5],"paso_dir":"Y","paso":4,"n_repeticiones":3,"seccion":{"b_cm":40,"h_cm":120}},{"tipo":"vigas_repetidas","desde":[0,-4,5],"hasta":[0,4,5],"paso_dir":"X","paso":2,"hasta_coord":60,"seccion":{"b_cm":30,"h_cm":60},"carga_kN_m":50},{"tipo":"vigas_repetidas","desde":[0,-4,0],"hasta":[0,-4,5],"paso_dir":"X","paso":20,"hasta_coord":60,"seccion":{"b_cm":80,"h_cm":80}},{"tipo":"vigas_repetidas","desde":[0,4,0],"hasta":[0,4,5],"paso_dir":"X","paso":20,"hasta_coord":60,"seccion":{"b_cm":80,"h_cm":80}}],"apoyos":[{"z":0,"tipo":"empotrado"}]}.
Para CERCHAS/CELOSIAS/VIGAS WARREN sueltas (a dos aguas o viga de celosia, tipo Warren/Pratt/Howe) usa tipologia:"cercha" y rellena cercha{luz_m, pendiente_pct (ej 10 = 10%) o altura_cumbrera_m, n_paneles, separacion_m, escuadria_cordon (ej "2x6"), escuadria_diagonal (ej "2x4"), tipo_celosia(warren|pratt|howe)}. modo:"2D" por defecto, PERO si el usuario pide explicitamente 3D (ej "viga warren EN 3D", "cercha 3D") pon modo:"3D" (la cercha sigue siendo plana pero se muestra y navega en 3D). material:"Pino Radiata" (o "acero"/"S275" si es metalica). "cercha a dos aguas pendiente 10% cada 60cm" -> pendiente_pct:10, separacion_m:0.6. "viga warren en 3D de 12m" -> {modo:"3D",tipologia:"cercha",cercha:{luz_m:12,tipo_celosia:"warren"}}.
EJEMPLO madera (entrada: "casa de 2 niveles de 3m, planta 8x6, tabiques 2x4 cada 40cm, vigas de piso 2x8 cada 60cm, uso habitacional, pino radiata, con un tabique al centro con puerta de 80cm"):
{"modo":"3D","tipologia":"muros_madera","secciones":{"material":"Pino Radiata"},"geometria":{"planta_inferior":{"Lx_m":8,"Ly_m":6},"niveles":[{"altura_m":3},{"altura_m":3}]},"tabiques":{"escuadria":"2x4","separacion_m":0.4,"perimetro":true,"interiores":[{"nivel":1,"dir":"Y","pos_m":4.0,"aberturas":[{"tipo":"puerta","ancho_m":0.8,"alto_m":2.0,"centro_m":3.0}]}]},"entrepisos":{"escuadria":"2x8","separacion_m":0.6,"dir":"X"},"cargas":{"uso_NCh1537":"Habitacionales/Viviendas"}}
EJEMPLO cercha (entrada: "cercha de techo de madera a dos aguas, luz 10m, pendiente 10%, cerchas cada 60cm, tipo warren"):
{"modo":"2D","tipologia":"cercha","secciones":{"material":"Pino Radiata"},"cercha":{"luz_m":10,"pendiente_pct":10,"n_paneles":8,"separacion_m":0.6,"escuadria_cordon":"2x6","escuadria_diagonal":"2x4"}}`;

// Prompt para MODIFICAR un modelo ya construido: orden NL → lista de OPERACIONES
// (las ejecuta el cliente de forma determinista, ver js/model/model_ops.js).
const MOD_SYSTEM = `Eres un asistente que convierte una ORDEN de modificacion sobre un modelo estructural PORTICO YA CONSTRUIDO en una lista JSON de OPERACIONES. Responde SOLO con JSON {"ops":[...]}, sin texto ni markdown. Cada operacion es un objeto con "op". Tipos validos:
- {"op":"add_load","target","caso?","dir?","w","w2?"}: agrega carga distribuida (kN/m). target: "selection" (lo seleccionado por el usuario), "all_beams" (todas las vigas/horizontales), "columns", "all", o lista de ids de elemento. dir: "gravity" (por defecto, hacia abajo -Z), "globalX","globalY","localY","localZ". w = intensidad; w2 = intensidad en el extremo j (carga TRAPECIAL); omite w2 si es uniforme. caso = nombre del caso de carga (por defecto la sobrecarga de uso L).
- {"op":"add_story","height","copies?"}: anexa piso(s) ENCIMA replicando el nivel superior una altura height (m). copies = numero de pisos (def 1).
- {"op":"add_bay","dir","span","copies?"}: anexa vano(s) LATERAL(es) extendiendo la planta. dir: "x" o "y". span = luz del vano (m). copies def 1.
- {"op":"set_modifiers","target","mods":{"A?","Iy?","Iz?","J?"}}: factores de rigidez (seccion agrietada, etc.) a los elementos target.
- {"op":"set_mass","target","mass":{"mx?","my?","mz?"}}: masa nodal (ton) a NODOS. target de nodos: "selection","all" o lista de ids de nodo.
Usa el resumen del modelo (niveles_z, ejes_x, ejes_y, casos, secciones, bbox, unidades) y la seleccion para elegir target y valores coherentes. Si la orden menciona "seleccion"/"seleccionados" usa target "selection". No inventes operaciones fuera de esta lista; si algo no se puede expresar, omitelo. Devuelve {"ops":[]} si nada aplica.
Ejemplos:
"agrega carga viva de 20 kN/m a todas las vigas" -> {"ops":[{"op":"add_load","target":"all_beams","w":20}]}
"anexa un piso de 3 m encima" -> {"ops":[{"op":"add_story","height":3}]}
"agrega dos pisos mas de 3.5 m" -> {"ops":[{"op":"add_story","height":3.5,"copies":2}]}
"agrega un vano de 5 m hacia la derecha en X" -> {"ops":[{"op":"add_bay","dir":"x","span":5}]}
"carga triangular de 0 a 10 kN/m en la seleccion" -> {"ops":[{"op":"add_load","target":"selection","w":0,"w2":10}]}
"aplica modificador de rigidez Iz 0.5 a la seleccion" -> {"ops":[{"op":"set_modifiers","target":"selection","mods":{"Iz":0.5}}]}
"pon 2 ton de masa horizontal en todos los nodos" -> {"ops":[{"op":"set_mass","target":"all","mass":{"mx":2,"my":2}}]}`;

function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',').map((s) => s.trim());
    return Object.fromEntries(head.map((h, i) => [h, c[i]]));
  });
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });

// ── RAG: corpus de ejemplos + recuperación léxica (few-shot dinámico) ──────────
let _CORPUS = null;   // cache por instancia del Worker
async function cargarCorpus(env, base) {
  if (_CORPUS) return _CORPUS;
  try {
    const r = await env.ASSETS.fetch(new Request(new URL('/asistente/ejemplos.json', base)));
    const data = await r.json();
    _CORPUS = Array.isArray(data.ejemplos) ? data.ejemplos : [];
  } catch { _CORPUS = []; }
  return _CORPUS;
}
const STOP_RAG = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'o', 'en', 'con', 'un', 'una', 'para', 'por', 'que', 'es', 'al', 'm', 'cm', 'mm', 'cada', 'tipo']);
const tokRAG = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP_RAG.has(t));
// Recupera los k ejemplos más parecidos (solape de tokens) al mensaje del usuario.
function recuperarEjemplos(mensaje, corpus, k = 3) {
  const q = new Set(tokRAG(mensaje));
  if (!q.size || !corpus.length) return { ejemplos: [], score: 0 };
  const rank = corpus.map((ej) => {
    const t = tokRAG(`${ej.desc} ${JSON.stringify(ej.ficha.tipologia || '')}`);
    let s = 0; for (const w of t) if (q.has(w)) s++;
    return { ej, score: s / Math.sqrt(t.length || 1) };
  }).sort((a, b) => b.score - a.score);
  const top = rank.filter((r) => r.score > 0).slice(0, k);
  return { ejemplos: top.map((r) => r.ej), score: top.length ? top[0].score : 0 };
}

async function cargarBibliotecas(env, base) {
  const get = (p) => env.ASSETS.fetch(new Request(new URL(p, base)));
  const [reglas, pTxt, mTxt, sTxt] = await Promise.all([
    get('/asistente/reglas.json').then((r) => r.json()),
    get('/asistente/perfiles.csv').then((r) => r.text()),
    get('/asistente/materiales.csv').then((r) => r.text()),
    get('/asistente/sobrecargas_NCh1537.csv').then((r) => r.text()),
  ]);
  return { reglas, perfiles: parseCSV(pTxt), materiales: parseCSV(mTxt), sobrecargas: parseCSV(sTxt) };
}

// Proveedores del LLM EN ORDEN DE PRIORIDAD. Se intentan en cascada: primero
// OpenAI (si hay OPENAI_API_KEY), y si TODOS sus modelos fallan, se pasa a
// OpenRouter (modelos gratis). Ambos usan el formato chat/completions de OpenAI.
function proveedoresLLM(env) {
  const lista = [];
  if (env.OPENAI_API_KEY) lista.push({
    nombre: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    key: env.OPENAI_API_KEY,
    modelos: [env.OPENAI_MODEL || 'gpt-4o-mini'],
    extraHeaders: {},
  });
  if (env.OPENROUTER_API_KEY) lista.push({
    nombre: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: env.OPENROUTER_API_KEY,
    modelos: env.OPENROUTER_MODEL ? [env.OPENROUTER_MODEL] : MODELS_FREE,
    extraHeaders: { 'X-Title': 'PORTICO Asistente' },
  });
  return lista;
}

async function llamarModelo(prov, modelo, mensaje, fewshot = []) {
  // few-shot dinámico (RAG): pares usuario→ficha de los ejemplos recuperados
  const ejMsgs = [];
  for (const ej of fewshot) { ejMsgs.push({ role: 'user', content: ej.desc }, { role: 'assistant', content: JSON.stringify(ej.ficha) }); }
  return fetch(prov.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${prov.key}`, 'Content-Type': 'application/json', ...prov.extraHeaders },
    body: JSON.stringify({
      model: modelo,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, ...ejMsgs, { role: 'user', content: mensaje }],
    }),
  });
}

async function fichaDesdeLLM(mensaje, env, fewshot = []) {
  const provs = proveedoresLLM(env);
  if (!provs.length) throw new Error('Falta el secreto OPENAI_API_KEY u OPENROUTER_API_KEY en el Worker.');
  const intentos = [];   // log de cada intento (para diagnóstico)
  for (const prov of provs) {
    for (const modelo of prov.modelos) {
      const r = await llamarModelo(prov, modelo, mensaje, fewshot);
      if (r.ok) {
        const data = await r.json();
        if (data.error) { intentos.push(`${prov.nombre}/${modelo}: ${data.error.message || JSON.stringify(data.error)}`); continue; }
        let raw = String(data.choices?.[0]?.message?.content ?? '').trim()
          .replace(/^```(json)?/i, '').replace(/```$/, '').trim();
        const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
        if (i < 0 || j < 0) { intentos.push(`${prov.nombre}/${modelo}: no devolvió JSON`); continue; }
        // data.model = id real del modelo que respondió (puede traer sufijo de versión)
        return { ficha: JSON.parse(raw.slice(i, j + 1)), llm: { proveedor: prov.nombre, modelo: data.model || modelo, intentos } };
      }
      intentos.push(`${prov.nombre}/${modelo}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      // 401/403 = credencial/política: no sirve probar más modelos de ESTE proveedor.
      if (r.status === 401 || r.status === 403) break;
      // 429 (rate limit) o 5xx: probar el siguiente modelo del mismo proveedor.
    }
    // si este proveedor no funcionó, se pasa al siguiente (OpenAI → OpenRouter)
  }
  throw new Error(`Ningún modelo disponible. Intentos: ${intentos.join(' | ')}`);
}

// Llamada genérica chat/completions con un system prompt arbitrario (JSON mode).
async function chatJSON(prov, modelo, system, userContent) {
  return fetch(prov.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${prov.key}`, 'Content-Type': 'application/json', ...prov.extraHeaders },
    body: JSON.stringify({
      model: modelo, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
    }),
  });
}

// Orden de modificación → { ops:[...] } (cascada de proveedores/modelos, como la ficha).
async function opsDesdeLLM(payload, env) {
  const provs = proveedoresLLM(env);
  if (!provs.length) throw new Error('Falta el secreto OPENAI_API_KEY u OPENROUTER_API_KEY en el Worker.');
  const userContent = JSON.stringify(payload);   // { mensaje, modelo, seleccion }
  const intentos = [];
  for (const prov of provs) {
    for (const modelo of prov.modelos) {
      const r = await chatJSON(prov, modelo, MOD_SYSTEM, userContent);
      if (r.ok) {
        const data = await r.json();
        if (data.error) { intentos.push(`${prov.nombre}/${modelo}: ${data.error.message || JSON.stringify(data.error)}`); continue; }
        let raw = String(data.choices?.[0]?.message?.content ?? '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
        const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
        if (i < 0 || j < 0) { intentos.push(`${prov.nombre}/${modelo}: no devolvió JSON`); continue; }
        const parsed = JSON.parse(raw.slice(i, j + 1));
        const ops = Array.isArray(parsed) ? parsed : (parsed.ops || parsed.operaciones || []);
        return { ops, llm: { proveedor: prov.nombre, modelo: data.model || modelo, intentos } };
      }
      intentos.push(`${prov.nombre}/${modelo}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      if (r.status === 401 || r.status === 403) break;
    }
  }
  throw new Error(`Ningún modelo disponible. Intentos: ${intentos.join(' | ')}`);
}

// ── Registro de consultas en KV (revisión semanal) ────────────────────────────
// estado: 'ok' (generó), 'error' (falló LLM o generador), 'incorrecto' (feedback
// del usuario: no era lo solicitado). 'novedoso' es ortogonal (score RAG bajo).
// Devuelve la clave del registro (para que la app pueda enviar feedback luego).
async function registrarConsulta(env, { mensaje, ficha = null, rag = null, llm = null, estado = 'ok', error = null }) {
  if (!env.ASIS_LOG) return null;
  const ts = Date.now();
  const key = `q:${ts}-${Math.random().toString(36).slice(2, 6)}`;   // evita colisión en el mismo ms
  const registro = {
    id: key, ts, fecha: new Date(ts).toISOString(), estado,
    mensaje, ficha: ficha || null, tipologia: ficha?.tipologia || null,
    score: rag?.score ?? null, novedoso: !!rag?.novedoso,
    modelo: llm?.modelo || null, error: error || null, comentario: null,
  };
  try {
    await env.ASIS_LOG.put(key, JSON.stringify(registro), {
      expirationTtl: 60 * 60 * 24 * 180,
      metadata: { estado, novedoso: registro.novedoso, tipologia: registro.tipologia, score: registro.score },
    });
    return key;
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Lectura del registro de consultas (revisión semanal) ──
    // GET /api/asistente/log?token=TOKEN[&solo_novedosos=1][&limite=50]
    // Devuelve los pedidos guardados y un 'corpus_sugerido' [{desc, ficha}] listo
    // para revisar y pegar en asistente/ejemplos.json.
    if (url.pathname === '/api/asistente/log') {
      if (!env.ASIS_LOG) return json({ error: 'KV ASIS_LOG no está configurado en el Worker.' }, 400);
      const token = url.searchParams.get('token') || request.headers.get('x-asis-token');
      if (!env.ASIS_LOG_TOKEN || token !== env.ASIS_LOG_TOKEN) return json({ error: 'Token inválido (defina el secreto ASIS_LOG_TOKEN y páselo en ?token=).' }, 401);
      const soloNov = url.searchParams.get('solo_novedosos') === '1';
      const estadoF = url.searchParams.get('estado');   // ok | error | incorrecto
      const limite = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limite') || '100', 10)));
      const lista = await env.ASIS_LOG.list({ prefix: 'q:', limit: 1000 });
      // Conteo por estado sobre TODO el registro (no solo la página devuelta).
      const conteo = { ok: 0, error: 0, incorrecto: 0, novedoso: 0 };
      for (const k of lista.keys) {
        const e = (k.metadata && k.metadata.estado) || 'ok';
        if (conteo[e] != null) conteo[e]++;
        if (k.metadata && k.metadata.novedoso) conteo.novedoso++;
      }
      let keys = lista.keys.sort((a, b) => b.name.localeCompare(a.name));   // más recientes primero
      if (soloNov) keys = keys.filter((k) => k.metadata && k.metadata.novedoso);
      if (estadoF) keys = keys.filter((k) => ((k.metadata && k.metadata.estado) || 'ok') === estadoF);
      keys = keys.slice(0, limite);
      const items = await Promise.all(keys.map(async (k) => { try { return JSON.parse(await env.ASIS_LOG.get(k.name)); } catch { return null; } }));
      const reg = items.filter(Boolean);
      // Candidatos a corpus: SOLO novedosos que generaron bien (no errores ni incorrectos).
      const corpus_sugerido = reg.filter((r) => r.novedoso && r.estado === 'ok').map((r) => ({ desc: r.mensaje, ficha: r.ficha }));
      // Casos a revisar/arreglar: errores y los marcados incorrectos por el usuario.
      const revisar = reg.filter((r) => r.estado === 'error' || r.estado === 'incorrecto')
        .map((r) => ({ id: r.id, estado: r.estado, mensaje: r.mensaje, error: r.error || null, comentario: r.comentario || null, tipologia: r.tipologia, ficha: r.ficha }));
      return json({ total: reg.length, conteo, registros: reg, corpus_sugerido, revisar });
    }

    if (url.pathname === '/api/asistente') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido en la solicitud' }, 400); }
      const desdeMensaje = !body.ficha && !!body.mensaje;   // solo registramos lo que vino del LLM
      let ficha = body.ficha ?? null, llm = null, rag = null;
      try {
        if (desdeMensaje) {
          // RAG: recuperar ejemplos parecidos del corpus e inyectarlos como few-shot
          const corpus = await cargarCorpus(env, request.url);
          const rec = recuperarEjemplos(body.mensaje, corpus, 3);
          rag = { usados: rec.ejemplos.map((e) => e.desc.slice(0, 60)), score: +rec.score.toFixed(3), novedoso: rec.score < 0.5 };
          const res = await fichaDesdeLLM(body.mensaje, env, rec.ejemplos);
          ficha = res.ficha; llm = res.llm;
        }
        if (!ficha) return json({ error: 'Envíe { mensaje } o { ficha }' }, 400);
        const libs = await cargarBibliotecas(env, request.url);
        const modelo = generarModelo(ficha, libs);
        // Registro OK (candidato a corpus). Devuelve la clave para feedback posterior.
        const logId = desdeMensaje ? await registrarConsulta(env, { mensaje: body.mensaje, ficha, rag, llm, estado: 'ok' }) : null;
        // _llm: proveedor/modelo usado. _rag: ejemplos recuperados + si fue 'novedoso'.
        const hdr = llm ? { 'X-Asistente-Proveedor': llm.proveedor, 'X-Asistente-Modelo': String(llm.modelo) } : {};
        return json({ ficha, resumen: modelo._generado?.resumen, modelo, _llm: llm, _rag: rag, _logId: logId }, 200, hdr);
      } catch (e) {
        const msg = String(e.message || e);
        // Registro de ERROR (LLM caído / sin JSON / fallo del generador).
        if (desdeMensaje) { try { await registrarConsulta(env, { mensaje: body.mensaje, ficha, rag, llm, estado: 'error', error: msg }); } catch { /* no bloquear */ } }
        return json({ error: msg }, 500);
      }
    }

    // ── MODIFICAR el modelo ya construido: orden NL → operaciones ──
    // POST /api/asistente/modificar  body { mensaje, modelo?, seleccion? }
    //   → { ops:[...] }  (el cliente las ejecuta con js/model/model_ops.js)
    if (url.pathname === '/api/asistente/modificar') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido en la solicitud' }, 400); }
      if (!body.mensaje) return json({ error: 'Envíe { mensaje }' }, 400);
      try {
        const { ops, llm } = await opsDesdeLLM(
          { mensaje: body.mensaje, modelo: body.modelo || null, seleccion: body.seleccion || null }, env);
        const hdr = llm ? { 'X-Asistente-Proveedor': llm.proveedor, 'X-Asistente-Modelo': String(llm.modelo) } : {};
        return json({ ops, _llm: llm }, 200, hdr);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    // ── Feedback del usuario: marcar una consulta como 'incorrecto' ──
    // POST /api/asistente/feedback  body { id, comentario? }
    if (url.pathname === '/api/asistente/feedback') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
      if (!env.ASIS_LOG) return json({ error: 'Registro KV no configurado' }, 400);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
      const id = String(body.id || '');
      if (!id.startsWith('q:')) return json({ error: 'id inválido' }, 400);
      const raw = await env.ASIS_LOG.get(id);
      if (!raw) return json({ error: 'registro no encontrado' }, 404);
      let reg; try { reg = JSON.parse(raw); } catch { return json({ error: 'registro corrupto' }, 500); }
      reg.estado = 'incorrecto';
      reg.comentario = body.comentario ? String(body.comentario).slice(0, 500) : null;
      reg.feedback_ts = Date.now();
      try {
        await env.ASIS_LOG.put(id, JSON.stringify(reg), {
          expirationTtl: 60 * 60 * 24 * 180,
          metadata: { estado: 'incorrecto', novedoso: !!reg.novedoso, tipologia: reg.tipologia, score: reg.score },
        });
      } catch (e) { return json({ error: String(e.message || e) }, 500); }
      return json({ ok: true, id, estado: reg.estado });
    }

    // ── Verificación del TOKEN PROFESIONAL ──
    // POST /api/asistente/pro { token } → { ok } si el token coincide con uno de
    // los configurados en el secreto PRO_TOKENS (lista separada por comas) o
    // PRO_TOKEN. Habilita en el cliente las funciones profesionales. El token se
    // obtiene enviando una solicitud; así la app NO se usa con fines comerciales
    // sin autorización. (La verificación de fondo es del lado servidor.)
    if (url.pathname === '/api/asistente/pro') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
      const conf = (env.PRO_TOKENS || env.PRO_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!conf.length) return json({ ok: false, error: 'El modo profesional no está habilitado en el servidor (defina el secreto PRO_TOKENS).' }, 503);
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON inválido' }, 400); }
      const token = String(body.token || '').trim();
      if (token && conf.includes(token)) return json({ ok: true, nivel: 'profesional' });
      return json({ ok: false, error: 'Token inválido. Solicite un token autorizado para habilitar las funciones profesionales.' }, 401);
    }

    // Resto: servir la PWA (assets estáticos)
    return env.ASSETS.fetch(request);
  },
};
