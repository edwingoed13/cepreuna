'use strict';

/**
 * Consultas de la vista /stats/alumnos contra la base institucional.
 *
 * El servidor principal no puede alcanzar esta base, así que le envía los
 * FILTROS (nunca SQL) y aquí se arma la consulta: el SQL base vive en este
 * paquete y los valores van siempre como parámetros.
 *
 * El filtro por grupos llega resuelto desde el servidor, que lo saca del JWT de
 * la sesión. `null` significa acceso global (administradores); un array limita a
 * esos grupos; un array vacío no debe consultar nada.
 */

const fs = require('fs');
const path = require('path');
const { conReintento } = require('./reintento');

// El SQL base no lleva WHERE: se envuelve para poder filtrar por las columnas
// calculadas (estado_cuota1, etc.) sin tocar el fuente.
// El archivo ya no trae ORDER BY final (lo pone el envoltorio de abajo): recortarlo
// con una expresion se llevaba por delante los ORDER BY internos de los LATERAL.
const SQL_BASE = fs
  .readFileSync(path.join(__dirname, 'reporte-pagos.sql'), 'utf8')
  .replace(/;\s*$/, '')
  .trim();

// El periodo vigente se resuelve en la base y se cachea un rato: cambia una vez
// por ciclo, no tiene sentido consultarlo en cada peticion.
let periodoCache = { datos: null, hasta: 0 };
async function periodoVigente(conn) {
  if (periodoCache.datos && Date.now() < periodoCache.hasta) return periodoCache.datos;
  const [[p]] = await conn.query(`
    SELECT id, codigo,
           DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS desde,
           DATE_FORMAT(fecha_fin, '%Y-%m-%d') AS hasta
    FROM periodos WHERE es_actual = 1 LIMIT 1`);
  if (!p) throw Object.assign(new Error('No hay periodo vigente'), { codigo: 'SIN_PERIODO' });
  periodoCache = { datos: p, hasta: Date.now() + 10 * 60 * 1000 };
  return p;
}

// El rango de asistencia sale del propio periodo vigente: fijarlo a mano dejaba
// la ficha en blanco al cambiar de ciclo.

const soloEnteros = (v) => (Array.isArray(v) ? v : [])
  .map(Number).filter(Number.isInteger);

/** Arma la consulta del reporte a partir de filtros ya validados. */
function construirConsulta(filtros = {}, periodo) {
  const cond = [];
  // El periodo aparece tres veces en el SQL base, en este orden: la imputacion
  // de pagos, el tarifario y el filtro de inscripciones.
  const params = [periodo, periodo, periodo];

  // Permisos: array = restringido a esos grupos; null = global.
  const permitidos = filtros.grupos === null ? null : soloEnteros(filtros.grupos);
  if (permitidos !== null) {
    if (permitidos.length === 0) return { bloqueado: true };
    cond.push(`grupo_aulas_id IN (${permitidos.map(() => '?').join(',')})`);
    params.push(...permitidos);
  }

  // Selección de la interfaz: se intersecta con lo permitido.
  const seleccion = soloEnteros(filtros.gruposSeleccionados);
  if (seleccion.length) {
    cond.push(`grupo_aulas_id IN (${seleccion.map(() => '?').join(',')})`);
    params.push(...seleccion);
  }

  // '0' = pagada, '1' = pendiente. Cualquier otro valor se ignora.
  for (const n of [1, 2, 3, 4]) {
    const v = filtros['cuota' + n];
    const col = 'estado_cuota' + n;
    if (v === '0') cond.push(`${col} = 'PAGADA'`);
    else if (v === '1') cond.push(`${col} <> 'PAGADA'`);
  }

  const q = typeof filtros.q === 'string' ? filtros.q.trim() : '';
  if (q) { cond.push('nro_documento LIKE ?'); params.push(`%${q}%`); }

  return {
    sql: `SELECT * FROM (${SQL_BASE}) AS t ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY paterno, materno, nombres`,
    params
  };
}

