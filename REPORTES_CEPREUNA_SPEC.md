# Sistema de Reportes con Visualización — CEPREUNA

Especificación para implementar dos reportes con interfaz web filtrable, basados en la BD del sistema académico CEPREUNA.

---

## Contexto general

- **Stack actual de la app**: Laravel (PHP). La BD tiene tablas auditadas con `owen-it/laravel-auditing`.
- **Motor**: MySQL 8 / MariaDB 10.4
- **BD de trabajo**: `marzo_julio_2025` (espejo local) o `cepreuna_production` (producción). Nombre configurable.
- **Periodo único activo en el dump**: `periodos.id = 1` (MARZO-JULIO 2025).
- **Encoding**: `utf8mb4_unicode_ci`. Si se crean variables del cliente para comparar strings, agregar `COLLATE utf8mb4_unicode_ci`.

### Catálogos clave (enums hardcoded en BD)

| Tabla | Campo | Valores |
|---|---|---|
| `sedes` | `id` | 1=Virtual · 2=Juliaca · 3=Puno · 4=Juli-Chucuito · 5=Ayaviri · 6=Azangaro · 7=Huancané-Moho · 8=Ilave |
| `sedes` | `modalidad` | 1=virtual · 2=presencial |
| `turnos` | `id` | 1=Mañana · 2=Tarde · 3=Noche |
| `areas` | `id` | 1=Biomédicas · 2=Ingenierías · 3=Sociales |
| `inscripciones` | `modalidad` | 1=virtual · 2=presencial · 3=ambas |
| `asistencia_docentes` | `estado` | 1=presente · 2=tarde · 3=falta |
| `carga_academicas` | `tipo` | 1=normal (titular) · 2=suplente |

### Modelo relacional resumido

```
asistencia_docentes
├─ docentes_id          → docentes
├─ users_id             → users (quién registró la asistencia)
└─ carga_academicas_id  → carga_academicas
                         ├─ docentes_id  → docentes
                         ├─ cursos_id    → cursos
                         └─ grupo_aulas_id → grupo_aulas
                                            ├─ grupos_id  → grupos
                                            ├─ turnos_id  → turnos
                                            ├─ areas_id   → areas
                                            └─ aulas_id   → aulas → locales → sedes

asistencia_estudiantes
├─ grupo_aulas_id → grupo_aulas (= mismo árbol que arriba)
└─ users_id        → users (auxiliar que tomó la lista)

auxiliar_grupos    (asignación de auxiliares a grupos)
├─ auxiliares_id  → auxiliares → users
└─ grupo_aulas_id → grupo_aulas

coordinador_grupos (asignación de coordinadores a grupos)
├─ coordinador_id → users
└─ grupos_id      → grupo_aulas (¡ojo: la FK apunta a grupo_aulas no a grupos!)
```

---

## Reporte 1 — Horas pago por docentes (con coordinador y auxiliar)

### Objetivo
Para un rango de fechas, mostrar las horas totales de pago a docentes agrupadas por **coordinador, auxiliar, sede, turno, área y grupo**. Permite identificar cuánto se le debe pagar a cada docente desglosado por estructura organizacional.

### Filtros UI requeridos
- **Fecha desde / Fecha hasta** (obligatorio, default = mes actual)
- **Coordinador** (multi-select, opcional)
- **Auxiliar** (multi-select, opcional)
- **Sede** (multi-select, opcional)
- **Turno** (multi-select, opcional)
- **Área** (multi-select, opcional)
- **Grupo** (multi-select, opcional, dependiente de área+turno+sede)
- **Tipo carga**: opción "Solo titular" / "Solo suplente" / "Ambos" (default: Ambos)

### Salida (columnas)
| Columna | Origen |
|---|---|
| Coordinador | `coordinador_grupos` → `users` |
| Auxiliar | `auxiliar_grupos` → `auxiliares` → `users` |
| Sede | `sedes.denominacion` |
| Turno | `turnos.denominacion` |
| Área | `areas.denominacion` |
| Grupo | `grupos.denominacion` |
| Total horas pago | `SUM(asistencia_docentes.horas_pago)` |

### Query SQL base

