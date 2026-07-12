/**
 * Genera data/informes-docentes-9-16-2026.json a partir del Excel de la
 * segunda notificación (presentación de informes, semanas 9 a 16).
 *
 * Uso:  node scripts/generar-informes-9-16-json.js [ruta-al-excel]
 *       (por defecto: horas-9-16-noti.xlsx)
 *
 * Columnas relevantes del Excel (sin fila de encabezado):
 *   B = mensaje completo del comunicado · D = DNI del docente
 *   (A = teléfono, C = "-": se ignoran)
 *
 * Salida: { "<dni>": "<mensaje>", ... }  (mismo formato que informes-docentes-2026.json)
 *
 * exceljs es dependencia de desarrollo; el servidor NO lo necesita en runtime
 * (solo consume el JSON generado, servido por DNI vía la API).
 */
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const EXCEL_PATH = process.argv[2] || path.join(__dirname, '..', 'horas-9-16-noti.xlsx');
const OUT_PATH = path.join(__dirname, '..', 'data', 'informes-docentes-9-16-2026.json');

// Extrae texto plano de una celda (soporta richText / objetos).
function cellText(cell) {
  const v = cell && cell.value;
  if (v == null) return '';
  if (typeof v === 'object' && Array.isArray(v.richText)) {
    return v.richText.map((t) => t.text).join('');
  }
  return String(v);
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);
  const ws = wb.worksheets[0];

  const out = {};
  ws.eachRow((row) => {
    const dni = cellText(row.getCell(4)).replace(/\D/g, ''); // Col D
    const mensaje = cellText(row.getCell(2)).trim();          // Col B
    if (!dni || !mensaje) return;
    out[dni] = mensaje;
  });

  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`Registros escritos: ${Object.keys(out).length} -> ${OUT_PATH}`);
})().catch((e) => {
  console.error('Error generando JSON:', e);
  process.exit(1);
});
