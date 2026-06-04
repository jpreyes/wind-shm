// ──────────────────────────────────────────────────────────────────────────────
// Timoshenko 3D Beam Element
// 12 DOF per element (2 nodes × 6 DOF)
// DOF order (local): [u1,v1,w1,rx1,ry1,rz1,  u2,v2,w2,rx2,ry2,rz2]
//   u=axial, v=transv-y, w=transv-z, rx=torsion, ry=bend-y, rz=bend-z
//
// Coordinate convention (model Z-up, SAP2000):
//   Global: X east, Y north, Z up
//   Local:  x along element, y/z defined by reference vector
// ──────────────────────────────────────────────────────────────────────────────

// ── Vector helpers ─────────────────────────────────────────────────────────
const dot  = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = ([ax,ay,az],[bx,by,bz]) =>
  [ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx];
const norm = v => Math.sqrt(dot(v,v));
const unit = v => { const n=norm(v); return v.map(x=>x/n); };

// ── Local coordinate system ───────────────────────────────────────────────
/**
 * Returns {ex, ey, ez, L} for an element from n1→n2.
 * - ex: unit vector along element axis
 * - ey: "up" reference (global Z projected perpendicular to ex) or global X for vertical elements
 * - ez: ex × ey (right-hand)
 */
export function localAxes(n1, n2) {
  const d = [n2.x-n1.x, n2.y-n1.y, n2.z-n1.z];
  const L = norm(d);
  if (L < 1e-12) throw new Error(`Elemento de longitud cero entre nodos ${n1.id} y ${n2.id}`);
  const ex = unit(d);

  // Reference vector: global Z=[0,0,1] unless element is nearly vertical
  const VERT = 0.9994;
  const isVert = Math.abs(ex[2]) > VERT;
  const ref = isVert ? [1,0,0] : [0,0,1];  // global X or global Z

  const ez = unit(cross(ex, ref));  // local z perpendicular to ex and ref
  const ey = cross(ez, ex);          // local y (right-hand: ey = ez×ex)

  return { ex, ey, ez, L };
}

// ── 12×12 local stiffness matrix (Timoshenko) ─────────────────────────────
/**
 * @param {number} L   element length
 * @param {object} mat {E, G}
 * @param {object} sec {A, Iz, Iy, J, Avy, Avz}
 * @returns {number[][]} 12×12 symmetric stiffness matrix in local coords
 */
export function stiffnessMatrix(L, mat, sec) {
  const { E, G } = mat;
  const { A, Iz, Iy, J, Avy, Avz } = sec;

  const Ke = Array.from({length:12}, () => Array(12).fill(0));

  // ── Axial ─────────────────────────────────────────────────────────────
  const a = E * A / L;
  Ke[0][0]=a; Ke[0][6]=-a; Ke[6][0]=-a; Ke[6][6]=a;

  // ── Torsion ───────────────────────────────────────────────────────────
  const t = G * J / L;
  Ke[3][3]=t; Ke[3][9]=-t; Ke[9][3]=-t; Ke[9][9]=t;

  // ── Bending in local XY plane (about local z, uses Iz, Avy) ──────────
  // Timoshenko factor: Φy = 12·E·Iz / (G·Avy·L²)
  const Phy = (Avy > 1e-30) ? 12*E*Iz / (G*Avy*L*L) : 0;
  const fy  = 1 / (1 + Phy);
  const by  = 12*E*Iz*fy / (L*L*L);
  const cy  = 6*E*Iz*fy / (L*L);
  const dy  = (4 + Phy)*E*Iz*fy / L;
  const ey  = (2 - Phy)*E*Iz*fy / L;

  // DOF indices in 12-DOF vector for XY bending: v1=1, θz1=5, v2=7, θz2=11
  const xy = [1, 5, 7, 11];
  const KXY = [
    [ by,  cy, -by,  cy],
    [ cy,  dy, -cy,  ey],
    [-by, -cy,  by, -cy],
    [ cy,  ey, -cy,  dy]
  ];
  for (let i=0; i<4; i++) for (let j=0; j<4; j++) Ke[xy[i]][xy[j]] = KXY[i][j];

  // ── Bending in local XZ plane (about local y, uses Iy, Avz) ──────────
  // Timoshenko factor: Φz = 12·E·Iy / (G·Avz·L²)
  const Phz = (Avz > 1e-30) ? 12*E*Iy / (G*Avz*L*L) : 0;
  const fz  = 1 / (1 + Phz);
  const bz  = 12*E*Iy*fz / (L*L*L);
  const cz  = 6*E*Iy*fz / (L*L);
  const dz  = (4 + Phz)*E*Iy*fz / L;
  const ez  = (2 - Phz)*E*Iy*fz / L;

  // DOF indices: w1=2, θy1=4, w2=8, θy2=10
  // Sign convention: dw/dx = -θy (right-hand rule with Z-up model)
  const xz = [2, 4, 8, 10];
  const KXZ = [
    [ bz, -cz, -bz, -cz],
    [-cz,  dz,  cz,  ez],
    [-bz,  cz,  bz,  cz],
    [-cz,  ez,  cz,  dz]
  ];
  for (let i=0; i<4; i++) for (let j=0; j<4; j++) Ke[xz[i]][xz[j]] = KXZ[i][j];

  return Ke;
}

