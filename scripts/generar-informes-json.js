/**
 * Genera data/informes-docentes-2026.json a partir del Excel de informes.
 *
 * Uso:  node scripts/generar-informes-json.js [ruta-al-excel]
 *
 * El Excel tiene 3 columnas relevantes:
 *   Col 1 "Contact Numbers" -> teléfono (NO se usa)
 *   Col 2 "Name"            -> DNI del docente (clave)
 *   Col 3 "Message"         -> mensaje personalizado (valor)
 *
 * Salida: { "<dni>": "<mensaje>", ... }  en data/informes-docentes-2026.json
 *
 * exceljs es dependencia de desarrollo aquí; el servidor NO lo necesita en
 * runtime (solo consume el JSON generado).
 */
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const EXCEL_PATH = process.argv[2] || path.join(__dirname, '..', 'informes-docentes-completo-2026.xlsx');
const OUT_PATH = path.join(__dirname, '..', 'data', 'informes-docentes-2026.json');

// Extrae texto plano de una celda (soporta richText / objetos).
function txt(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.text != null) return String(v.text);
    return String(v);
  }
  return String(v);
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);
  const ws = wb.worksheets[0];

  const map = {};
  let total = 0, sinDni = 0, dniNoEstandar = 0, duplicados = 0;

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const dni = txt(row.getCell(2).value).trim();
    const msg = txt(row.getCell(3).value).trim();

    if (!dni && !msg) continue;          // fila vacía
    if (!dni) { sinDni++; continue; }     // sin clave -> se descarta
    total++;

    if (!/^\d{8}$/.test(dni)) dniNoEstandar++;
    if (map[dni] !== undefined) duplicados++;

    map[dni] = msg;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(map, null, 0), 'utf8');

  console.log(`✅ Generado: ${OUT_PATH}`);
  console.log(`   Docentes: ${Object.keys(map).length} (procesados ${total})`);
  console.log(`   Sin DNI descartados: ${sinDni} | DNI no estándar: ${dniNoEstandar} | duplicados sobrescritos: ${duplicados}`);
})().catch(err => {
  console.error('❌ Error generando JSON:', err.message);
  process.exit(1);
});