```sql
SELECT
    CONCAT(u_coord.name, ' ', COALESCE(u_coord.paterno,''), ' ', COALESCE(u_coord.materno,'')) AS coordinador,
    CONCAT(u_aux.name,   ' ', COALESCE(u_aux.paterno,''),   ' ', COALESCE(u_aux.materno,''))   AS auxiliar,
    s.denominacion       AS sede,
    t.denominacion       AS turno,
    ar_grupo.denominacion AS area,
    g.denominacion       AS grupo,
    SUM(a.horas_pago)    AS total_horas_pago
FROM asistencia_docentes a
JOIN carga_academicas ca ON a.carga_academicas_id = ca.id
JOIN grupo_aulas ga ON ca.grupo_aulas_id = ga.id
JOIN grupos    g        ON ga.grupos_id = g.id
JOIN areas     ar_grupo ON ga.areas_id  = ar_grupo.id
JOIN turnos    t        ON ga.turnos_id = t.id
JOIN aulas     au       ON ga.aulas_id  = au.id
JOIN locales   l        ON au.locales_id = l.id
JOIN sedes     s        ON l.sedes_id    = s.id
LEFT JOIN coordinador_grupos cg ON ga.id = cg.grupos_id
LEFT JOIN users          u_coord ON cg.coordinador_id = u_coord.id
LEFT JOIN auxiliar_grupos ag    ON ga.id = ag.grupo_aulas_id
LEFT JOIN auxiliares     aux    ON ag.auxiliares_id = aux.id
LEFT JOIN users          u_aux  ON aux.users_id = u_aux.id
WHERE a.fecha BETWEEN :desde AND :hasta
  -- Filtros opcionales (binding dinámico):
  -- AND s.id   IN (:sedes)
  -- AND t.id   IN (:turnos)
  -- AND ar_grupo.id IN (:areas)
  -- AND g.id   IN (:grupos)
  -- AND ca.tipo = :tipo_carga
GROUP BY
  u_coord.id, u_coord.name, u_coord.paterno, u_coord.materno,
  u_aux.id,   u_aux.name,   u_aux.paterno,   u_aux.materno,
  s.id, s.denominacion,
  t.id, t.denominacion,
  ar_grupo.id, ar_grupo.denominacion,
  g.id, g.denominacion
ORDER BY coordinador, auxiliar, sede, turno, area, grupo;
```

### Observaciones implementación
- La FK `coordinador_grupos.grupos_id` apunta a `grupo_aulas.id` (no a `grupos.id` — nombre confuso en el esquema original).
- Si un grupo tiene varios coordinadores/auxiliares, se producen filas adicionales por cada combinación. Para evitarlo, considerar `GROUP_CONCAT` en lugar de joins múltiples si se desea **una fila por grupo**.
- Asistencias con `estado=3 (falta)` también tienen `horas_pago` registrado pero generalmente debería ser 0. Validar comportamiento esperado con el negocio.

### Vista sugerida
- **Tabla** con paginación y subtotales por (sede), (sede+turno), (coordinador).
- **Totalizador** al pie: total horas pago del rango.
- **Exportar a Excel/CSV**.
- **Gráficos**: barras horizontales con top 10 docentes/coordinadores por horas.

---

## Reporte 2 — Cobertura de asistencia por grupos (matriz semanal)

### Objetivo
Para un rango de fechas (típicamente 1 semana Mon-Fri), mostrar **una fila por grupo** con SI/NO por cada día hábil, indicando si el auxiliar tomó asistencia a estudiantes ese día. Permite detectar grupos sin cobertura.

### Filtros UI requeridos
- **Fecha desde / Fecha hasta** (obligatorio, default = semana actual)
- **Sede** (multi-select, opcional)
- **Turno** (multi-select, opcional)
- **Área** (multi-select, opcional)
- **Grupo** (multi-select, opcional)
- **Auxiliar responsable** (multi-select, opcional)
- **Estado**: "Todos" / "Con faltas (al menos 1 NO)" / "100% cumplimiento" / "Sin asignar"

### Salida (columnas)
| Columna | Descripción |
|---|---|
| Grupo | `grupos.denominacion` |
| Área | `areas.denominacion` |
| Turno | `turnos.denominacion` |
| Sede | `sedes.denominacion` |
| Auxiliar responsable | Auxiliares asignados en `auxiliar_grupos` (concatenados) |
| Lunes / Martes / … / Viernes | SI / NO si alguien tomó asistencia ese día de la semana |
| Días tomados | Conteo de SI |
| Días faltantes | Conteo de NO |
| % cumplimiento | `100 × SI / total días hábiles` |

### Query SQL base