// ── 12×12 consistent mass matrix ──────────────────────────────────────────
/**
 * Consistent mass matrix (Archer/Przemieniecki) — used in modal analysis (Fase 5)
 */
export function massMatrix(L, mat, sec) {
  const rho = mat.rho;
  const A   = sec.A;
  const m   = rho * A * L;  // total element mass
  const Ix  = mat.G !== 0 ? sec.J * mat.rho : 0;  // approx mass moment about x

  const Me = Array.from({length:12}, () => Array(12).fill(0));

  // Translational mass (consistent, without rotational inertia)
  const c = m / 420;

  // Axial: [u1, u2]
  Me[0][0] = c*140; Me[0][6] = c*70;
  Me[6][0] = c*70;  Me[6][6] = c*140;

  // Bending in XY: [v1, θz1, v2, θz2]
  const Mb = [
    [156,  22*L,  54,   -13*L],
    [22*L,  4*L*L, 13*L, -3*L*L],
    [54,   13*L,  156,  -22*L],
    [-13*L,-3*L*L,-22*L,  4*L*L]
  ];
  const xy = [1, 5, 7, 11];
  for (let i=0; i<4; i++) for (let j=0; j<4; j++) Me[xy[i]][xy[j]] = c * Mb[i][j];

  // Bending in XZ: [w1, θy1, w2, θy2] — same pattern but check signs
  const xz = [2, 4, 8, 10];
  const MbXZ = [
    [156, -22*L,  54,   13*L],
    [-22*L, 4*L*L,-13*L,-3*L*L],
    [54,  -13*L, 156,   22*L],
    [13*L,-3*L*L, 22*L,  4*L*L]
  ];
  for (let i=0; i<4; i++) for (let j=0; j<4; j++) Me[xz[i]][xz[j]] = c * MbXZ[i][j];

  // Torsional mass: [rx1, rx2]
  const mt = rho * Ix * L / 6;
  Me[3][3] = mt*2; Me[3][9] = mt; Me[9][3] = mt; Me[9][9] = mt*2;

  return Me;
}

// ── 12×12 transformation matrix ───────────────────────────────────────────
/**
 * T12 maps global DOF to local DOF: u_local = T12 · u_global
 * T12 = block_diag(R, R, R, R) where R = [ex; ey; ez] (3×3)
 */
export function transformMatrix(ex, ey, ez) {
  const T = Array.from({length:12}, () => Array(12).fill(0));
  const R = [ex, ey, ez];  // each row is a local axis in global coords
  for (let b=0; b<4; b++) {
    for (let i=0; i<3; i++) for (let j=0; j<3; j++) {
      T[3*b+i][3*b+j] = R[i][j];
    }
  }
  return T;
}

