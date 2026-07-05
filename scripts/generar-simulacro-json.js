/**
 * Genera data/simulacro-resultados-2026.json a partir del Excel de resultados.
 *
 * Uso:  node scripts/generar-simulacro-json.js [ruta-al-excel]
 *       (por defecto: simulacro-resultados/resultados.xlsx)
 *
 * Columnas relevantes del Excel (fila 1 = encabezado):
 *   A DNI · B Paterno · C Materno · D Nombres · G Dependencia(área) · O Puntaje
 *
 * Salida: { "<dni>": { "n": "APELLIDOS NOMBRES", "a": "Área", "p": <puntaje|null> }, ... }
 *   p = null cuando el estudiante no rindió el examen (sin puntaje).
 *
 * exceljs es dependencia de desarrollo; el servidor NO lo necesita en runtime
 * (solo consume el JSON generado, que se sirve por DNI vía la API).
 */
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const EXCEL_PATH = process.argv[2] || path.join(__dirname, '..', 'simulacro-resultados', 'resultados.xlsx');
const OUT_PATH = path.join(__dirname, '..', 'data', 'simulacro-resultados-2026.json');

// Etiquetas de presentación para cada dependencia (columna G).
const AREA_LABEL = {
  'BIOMEDICAS': 'Biomédicas',
  'INGENIERIAS': 'Ingenierías',
  'SOCIALES': 'Sociales',
};

// Extrae texto plano de una celda (soporta richText / objetos) y colapsa espacios.
function txt(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.text != null) return String(v.text);
    return String(v);
  }
  return String(v);
}
const clean = (v) => txt(v).replace(/\s+/g, ' ').trim();

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);
  const ws = wb.worksheets[0];

  const map = {};
  let total = 0, sinDni = 0, dniNoEstandar = 0, duplicados = 0, ausentes = 0;

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    let dni = txt(row.getCell(1).value).replace(/\D/g, '');
    if (!dni) { sinDni++; continue; }
    dni = dni.padStart(8, '0');
    if (!/^\d{8}$/.test(dni)) { dniNoEstandar++; continue; }
    total++;

    const nombre = [clean(row.getCell(2).value), clean(row.getCell(3).value), clean(row.getCell(4).value)]
      .join(' ').replace(/\s+/g, ' ').trim();
    const dep = clean(row.getCell(7).value).toUpperCase();
    const area = AREA_LABEL[dep] || clean(row.getCell(7).value);

    const punRaw = row.getCell(15).value;
    const punNum = Number(txt(punRaw).replace(',', '.'));
    const puntaje = (punRaw == null || Number.isNaN(punNum)) ? null : Math.round(punNum * 100) / 100;
    if (puntaje === null) ausentes++;

    if (map[dni] !== undefined) duplicados++;
    map[dni] = { n: nombre, a: area, p: puntaje };
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(map, null, 0), 'utf8');

  console.log(`✅ Generado: ${OUT_PATH}`);
  console.log(`   Estudiantes: ${Object.keys(map).length} (procesados ${total})`);
  console.log(`   Sin DNI: ${sinDni} | DNI no estándar: ${dniNoEstandar} | duplicados: ${duplicados} | sin puntaje (ausentes): ${ausentes}`);
})().catch(err => {
  console.error('❌ Error generando JSON:', err.message);
  process.exit(1);
});
