// Test del núcleo de fatiga (R-22) en Node: rainflow + S-N + Miner + DEL.
// Verifica contra el caso canónico de rainflow y soluciones analíticas.
// Uso: node js/shm/test_fatigue.mjs
import {
  reversals, extractCycles, countCycles, snN, snLimits,
  minerDamage, del, assessFatigue,
} from './fatigue.js';

let fail = 0;
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function ok(name, cond, extra = '') { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) fail++; }

// ── 1) Rainflow: caso canónico documentado (iamlikeme/rainflow) ──────────────
// series = [-2,1,-3,5,-1,3,-4,4,-2] → count_cycles = [(3,0.5),(4,1.5),(6,0.5),(8,1.0),(9,0.5)]
{
  const series = [-2, 1, -3, 5, -1, 3, -4, 4, -2];
  const got = countCycles(series).map(c => [c.range, c.count]);
  const exp = [[3, 0.5], [4, 1.5], [6, 0.5], [8, 1.0], [9, 0.5]];
  const same = got.length === exp.length && got.every((g, i) => approx(g[0], exp[i][0]) && approx(g[1], exp[i][1]));
  ok('rainflow caso canónico', same, JSON.stringify(got));
  const total = got.reduce((a, g) => a + g[1], 0);
  ok('rainflow total = 4.0 ciclos', approx(total, 4.0), `total=${total}`);
}

// ── 2) Amplitud constante: todos los rangos = R; DEL = R para cualquier m ─────
{
  const A = 40, R = 2 * A, K = 50;           // serie que solo visita ±A → todo rango 2A
  const series = [];
  for (let k = 0; k < K; k++) { series.push(A, -A); }
  const cyc = extractCycles(series);
  const totalCount = cyc.reduce((a, c) => a + c.count, 0);
  const allR = cyc.every(c => approx(c.range, R, 1e-9));
  ok('amplitud constante: todos los rangos = 2A', allR, `n=${cyc.length}, count=${totalCount}`);
  ok('DEL(m=3, Neq=total) = R', approx(del(cyc, 3, totalCount), R, 1e-9), `${del(cyc, 3, totalCount).toFixed(4)}`);
  ok('DEL(m=5, Neq=total) = R', approx(del(cyc, 5, totalCount), R, 1e-9), `${del(cyc, 5, totalCount).toFixed(4)}`);
}

// ── 3) Curva S-N EN 1993-1-9: continuidad en los quiebres ────────────────────
{
  const det = 80, L = snLimits(det);
  ok('snN(ΔσC) = 2·10⁶', approx(snN(det, det), 2e6, 1e-9), snN(det, det).toExponential(3));
  ok('snN(ΔσD) = 5·10⁶', approx(snN(L.dsD, det), 5e6, 1e-6), snN(L.dsD, det).toExponential(3));
  ok('snN(ΔσL) = 1·10⁸', approx(snN(L.dsL, det), 1e8, 1e-6), snN(L.dsL, det).toExponential(3));
  ok('snN bajo el corte = ∞', snN(L.dsL * 0.99, det) === Infinity);
  ok('pendiente m1=3: doblar Δσ ⇒ N/8', approx(snN(2 * det, det), snN(det, det) / 8, 1e-6));
}

// ── 4) Miner: linealidad en el conteo ────────────────────────────────────────
{
  const c1 = [{ range: 80, count: 1000 }];
  const c2 = [{ range: 80, count: 2000 }];
  ok('Miner lineal (×2 ciclos ⇒ ×2 daño)', approx(minerDamage(c2) / minerDamage(c1), 2, 1e-9));
  ok('Miner(Δσ=ΔσC, n=Nc) = 1', approx(minerDamage([{ range: 80, count: 2e6 }], 80), 1, 1e-9));
}

// ── 5) assessFatigue: monotonía y coherencia ─────────────────────────────────
{
  const base = { id: 'T01', vMean: 8, dmgIndex: 0.0, yearsInService: 5 };
  const a = assessFatigue(base);
  const b = assessFatigue({ ...base, id: 'T01', dmgIndex: 0.4 });   // más daño → más tensión
  ok('assess: daño/año finito y > 0', a.Dyear > 0 && isFinite(a.Dyear), `Dyear=${a.Dyear.toExponential(2)}`);
  ok('assess: vida de diseño = 1/Dyear', approx(a.lifeYears, 1 / a.Dyear, 1e-9), `${a.lifeYears.toFixed(1)} años`);
  ok('assess: más daño ⇒ más consumo de vida', b.Dyear > a.Dyear, `${a.Dyear.toExponential(2)} → ${b.Dyear.toExponential(2)}`);
  ok('assess: determinista (misma entrada ⇒ mismo resultado)', assessFatigue(base).Dyear === a.Dyear);
  ok('assess: espectro no vacío y DEL > 0', a.spectrum.length > 0 && a.del3 > 0, `DEL₃=${a.del3.toFixed(1)} MPa, ${a.spectrum.length} bins`);
}

console.log(fail ? `\n✗ ${fail} fallo(s)` : '\n✓ Todo OK');
process.exit(fail ? 1 : 0);
