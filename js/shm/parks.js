// ─────────────────────────────────────────────────────────────────────────────
// parks.js — multiparque para ReWind: árbol lateral «Parque ▸ Zona ▸ Torre».
//
// Modelo de datos (persistido en localStorage):
//   store = { activeId, parks: [ { id, name, zones:[{id,name}],
//                                  turbines:[{x,z,yaw,zone}], hv:[{x,z,yaw,zone}] } ] }
// Cada estructura de la flota lleva `st.zone` (id de zona) para mapear el layout.
// El ParkManager mantiene el store, sincroniza con el FleetView y pinta el árbol.
// ─────────────────────────────────────────────────────────────────────────────

import { buildCamanPark } from './parks_data_caman.js?v=279';

const KEY = 'rewind-parks';
const SEED = 'caman-i-v6';      // sello de siembra; al cambiarlo se re-siembra el store (v6: etapas con % de avance)
let _seq = 0;
const uid = (p) => p + Date.now().toString(36) + (++_seq).toString(36);

// Carga el store. Si no hay store o su sello no coincide con SEED, lo (re)siembra
// con el parque real Camán I (datos georreferenciados del KMZ del cliente).
export function loadParksStore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (s && s.seed === SEED && Array.isArray(s.parks) && s.parks.length) return s;
  const park = buildCamanPark(uid);
  return { activeId: park.id, parks: [park], seed: SEED };
}

export class ParkManager {
  /** @param {object} o { el, fleet, store, onSync } */
  constructor({ el, fleet, store, onSync }) {
    this.el = el;
    this.fleet = fleet;
    this.store = store;
    this.onSync = onSync || (() => {});
    this.activeZoneId = this.active?.zones[0]?.id || null;   // zona enfocada / destino de torres nuevas
    this.collapsed = new Set();                              // ids de parque colapsados en el árbol
  }

