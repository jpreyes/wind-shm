// ──────────────────────────────────────────────────────────────────────────────
// mesher.js — Mallador 2D de BLOQUE (estilo MESHGEN de Chandrupatla & Belegundu).
//
// Dado un bloque cuadrilátero de 4 esquinas (P1,P2,P3,P4 en sentido antihorario),
// genera una malla estructurada de nx×ny celdas por INTERPOLACIÓN BILINEAL del
// bloque (mapeo del cuadrado de referencia ξ,η ∈ [0,1] a la geometría real).
// Sirve para mallar muros, paneles y losas (rectangulares o trapezoidales) en
// QUAD (4 nodos) o CST (2 triángulos por celda).
//
// AUTÓNOMO (sin dependencias) → verificable en Node.
// Índice de grilla: idx(i,j) = i*(ny+1) + j,  i∈[0,nx], j∈[0,ny].
// ──────────────────────────────────────────────────────────────────────────────

// Grilla de (nx+1)×(ny+1) puntos por interpolación bilineal de las 4 esquinas.
// corners = [P1,P2,P3,P4] (cada Pk = [x,y,z]), CCW. Esquinas:
//   idx(0,0)=P1, idx(nx,0)=P2, idx(nx,ny)=P3, idx(0,ny)=P4.
export function bilinearGrid(corners, nx, ny) {
  const [P1, P2, P3, P4] = corners;
  const pts = [];
  for (let i = 0; i <= nx; i++) {
    const xi = i / nx;
    for (let j = 0; j <= ny; j++) {
      const eta = j / ny;
      const a = (1 - xi) * (1 - eta), b = xi * (1 - eta), c = xi * eta, d = (1 - xi) * eta;
      pts.push([
        a * P1[0] + b * P2[0] + c * P3[0] + d * P4[0],
        a * P1[1] + b * P2[1] + c * P3[1] + d * P4[1],
        a * P1[2] + b * P2[2] + c * P3[2] + d * P4[2],
      ]);
    }
  }
  return pts;   // pts[idx(i,j)]
}

// Conectividad de celdas (índices de grilla). tri=false → QUAD [i,j],[i+1,j],
// [i+1,j+1],[i,j+1]; tri=true → 2 triángulos CST por celda.
export function blockCells(nx, ny, tri = false) {
  const idx = (i, j) => i * (ny + 1) + j;
  const cells = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const q = [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)];
    if (tri) { cells.push([q[0], q[1], q[2]]); cells.push([q[0], q[2], q[3]]); }
    else cells.push(q);
  }
  return cells;
}

// Índices de grilla de las 4 esquinas (para reutilizar los nodos ya existentes).
export function cornerGridIndices(nx, ny) {
  const idx = (i, j) => i * (ny + 1) + j;
  return [idx(0, 0), idx(nx, 0), idx(nx, ny), idx(0, ny)];   // P1,P2,P3,P4
}