async function reportePagos(pool, filtros) {
  return conReintento(async () => {
    const conn = await pool.getConnection();
    try {
      const q = construirConsulta(filtros, (await periodoVigente(conn)).id);
      if (q.bloqueado) return { total: 0, registros: [] };
      const [rows] = await conn.query(q.sql, q.params);
      return { total: rows.length, registros: rows };
    } finally { conn.release(); }
  });
}

/**
 * Ficha de un alumno: contacto, contexto académico y asistencia del ciclo.
 * Devuelve { error: 'no_encontrado' } o { error: 'sin_acceso' } para que el
 * servidor traduzca el código HTTP.
 */
async function fichaAlumno(pool, dni, gruposPermitidos) {
  if (!/^\d{6,12}$/.test(String(dni || '').trim())) return { error: 'dni_invalido' };

  return conReintento(async () => {
    const conn = await pool.getConnection();
    try {
      const periodo = await periodoVigente(conn);

      const [[est]] = await conn.query(`
        SELECT e.id, e.nro_documento AS dni, e.celular, e.email,
               CONCAT_WS(' ', e.paterno, e.materno, e.nombres) AS nombre
        FROM estudiantes e WHERE e.nro_documento = ?`, [String(dni).trim()]);
      if (!est) return { error: 'no_encontrado' };

      const [[ctx]] = await conn.query(`
        SELECT ANY_VALUE(s.denominacion) AS sede,
               ANY_VALUE(g.denominacion) AS grupo,
               ANY_VALUE(ar.denominacion) AS area,
               ANY_VALUE(t.denominacion) AS turno,
               ANY_VALUE(m.grupo_aulas_id) AS grupo_aulas_id
        FROM inscripciones i
        LEFT JOIN matriculas m ON m.estudiantes_id = i.estudiantes_id AND m.periodos_id = i.periodos_id
        LEFT JOIN grupo_aulas ga ON ga.id = m.grupo_aulas_id
        LEFT JOIN grupos g ON g.id = ga.grupos_id
        LEFT JOIN areas ar ON ar.id = ga.areas_id
        LEFT JOIN turnos t ON t.id = ga.turnos_id
        LEFT JOIN sedes s ON s.id = i.sedes_id
        WHERE i.estudiantes_id = ? AND i.periodos_id = ? AND i.estado = '1'
        GROUP BY i.estudiantes_id`, [est.id, periodo.id]);

      // Un usuario no administrador solo ve alumnos de sus grupos.
      if (Array.isArray(gruposPermitidos)) {
        const gid = ctx && Number(ctx.grupo_aulas_id);
        if (!gid || !gruposPermitidos.map(Number).includes(gid)) return { error: 'sin_acceso' };
      }

      const [asis] = await conn.query(`
        SELECT DATE_FORMAT(ae.fecha, '%Y-%m-%d') AS fecha, MAX(aed.estado) AS estado
        FROM asistencia_estudiante_detalles aed
        JOIN asistencia_estudiantes ae ON ae.id = aed.asistencia_estudiantes_id
        WHERE aed.estudiantes_id = ? AND ae.fecha BETWEEN ? AND ?
        GROUP BY ae.fecha
        ORDER BY ae.fecha`, [est.id, periodo.desde, periodo.hasta]);

      const resumen = { presente: 0, tarde: 0, falta: 0 };
      for (const r of asis) {
        if (r.estado === '1') resumen.presente++;
        else if (r.estado === '2') resumen.tarde++;
        else if (r.estado === '3') resumen.falta++;
      }
      resumen.total = asis.length;
      resumen.pct = asis.length ? Math.round(100 * (resumen.presente + resumen.tarde) / asis.length) : null;

      return { ...est, ...(ctx || {}), asistencia: asis, resumen,
               rango: { desde: periodo.desde, hasta: periodo.hasta }, ciclo: periodo.codigo };
    } finally { conn.release(); }
  });
}

module.exports = { reportePagos, fichaAlumno };