```sql
SET @desde := :desde;   -- '2025-05-05'
SET @hasta := :hasta;   -- '2025-05-09'

WITH RECURSIVE
dias AS (
  SELECT @desde AS d
  UNION ALL
  SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM dias WHERE d < @hasta
),
habiles AS (
  SELECT d FROM dias WHERE DAYOFWEEK(d) BETWEEN 2 AND 6   -- Lunes-Viernes
),
asistencia_dia AS (
  SELECT
    ae.grupo_aulas_id,
    ae.fecha,
    GROUP_CONCAT(DISTINCT CONCAT_WS(' ', u.paterno, u.materno, u.name)
                 ORDER BY u.paterno SEPARATOR ', ') AS tomada_por
  FROM asistencia_estudiantes ae
  JOIN users u ON u.id = ae.users_id
  WHERE ae.fecha BETWEEN @desde AND @hasta
  GROUP BY ae.grupo_aulas_id, ae.fecha
),
matriz AS (
  SELECT
    ga.id  AS grupo_aulas_id,
    h.d    AS dia,
    DAYOFWEEK(h.d) AS dow,
    CASE WHEN ad.fecha IS NOT NULL THEN 'SI' ELSE 'NO' END AS tomado,
    ad.tomada_por
  FROM grupo_aulas ga
  CROSS JOIN habiles h
  LEFT JOIN asistencia_dia ad
         ON ad.grupo_aulas_id = ga.id
        AND ad.fecha          = h.d
  WHERE ga.periodos_id = 1
),
auxiliares_grupo AS (
  SELECT
    ag.grupo_aulas_id,
    GROUP_CONCAT(DISTINCT CONCAT_WS(' ', u.paterno, u.materno, u.name)
                 ORDER BY u.paterno SEPARATOR ', ') AS auxiliares_asignados
  FROM auxiliar_grupos ag
  JOIN auxiliares a ON a.id = ag.auxiliares_id
  JOIN users      u ON u.id = a.users_id
  GROUP BY ag.grupo_aulas_id
)
SELECT
  g.denominacion                                    AS grupo,
  ar.denominacion                                   AS area,
  t.denominacion                                    AS turno,
  s.denominacion                                    AS sede,
  COALESCE(axg.auxiliares_asignados, '— sin asignar —') AS auxiliar_responsable,

  MAX(CASE WHEN m.dow = 2 THEN m.tomado END)        AS lunes,
  MAX(CASE WHEN m.dow = 3 THEN m.tomado END)        AS martes,
  MAX(CASE WHEN m.dow = 4 THEN m.tomado END)        AS miercoles,
  MAX(CASE WHEN m.dow = 5 THEN m.tomado END)        AS jueves,
  MAX(CASE WHEN m.dow = 6 THEN m.tomado END)        AS viernes,

  SUM(m.tomado = 'SI')                              AS dias_tomados,
  SUM(m.tomado = 'NO')                              AS dias_faltantes,
  ROUND(100 * SUM(m.tomado='SI') / COUNT(*), 0)     AS pct
FROM matriz m
JOIN grupo_aulas      ga ON ga.id = m.grupo_aulas_id
JOIN grupos           g  ON g.id  = ga.grupos_id
JOIN turnos           t  ON t.id  = ga.turnos_id
JOIN areas            ar ON ar.id = ga.areas_id
JOIN aulas            au ON au.id = ga.aulas_id
JOIN locales          l  ON l.id  = au.locales_id
JOIN sedes            s  ON s.id  = l.sedes_id
LEFT JOIN auxiliares_grupo axg ON axg.grupo_aulas_id = ga.id
WHERE 1=1
  -- Filtros opcionales:
  -- AND s.id  IN (:sedes)
  -- AND t.id  IN (:turnos)
  -- AND ar.id IN (:areas)
  -- AND ga.id IN (:grupos)
GROUP BY ga.id, g.denominacion, ar.denominacion, t.denominacion,
         s.denominacion, axg.auxiliares_asignados
-- HAVING dias_faltantes > 0   -- (si filtro = "Con faltas")
-- HAVING pct = 100            -- (si filtro = "100% cumplimiento")
ORDER BY sede, turno, area, grupo;
```

### Observaciones implementación
- **Días dinámicos**: las columnas `lunes-viernes` asumen rango de 1 semana Mon-Fri. Para rangos mayores, decidir:
  - **A)** Mantener pivote por día de la semana (lunes/martes/…), donde el valor es "SI si algún lunes del rango tuvo asistencia". Bueno para visión semanal.
  - **B)** Pivote dinámico por fecha (1 columna por fecha real). Requiere construir SQL/columnas en código.
  - Recomendado: ofrecer toggle "Vista semanal" vs "Vista detallada" en UI.
