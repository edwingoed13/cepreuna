-- =============================================================================
-- Índices para acelerar el panel /stats/docentes-stats
-- =============================================================================
-- CONTEXTO
--   Las consultas del dashboard de calificación docente hacen full-scans
--   (type=ALL + "Using temporary; Using filesort" en EXPLAIN) sobre las tablas
--   grandes porque faltan índices en las columnas de JOIN/filtro más calientes.
--
--   Medición (BD producción, ~399k filas en calificacion_docente_detalles):
--     - NUM_SUBQ (cobertura por alumno)      ~2.3 s  → type=ALL en calificacion_docentes
--     - ASIST_VALIDA (modo "solo válidas")   ~2.7 s  → escaneo de 363k filas
--     - KPIs cobertura                        ~1.6 s
--   Estos índices deberían bajar esas consultas de segundos a decenas de ms.
--
-- CÓMO APLICAR
--   Ejecutar con un usuario con privilegio ALTER/INDEX (el usuario 'vista' del
--   .env es solo lectura y NO puede). Preferible en ventana de bajo tráfico.
--   Son índices pequeños; la creación toma segundos. MySQL 8 los crea online
--   (ALGORITHM=INPLACE) sin bloquear escrituras en la mayoría de casos.
--
-- SEGURIDAD
--   Solo AÑADEN índices; no modifican datos ni esquema lógico. Reversibles con
--   los DROP INDEX del final si hiciera falta.
--
-- NOTA: si algún índice ya existe, MySQL dará error "Duplicate key name"; en ese
--   caso omítelo. (Para idempotencia real se requeriría un procedimiento; aquí
--   se dejan los CREATE directos por claridad.)
-- =============================================================================

-- 1) calificacion_docentes: cubre el patrón cd.estado='1' + JOIN por carga + COUNT/AVG por docente.
--    Ataca el type=ALL de NUM_SUBQ / TC_SUBQ / cd_src.
CREATE INDEX idx_cd_estado_carga_doc
  ON calificacion_docentes (estado, carga_academicas_id, docentes_id, participantes);

-- 2) carga_academicas: cubre el filtro recurrente tipo='1' + periodos_id=1 + estado='1'
--    y el JOIN por grupo_aulas_id (cobertura por grupo) y cursos_id (rankings).
CREATE INDEX idx_ca_tipo_periodo_estado
  ON carga_academicas (tipo, periodos_id, estado, grupo_aulas_id, cursos_id);

-- 3) asistencia_estudiante_detalles: acelera el cálculo de "asistencia válida"
--    (GROUP BY estudiantes_id con SUM(estado IN ('1','2'))). Modo "solo válidas".
CREATE INDEX idx_aed_est_estado
  ON asistencia_estudiante_detalles (estudiantes_id, estado);

-- 4) calificacion_docente_detalles: acelera la evolución temporal por día
--    (GROUP BY DATE(created_at)) y los escaneos por fecha.
CREATE INDEX idx_cdd_created
  ON calificacion_docente_detalles (created_at);

-- (Las claves de JOIN calificacion_docente_detalles(calificacion_docentes_id) y
--  (estudiantes_id) YA tienen índice FK, no hace falta agregarlas.)

-- =============================================================================
-- Para verificar el efecto: EXPLAIN antes/después debería pasar de
--   type=ALL / "Using temporary; Using filesort"  →  type=ref/range usando estos índices.
-- =============================================================================

-- ---- ROLLBACK (solo si se quisiera revertir) --------------------------------
-- DROP INDEX idx_cd_estado_carga_doc       ON calificacion_docentes;
-- DROP INDEX idx_ca_tipo_periodo_estado    ON carga_academicas;
-- DROP INDEX idx_aed_est_estado            ON asistencia_estudiante_detalles;
-- DROP INDEX idx_cdd_created               ON calificacion_docente_detalles;
