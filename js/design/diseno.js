// ──────────────────────────────────────────────────────────────────────────────
// diseno.js — ORQUESTADOR de diseño de elementos (multinorma, generalizado).
//
// Antes este archivo tenía las fórmulas de acero/hormigón/madera embebidas y los
// parámetros vivían en un JSON GLOBAL por tipología (un único Fy para todo el
// acero, etc.), adivinando el tipo por el nombre. Ahora:
//
//   1. Las RESISTENCIAS son propiedades del MATERIAL (mat.design) → cualquier
//      material es diseñable (material_props.js).
//   2. La GEOMETRÍA de diseño (módulos plásticos, esbelteces…) sale de la FORMA
//      de la sección (section_props.js).
//   3. Los CÓDIGOS (AISC 360 LRFD/ASD, Eurocódigo 3, ACI 318, EC2, NCh1198) son
//      módulos CONECTABLES en un registro (registry.js) y extensibles por la API.
//
// Compatibilidad: si un material no trae design.family, se clasifica por su nombre
// y las resistencias caen al JSON legado (diseno_params.json). La firma de
// verificarElemento se mantiene utilizable como antes.
// ──────────────────────────────────────────────────────────────────────────────

import { resolveMaterial, clasificarMaterial } from './material_props.js?v=189';
import { resolveSectionProps } from './section_props.js?v=189';
import { registerDesignCode, getDesignCode, defaultCodeFor, setDefaultCode, listDesignCodes } from './registry.js?v=189';
import { aisc360_lrfd, aisc360_asd } from './codes/aisc360.js?v=189';
import { eurocode3 } from './codes/eurocode3.js?v=189';
import { aci318, eurocode2 } from './codes/concrete.js?v=189';
import { timber_nch1198 } from './codes/timber.js?v=189';
import { eurocode9 } from './codes/eurocode9.js?v=189';

// ── Registro de códigos por defecto (idempotente) ───────────────────────────────
let _registered = false;
export function registerBuiltinCodes() {
  if (_registered) return;
  [aisc360_lrfd, aisc360_asd, eurocode3, aci318, eurocode2, timber_nch1198, eurocode9].forEach(registerDesignCode);
  setDefaultCode('steel', 'AISC360-16:LRFD');
  setDefaultCode('concrete', 'ACI318-19');
  setDefaultCode('timber', 'NCh1198');
  setDefaultCode('aluminum', 'EN1999-1-1');        // Eurocódigo 9 (aluminio)
  _registered = true;
}
registerBuiltinCodes();

export { clasificarMaterial, listDesignCodes, getDesignCode, registerDesignCode };

// ── API principal ──────────────────────────────────────────────────────────────
// Entrada (todo opcional salvo fuerzas + sec):
//   fuerzas: { N (kN, + tracción / − compresión), Vy, Vz, My, Mz (kN·m, magnitudes), L (m) }
//   sec:     sección del modelo { A, Iz, Iy, J, Avy, Avz, design?:{shape,dims,rebar,...} }
//   mat:     material del modelo COMPLETO (preferido) { name, E, G, nu, design?:{family,Fy,...} }
//   matNombre: nombre del material (compat; si no se pasa mat)
//   params:  diseno_params.json (respaldo legado de resistencias y límites)
//   codeId:  id de código forzado (si no, default por familia o designSettings)
//   designSettings: { codeByFamily:{steel:'EN1993-1-1',...} } del modelo
//   member:  { Lb, K, Cb, ... } overrides de pandeo/LTB
//   options: factores extra para el código
export function verificarElemento({ fuerzas, sec, mat, matNombre, params = {}, codeId, designSettings, member, options }) {
  const matObj = mat || { name: matNombre, E: 0, G: 0, nu: 0.3 };
  const M = resolveMaterial(matObj, params);
  const P = resolveSectionProps(sec, { shapeFactor: params?.acero?.Z_sobre_S });

  // Elegir código: explícito → designSettings por familia → default por familia.
  let code = codeId ? getDesignCode(codeId) : null;
  if (!code && designSettings?.codeByFamily?.[M.family]) code = getDesignCode(designSettings.codeByFamily[M.family]);
  if (!code) code = defaultCodeFor(M.family) || defaultCodeFor('steel');

  const demands = {
    N: fuerzas.N || 0, Vy: fuerzas.Vy || 0, Vz: fuerzas.Vz || 0,
    My: fuerzas.My || 0, Mz: fuerzas.Mz || 0, T: fuerzas.T || 0,
  };
  const mem = { L: fuerzas.L || 1, Lb: (member?.Lb ?? fuerzas.L ?? 1), K: member?.K ?? 1,
    Cb: member?.Cb ?? 1.0, ho: P.ho, ...(member || {}) };

  // límites de aviso/falla desde el JSON legado o defaults
  const lim = params.limites || {};
  const opt = { ratio_aviso: lim.ratio_aviso ?? 0.90, ratio_falla: lim.ratio_falla ?? 1.0,
    cuantia_long_rho: params?.hormigon?.cuantia_long_rho, recubrimiento_mm: params?.hormigon?.recubrimiento_mm,
    phi: params?.[{ concrete: 'hormigon', steel: 'acero', timber: 'madera' }[M.family]]?.phi,
    ...(options || {}) };

  const r = code.check({ demands, mat: M, sec: P, member: mem, options: opt });
  r.codigo = code.id; r.codigoLabel = code.label; r.familia = M.family;
  return r;
}
