// ─────────────────────────────────────────────────────────────────────────────
// terrain.js — relieve CONCEPTUAL del parque (wind-shm).
//
// Construye una malla 3D desde el heightmap vendorizado (data/caman_dem.json,
// generado por tools/fetch_dem.mjs) usando la MISMA proyección que las torres
// (toScene de parks_data_caman.js), para que todo calce. Estética conceptual:
// tinte hipsométrico tenue + curvas de nivel por shader + hillshade suave (sin
// textura satelital). `heightAt(x,z)` devuelve la cota de escena para apoyar las
// torres y drapear caminos sobre el relieve.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { CAMAN_CENTER, LAYOUT_SCALE, toScene } from './parks_data_caman.js?v=270';

const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos(CAMAN_CENTER.lat * Math.PI / 180);

export class Terrain {
  constructor(dem, opts = {}) {
    this.dem = dem;
    this.vex = opts.vex ?? 1.0;            // exageración vertical (1 = sin exagerar)
    this.base = dem.min * LAYOUT_SCALE * this.vex;   // referencia: la cota mínima va a y=0 (se asienta sobre el grid)
    this.mesh = this._build();
  }

  // Elevación (m) interpolada bilineal en la grilla DEM, dada lon/lat.
  _elev(lon, lat) {
    const { bbox, nx, ny, data } = this.dem;
    let fx = (lon - bbox.lon0) / (bbox.lon1 - bbox.lon0) * (nx - 1);
    let fy = (lat - bbox.lat0) / (bbox.lat1 - bbox.lat0) * (ny - 1);
    fx = Math.max(0, Math.min(nx - 1.001, fx)); fy = Math.max(0, Math.min(ny - 1.001, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), dx = fx - x0, dy = fy - y0;
    const g = (x, y) => data[y * nx + x];
    return g(x0, y0) * (1 - dx) * (1 - dy) + g(x0 + 1, y0) * dx * (1 - dy)
         + g(x0, y0 + 1) * (1 - dx) * dy + g(x0 + 1, y0 + 1) * dx * dy;
  }

  // Cota de ESCENA (Y) en una posición de escena (x,z) — para apoyar torres/caminos.
  heightAt(x, z) {
    const east = x / LAYOUT_SCALE, north = -z / LAYOUT_SCALE;
    const lon = CAMAN_CENTER.lon + east / M_PER_DEG_LON;
    const lat = CAMAN_CENTER.lat + north / M_PER_DEG_LAT;
    return this._elev(lon, lat) * LAYOUT_SCALE * this.vex - this.base;
  }

  _build() {
    const { bbox, nx, ny, data, min, max } = this.dem;
    const pos = new Float32Array(nx * ny * 3);
    const uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const u = i / (nx - 1), v = j / (ny - 1);
      const lon = bbox.lon0 + u * (bbox.lon1 - bbox.lon0);
      const lat = bbox.lat0 + v * (bbox.lat1 - bbox.lat0);
      const s = toScene(lon, lat), k = (j * nx + i) * 3, m = (j * nx + i) * 2;
      pos[k] = s.x; pos[k + 1] = data[j * nx + i] * LAYOUT_SCALE * this.vex - this.base; pos[k + 2] = s.z;
      uv[m] = u; uv[m + 1] = v;
    }
    const idx = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);            // winding → normales hacia +Y
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();

