// ─────────────────────────────────────────────────────────────────────────────
// workspaces/obra.js — espacio de trabajo OBRA (construcción).
//
// Segundo workspace extraído del módulo-dios (refactor B2). El renderer pesado
// (avance 4D por partida) ya vivía afuera en `avance_dashboard.js`; acá queda el
// WIRING de la vista Obra: llamar a `renderAvance` con el callback que, al mover una
// etapa, recalcula el `built` de la torre, lo aplica al 3D y avisa a shm_mode para
// refrescar el avance del parque + el mapa. `current` = torre seleccionada (o null).
// ─────────────────────────────────────────────────────────────────────────────
import { renderAvance } from '../shm/avance_dashboard.js?v=332';
import { builtFromStages } from '../shm/parks_data_caman.js?v=332';

export function renderObra(host, fleet, current, onProgress) {
  if (!host) return;
  try {
    renderAvance(host, fleet.structures, current, (st) => {
      st.built = builtFromStages(st.stages);
      fleet.setProgress(st.id, st.built);
      fleet.onLayoutChange?.();
      onProgress?.();                    // shm_mode refresca park-progress + mapa
    });
  } catch (e) { console.warn('[obra] avance', e); }
}
