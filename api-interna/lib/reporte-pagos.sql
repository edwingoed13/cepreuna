-- =============================================================================
-- Reporte de Pagos Efectuados (por estado de tarifa)
-- =============================================================================
-- Fuente:  inscripciones + estudiantes + tarifa_estudiantes  (filtrado por periodo)
--
-- OJO (base multiciclo): aqui `tarifa_estudiantes` guarda las cuotas de TODOS
-- los ciclos, asi que cada union debe ceñirse al periodo de la inscripcion. Sin
-- esa condicion un alumno se cruza con sus tarifas historicas (8 de media, hasta
-- 45) y el reporte se multiplica. El periodo llega como parametro (?), resuelto por
-- `periodos.es_actual = 1`.
-- Modelo:
--   En `tarifa_estudiantes`:
--     - monto  = obligación principal de la cuota (lo que el alumno debe).
--     - pagado = monto aplicado al principal (cobranza ya recibida).
--     - mora   = monto aplicado al recargo por mora (cobranza adicional, NO obligación).
--   La validación contra `inscripcion_pagos` confirma que `pagado + mora` = vouchers
--   recibidos del alumno en el ciclo, así que `mora` es plata que ya entró y NO
--   debe sumarse a la deuda.
--
--   Por cuota i ∈ {1,2,3,4}:
--     deuda_i  = max(0, monto - pagado)
--     estado_i = PAGADA    si pagado >= monto (existe la tarifa)
--                SIN_PAGAR si pagado = 0 (sin cobranza al principal)
--                PARCIAL   en cualquier otro caso
-- =============================================================================