// ── Global element stiffness: Ke_global = T^T · Ke_local · T ──────────────
export function globalStiffness(Ke_local, T) {
  const n = 12;
  // KT = Ke_local · T
  const KT = Array.from({length:n}, (_,i) =>
    Array.from({length:n}, (_,j) =>
      Ke_local[i].reduce((s,v,k) => s + v * T[k][j], 0)
    )
  );
  // T^T · KT
  return Array.from({length:n}, (_,i) =>
    Array.from({length:n}, (_,j) =>
      T.reduce((s,row,k) => s + row[i] * KT[k][j], 0)
    )
  );
}

// ── Static condensation for end releases ──────────────────────────────────
/**
 * Apply static condensation to element Ke for released DOFs.
 * releases: boolean[12] — true means that DOF is a hinge (released)
 * Returns condensed 12×12 matrix with zero rows/cols for released DOFs.
 */
export function applyReleases(Ke, releases) {
  const n = 12;
  const free  = []; // non-released DOF indices
  const rel   = []; // released DOF indices
  for (let i=0; i<n; i++) {
    if (releases[i]) rel.push(i);
    else free.push(i);
  }
  if (rel.length === 0) return Ke;  // no releases

  // Partition: Kff, Kfr, Krf, Krr
  const Kff = free.map(i => free.map(j => Ke[i][j]));
  const Kfr = free.map(i => rel.map(j => Ke[i][j]));
  const Krr = rel.map(i => rel.map(j => Ke[i][j]));

  // Invert Krr (small matrix: max 6×6 in practice)
  const KrrInv = invertSmall(Krr);
  if (!KrrInv) return Ke;  // fallback if singular

  // Condensed: Kff* = Kff - Kfr · Krr^-1 · Krf
  const nr = rel.length;
  const nf = free.length;
  const KfrKrrInv = Array.from({length:nf}, (_,i) =>
    Array.from({length:nr}, (_,j) =>
      Kfr[i].reduce((s,v,k) => s + v * KrrInv[k][j], 0)
    )
  );
  const KCond = Kff.map((row, i) =>
    row.map((v, j) =>
      v - KfrKrrInv[i].reduce((s,c,k) => s + c * Kfr[j][k], 0)
    )
  );

  // Reassemble into 12×12 (zeros for released rows/cols)
  const result = Array.from({length:n}, () => Array(n).fill(0));
  for (let i=0; i<nf; i++) for (let j=0; j<nf; j++) {
    result[free[i]][free[j]] = KCond[i][j];
  }
  return result;
}

// Simple Gauss-Jordan inversion for small matrices
function invertSmall(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({length:n}, (_,j) => i===j ? 1 : 0)]);
  for (let col=0; col<n; col++) {
    let piv = col;
    for (let r=col+1; r<n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-30) return null;
    const f = A[col][col];
    A[col] = A[col].map(v => v/f);
    for (let r=0; r<n; r++) {
      if (r === col) continue;
      const k = A[r][col];
      A[r] = A[r].map((v,c) => v - k*A[col][c]);
    }
  }
  return A.map(row => row.slice(n));
}

// ── Fixed-end forces for distributed loads ────────────────────────────────
/**
 * Returns 12-element array of fixed-end forces in LOCAL coordinates.
 * load: {dir: 'y'|'z'|'x', w: number}  (uniform load per unit length in local dir)
 */
export function fixedEndForces(L, load) {
  const f = Array(12).fill(0);
  const { dir, w } = load;
  const wL = w * L;

  if (dir === 'x') {
    // Axial distributed load: f[0] = f[6] = w·L/2
    f[0]  = -wL/2;
    f[6]  = -wL/2;
  } else if (dir === 'y') {
    // Transverse y — XY bending
    f[1]  = -wL/2;          // Vy1
    f[5]  = -wL*L/12;       // Mz1
    f[7]  = -wL/2;          // Vy2
    f[11] =  wL*L/12;       // Mz2
  } else if (dir === 'z') {
    // Transverse z — XZ bending
    f[2]  = -wL/2;          // Vz1
    f[4]  =  wL*L/12;       // My1
    f[8]  = -wL/2;          // Vz2
    f[10] = -wL*L/12;       // My2
  }
  return f;
}
