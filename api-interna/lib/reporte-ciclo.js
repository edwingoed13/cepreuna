'use strict';

/**
 * Reporte de inscripciones del ciclo vigente sobre la base multiciclo.
 *
 * Vive aparte porque lo usan dos procesos distintos: el servidor principal
 * (cuando alcanza la base por VPN) y la API interna que se publica desde la red
 * institucional. Recibe el pool ya creado para no atarse a una configuración.
 *
 * El periodo nunca se fija a mano: se resuelve con `periodos.es_actual = 1`, de
 * modo que al abrirse el siguiente ciclo el reporte lo toma sin tocar código.
 */

async function obtenerReporteCicloActual(pool) {
  const conn = await pool.getConnection();
  try {
    const [[periodo]] = await conn.query(
      `SELECT id, nombre, codigo, inicio_ciclo, fin_ciclo,
              DATE_FORMAT(fecha_inicio, '%Y-%m-%d') fecha_inicio,
              DATE_FORMAT(fecha_fin, '%Y-%m-%d') fecha_fin
       FROM periodos WHERE es_actual = 1 LIMIT 1`);
    if (!periodo) {
      const e = new Error('No hay ningún periodo marcado como vigente');
      e.codigo = 'SIN_PERIODO';
      throw e;
    }

    // Inscritos por sede/turno/área (se excluyen los anulados: estado '0').
    const [inscritos] = await conn.query(`
      SELECT s.id sede_id, s.denominacion sede,
             t.id turno_id, t.denominacion turno,
             a.id area_id, a.denominacion area,
             COUNT(DISTINCT i.estudiantes_id) inscritos
      FROM inscripciones i
      JOIN sedes s ON s.id = i.sedes_id
      JOIN turnos t ON t.id = i.turnos_id
      JOIN areas a ON a.id = i.areas_id
      WHERE i.periodos_id = ? AND i.estado <> '0'
      GROUP BY s.id, s.denominacion, t.id, t.denominacion, a.id, a.denominacion`, [periodo.id]);

    // Oferta vigente. `vacantes` y `cantidad` son equivalentes en esta tabla.
    const [oferta] = await conn.query(`
      SELECT cv.sedes_id, s.denominacion sede,
             cv.turnos_id, t.denominacion turno,
             cv.areas_id, a.denominacion area,
             COALESCE(cv.vacantes, cv.cantidad, 0) capacidad
      FROM configuracion_vacantes cv
      JOIN sedes s ON s.id = cv.sedes_id
      JOIN turnos t ON t.id = cv.turnos_id
      JOIN areas a ON a.id = cv.areas_id
      WHERE cv.periodos_id = ? AND cv.estado = '1'`, [periodo.id]);

    const buscar = (lista, sede, turno, area) =>
      lista.find(x => x.sedes_id === sede && x.turnos_id === turno && x.areas_id === area);
    const inscritosDe = (sede, turno, area) =>
      Number(inscritos.find(r => r.sede_id === sede && r.turno_id === turno && r.area_id === area)?.inscritos || 0);

    // Se recorre la oferta y además lo inscrito fuera de ella, para que una sede
    // ofertada sin inscritos siga apareciendo (y viceversa).
    const combinaciones = [
      ...oferta,
      ...inscritos.map(r => ({
        sedes_id: r.sede_id, sede: r.sede,
        turnos_id: r.turno_id, turno: r.turno,
        areas_id: r.area_id, area: r.area
      }))
    ];

    const sedesMap = new Map();
    const vistas = new Set();
    for (const c of combinaciones) {
      const clave = `${c.sedes_id}-${c.turnos_id}-${c.areas_id}`;
      if (vistas.has(clave)) continue;
      vistas.add(clave);

      if (!sedesMap.has(c.sedes_id)) {
        sedesMap.set(c.sedes_id, { sede_id: c.sedes_id, sede: c.sede, turnos: new Map() });
      }
      const sede = sedesMap.get(c.sedes_id);
      if (!sede.turnos.has(c.turnos_id)) {
        sede.turnos.set(c.turnos_id, { turno_id: c.turnos_id, turno: c.turno, areas: [] });
      }
      sede.turnos.get(c.turnos_id).areas.push({
        area_id: c.areas_id,
        area: c.area,
        total_inscritos: inscritosDe(c.sedes_id, c.turnos_id, c.areas_id),
        capacidad: Number(buscar(oferta, c.sedes_id, c.turnos_id, c.areas_id)?.capacidad || 0)
      });
    }

    const reporte = [...sedesMap.values()].map(s => {
      const turnos = [...s.turnos.values()].map(t => {
        const areas = t.areas
          .map(a => ({ ...a, vacantes_disponibles: Math.max(0, a.capacidad - a.total_inscritos) }))
          .sort((x, y) => x.area.localeCompare(y.area));
        return {
          turno_id: t.turno_id,
          turno: t.turno,
          areas,
          total_inscritos: areas.reduce((n, a) => n + a.total_inscritos, 0)
        };
      }).sort((a, b) => a.turno.localeCompare(b.turno));

      return {
        sede_id: s.sede_id,
        sede: s.sede,
        es_virtual: /virtual/i.test(s.sede),
        total_inscritos: turnos.reduce((n, t) => n + t.total_inscritos, 0),
        capacidad: turnos.reduce((n, t) => n + t.areas.reduce((m, a) => m + a.capacidad, 0), 0),
        turnos
      };
    }).sort((a, b) => b.total_inscritos - a.total_inscritos);

    return {
      periodo: {
        id: periodo.id,
        codigo: periodo.codigo,
        nombre: periodo.nombre,
        rango: `${periodo.inicio_ciclo} - ${periodo.fin_ciclo}`,
        fecha_inicio: periodo.fecha_inicio,
        fecha_fin: periodo.fecha_fin
      },
      totales: {
        inscritos: reporte.reduce((n, s) => n + s.total_inscritos, 0),
        capacidad: oferta.reduce((n, v) => n + Number(v.capacidad), 0),
        sedes: reporte.length
      },
      reporte,
      timestamp: new Date().toISOString()
    };
  } finally {
    conn.release();
  }
}

module.exports = { obtenerReporteCicloActual };