- **Sábado/Domingo**: agregar columnas `sabado` (dow=7) y `domingo` (dow=1) y cambiar el filtro `habiles` si se requiere.
- **Grupos sin asignar**: aparecen con `auxiliar_responsable = '— sin asignar —'`. Útil reporte separado de grupos huérfanos.
- **Suplencia**: si `tomada_por` ≠ `auxiliar_responsable`, hubo suplencia. Considerar columna extra "Suplencias detectadas".
- **Periodos**: actualmente `periodos.id = 1` hardcoded. Hacer parametrizable cuando se carguen futuros periodos.

### Vista sugerida
- **Tabla** con códigos de color: verde `SI`, rojo `NO`, gris `— sin asignar —`.
- **Filas con `pct < 100`** resaltadas.
- **Subtotales por sede / turno**: % promedio de cumplimiento.
- **Heatmap opcional**: matriz visual día × grupo con intensidad de color según cobertura.
- **Drilldown**: click en una celda "NO" abre detalle del día (qué pasó, hubo `audits` de borrado, asistencias parciales, etc.).
- **Exportar a Excel/CSV**.

---

## Reporte 3 — Evaluación docente (Docentes-Stats)

### Objetivo
Mostrar el desempeño de los docentes a partir de la encuesta de calificación que llenan los alumnos. Permite identificar mejores y peores docentes (con corrección estadística por tamaño de muestra), ver el desempeño desagregado por curso, área, turno, sede y pregunta, y consultar la ficha individual de cualquier docente buscado por DNI o nombre.

### Restricción de acceso
**Vista exclusiva para administradores.** Roles permitidos: `Administrador`, `Super Admin`, `Oficina de Administración`. Se aplica triple protección:
1. **Backend** — todos los endpoints (`requireAdmin` middleware)
2. **Frontend** — guard JS en cada página: redirige a `/stats/alumnos` si el rol no es admin
3. **Sidebar** — link oculto por defecto (`data-role="admin" style="display:none"`), se muestra solo si el rol es admin

### Origen de datos
| Tabla | Uso |
|---|---|
| `calificacion_docentes` | Una fila por (docente, carga académica) con `promedio` (1–5), `puntaje_total`, `participantes`, `modalidad` |
| `calificacion_docente_detalles` | Respuesta individual del alumno a cada `criterios_id`, con `puntaje` 1–5 |
| `criterios` | Preguntas de la encuesta. Filtrar por `tipo='1' AND estado='1'` para las preguntas docentes activas |
| `carga_academicas` | Filtrar por `tipo='1'` (titular) para no duplicar suplentes |
| `docentes` | Identidad. `condicion='2'` = UNAP (tiene `codigo_unap`), `condicion='1'` = Particular |

### Score corregido (bayesiano)

Un docente con 10 alumnos y promedio 5.00 **no es comparable** con uno de 300 y 4.50. Para evitar premiar/castigar por azar, el ranking usa un puntaje **acercado al promedio institucional** cuando la muestra es pequeña:

```
score = (n × prom_doc + m × C) / (n + m)
```

Donde:
- `prom_doc` = **media de los promedios de cada grupo** del docente (no media ponderada por alumnos — evita que un grupo grande domine)
- `n` = total de participantes (alumnos que lo calificaron)
- `C` = promedio global institucional (calculado dinámicamente, típicamente ≈ 4.41)
- `m` = mediana de participantes por docente (peso "fantasma", típicamente ≈ 91, mínimo 20)

Tag de robustez por número de participantes:
- `n ≥ 50` → **robusta** (ranking confiable)
- `30 ≤ n < 50` → **referencial**
- `n < 30` → **insuficiente** (no entra al ranking institucional)

### Endpoints (admin-only)

```
GET /api/stats/docentes-stats/dashboard?sede=&area=&turno=
GET /api/stats/docentes-stats/buscar?q=<dni|codigo|nombre>
GET /api/stats/docentes-stats/docente/:id
GET /api/stats/docentes-stats/curso?curso=<denominacion>
GET /api/stats/docentes-stats/heatmap?curso=<denominacion>
GET /api/stats/docentes-stats/export/intervenciones.xlsx?sede=&area=&turno=
GET /api/stats/docentes-stats/export/curso.xlsx?curso=<denominacion>
GET /api/stats/docentes-stats/export/ficha/:id.xlsx
```

### Filtros globales del dashboard

Los parámetros `sede` (id), `area` (id) y `turno` (id) aplican a las series **KPIs, top/bottom docentes, intervenciones priorizadas y grupos en riesgo**. Las series cuya función es comparar dimensiones (`distribucion_promedios`, `ranking_por_curso/area/turno/sede`, `por_modalidad`, `por_pregunta`, `varianza_cursos`, `evolucion`) **siempre devuelven la vista institucional** — filtrarlas eliminaría su propósito comparativo.

