// ─────────────────────────────────────────────────────────────────────────────
// i18n.js — internacionalización ES/EN de ReWind (R-6).
//
// Diccionario + `t(key)` + idioma persistido en localStorage. El idioma se elige
// con el conmutador del menú superior; al cambiarlo la app se recarga para que
// todos los render se rehagan en el nuevo idioma (sin un sistema reactivo).
//
// FASE 1: cubre el MARCO de la app (menú, barra de herramientas, barra de estado,
// pestañas, portada, «Acerca de»). Los cuerpos de los paneles e informes se
// traducen de forma incremental (Fase 2) reutilizando este mismo `t()`.
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'rewind-lang';
let lang = 'es';
try {
  const saved = localStorage.getItem(KEY);
  lang = saved || ((navigator.language || 'es').slice(0, 2) === 'en' ? 'en' : 'es');
} catch { lang = 'es'; }
if (lang !== 'en') lang = 'es';   // solo ES/EN soportados; ES por defecto

const DICT = {
  es: {
    // Barra de herramientas (label + tooltip)
    'tool.tree': 'Árbol', 'tool.tree.tip': 'Mostrar/ocultar el árbol de parques y zonas',
    'tool.tower': 'Torre', 'tool.tower.tip': 'Agregar aerogenerador',
    'tool.hv': 'Torre AT', 'tool.hv.tip': 'Agregar torre de alta tensión',
    'tool.pause': 'Detener', 'tool.pause.tip': 'Detener animación de aspas',
    'tool.play': 'Animar', 'tool.play.tip': 'Reanudar animación de aspas',
    'tool.del': 'Borrar', 'tool.del.tip': 'Borrar la estructura seleccionada (Supr)',
    'tool.avance': 'Avance', 'tool.avance.tip': 'Mostrar/ocultar el avance de obra (4D)',
    'tool.relieve': 'Relieve', 'tool.relieve.tip': 'Mostrar/ocultar el relieve del terreno',
    'tool.shadow': 'Shadow', 'tool.shadow.tip': 'Shadow: estudio de sombra de las torres según hora y día',
    'tool.edit': 'Editar', 'tool.edit.tip': 'Activar/desactivar el modo edición (crear · borrar · mover)',
    'tool.pan': 'Mover', 'tool.pan.tip': 'Mover la vista (PAN): arrastra con el botón izquierdo',
    'tool.map': 'Mapa', 'tool.map.tip': 'Mostrar/ocultar el mini-mapa 2D del parque',
    'tool.data': 'Datos', 'tool.data.tip': 'Mostrar/ocultar el panel de datos',
    // Menú superior
    'menu.park': 'Parque', 'menu.data': 'Datos', 'menu.report': 'Informe',
    'mi.newTower': '＋ Nueva torre', 'mi.newHV': '＋ Nueva torre AT',
    'mi.exportPark': '⤓ Exportar parque (.json)', 'mi.importPark': '⤒ Importar parque (.json)',
    'mi.source': '● Fuente: ', 'src.sim': 'Simulada', 'src.live': 'En vivo',
    'mi.exportTelem': '⤓ Exportar telemetría (.json)',
    'mi.exportInsp': '⤓ Exportar inspecciones (.json)', 'mi.importInsp': '⤒ Importar inspecciones (.json)',
    'mi.parkReport': '📄 Informe del parque', 'mi.selReport': '📄 Informe de la selección',
    'mi.about': 'ⓘ Acerca de ReWind',
    'about.desc': 'Monitoreo de salud estructural (SHM) de torres eólicas — gemelo digital físico, fatiga, inspección y avance de obra para el parque Camán I.',
    'about.credit': 'Instituto de Obras Civiles · Universidad Austral de Chile. Motor de elementos finitos heredado, reutilizado como gemelo digital.',
    // Alertas de las acciones del menú
    'alert.noPark': 'No hay parque que exportar.',
    'alert.badPark': 'Archivo de parque no válido.',
    'alert.parkImported': 'Parque importado. Se recargará la app.',
    'alert.badInsp': 'Archivo de inspecciones no válido.',
    'alert.inspImported': (n) => `Importadas inspecciones de ${n} estructura(s). Se recargará la app.`,
    'alert.selectFirst': 'Selecciona una estructura primero.',
    'alert.exportFail': 'No se pudo exportar.',
    // Panel: cabecera + pestañas
    'dash.sub': 'Salud estructural en tiempo real', 'dash.reportBtn': '📄 Parque',
    'dash.reportBtn.tip': 'Informe compilado de todo el parque',
    'tab.parque': 'Parque', 'tab.seleccion': 'Selección', 'tab.obra': 'Obra',
    'tab.insp': 'Inspección', 'tab.shm': 'SHM', 'tab.shadow': 'Shadow flicker',
    'tab.estado': 'Estado', 'tab.senal': 'Señal', 'tab.sensores': 'Sensores',
    'tab.fatiga': 'Fatiga', 'tab.avz': 'Avanzado',
    'empty.select': 'Selecciona una estructura.',
    // Barra de estado
    'sb.park': 'Parque', 'sb.struct': 'Estructuras', 'sb.avance': 'Avance parque',
    'sb.sens': 'Sensores', 'sb.alarm': 'Alarmas', 'sb.wind': 'Viento medio', 'sb.source': 'Fuente',
    'sb.nosel': 'Sin selección', 'sb.sel': 'Selección', 'sb.ok': 'OK', 'sb.fault': 'en falla',
    // Portada
    'hero.tag': 'Monitoreo de salud estructural de torres eólicas',
    'load.start': 'Iniciando…',
    // Conmutador de idioma
    'lang.tip': 'Cambiar idioma · Switch language',
    // Clasificación ML de daño
    'cls.0': 'Sin daño', 'cls.1': 'Leve', 'cls.2': 'Moderado', 'cls.3': 'Alto', 'cls.4': 'Muy alto',
    'units.years': 'a',
    // Selección (detalle)
    'det.structure': 'Estructura', 'det.type': 'Tipo',
    'det.typeHV': 'Torre de alta tensión', 'det.typeTurbine': 'Aerogenerador',
    'det.height': 'Altura', 'det.power': 'Potencia', 'det.sensors': 'Sensores',
    'det.f1twin': 'f₁ gemelo digital', 'det.f1now': 'f₁ actual', 'det.calc': '… calculando',
    'det.wind': 'Velocidad del viento', 'det.temp': 'Temperatura', 'det.orient': 'Orientación',
    'det.note': 'Estado por sensores → pestaña <b>SHM</b> · evaluación e inspección → <b>Inspección</b> · avance de obra → <b>Obra</b>.',
    'det.report': '📄 Informe de esta torre',
    // SHM · Estado
    'sh.cls': 'Clasificación (sensores)', 'sh.dmg': 'Índice de daño',
    'sh.sensOk': 'Sensores OK', 'sh.f1now': 'f₁ actual',
    'sh.note': 'Estado/clasificación EN VIVO del servicio ML que vigila los sensores. Es distinto de la <b>evaluación de inspección</b> (pestaña Inspección).',
    'sig.note': 'Señal de aceleración en vivo (se mueve en tiempo real):',
    'sens.note': 'Verde = operativo · Rojo = en falla. Estado y RMS en vivo desde el gateway (sim).',
    // SHM · Fatiga
    'fat.lifeUsed': 'Vida consumida', 'fat.rul': 'Vida remanente', 'fat.dmgYear': 'Daño / año',
    'fat.state': 'Estado de fatiga', 'fat.designLife': 'Vida de diseño estimada',
    'fat.yis': 'Años en servicio (sim.)', 'fat.detail': 'Categoría de detalle',
    'fat.spectrum': 'Espectro de carga (rainflow · ciclos/año)',
    'fat.xaxis': 'rango Δσ (MPa)', 'fat.yaxis': 'ciclos/año (log)',
    'fat.note': 'Conteo <b>rainflow</b> (ASTM E1049) + S-N <b>EN 1993-1-9</b> + daño de <b>Miner</b> → vida remanente y <b>DEL</b>. Historia de tensiones <b>sintética</b> (turbulencia de banda baja + armónicos 1P/3P del rotor) hasta conectar la galga/acelerómetro real. Distinto del índice de daño por sensores (pestaña Estado).',
    'fat.state.operativa': 'Operativo', 'fat.state.observacion': 'Observación', 'fat.state.critica': 'Crítico',
    // SHM · Avanzado
    'avz.nvmNote': 'Diagramas del gemelo digital — fuste bajo viento + peso propio:',
    'avz.axialNote': 'Esfuerzo axial del reticulado (gemelo, bajo viento):',
    'avz.axialT': 'Axial máx · tracción', 'avz.axialC': 'Axial máx · compresión',
    'avz.fftNote': 'Espectro de frecuencias (FFT) del acelerómetro superior:',
    'avz.fftPeak': 'Pico dominante',
    'avz.specNote': 'Espectrograma (frecuencia–tiempo) del acelerómetro superior:',
    'avz.freqNote': 'Seguimiento de la frecuencia natural f₁ (vs. línea base del gemelo):',
    'avz.note': 'f₁ a la baja = pérdida de rigidez (daño). Diagramas del solver FEM del gemelo digital.',
    'np.anom': '⚠ Anomalía detectada',
    'banner.anom': 'ANOMALÍA DETECTADA', 'banner.more': (n) => ` y ${n} más`,
  },
  en: {
    'tool.tree': 'Tree', 'tool.tree.tip': 'Show/hide the parks and zones tree',
    'tool.tower': 'Turbine', 'tool.tower.tip': 'Add wind turbine',
    'tool.hv': 'HV tower', 'tool.hv.tip': 'Add high-voltage tower',
    'tool.pause': 'Pause', 'tool.pause.tip': 'Pause blade animation',
    'tool.play': 'Animate', 'tool.play.tip': 'Resume blade animation',
    'tool.del': 'Delete', 'tool.del.tip': 'Delete the selected structure (Del)',
    'tool.avance': 'Progress', 'tool.avance.tip': 'Show/hide construction progress (4D)',
    'tool.relieve': 'Terrain', 'tool.relieve.tip': 'Show/hide the terrain relief',
    'tool.shadow': 'Shadow', 'tool.shadow.tip': 'Shadow: tower shadow study by time and date',
    'tool.edit': 'Edit', 'tool.edit.tip': 'Toggle edit mode (create · delete · move)',
    'tool.pan': 'Pan', 'tool.pan.tip': 'Pan the view: drag with the left button',
    'tool.map': 'Map', 'tool.map.tip': 'Show/hide the 2D mini-map of the park',
    'tool.data': 'Data', 'tool.data.tip': 'Show/hide the data panel',
    'menu.park': 'Park', 'menu.data': 'Data', 'menu.report': 'Report',
    'mi.newTower': '＋ New turbine', 'mi.newHV': '＋ New HV tower',
    'mi.exportPark': '⤓ Export park (.json)', 'mi.importPark': '⤒ Import park (.json)',
    'mi.source': '● Source: ', 'src.sim': 'Simulated', 'src.live': 'Live',
    'mi.exportTelem': '⤓ Export telemetry (.json)',
    'mi.exportInsp': '⤓ Export inspections (.json)', 'mi.importInsp': '⤒ Import inspections (.json)',
    'mi.parkReport': '📄 Park report', 'mi.selReport': '📄 Selection report',
    'mi.about': 'ⓘ About ReWind',
    'about.desc': 'Structural health monitoring (SHM) of wind turbines — physics-based digital twin, fatigue, inspection and construction progress for the Camán I wind farm.',
    'about.credit': 'Institute of Civil Works · Universidad Austral de Chile. Inherited finite-element engine, reused as the digital twin.',
    'alert.noPark': 'No park to export.',
    'alert.badPark': 'Invalid park file.',
    'alert.parkImported': 'Park imported. The app will reload.',
    'alert.badInsp': 'Invalid inspections file.',
    'alert.inspImported': (n) => `Imported inspections for ${n} structure(s). The app will reload.`,
    'alert.selectFirst': 'Select a structure first.',
    'alert.exportFail': 'Could not export.',
    'dash.sub': 'Structural health in real time', 'dash.reportBtn': '📄 Park',
    'dash.reportBtn.tip': 'Compiled report of the whole park',
    'tab.parque': 'Park', 'tab.seleccion': 'Selection', 'tab.obra': 'Construction',
    'tab.insp': 'Inspection', 'tab.shm': 'SHM', 'tab.shadow': 'Shadow flicker',
    'tab.estado': 'Status', 'tab.senal': 'Signal', 'tab.sensores': 'Sensors',
    'tab.fatiga': 'Fatigue', 'tab.avz': 'Advanced',
    'empty.select': 'Select a structure.',
    'sb.park': 'Park', 'sb.struct': 'Structures', 'sb.avance': 'Park progress',
    'sb.sens': 'Sensors', 'sb.alarm': 'Alarms', 'sb.wind': 'Mean wind', 'sb.source': 'Source',
    'sb.nosel': 'No selection', 'sb.sel': 'Selection', 'sb.ok': 'OK', 'sb.fault': 'fault',
    'hero.tag': 'Structural health monitoring of wind turbines',
    'load.start': 'Starting…',
    'lang.tip': 'Switch language · Cambiar idioma',
    'cls.0': 'No damage', 'cls.1': 'Minor', 'cls.2': 'Moderate', 'cls.3': 'High', 'cls.4': 'Very high',
    'units.years': 'yr',
    'det.structure': 'Structure', 'det.type': 'Type',
    'det.typeHV': 'High-voltage tower', 'det.typeTurbine': 'Wind turbine',
    'det.height': 'Height', 'det.power': 'Power', 'det.sensors': 'Sensors',
    'det.f1twin': 'f₁ digital twin', 'det.f1now': 'f₁ current', 'det.calc': '… computing',
    'det.wind': 'Wind speed', 'det.temp': 'Temperature', 'det.orient': 'Orientation',
    'det.note': 'Sensor status → <b>SHM</b> tab · assessment and inspection → <b>Inspection</b> · construction progress → <b>Construction</b>.',
    'det.report': '📄 Report of this tower',
    'sh.cls': 'Classification (sensors)', 'sh.dmg': 'Damage index',
    'sh.sensOk': 'Sensors OK', 'sh.f1now': 'f₁ current',
    'sh.note': 'LIVE status/classification from the ML service watching the sensors. Different from the <b>inspection assessment</b> (Inspection tab).',
    'sig.note': 'Live acceleration signal (updates in real time):',
    'sens.note': 'Green = operational · Red = fault. Live status and RMS from the gateway (sim).',
    'fat.lifeUsed': 'Life consumed', 'fat.rul': 'Remaining life', 'fat.dmgYear': 'Damage / year',
    'fat.state': 'Fatigue state', 'fat.designLife': 'Estimated design life',
    'fat.yis': 'Years in service (sim.)', 'fat.detail': 'Detail category',
    'fat.spectrum': 'Load spectrum (rainflow · cycles/year)',
    'fat.xaxis': 'range Δσ (MPa)', 'fat.yaxis': 'cycles/year (log)',
    'fat.note': '<b>Rainflow</b> counting (ASTM E1049) + S-N <b>EN 1993-1-9</b> + <b>Miner</b> damage → remaining life and <b>DEL</b>. <b>Synthetic</b> stress history (low-band turbulence + rotor 1P/3P harmonics) until the real strain/accelerometer is connected. Different from the sensor damage index (Status tab).',
    'fat.state.operativa': 'Operational', 'fat.state.observacion': 'Watch', 'fat.state.critica': 'Critical',
    'avz.nvmNote': 'Digital-twin diagrams — mast under wind + self-weight:',
    'avz.axialNote': 'Lattice axial force (twin, under wind):',
    'avz.axialT': 'Max axial · tension', 'avz.axialC': 'Max axial · compression',
    'avz.fftNote': 'Frequency spectrum (FFT) of the top accelerometer:',
    'avz.fftPeak': 'Dominant peak',
    'avz.specNote': 'Spectrogram (frequency–time) of the top accelerometer:',
    'avz.freqNote': 'Natural frequency f₁ tracking (vs. twin baseline):',
    'avz.note': 'Falling f₁ = stiffness loss (damage). Diagrams from the digital-twin FEM solver.',
    'np.anom': '⚠ Anomaly detected',
    'banner.anom': 'ANOMALY DETECTED', 'banner.more': (n) => ` and ${n} more`,
  },
};

export function getLang() { return lang; }

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'es';
  try { localStorage.setItem(KEY, lang); } catch {}
}

// Traduce `key`. Si el valor es una función (string con parámetros), la invoca
// con `...args`. Cae a ES y luego a `key` si falta la entrada.
export function t(key, ...args) {
  const v = (DICT[lang] && DICT[lang][key] != null) ? DICT[lang][key]
          : (DICT.es[key] != null ? DICT.es[key] : key);
  return typeof v === 'function' ? v(...args) : v;
}
