# Reporte de Pagos Efectuados — Guía de implementación

Endpoint Nuxt server-side que genera un Excel con el estado de pago de cada estudiante usando una distribución **FIFO** del neto recibido vs la obligación bruta (cuotas + mora).

---

## 1. Modelo de datos

### Tablas implicadas

| Tabla | Rol |
|-------|-----|
| `estudiantes` | Datos personales del alumno (id, nro_documento, paterno, materno, nombres, colegios_id) |
| `inscripciones` | Inscripción del alumno a un periodo (1 estudiante puede tener varias) |
| `tarifa_estudiantes` | Cuotas del alumno (5 filas por inscripción: nro_cuota 0-4) |
| `pagos` | Vouchers pagados (no FK directa, se vincula por `nro_documento`) |
| `cronograma_pagos` | Fechas de vencimiento por cuota (no usado en este reporte; opcional) |
| `sedes`, `areas`, `turnos`, `grupos`, `matriculas`, `grupo_aulas`, `colegios`, `tipo_colegios` | Catálogos de presentación |

### Reglas de negocio (no obvias)

- **Comisión bancaria**: cada voucher pagado descuenta **S/1** de comisión. El sistema solo recibe el neto.
- **Mora**: no se paga como concepto separado. La columna `tarifa_estudiantes.mora` es el cargo aplicado a la cuota (histórico, no se resetea).
- **Distribución FIFO**: el neto recibido se asigna en orden: matrícula → cuota1 → cuota2 → cuota3 → cuota4. La obligación de cada cuota es `monto + mora`.
- **`pagos.estado = '2'`**: pagos válidos. Estado `'1'` corresponde a anulados/pendientes — **excluir**.
- **`tarifa_estudiantes.modalidad` y `tipo_estudiante`** deben coincidir con los de `inscripciones` (filtro obligatorio para no mezclar periodos).

### Fórmula FIFO

```
neto_recibido = SUM(pagos.monto WHERE estado='2') - COUNT(pagos)   -- comisión por voucher

acum_i = SUM(monto + mora) hasta la cuota i (incluyéndola)
res_i  = MAX(0, acum_i - neto_recibido)         -- deuda residual al cierre

deuda_cuota_i = res_i - res_{i-1}               -- deuda incremental de la cuota
```

### Estados derivados

| Condición | Estado | Color del Excel |
|-----------|--------|-----------------|
| `deuda_cuota_i == 0` | `PAGADA` | 🟢 Verde (`#66bb6a`) |
| `deuda_cuota_i == monto + mora` | `SIN_PAGAR` | 🔴 Rojo (`#ef5350`) |
| en medio | `PARCIAL` | 🟡 Amarillo (`#f4ff81`) |

---

## 2. Query SQL

Archivo: [`reporte-pagos.sql`](./reporte-pagos.sql)

### Validación de referencia

Con DNI `60836542` (Jeff Agüero, modalidad presencial particular, S/300 por cuota):

| Campo | Valor esperado |
|-------|----------------|
| `neto_recibido` | 529 |
| `pago_total` | 1280 |
| `saldo` | -751 |
| `pago_matricula` | `250\|250\|0` |
| `primera_mensualidad` | 1 |
| `segunda_mensualidad` | 250 |
| `tercera_mensualidad` | 250 |
| `cuarta_mensualidad` | 250 |
| `estado_cuota1` | `PARCIAL` |
| `estado_cuota2-4` | `SIN_PAGAR` |

---

## 3. Esquema del resultado

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | int | ID de la inscripción |
| `nro_documento` | string | DNI |
| `paterno`, `materno`, `nombres` | string | Datos del estudiante |
| `sede`, `area`, `turno`, `grupo` | string | Ubicación académica |
| `descuento` | string | Tipo de estudiante (Normal, Hijo trabajador, etc.) |
| `tipo_colegio` | string | Estatal / Particular |
| `estado` | string | Estado de la inscripción (`'0'` PreInscrito, `'1'` Inscrito) |
| `pago_total` | decimal | Obligación bruta (con mora) |
| `neto_recibido` | decimal | Suma de vouchers válidos − comisiones |
| `saldo` | decimal | `neto - pago_total` (negativo = deuda) |
| `pago_matricula` | string | `"monto\|pagado\|mora"` |
| `primera_mensualidad` ... `cuarta_mensualidad` | decimal | Deuda incremental de la cuota |
| `estado_cuota1` ... `estado_cuota4` | string | `PAGADA`, `PARCIAL`, `SIN_PAGAR` |