Construido por el helper `buildDashboardFilters(query)` que devuelve dos pares JOIN/WHERE:
- `joinsCa` + `whereCa` para queries que parten desde `calificacion_docentes` (perspectiva docente)
- `joinsIm` + `whereIm` para queries que parten desde `inscripciones`/`matriculas` (perspectiva alumno)

El response incluye `filtros_aplicados: { sede, area, turno }` para que el frontend muestre badge de filtros activos.

### Vistas adicionales

| Ruta | Descripción |
|---|---|
| `/stats/docentes-stats/comparar?a=<id>&b=<id>` | **Comparador 1-vs-1**: dos buscadores con autocompletar, tabla comparativa (score, polarización, consistencia, asistencia), gráfico de pregunta lado a lado y modalidad. URL persistente. |
| Heatmap embebido | En la tarjeta de "Ranking de docentes por curso", botón "Ver heatmap" que abre matriz coloreada (docente × pregunta) — filas clickables a la ficha. Sirve `/api/.../heatmap`. |

#### `GET /dashboard` — Vista institucional
Devuelve un JSON con todas las series del dashboard ejecutivo:

```json
{
  "kpis": { "total_alumnos": 7263, "completos": 4236, "parciales": 730, "sin_calificar": 2297, "cobertura_global_pct": 65.0, "docentes_evaluados": 580 },
  "bayes": { "C": 4.412, "m": 91, "formula": "score = (n·prom_doc + m·C)/(n+m); ..." },
  "distribucion_cumplimiento": [ { "rango": "100% Completo", "alumnos": 4236 }, ... ],
  "cobertura_por_sede": [ { "sede": "Juliaca", "alumnos": ..., "pct": ... }, ... ],
  "top_docentes":    [ { "id":96, "docente":"...", "promedio_crudo":4.89, "score":4.75, "participantes":232, "asignaciones":8, "robustez":"robusta" }, ... ],
  "bottom_docentes": [ ... ],
  "distribucion_promedios": [ { "rango": "4.5–5.0 Excelente", "docentes": 124 }, ... ],
  "ranking_por_curso": [ { "etiqueta": "Razonamiento Verbal", "promedio": 4.56, "participantes": 4830, "docentes": 69 }, ... ],
  "ranking_por_area":  [ ... ],
  "ranking_por_turno": [ ... ],
  "ranking_por_sede":  [ ... ],
  "por_pregunta": [ { "id":5, "pregunta":"¿El docente desarrolla las sesiones según el temario del curso?", "promedio":4.66, "respuestas":40989, "aprobatorias":..., "criticas":... }, ... ],
  "por_modalidad": [
    { "modalidad":"Presencial", "docentes":381, "cargas":1649, "calificaciones":40959, "promedio":4.46 },
    { "modalidad":"Virtual",    "docentes":278, "cargas":668,  "calificaciones":20871, "promedio":4.39 }
  ],
  "intervenciones": [
    { "id":N, "docente":"...", "dni":"...", "vinculo":"Particular", "promedio_crudo":4.10, "score":4.18,
      "participantes":268, "cursos":1, "grupos":11, "impacto":62.4 }, ...
  ],
  "varianza_cursos": [
    { "curso":"Literatura", "docentes":46, "promedio":4.47, "desviacion":0.324, "rango":1.54, "minimo":3.40, "maximo":4.94 }, ...
  ],
  "grupos_riesgo": [ ... ],
  "evolucion": [ ... ]
}
```

Cacheado 180 s. Las queries que tocan `calificacion_docente_detalles` (399 k filas) son las más costosas — sobrevive bien con el cache.

#### `GET /buscar?q=...` — Autocompletar
Mínimo 2 caracteres. Hace `LIKE %q%` simultáneamente sobre `nro_documento`, `codigo_unap` y nombre completo. Devuelve hasta 25 matches con `{ id, dni, codigo_unap, nombre, vinculo, profesion }`.

#### `GET /docente/:id` — Ficha individual

