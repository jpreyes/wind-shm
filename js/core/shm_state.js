// ─────────────────────────────────────────────────────────────────────────────
// core/shm_state.js — estado del subsistema SHM (señal en vivo, espectrograma,
// clasificación ML, pestaña activa), en un objeto MUTABLE compartido.
//
// Paso 1 del refactor B2 de Operación: se saca este bloque de estado del closure
// de shm_mode para que, cuando `renderSHM` se mude a workspaces/operacion.js, ambos
// (el shell que aún alimenta `onTick` y el workspace que dibuja) lean/escriban el
// MISMO estado importando este módulo. Es un objeto (no `export let`) porque las
// reasignaciones se hacen como `Shm.sigBuf = {}` (mutar propiedad, no el binding).
//
// Contenido: pane (sub-pestaña SHM), sigBuf (buffers de señal por sensor), sigRAF
// (handle del rAF de dibujo), freqHist (histórico de f₁), wavePlay/liveStop (handles
// de reproducción/streaming), specOff/specLast (espectrograma), clsHist/clsEvents +
// lastHistT (histórico de clasificación ML), editSensorId (sensor en edición), y las
// constantes del espectrograma.
// ─────────────────────────────────────────────────────────────────────────────
export const Shm = {
  pane: 'datos',
  sigBuf: {}, sigRAF: null, freqHist: {},
  wavePlay: null, liveStop: null,
  specOff: null, specLast: 0,
  clsHist: {}, clsEvents: {}, lastHistT: 0,
  editSensorId: null,
  SPEC_W: 170, SPEC_BINS: 48, SPEC_FMAX: 6,
};
