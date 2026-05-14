-- =============================================================================
-- Reporte de Pagos Efectuados (por estado de tarifa)
-- =============================================================================
-- Fuente:  inscripciones + estudiantes + tarifa_estudiantes  (filtrado por periodo)
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

    -- Deuda residual de cada cuota (solo principal; mora es cobranza, no obligación)
    GREATEST(0, COALESCE(t1.monto,0) - COALESCE(t1.pagado,0)) AS primera_mensualidad,
    GREATEST(0, COALESCE(t2.monto,0) - COALESCE(t2.pagado,0)) AS segunda_mensualidad,
    GREATEST(0, COALESCE(t3.monto,0) - COALESCE(t3.pagado,0)) AS tercera_mensualidad,
    GREATEST(0, COALESCE(t4.monto,0) - COALESCE(t4.pagado,0)) AS cuarta_mensualidad,

    -- Estado por cuota
    CASE
        WHEN t1.id IS NULL THEN 'SIN_PAGAR'
        WHEN COALESCE(t1.pagado,0) >= COALESCE(t1.monto,0) THEN 'PAGADA'
        WHEN COALESCE(t1.pagado,0) = 0 THEN 'SIN_PAGAR'
        ELSE 'PARCIAL'
    END AS estado_cuota1,

    CASE
        WHEN t2.id IS NULL THEN 'SIN_PAGAR'
        WHEN COALESCE(t2.pagado,0) >= COALESCE(t2.monto,0) THEN 'PAGADA'
        WHEN COALESCE(t2.pagado,0) = 0 THEN 'SIN_PAGAR'
        ELSE 'PARCIAL'
    END AS estado_cuota2,

    CASE
        WHEN t3.id IS NULL THEN 'SIN_PAGAR'
        WHEN COALESCE(t3.pagado,0) >= COALESCE(t3.monto,0) THEN 'PAGADA'
        WHEN COALESCE(t3.pagado,0) = 0 THEN 'SIN_PAGAR'
        ELSE 'PARCIAL'
    END AS estado_cuota3,

    CASE
        WHEN t4.id IS NULL THEN 'SIN_PAGAR'
        WHEN COALESCE(t4.pagado,0) >= COALESCE(t4.monto,0) THEN 'PAGADA'
        WHEN COALESCE(t4.pagado,0) = 0 THEN 'SIN_PAGAR'
        ELSE 'PARCIAL'
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
LEFT JOIN tarifa_estudiantes t2
    ON t2.estudiantes_id = e.id AND t2.nro_cuota = 2
LEFT JOIN tarifa_estudiantes t3
    ON t3.estudiantes_id = e.id AND t3.nro_cuota = 3
LEFT JOIN tarifa_estudiantes t4
    ON t4.estudiantes_id = e.id AND t4.nro_cuota = 4

-- Catálogos de presentación
JOIN sedes s ON s.id = i.sedes_id
LEFT JOIN matriculas m ON m.estudiantes_id = e.id AND m.periodos_id = i.periodos_id
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

-- Solo el ciclo actual
WHERE i.periodos_id = 1

ORDER BY e.paterno, e.materno, e.nombres;
