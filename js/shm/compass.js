// ─────────────────────────────────────────────────────────────────────────────
// compass.js — rosa de los vientos (rueda de orientación) compartida 3D/2D.
//
// Devuelve el SVG de una rosa de 8 puntas con el Norte en rojo. El grupo `.cmp-rose`
// se puede rotar para que el Norte apunte a donde corresponde: en 3D gira con la
// cámara (FleetView.northScreenAngle); en 2D queda fijo (el mapa es norte-arriba).
// Los colores salen del tema vía clases CSS (ver shm.css).
// ─────────────────────────────────────────────────────────────────────────────
export function compassRoseSVG() {
  return `<svg viewBox="-50 -50 100 100" xmlns="http://www.w3.org/2000/svg">
    <circle r="47" class="cmp-bg"/>
    <g class="cmp-rose">
      <polygon class="cmp-pt" points="19,-19 9,-3 3,-9"/>
      <polygon class="cmp-pt" points="19,19 9,3 3,9"/>
      <polygon class="cmp-pt" points="-19,19 -9,3 -3,9"/>
      <polygon class="cmp-pt" points="-19,-19 -9,-3 -3,-9"/>
      <polygon class="cmp-pt" points="0,33 6,7 -6,7"/>
      <polygon class="cmp-pt" points="33,0 7,-6 7,6"/>
      <polygon class="cmp-pt" points="-33,0 -7,-6 -7,6"/>
      <polygon class="cmp-n"  points="0,-33 6,-7 -6,-7"/>
      <circle class="cmp-hub" r="4.5"/>
      <text class="cmp-lbl cmp-nl" x="0" y="-40">N</text>
      <text class="cmp-lbl" x="40" y="0">E</text>
      <text class="cmp-lbl" x="0" y="40">S</text>
      <text class="cmp-lbl" x="-40" y="0">O</text>
    </g>
  </svg>`;
}