---

## 4. Endpoint Nuxt sugerido

### Estructura

```
server/
  api/
    reportes/
      pagos.get.ts          # endpoint principal
  utils/
    db.ts                   # cliente MySQL/MariaDB
    excel/
      reporte-pagos.ts      # generador del .xlsx
  sql/
    reporte-pagos.sql       # la query (importar con ?raw)
```

### Implementación de referencia

```ts
// server/api/reportes/pagos.get.ts
import { defineEventHandler, setHeader, getQuery } from 'h3'
import { db } from '~/server/utils/db'
import { buildExcel } from '~/server/utils/excel/reporte-pagos'
import sqlText from '~/server/sql/reporte-pagos.sql?raw'

export default defineEventHandler(async (event) => {
  // (Opcional) validar permiso del usuario
  // const user = await requireUser(event)
  // if (!user.permissions.includes('descargar reporte pagos')) throw createError({ statusCode: 403 })

  // (Opcional) leer filtros del frontend
  // const { estado, cuota1, cuota2, cuota3, cuota4 } = getQuery(event)

  const rows = await db.query<ReporteRow[]>(sqlText)

  const buffer = await buildExcel(rows)

  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', 'attachment; filename="reporte-pagos.xlsx"')
  setHeader(event, 'Cache-Control', 'no-store')

  return buffer
})

interface ReporteRow {
  id: number
  nro_documento: string
  paterno: string
  materno: string
  nombres: string
  sede: string
  area: string | null
  turno: string | null
  grupo: string | null
  descuento: string
  tipo_colegio: string
  estado: string
  pago_total: number
  neto_recibido: number
  saldo: number
  pago_matricula: string
  primera_mensualidad: number
  segunda_mensualidad: number
  tercera_mensualidad: number
  cuarta_mensualidad: number
  estado_cuota1: 'PAGADA' | 'PARCIAL' | 'SIN_PAGAR'
  estado_cuota2: 'PAGADA' | 'PARCIAL' | 'SIN_PAGAR'
  estado_cuota3: 'PAGADA' | 'PARCIAL' | 'SIN_PAGAR'
  estado_cuota4: 'PAGADA' | 'PARCIAL' | 'SIN_PAGAR'
}
```

### Generador del Excel (con `exceljs`)

```ts
// server/utils/excel/reporte-pagos.ts
import ExcelJS from 'exceljs'

const COLOR_BY_ESTADO: Record<string, string> = {
  PAGADA:    'FF66BB6A',
  PARCIAL:   'FFF4FF81',
  SIN_PAGAR: 'FFEF5350',
}

const HEADERS = [
  'ID', 'Nro Documento', 'Paterno', 'Materno', 'Nombres',
  'Sede', 'Area', 'Turno', 'Grupo',
  'Descuento', 'Tipo Colegio', 'Estado',
  'Pago Total', 'Neto Recibido', 'Saldo',
  'Pago Matrícula',
  '1ra Mensualidad', '2da Mensualidad', '3ra Mensualidad', '4ta Mensualidad',
]

export async function buildExcel(rows: ReporteRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Reporte')

  // Título mergeado
  ws.mergeCells('F1:G1')
  ws.getCell('F1').value = 'Reporte Pagos Efectuados (FIFO)'
  ws.getCell('F1').font = { bold: true, color: { argb: 'FFFFFFFF' } }
  ws.getCell('F1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3366CC' } }
  ws.getCell('F1').alignment = { horizontal: 'center', vertical: 'middle' }

  // Cabeceras en fila 3
  ws.getRow(3).values = HEADERS
  ws.getRow(3).eachCell((cell) => {
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = {
      top:    { style: 'thin' },
      left:   { style: 'thin' },
      bottom: { style: 'thin' },
      right:  { style: 'thin' },
    }
  })

  // Datos desde fila 4
  rows.forEach((r, idx) => {
    const rowNum = 4 + idx
    const row = ws.getRow(rowNum)
    row.values = [
      r.id, r.nro_documento, r.paterno, r.materno, r.nombres,
      r.sede, r.area, r.turno, r.grupo,
      r.descuento, r.tipo_colegio, r.estado,
      r.pago_total, r.neto_recibido, r.saldo,
      r.pago_matricula,
      r.primera_mensualidad, r.segunda_mensualidad, r.tercera_mensualidad, r.cuarta_mensualidad,
    ]

    // Colorear las 4 celdas de mensualidad según el estado
    const estados = [r.estado_cuota1, r.estado_cuota2, r.estado_cuota3, r.estado_cuota4]
    const cols   = ['Q', 'R', 'S', 'T']  // 17, 18, 19, 20 → Q, R, S, T
    estados.forEach((estado, i) => {
      const color = COLOR_BY_ESTADO[estado]
      if (color) {
        ws.getCell(`${cols[i]}${rowNum}`).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: color },
        }
      }
    })
  })

  // Auto-size de las primeras columnas (las descriptivas)
  ;['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T'].forEach((col) => {
    const column = ws.getColumn(col)
    let maxLen = 10
    column.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? '').length
      if (len > maxLen) maxLen = len
    })
    column.width = Math.min(maxLen + 2, 40)
  })

  return Buffer.from(await wb.xlsx.writeBuffer())
}
```

