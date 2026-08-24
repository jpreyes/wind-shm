// ─────────────────────────────────────────────────────────────────────────────
// compass.js — rosa de los vientos (rueda de orientación) compartida 3D/2D.
//
// Diseño moderno: disco «glass» (el contenedor) + anillo de marcas finas + aguja
// bicolor (Norte = acento, Sur = atenuado). El grupo `.cmp-rose` se rota para que
// el Norte apunte a donde corresponde: en 3D gira con la cámara
// (FleetView.northScreenAngle); en 2D queda fijo (el mapa es norte-arriba). La
// letra «N» (`.cmp-nl`) se contra-rota en 3D para mantenerse siempre legible.
// Colores desde el tema vía clases CSS (ver shm.css).
// ─────────────────────────────────────────────────────────────────────────────
export function compassRoseSVG() {
  return `<svg viewBox="-50 -50 100 100" xmlns="http://www.w3.org/2000/svg">
    <g class="cmp-ring">
      <circle class="cmp-rim" r="44"/>
      <line class="cmp-tk" x1="44" y1="0" x2="38" y2="0"/>
      <line class="cmp-tk" x1="-44" y1="0" x2="-38" y2="0"/>
      <line class="cmp-tk" x1="0" y1="44" x2="0" y2="38"/>
      <line class="cmp-tkm" x1="31.1" y1="-31.1" x2="27" y2="-27"/>
      <line class="cmp-tkm" x1="31.1" y1="31.1" x2="27" y2="27"/>
      <line class="cmp-tkm" x1="-31.1" y1="31.1" x2="-27" y2="27"/>
      <line class="cmp-tkm" x1="-31.1" y1="-31.1" x2="-27" y2="-27"/>
    </g>
    <g class="cmp-rose">
      <polygon class="cmp-n" points="0,-33 6,-2 0,3 -6,-2"/>
      <polygon class="cmp-s" points="0,33 6,2 0,-3 -6,2"/>
      <circle class="cmp-hub" r="3.4"/>
      <text class="cmp-nl" x="0" y="-39">N</text>
    </g>
  </svg>`;
}