SELECT
    i.id,
    e.nro_documento,
    e.paterno,
    e.materno,
    e.nombres,
    s.denominacion AS sede,
    areas.denominacion AS area,
    turnos.denominacion AS turno,
    grupos.denominacion AS grupo,
    m.grupo_aulas_id,
    sede_aula.denominacion AS sede_aula,
    tc.denominacion AS tipo_colegio,
    i.estado,

    -- Resumen economico del alumno
    tf.mensualidad AS monto_mensualidad,
    COALESCE(ip.pago_matricula, 0)     AS pago_matricula,
    COALESCE(ip.pago_mensualidades, 0) AS pago_mensualidades,
    COALESCE(ip.pago_rezagado, 0)      AS pago_rezagado,
    COALESCE(ip.total_pagado, 0)       AS total_pagado,
    CASE WHEN tf.mensualidad IS NULL THEN NULL
         ELSE LEAST(4, FLOOR(COALESCE(ip.pago_mensualidades,0) / tf.mensualidad)) END AS cuotas_cubiertas,

    -- Deuda residual de cada cuota (solo principal; mora es cobranza, no obligación)
    GREATEST(0, COALESCE(tf.mensualidad,0) - GREATEST(0, COALESCE(ip.pago_mensualidades,0) - 0 * COALESCE(tf.mensualidad,0))) AS primera_mensualidad,
    GREATEST(0, COALESCE(tf.mensualidad,0) - GREATEST(0, COALESCE(ip.pago_mensualidades,0) - 1 * COALESCE(tf.mensualidad,0))) AS segunda_mensualidad,
    GREATEST(0, COALESCE(tf.mensualidad,0) - GREATEST(0, COALESCE(ip.pago_mensualidades,0) - 2 * COALESCE(tf.mensualidad,0))) AS tercera_mensualidad,
    GREATEST(0, COALESCE(tf.mensualidad,0) - GREATEST(0, COALESCE(ip.pago_mensualidades,0) - 3 * COALESCE(tf.mensualidad,0))) AS cuarta_mensualidad,

    -- Estado por cuota
    CASE
        WHEN tf.mensualidad IS NULL THEN 'SIN_TARIFA'
        WHEN FLOOR(COALESCE(ip.pago_mensualidades,0) / tf.mensualidad) >= 1 THEN 'PAGADA'
        WHEN COALESCE(ip.pago_mensualidades,0) > (1 - 1) * tf.mensualidad THEN 'PARCIAL'
        ELSE 'SIN_PAGAR'
    END AS estado_cuota1,

    CASE
        WHEN tf.mensualidad IS NULL THEN 'SIN_TARIFA'
        WHEN FLOOR(COALESCE(ip.pago_mensualidades,0) / tf.mensualidad) >= 2 THEN 'PAGADA'
        WHEN COALESCE(ip.pago_mensualidades,0) > (2 - 1) * tf.mensualidad THEN 'PARCIAL'
        ELSE 'SIN_PAGAR'
    END AS estado_cuota2,

    CASE
        WHEN tf.mensualidad IS NULL THEN 'SIN_TARIFA'
        WHEN FLOOR(COALESCE(ip.pago_mensualidades,0) / tf.mensualidad) >= 3 THEN 'PAGADA'
        WHEN COALESCE(ip.pago_mensualidades,0) > (3 - 1) * tf.mensualidad THEN 'PARCIAL'
        ELSE 'SIN_PAGAR'
    END AS estado_cuota3,

    CASE
        WHEN tf.mensualidad IS NULL THEN 'SIN_TARIFA'
        WHEN FLOOR(COALESCE(ip.pago_mensualidades,0) / tf.mensualidad) >= 4 THEN 'PAGADA'
        WHEN COALESCE(ip.pago_mensualidades,0) > (4 - 1) * tf.mensualidad THEN 'PARCIAL'
        ELSE 'SIN_PAGAR'
    END AS estado_cuota4,

    -- Flags: la modalidad/tipo_estudiante de la cuota difiere de la inscripción.
    -- Esto delata alumnos que cambiaron de modalidad o tipo a mitad del ciclo:
    -- la cuota se cobró bajo otra modalidad/tipo y queda registrada así en tarifa.
    CASE WHEN t1.id IS NOT NULL AND (t1.modalidad <> i.modalidad OR t1.tipo_estudiante <> i.tipo_estudiante) THEN 1 ELSE 0 END AS cambio_mod_1,
    CASE WHEN t2.id IS NOT NULL AND (t2.modalidad <> i.modalidad OR t2.tipo_estudiante <> i.tipo_estudiante) THEN 1 ELSE 0 END AS cambio_mod_2,
    CASE WHEN t3.id IS NOT NULL AND (t3.modalidad <> i.modalidad OR t3.tipo_estudiante <> i.tipo_estudiante) THEN 1 ELSE 0 END AS cambio_mod_3,
    CASE WHEN t4.id IS NOT NULL AND (t4.modalidad <> i.modalidad OR t4.tipo_estudiante <> i.tipo_estudiante) THEN 1 ELSE 0 END AS cambio_mod_4

FROM inscripciones i
JOIN estudiantes e ON e.id = i.estudiantes_id

-- Tarifas por cuota: JOIN solo por (estudiantes_id, nro_cuota).
--
-- Históricamente se filtraba también por modalidad + tipo_estudiante para
-- "no mezclar periodos", pero hoy:
--   - Hay un solo periodo activo (filtrado por WHERE i.periodos_id = 1).
--   - 0 estudiantes tienen más de una fila de tarifa para la misma cuota
--     (verificado con consulta de impacto), así que no hay riesgo de
--     duplicación.
--   - Alumnos que cambian de modalidad (presencial ↔ virtual) durante el
--     ciclo dejan `inscripciones.modalidad` y `tarifa_estudiantes.modalidad`
--     desincronizados. El filtro estricto los mostraba como SIN_PAGAR 0 en
--     todas las cuotas. La cobranza real vive en `tarifa.pagado`, no
--     depende de qué modalidad esté declarada.
LEFT JOIN tarifa_estudiantes t1
    ON t1.estudiantes_id = e.id AND t1.nro_cuota = 1
   AND t1.periodos_id = i.periodos_id
LEFT JOIN tarifa_estudiantes t2
    ON t2.estudiantes_id = e.id AND t2.nro_cuota = 2
   AND t2.periodos_id = i.periodos_id
LEFT JOIN tarifa_estudiantes t3
    ON t3.estudiantes_id = e.id AND t3.nro_cuota = 3
   AND t3.periodos_id = i.periodos_id
