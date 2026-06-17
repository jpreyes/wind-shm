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
Para CERCHAS/CELOSIAS DE TECHO sueltas (a dos aguas, tipo Warren) usa tipologia:"cercha" y rellena cercha{luz_m, pendiente_pct (ej 10 = 10%) o altura_cumbrera_m, n_paneles, separacion_m, escuadria_cordon (ej "2x6"), escuadria_diagonal (ej "2x4")}. modo:"2D". material:"Pino Radiata". "cercha a dos aguas pendiente 10% cada 60cm" -> pendiente_pct:10, separacion_m:0.6.
EJEMPLO madera (entrada: "casa de 2 niveles de 3m, planta 8x6, tabiques 2x4 cada 40cm, vigas de piso 2x8 cada 60cm, uso habitacional, pino radiata, con un tabique al centro con puerta de 80cm"):
{"modo":"3D","tipologia":"muros_madera","secciones":{"material":"Pino Radiata"},"geometria":{"planta_inferior":{"Lx_m":8,"Ly_m":6},"niveles":[{"altura_m":3},{"altura_m":3}]},"tabiques":{"escuadria":"2x4","separacion_m":0.4,"perimetro":true,"interiores":[{"nivel":1,"dir":"Y","pos_m":4.0,"aberturas":[{"tipo":"puerta","ancho_m":0.8,"alto_m":2.0,"centro_m":3.0}]}]},"entrepisos":{"escuadria":"2x8","separacion_m":0.6,"dir":"X"},"cargas":{"uso_NCh1537":"Habitacionales/Viviendas"}}
EJEMPLO cercha (entrada: "cercha de techo de madera a dos aguas, luz 10m, pendiente 10%, cerchas cada 60cm, tipo warren"):
{"modo":"2D","tipologia":"cercha","secciones":{"material":"Pino Radiata"},"cercha":{"luz_m":10,"pendiente_pct":10,"n_paneles":8,"separacion_m":0.6,"escuadria_cordon":"2x6","escuadria_diagonal":"2x4"}}`;

function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',').map((s) => s.trim());
    return Object.fromEntries(head.map((h, i) => [h, c[i]]));
  });
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

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

// Proveedor del LLM. Prioridad: OpenAI directo (si hay OPENAI_API_KEY) →
// OpenRouter. Ambos usan el formato chat/completions de OpenAI, así que el
// parseo de la respuesta es idéntico.
function proveedorLLM(env) {
  if (env.OPENAI_API_KEY) return {
    nombre: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    key: env.OPENAI_API_KEY,
    modelos: [env.OPENAI_MODEL || 'gpt-4o-mini'],
    extraHeaders: {},
  };
  if (env.OPENROUTER_API_KEY) return {
    nombre: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    key: env.OPENROUTER_API_KEY,
    modelos: env.OPENROUTER_MODEL ? [env.OPENROUTER_MODEL] : MODELS_FREE,
    extraHeaders: { 'X-Title': 'PORTICO Asistente' },
  };
  return null;
}

async function llamarModelo(prov, modelo, mensaje) {
  return fetch(prov.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${prov.key}`, 'Content-Type': 'application/json', ...prov.extraHeaders },
    body: JSON.stringify({
      model: modelo,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: mensaje }],
    }),
  });
}

async function fichaDesdeLLM(mensaje, env) {
  const prov = proveedorLLM(env);
  if (!prov) throw new Error('Falta el secreto OPENAI_API_KEY u OPENROUTER_API_KEY en el Worker.');
  let ultimoError = 'sin respuesta';
  for (const modelo of prov.modelos) {
    const r = await llamarModelo(prov, modelo, mensaje);
    if (r.ok) {
      const data = await r.json();
      // Algunos proveedores devuelven 200 con un error embebido.
      if (data.error) { ultimoError = `${modelo}: ${data.error.message || JSON.stringify(data.error)}`; continue; }
      let raw = String(data.choices?.[0]?.message?.content ?? '').trim()
        .replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
      if (i < 0 || j < 0) { ultimoError = `${modelo}: no devolvió JSON`; continue; }
      return JSON.parse(raw.slice(i, j + 1));
    }
    ultimoError = `${modelo}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
    // 401/403 son de credencial/política: no sirve probar otros modelos.
    if (r.status === 401 || r.status === 403) break;
    // 429 (rate limit) o 5xx: probar el siguiente modelo de la cascada.
  }
  throw new Error(`${prov.nombre}: sin modelo disponible. Último: ${ultimoError}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/asistente') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
      try {
        const body = await request.json();
        const ficha = body.ficha ?? (body.mensaje ? await fichaDesdeLLM(body.mensaje, env) : null);
        if (!ficha) return json({ error: 'Envíe { mensaje } o { ficha }' }, 400);
        const libs = await cargarBibliotecas(env, request.url);
        const modelo = generarModelo(ficha, libs);
        return json({ ficha, resumen: modelo._generado?.resumen, modelo });
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    // Resto: servir la PWA (assets estáticos)
    return env.ASSETS.fetch(request);
  },
};
