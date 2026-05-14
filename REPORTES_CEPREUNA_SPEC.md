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

## Filtros comunes a ambos reportes

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