LEFT JOIN tarifa_estudiantes t4
    ON t4.estudiantes_id = e.id AND t4.nro_cuota = 4
   AND t4.periodos_id = i.periodos_id

-- Tarifa que corresponde al alumno. El importe vive en `tarifas.importe`
-- (`monto` esta a 0) y depende de modalidad + tipo_estudiante + tipo de colegio.
-- Como `inscripciones.tarifas_id` esta vacio, el tipo de colegio se deduce por el
-- importe de matricula cobrado, que es unico dentro de cada modalidad y tipo.
LEFT JOIN (
    SELECT tm.modalidad, tm.tipo_estudiante,
           tm.importe  AS matricula,
           tme.importe AS mensualidad
    FROM tarifas tm
    JOIN tarifas tme
      ON tme.periodos_id      = tm.periodos_id
     AND tme.modalidad        = tm.modalidad
     AND tme.tipo_estudiante  = tm.tipo_estudiante
     AND tme.tipo_colegios_id = tm.tipo_colegios_id
     AND tme.denominacion LIKE 'Mensualidad%'
    WHERE tm.periodos_id = ? AND tm.denominacion LIKE 'Matricula%'
) tf ON tf.modalidad       = i.modalidad
    AND tf.tipo_estudiante = i.tipo_estudiante
    AND tf.matricula       = i.monto_total

-- Lo abonado segun la imputacion del propio sistema: `inscripcion_pagos` reparte
-- cada pago entre conceptos (1 matricula, 2 mensualidad, 3 rezagado). La tabla
-- `pagos` no sirve para esto: alli todo figura como concepto 1.
LEFT JOIN (
    SELECT inscripciones_id,
           SUM(CASE WHEN concepto_pagos_id = 1 THEN monto ELSE 0 END) AS pago_matricula,
           SUM(CASE WHEN concepto_pagos_id = 2 THEN monto ELSE 0 END) AS pago_mensualidades,
           SUM(CASE WHEN concepto_pagos_id = 3 THEN monto ELSE 0 END) AS pago_rezagado,
           SUM(monto) AS total_pagado,
           COUNT(*)   AS n_lineas
    FROM inscripcion_pagos
    WHERE periodos_id = ?
    GROUP BY inscripciones_id
) ip ON ip.inscripciones_id = i.id

-- Catálogos de presentación
JOIN sedes s ON s.id = i.sedes_id
-- Una sola matricula por alumno y periodo: en la base hay registros repetidos
-- (819 en el ciclo vigente) y unirlos de forma directa multiplicaba las filas
-- del reporte. Se toma la mas reciente.
LEFT JOIN (
    SELECT estudiantes_id, periodos_id, MAX(id) AS id
    FROM matriculas
    GROUP BY estudiantes_id, periodos_id
) mu ON mu.estudiantes_id = e.id AND mu.periodos_id = i.periodos_id
LEFT JOIN matriculas m ON m.id = mu.id
LEFT JOIN grupo_aulas ga ON ga.id = m.grupo_aulas_id
LEFT JOIN areas ON areas.id = ga.areas_id
LEFT JOIN grupos ON grupos.id = ga.grupos_id
LEFT JOIN turnos ON turnos.id = ga.turnos_id
-- Sede REAL del aula del grupo (para etiquetar Puno vs Virtual correctamente).
-- Nota: la `sede` arriba viene de `inscripciones` (donde el alumno se inscribió),
-- que puede no coincidir con la sede del aula en que finalmente fue matriculado.
LEFT JOIN aulas aula_real ON aula_real.id = ga.aulas_id
LEFT JOIN locales local_aula ON local_aula.id = aula_real.locales_id
LEFT JOIN sedes sede_aula ON sede_aula.id = local_aula.sedes_id
JOIN colegios cl ON cl.id = e.colegios_id
JOIN tipo_colegios tc ON tc.id = cl.tipo_colegios_id

-- Solo el ciclo actual y solo alumnos inscritos (estado = '1').
-- Se excluyen pre-inscritos ('0') y retirados.
WHERE i.periodos_id = ?
  AND i.estado = '1'

ORDER BY e.paterno, e.materno, e.nombres;