    const yMin = 0, yMax = (max - min) * LAYOUT_SCALE * this.vex;   // relieve asentado en y=0
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMin: { value: yMin }, uMax: { value: yMax },
        uInterval: { value: 50 * LAYOUT_SCALE * this.vex },   // curvas cada 50 m (menos densas)
        uLight: { value: new THREE.Vector3(0.5, 0.85, 0.3).normalize() },
        uDim: { value: 0.0 },                                 // oscurece al seleccionar una torre (no se vuelve blanco)
        uShadow: { value: 0.0 },                              // modo Shadow: aclara el relieve para que la sombra proyectada resalte
      },
      vertexShader: `
        varying float vH; varying vec3 vN; varying vec2 vUv;
        void main(){ vH = position.y; vN = normalize(normal); vUv = uv;   // normal en MUNDO (el relieve no rota) → hillshade sigue al sol
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        precision highp float;
        varying float vH; varying vec3 vN; varying vec2 vUv;
        uniform float uMin, uMax, uInterval, uDim, uShadow; uniform vec3 uLight;
        vec3 ramp(float t){                       // rampa pálida, bajo contraste
          vec3 c0 = vec3(0.80, 0.85, 0.78);
          vec3 c1 = vec3(0.86, 0.85, 0.74);
          vec3 c2 = vec3(0.89, 0.88, 0.83);
          vec3 c3 = vec3(0.94, 0.95, 0.96);
          if(t < 0.4) return mix(c0, c1, t / 0.4);
          if(t < 0.75) return mix(c1, c2, (t - 0.4) / 0.35);
          return mix(c2, c3, (t - 0.75) / 0.25);
        }
        void main(){
          float t = clamp((vH - uMin) / max(uMax - uMin, 1.0), 0.0, 1.0);
          vec3 col = ramp(t);
          float lit = clamp(dot(normalize(vN), uLight), 0.0, 1.0);                // 0 = ladera en sombra, 1 = al sol
          float hs = mix(0.62, 0.84, uShadow);                                    // modo Shadow: hillshade más suave (relieve más plano/claro)
          col *= hs + (1.0 - hs) * lit;
          col = mix(col, vec3(0.16, 0.21, 0.46), (1.0 - lit) * 0.34 * (1.0 - 0.75 * uShadow)); // menos tinte índigo en modo Shadow
          col = mix(col, clamp(col * 1.18 + 0.05, 0.0, 1.0), uShadow);            // y un realce general → la sombra proyectada (oscura) resalta
          float e = vH / uInterval;                                              // curvas de nivel finas
          float d = abs(fract(e - 0.5) - 0.5) / max(fwidth(e), 1e-4);
          float line = 1.0 - clamp(d, 0.0, 1.0);                                 // ~1 px
          col = mix(col, col * 0.72, line * 0.4);
          // Borde difuminado: el rectángulo del DEM se desvanece en sus orillas.
          float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
          float a = smoothstep(0.0, 0.09, edge);
          a *= (1.0 - uDim * 0.35);                  // al seleccionar: recede un poco (sin cambiar de color)
          gl_FragColor = vec4(col, a);
        }`,
      side: THREE.DoubleSide, transparent: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.castShadow = false;   // el relieve NO castea al mapa (su sombra = hillshade, tenue); sólo recibe la de las torres
    mesh.renderOrder = -1; mesh.name = 'terrain';

    // Malla receptora de sombras (comparte la geometría del relieve): el
    // ShaderMaterial conceptual no recibe sombras, así que superponemos un
    // ShadowMaterial que SÓLO dibuja la sombra translúcida sobre la superficie del
    // terreno (Frente 2: sombras sobre el relieve). polygonOffset evita z-fighting.
    const shMat = new THREE.ShadowMaterial({ opacity: 0.44, color: 0x1b2e6b });   // sombra de TORRES sobre el relieve (prominente; el relieve ya no castea)
    shMat.polygonOffset = true; shMat.polygonOffsetFactor = -1; shMat.polygonOffsetUnits = -1; shMat.depthWrite = false;
    const shadowMesh = new THREE.Mesh(geo, shMat);
    shadowMesh.receiveShadow = true; shadowMesh.renderOrder = 0; shadowMesh.visible = false; shadowMesh.name = 'terrain-shadow';
    this.shadowMesh = shadowMesh;
    return mesh;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.shadowMesh?.material.dispose(); }
}

// Carga el DEM vendorizado y devuelve un Terrain listo para añadir a la escena.
export async function loadTerrain(url, opts) {
  const dem = await (await fetch(url)).json();
  return new Terrain(dem, opts);
}