```json
{
  "docente": { "id":96, "dni":"47214881", "codigo_unap": null, "nombre":"MAMANI CALLA NILO", "vinculo":"Particular", "profesion":"Otros", "email":"..." },
  "bayes":   { "C":4.412, "m":91 },
  "resumen": {
    "promedio_crudo": 4.89, "score": 4.75, "participantes": 232,
    "asignaciones": 8, "cursos_distintos": 1, "grupos_distintos": 8,
    "robustez": "robusta",
    "posicion": 1, "total_ranking": 514,
    "media_institucional": 4.412
  },
  "cargas": [
    { "curso":"Educación Cívica", "grupo":"S-102", "area":"Sociales", "turno":"Mañana", "sede":"Juliaca", "participantes":43, "promedio":"4.95" }, ...
  ],
  "por_pregunta": [
    { "id":5, "pregunta":"...", "promedio_docente":4.92, "promedio_global":4.39, "n_docente":232 }, ...
  ],
  "por_modalidad": [
    { "modalidad":"Presencial", "promedio":4.89, "calificaciones":232, "cargas":8 }
  ],
  "polarizacion": {
    "total":1392, "top5":1280, "p4":88, "p3":24, "criticas":0,
    "pct_top":92.0, "pct_buena":6.3, "pct_regular":1.7, "pct_critica":0.0
  },
  "consistencia": {
    "desviacion":0.05, "min_grupo":4.83, "max_grupo":4.95, "rango":0.12, "n_grupos":8
  },
  "asistencia": {
    "total_sesiones":80, "presente":80, "tarde":0, "falta":0,
    "pct_presente":100.0, "pct_tarde":0.0, "pct_falta":0.0, "horas_dictadas":130
  }
}
```

`posicion` solo se calcula si `n >= 30`; de lo contrario es `null`.

#### `GET /curso?curso=...` — Ranking de docentes dentro de un curso

Devuelve los docentes que dictan el curso indicado, ordenados por **score bayesiano local al curso** (la media `C` es la del curso, no la institucional → permite comparación justa entre pares que enseñan lo mismo).

```json
{
  "curso": "Razonamiento Verbal",
  "bayes": { "C": 4.538, "m": 65, "formula": "score local al curso = (n·prom_doc + m·C_curso)/(n+m)" },
  "docentes": [
    { "id": 12, "docente": "LUJANO QUISPE FRESNIL ALBERT", "dni": "44538378", "vinculo": "Particular",
      "promedio_crudo": 4.88, "score": 4.76, "participantes": 118, "grupos": 5, "robustez": "robusta" },
    ...
  ],
  "total_docentes": 69, "total_calificaciones": 4830
}
```

Umbrales de robustez intra-curso (más laxos que los institucionales, porque los volúmenes por docente×curso son menores): `n ≥ 30` robusta · `n ≥ 15` referencial · `n < 15` insuficiente.

Cada docente trae además `pct_top` (% de respuestas con puntaje 5) y `pct_critica` (% de respuestas 1–2), para identificar polarización dentro del curso.

### Series adicionales (sesgo y gestión)

| Serie | Fuente | Pregunta que responde |
|---|---|---|
| **Modalidad institucional/del docente** | `cd.modalidad` 0=presencial, 1=virtual | ¿Los alumnos perciben peor a los docentes virtuales? |
| **Polarización por docente** | `cdd.puntaje IN (1,2)` vs `=5` | ¿Cuántos alumnos lo califican muy bajo o muy alto? El promedio oculta esto. |
| **Consistencia entre grupos** | `STDDEV_POP(cd.promedio)` por docente | ¿Es parejo en todos sus grupos o depende del grupo? |
| **Asistencia del docente** | `asistencia_docentes.estado` (1=presente, 2=tarde, 3=falta) | ¿Su puntualidad correlaciona con su score? |
| **Intervenciones priorizadas** | `(C − score) × n` | ¿Sobre quién intervenir primero por **impacto**, no por peor promedio? |
| **Varianza por curso** | `STDDEV_POP(cd.promedio)` por curso | ¿Qué cursos necesitan estandarización entre docentes? |
| **Observaciones del auxiliar** | `asistencia_docentes.observacion` (último 30) | Notas cualitativas del docente: tardanzas, faltas, comportamiento. |
| **Heatmap docente × pregunta** | Pivot de promedios por (docente × criterio) | ¿En qué aspecto baja cada docente del curso? |
| **Comparador 1-vs-1** | Reusa `/docente/:id` para A y B | Decisiones de promoción / acompañamiento. |

### Exportación a Excel