### Cliente MySQL (referencia)

```ts
// server/utils/db.ts
import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
})

export const db = {
  query: async <T = any>(sql: string, params?: any[]): Promise<T> => {
    const [rows] = await pool.query(sql, params)
    return rows as T
  },
}
```

---

## 5. Filtros opcionales (paridad con la pantalla del Vue)

La pantalla actual tiene 5 filtros: `estado`, `cuota1`, `cuota2`, `cuota3`, `cuota4`. Para respetarlos en el Excel, agregar `WHERE`/`HAVING` dinámico:

```ts
// pseudocódigo
const conditions: string[] = []
const params: any[] = []

if (estado !== '') {
  conditions.push('i.estado = ?')
  params.push(estado)
}

// Para cuotaN faltante (= 1) → estado_cuotaN ≠ 'PAGADA'
// Para cuotaN completo (= 0) → estado_cuotaN = 'PAGADA'
if (cuota1 === '0') havingConditions.push("estado_cuota1 = 'PAGADA'")
if (cuota1 === '1') havingConditions.push("estado_cuota1 != 'PAGADA'")
// idem cuota2, 3, 4

const finalSql = sqlText
  + (conditions.length    ? ' WHERE '  + conditions.join(' AND ')    : '')
  + (havingConditions.length ? ' HAVING ' + havingConditions.join(' AND ') : '')
```

---

## 6. Performance e índices

Si la query tarda con muchos registros, asegurar estos índices en MySQL:

```sql
CREATE INDEX idx_pagos_nro_doc_estado    ON pagos (nro_documento, estado);
CREATE INDEX idx_tarifa_lookup           ON tarifa_estudiantes (estudiantes_id, nro_cuota, modalidad, tipo_estudiante);
CREATE INDEX idx_inscripciones_estud     ON inscripciones (estudiantes_id);
```

---

## 7. Seguridad

- **Autenticación obligatoria**: usar middleware de Nuxt (`defineEventHandler` con guard).
- **Permiso explícito**: validar que el usuario tenga el permiso `descargar reporte pagos` (o el que use tu sistema).
- **Rate limiting**: el reporte trae miles de filas; limitar descargas por minuto/usuario.

---

## 8. Cambios respecto al reporte Laravel anterior

| Antes (Laravel) | Ahora (Nuxt FIFO) |
|------------------|--------------------|
| `SUM(tarifa_estudiantes.monto)` con riesgo de duplicación | Suma directa, sin producto cartesiano |
| Mora ignorada en mensualidades | Mora incluida en `monto + mora` |
| Color basado en `monto - pagado` (estados ambiguos) | Estado FIFO explícito, 3 categorías |
| `pagado` como única fuente | `pagos` (vouchers reales) − comisión |
| `groupBy('nro_documento')` con riesgo de pérdida silenciosa | Sin GROUP BY: una fila por inscripción |

---

## 9. Validación post-deploy

Después de desplegar, verificar manualmente con 3 estudiantes representativos:

1. **Jeff Agüero (DNI 60836542)** — caso PARCIAL en cuota 1
   - Esperado: `primera_mensualidad = 1`, color amarillo

2. **Estudiante con saldo 0 o positivo** — caso todo PAGADA
   - Esperado: las 4 mensualidades = 0, color verde

3. **Estudiante que solo pagó matrícula** — caso 4 cuotas SIN_PAGAR
   - Esperado: las 4 mensualidades = monto+mora, color rojo

Si alguno difiere, revisar:
- Filtro `pagos.estado = '2'` (puede haber otros estados válidos en tu BD)
- Coincidencia de `modalidad` y `tipo_estudiante` entre `inscripciones` y `tarifa_estudiantes`
- Indice en `pagos.nro_documento` (si tarda mucho)