  get active() { return this.store.parks.find(p => p.id === this.store.activeId) || this.store.parks[0]; }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.store)); } catch {} }

  // Vuelca posiciones/yaw/zona de la flota viva en el parque activo del store.
  syncFleetToActive() {
    const a = this.active; if (!a) return;
    const f = this.fleet;
    const row = (t) => ({ id: t.id, label: t.label, x: +t.group.position.x.toFixed(1), z: +t.group.position.z.toFixed(1), yaw: +f.getYaw(t.id).toFixed(4), zone: t.zone || null, lat: t.lat ?? null, lon: t.lon ?? null, built: t.built ?? null, stages: t.stages ?? null });
    a.turbines = f.turbines.map(row);
    a.hv = (f.substation?.towers || []).map(row);
  }

  // Estructuras vivas de una zona (o sin zona si zoneId == null).
  _structsInZone(zoneId) { return this.fleet.structures.filter(s => (s.zone || null) === (zoneId || null)); }

  // ── Acciones ────────────────────────────────────────────────────────────────
  switchPark(id) {
    if (id === this.store.activeId) return;
    this.syncFleetToActive();                 // guarda el parque que se deja
    this.store.activeId = id;
    this.activeZoneId = this.active?.zones[0]?.id || null;
    this.fleet.loadPark(this.active);         // reconstruye la escena
    this.save(); this.onSync(); this.render();
  }

  addPark() {
    this.syncFleetToActive();
    const name = (prompt('Nombre del parque nuevo:', `Parque ${this.store.parks.length + 1}`) || '').trim();
    if (!name) return;
    const zId = uid('z');
    const park = { id: uid('p'), name, zones: [{ id: zId, name: 'Zona A' }], turbines: defaultTurbines(zId), hv: defaultHV(zId) };
    this.store.parks.push(park);
    this.switchPark(park.id);
  }

  renamePark(id) {
    const p = this.store.parks.find(x => x.id === id); if (!p) return;
    this._inlineEdit(this.el.querySelector(`.pt-park[data-pk="${id}"] .pt-name`), p.name, (v) => { p.name = v; this.save(); this.render(); });
  }

  deletePark(id) {
    if (this.store.parks.length <= 1) { alert('Debe quedar al menos un parque.'); return; }
    const p = this.store.parks.find(x => x.id === id); if (!p) return;
    if (!confirm(`¿Eliminar el parque «${p.name}» y todas sus torres?`)) return;
    this.store.parks = this.store.parks.filter(x => x.id !== id);
    if (this.store.activeId === id) {
      this.store.activeId = this.store.parks[0].id;
      this.activeZoneId = this.active?.zones[0]?.id || null;
      this.fleet.loadPark(this.active);
      this.onSync();
    }
    this.save(); this.render();
  }

  addZone() {
    const a = this.active; if (!a) return;
    const name = (prompt('Nombre de la zona nueva:', `Zona ${String.fromCharCode(65 + a.zones.length)}`) || '').trim();
    if (!name) return;
    a.zones.push({ id: uid('z'), name });
    this.save(); this.render();
  }

  renameZone(zoneId) {
    const z = this.active?.zones.find(x => x.id === zoneId); if (!z) return;
    this._inlineEdit(this.el.querySelector(`.pt-zone .pt-name[data-id="${zoneId}"]`), z.name, (v) => { z.name = v; this.save(); this.render(); });
  }

  deleteZone(zoneId) {
    const a = this.active; if (!a) return;
    const z = a.zones.find(x => x.id === zoneId); if (!z) return;
    if (!confirm(`¿Eliminar la zona «${z.name}»? Sus torres quedarán sin zona.`)) return;
    a.zones = a.zones.filter(x => x.id !== zoneId);
    for (const st of this._structsInZone(zoneId)) st.zone = null;     // huérfanas → sin zona
    if (this.activeZoneId === zoneId) { this.activeZoneId = null; this.fleet.focusZone(null); }
    this.syncFleetToActive(); this.save(); this.render();
  }

  focusZone(zoneId) {
    this.activeZoneId = (this.activeZoneId === zoneId) ? null : zoneId;   // toggle
    const ids = this.activeZoneId ? new Set(this._structsInZone(this.activeZoneId).map(s => s.id)) : null;
    this.fleet.focusZone(ids);
    this.render();
  }

  assignZone(structId, zoneId) {
    const st = this.fleet.getStructure(structId); if (!st) return;
    st.zone = zoneId || null;
    this.syncFleetToActive(); this.save(); this.render();
  }

  // Renombra una torre EN LÍNEA (el id se mantiene estable).
  renameStructure(structId) {
    const st = this.fleet.getStructure(structId); if (!st) return;
    this._inlineEdit(this.el.querySelector(`.pt-tower[data-id="${structId}"] .pt-name`), st.label, (v) => {
      this.fleet.setLabel(structId, v);            // etiqueta 3D flotante
      this.syncFleetToActive(); this.save(); this.render(); this.onSync();
    });
  }

  // Borra una torre desde el árbol (fleet limpia escena, cables, selección y persiste).
  removeStructure(structId) {
    this.fleet.removeStructure(structId);
    this.render();
  }

  // Edición de nombre EN LÍNEA (sin el prompt del sistema): reemplaza el rótulo por
  // un input; Enter/blur confirma, Esc cancela.
  _inlineEdit(nameEl, value, commit) {
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'pt-edit'; input.value = value;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (save && v && v !== value) commit(v); else this.render();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // Llamar tras agregar una torre desde la barra: la mete en la zona enfocada.
  onAddStructure(st) {
    if (st) st.zone = this.activeZoneId || this.active?.zones[0]?.id || null;
    this.syncFleetToActive(); this.save(); this.render();
  }

  // ── Render del árbol ──────────────────────────────────────────────────────────
  render() {
    if (!this.el) return;
    const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const a = this.active;
    let h = `<div class="pt-head"><span>Parques</span><button class="pt-icon" data-act="add-park" title="Agregar parque">＋</button></div>`;

    for (const p of this.store.parks) {
      const on = p.id === this.store.activeId;
      const open = on && !this.collapsed.has(p.id);
      h += `<div class="pt-park ${on ? 'active' : ''}" data-pk="${p.id}">
        <span class="pt-tw" data-act="toggle-park" data-id="${p.id}">${open ? '▾' : '▸'}</span>
        <span class="pt-name" data-act="switch-park" data-id="${p.id}" title="Activar parque">${esc(p.name)}</span>
        <span class="pt-acts"><button class="pt-icon" data-act="rename-park" data-id="${p.id}" title="Renombrar">✎</button><button class="pt-icon" data-act="del-park" data-id="${p.id}" title="Eliminar">🗑</button></span>
      </div>`;
      if (!open) continue;

      const zoneOpts = (sel) => a.zones.map(z => `<option value="${z.id}" ${z.id === sel ? 'selected' : ''}>${esc(z.name)}</option>`).join('') + `<option value="" ${!sel ? 'selected' : ''}>— sin zona —</option>`;
      const groups = [...a.zones.map(z => ({ z, structs: this._structsInZone(z.id) })), { z: null, structs: this._structsInZone(null) }];
      for (const { z, structs } of groups) {
        if (!z && !structs.length) continue;     // no muestres «sin zona» si está vacía
        const zoneOn = z && this.activeZoneId === z.id;
        h += `<div class="pt-zone ${zoneOn ? 'on' : ''}">
          <span class="pt-name" ${z ? `data-act="focus-zone" data-id="${z.id}"` : ''} title="${z ? 'Enfocar zona' : ''}">${z ? esc(z.name) : 'Sin zona'} <span class="pt-n">${structs.length}</span></span>
          ${z ? `<span class="pt-acts"><button class="pt-icon" data-act="rename-zone" data-id="${z.id}" title="Renombrar">✎</button><button class="pt-icon" data-act="del-zone" data-id="${z.id}" title="Eliminar">🗑</button></span>` : ''}
        </div>`;
        for (const st of structs) {
          h += `<div class="pt-tower" data-id="${st.id}">
            <span class="pt-dot ${st.type}"></span>
            <span class="pt-name" data-act="select" data-id="${st.id}" title="Seleccionar">${esc(st.label)}</span>
            <span class="pt-acts"><button class="pt-icon" data-act="rename-tower" data-id="${st.id}" title="Renombrar">✎</button><button class="pt-icon" data-act="del-tower" data-id="${st.id}" title="Eliminar">🗑</button></span>
            <select class="pt-zsel" data-id="${st.id}" title="Mover a zona">${zoneOpts(st.zone || '')}</select>
          </div>`;
        }
      }
      h += `<div class="pt-zone-add"><button class="pt-icon" data-act="add-zone" title="Agregar zona">＋ zona</button></div>`;
    }
    this.el.innerHTML = h;
  }

  // Cablea el contenedor una sola vez (delegación de eventos).
  bind() {
    this.el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const id = t.dataset.id, act = t.dataset.act;
      switch (act) {
        case 'add-park': this.addPark(); break;
        case 'toggle-park': this.collapsed.has(id) ? this.collapsed.delete(id) : this.collapsed.add(id); this.render(); break;
        case 'switch-park': this.switchPark(id); break;
        case 'rename-park': this.renamePark(id); break;
        case 'del-park': this.deletePark(id); break;
        case 'add-zone': this.addZone(); break;
        case 'rename-zone': this.renameZone(id); break;
        case 'rename-tower': this.renameStructure(id); break;
        case 'del-tower': this.removeStructure(id); break;
        case 'del-zone': this.deleteZone(id); break;
        case 'focus-zone': this.focusZone(id); break;
        case 'select': this.fleet.selectById(id); break;
      }
    });
    this.el.addEventListener('change', (e) => {
      const sel = e.target.closest('.pt-zsel'); if (!sel) return;
      this.assignZone(sel.dataset.id, sel.value);
    });
  }
}

// Layout por defecto de un parque nuevo (6 torres + 2 AT) — grilla simple.
function defaultTurbines(zone) {
  const S = 235, out = [];
  for (let i = 0; i < 6; i++) out.push({ x: (i % 3) * S - S, z: Math.floor(i / 3) * S - S / 2, yaw: Math.random() * 6.28, zone });
  return out;
}
function defaultHV(zone) {
  const z = 2 * 235;
  return [{ x: -55, z, yaw: 0, zone }, { x: 55, z, yaw: 0, zone }];
}