Los 3 endpoints `/export/*.xlsx` proxean con descarga forzada (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`). Estilo: título azul `#003366`, fecha de generación, tabla con bordes. Multi-hoja en el caso de la ficha (Resumen / Cursos y grupos / Por pregunta / Observaciones). El frontend usa `fetch + blob + download` para enviar el `Authorization: Bearer ...` (los `<a href>` no llevan headers).

### Query SQL clave — Top docentes con score bayesiano

```sql
SELECT d.id,
       CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
       ROUND(AVG(cd.promedio), 2) AS promedio_crudo,
       ROUND((SUM(cd.participantes) * AVG(cd.promedio) + :m * :C) / (SUM(cd.participantes) + :m), 2) AS score,
       SUM(cd.participantes) AS participantes,
       COUNT(DISTINCT cd.carga_academicas_id) AS asignaciones,
       CASE WHEN SUM(cd.participantes) >= 50 THEN 'robusta'
            WHEN SUM(cd.participantes) >= 30 THEN 'referencial'
            ELSE 'insuficiente' END AS robustez
FROM calificacion_docentes cd
JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
JOIN docentes d ON d.id = cd.docentes_id
WHERE cd.participantes > 0
GROUP BY d.id
HAVING participantes >= 30
ORDER BY score DESC, participantes DESC LIMIT 15;
```

`:C` y `:m` se calculan al inicio del request leyendo todos los promedios y participantes por docente, evitando subqueries en `OFFSET` (no soportadas por MySQL).

### Query SQL clave — Promedio por pregunta del docente vs media institucional

```sql
SELECT cr.id, cr.denominacion AS pregunta,
       ROUND(AVG(CASE WHEN cd.docentes_id = :id THEN cdd.puntaje END), 2) AS promedio_docente,
       ROUND(AVG(cdd.puntaje), 2) AS promedio_global,
       SUM(CASE WHEN cd.docentes_id = :id THEN 1 ELSE 0 END) AS n_docente
FROM calificacion_docente_detalles cdd
JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
JOIN criterios cr ON cr.id = cdd.criterios_id
WHERE cr.tipo='1' AND cr.estado='1'
GROUP BY cr.id, cr.denominacion
HAVING n_docente > 0
ORDER BY promedio_docente DESC;
```

### Vistas

| Ruta | Descripción |
|---|---|
| `/stats/docentes-stats` | **Dashboard institucional** — informe ejecutivo con 6 secciones narrativas (Participación · Calidad docente · Por dimensión · Por pregunta · Grupos en riesgo · Evolución). Cada gráfico lleva un texto "Lectura clave" auto-generado en lenguaje natural. Las barras de Top/Bottom 15 son clickables → ficha individual. |
| `/stats/docentes-stats/docente?id=<id>` | **Ficha individual** — buscador por DNI/código/nombre + ficha con identidad, KPIs (score, crudo, n, posición ranking), tabla de cursos×grupos con promedio por carga, y gráfico comparativo del docente vs media institucional por pregunta. |

### Observaciones implementación

- **Errores `ONLY_FULL_GROUP_BY`**: MySQL 8 con modo estricto rechaza `SELECT s.denominacion ... GROUP BY ga.id` cuando la sede no es funcionalmente dependiente del grupo. Solucionado con `ANY_VALUE()` en `grupos_riesgo` y usando la misma expresión `DATE_FORMAT(...)` en `GROUP BY` y `SELECT` para evolución.
- **Duplicados por nombre**: cursos con misma denominación pero distinto `id` aparecían como dos filas en el ranking (`Razonamiento Verbal`). Solución: `GROUP BY c.denominacion` en lugar de `c.id, c.denominacion`.
- **Escala 1–5**: confirmada por inspección de `MIN/MAX/AVG(puntaje)` en `calificacion_docente_detalles`. Los rangos del histograma de calidad y la paleta `colorByProm` están calibrados para esta escala.
- **Vínculo UNAP vs Particular**: `tipo_trabajador` y `contrato` están **null en los 988 docentes**. La distinción real viene de `condicion`: `'2'` = UNAP (119 docentes, todos con `codigo_unap`), `'1'` = Particular (869 docentes, sin código). Correlación 100% confirmada con `codigo_unap IS NOT NULL`.
- **Caché**: dashboard 180 s, ficha 120 s. Buscador sin caché (volátil).

---

## Filtros comunes a Reportes 1 y 2

| Filtro | Origen de datos para dropdown | Tipo |
|---|---|---|
| Sede | `SELECT id, denominacion FROM sedes WHERE estado='1' ORDER BY denominacion` | multi-select |
| Turno | `SELECT id, denominacion FROM turnos WHERE estado='1' ORDER BY id` | multi-select |
| Área | `SELECT id, denominacion FROM areas ORDER BY denominacion` | multi-select |
| Grupo | dependiente (área + turno + sede) — consultar `grupo_aulas` joinedo | multi-select |
| Coordinador | `SELECT id, CONCAT_WS(' ', paterno, materno, name) AS nombre FROM users WHERE id IN (SELECT DISTINCT coordinador_id FROM coordinador_grupos) ORDER BY paterno` | multi-select |
| Auxiliar | `SELECT u.id, CONCAT_WS(' ', u.paterno, u.materno, u.name) AS nombre FROM users u JOIN auxiliares a ON a.users_id = u.id ORDER BY u.paterno` | multi-select |
| Rango fechas | date range picker | obligatorio |

---

## Consideraciones técnicas

### Seguridad
- Si los reportes son sensibles (datos de pago), restringir por **rol** (`spatie/laravel-permission` ya está integrado — tabla `roles`). Roles relevantes:
  - 1: Super Admin
  - 2: Administrador
  - 4: Coordinador Cuadernillos
  - 5: Coordinador Auxiliar
  - 6: Secretaria
- **Sanitizar inputs** de fechas y arrays de IDs (usar Eloquent/Query Builder con bindings, nunca concatenar strings).

### Performance
- **Índices recomendados** (ya existen en gran parte):
  - `asistencia_docentes(fecha, carga_academicas_id)` — para Reporte 1
  - `asistencia_estudiantes(fecha, grupo_aulas_id)` — para Reporte 2
- **CTE recursiva**: requiere MySQL 8.0+ o MariaDB 10.2+. Para rangos > 1000 días, ejecutar antes:
  ```sql
  SET SESSION cte_max_recursion_depth = 10000;
  ```
- **Cache de catálogos** (sedes, turnos, áreas) en Redis/memoria — cambian rara vez.
- **Paginación server-side** para Reporte 1 si el rango supera 1 mes.

### Tecnología sugerida
- **Backend**: Laravel (mismo stack) — controlador con un endpoint por reporte que reciba filtros vía query string y devuelva JSON. Si ya hay API REST, registrar bajo `/api/reportes/horas-docentes` y `/api/reportes/cobertura-grupos`.
- **Frontend**: Vue/Livewire (lo que use el sistema). Componentes:
  - `FiltrosReporte.vue` reusable
  - `TablaReporte.vue` con sorting/exportación
  - `HeatmapCobertura.vue` para Reporte 2 (D3 o ApexCharts)
- **Exportación**: paquete `maatwebsite/excel` para XLSX, `barryvdh/laravel-dompdf` para PDF.

### Auditoría / logging
- Registrar consultas a estos reportes en `audits` o un log propio:
  - usuario que consultó
  - filtros aplicados
  - timestamp
  Útil para auditoría de quién mira qué datos sensibles (horas pago).

---

## Casos de prueba

### Reporte 1
1. **Rango 1 mes, sin filtros**: debe devolver todas las combinaciones (coordinador, auxiliar, sede, turno, área, grupo) con horas > 0.
2. **Filtro 1 coordinador**: solo filas de sus grupos.
3. **Sin coordinador asignado**: la columna `coordinador` aparece vacía/null — debe seguir mostrándose.
4. **Suma vertical**: el total de `total_horas_pago` debe coincidir con `SELECT SUM(horas_pago) FROM asistencia_docentes WHERE fecha BETWEEN ...`.

### Reporte 2
1. **Semana Mon-Fri sin clases (vacaciones)**: todas las filas con `NO` en todos los días.
2. **Grupo recién creado** sin auxiliar: aparece con `— sin asignar —` y `pct=0`.
3. **Grupo con 2 auxiliares**: ambos en `auxiliar_responsable`, lógica SI/NO se evalúa a nivel grupo (cualquier auxiliar cuenta).
4. **Rango con feriado**: ese día sale `NO` aunque sea legítimo. Mejora futura: tabla `feriados` para excluir.

---

## Endpoints sugeridos

```
GET /api/reportes/horas-docentes?desde=2026-03-01&hasta=2026-03-31&sedes[]=2&turnos[]=1
GET /api/reportes/cobertura-grupos?desde=2026-05-05&hasta=2026-05-09&areas[]=3

GET /api/catalogos/sedes
GET /api/catalogos/turnos
GET /api/catalogos/areas
GET /api/catalogos/grupos?sede_id=3&turno_id=1&area_id=2
GET /api/catalogos/coordinadores
GET /api/catalogos/auxiliares
```

Respuesta JSON sugerida (Reporte 1):
```json
{
  "filtros_aplicados": { "desde": "...", "hasta": "...", "sedes": [2] },
  "totales": { "horas_pago": 1245.5, "registros": 87 },
  "filas": [
    { "coordinador": "...", "auxiliar": "...", "sede": "Juliaca",
      "turno": "Mañana", "area": "Biomédicas", "grupo": "B-101",
      "total_horas_pago": 24.0 },
    ...
  ]
}
```
