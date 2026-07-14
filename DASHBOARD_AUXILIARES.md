# Dashboard de Rendimiento de Auxiliares — Consultas

Conjunto de consultas para armar un dashboard de **rendimiento y eficiencia de auxiliares** desde el inicio del ciclo (**23/03/2026**). Cada bloque alimenta una o varias gráficas.

- **BD**: producción CEPREUNA (esquema tipo `marzo_julio_2025`).
- **Inicio de ciclo**: `2026-03-23`.
- **Filtro de matrícula válido en producción**: `m.estado = '0'` (trae todas).
- **Periodo activo**: `periodos_id = 1`.

Variables comunes al inicio de cada consulta:
```sql
SET @inicio := '2026-03-23';
SET @fin    := CURDATE();
```

---

## 1. Cobertura de asistencia a estudiantes  *(métrica central)*

Cuántas listas tomó cada auxiliar, en cuántos días y grupos.

```sql
SET @inicio := '2026-03-23'; SET @fin := CURDATE();
SELECT
  CONCAT_WS(' ', u.paterno, u.materno, u.name)      AS auxiliar,
  u.dni,
  COUNT(*)                                          AS listas_tomadas,
  COUNT(DISTINCT ae.fecha)                          AS dias_con_asistencia,
  COUNT(DISTINCT ae.grupo_aulas_id)                 AS grupos_cubiertos,
  MIN(ae.fecha)                                     AS primer_dia,
  MAX(ae.fecha)                                     AS ultimo_dia
FROM asistencia_estudiantes ae
JOIN users u        ON u.id = ae.users_id
JOIN auxiliares aux ON aux.users_id = u.id
WHERE ae.fecha BETWEEN @inicio AND @fin
GROUP BY u.id, u.paterno, u.materno, u.name, u.dni
ORDER BY listas_tomadas DESC;
```
**Gráfica**: barras — auxiliar vs `listas_tomadas` (o `dias_con_asistencia`).

---

## 2. Puntualidad — hora de registro

A qué hora suele registrar la asistencia (temprano = mejor).

```sql
SET @inicio := '2026-03-23';
SELECT
  CONCAT_WS(' ', u.paterno, u.materno, u.name)      AS auxiliar,
  COUNT(*)                                          AS listas,
  SEC_TO_TIME(AVG(TIME_TO_SEC(TIME(ae.created_at)))) AS hora_promedio,
  SUM(HOUR(ae.created_at) < 12)                     AS en_manana,
  SUM(HOUR(ae.created_at) BETWEEN 12 AND 17)        AS en_tarde,
  SUM(HOUR(ae.created_at) >= 18)                    AS en_noche
FROM asistencia_estudiantes ae
JOIN users u        ON u.id = ae.users_id
JOIN auxiliares aux ON aux.users_id = u.id
WHERE ae.fecha >= @inicio
GROUP BY u.id, u.paterno, u.materno, u.name
ORDER BY hora_promedio;
```
**Gráfica**: barras apiladas — mañana / tarde / noche por auxiliar.

---

## 3. Volumen / actividad total (desde `audits`)

Todas las acciones del auxiliar en el sistema desde el inicio del ciclo.

```sql
SET @inicio := '2026-03-23';
SELECT
  CONCAT_WS(' ', u.paterno, u.materno, u.name)      AS auxiliar,
  COUNT(*)                                          AS total_acciones,
  SUM(a.event='created')                            AS registros,
  SUM(a.event='updated')                            AS ediciones,
  SUM(a.event='deleted')                            AS eliminaciones,
  COUNT(DISTINCT DATE(a.created_at))                AS dias_activos,
  MIN(a.created_at)                                 AS primera_accion,
  MAX(a.created_at)                                 AS ultima_accion
FROM audits a
JOIN users u        ON u.id = a.user_id
JOIN auxiliares aux ON aux.users_id = u.id
WHERE a.created_at >= @inicio
GROUP BY u.id, u.paterno, u.materno, u.name
ORDER BY total_acciones DESC;
```
**Gráfica**: barras apiladas — registros / ediciones / eliminaciones. (Muchas `ediciones` = posibles errores o correcciones frecuentes.)

---

## 4. Asistencia de docentes registrada por el auxiliar

Los auxiliares también registran la asistencia de docentes (`asistencia_docentes.users_id`).

```sql
SET @inicio := '2026-03-23';
SELECT
  CONCAT_WS(' ', u.paterno, u.materno, u.name)      AS auxiliar,
  COUNT(*)                                          AS asist_docentes_registradas,
  COUNT(DISTINCT ad.fecha)                          AS dias,
  COUNT(DISTINCT ad.docentes_id)                    AS docentes_distintos,
  SUM(ad.estado='2')                                AS marco_tardanza,
  SUM(ad.estado='3')                                AS marco_falta
FROM asistencia_docentes ad
JOIN users u        ON u.id = ad.users_id
JOIN auxiliares aux ON aux.users_id = u.id
WHERE ad.fecha >= @inicio
GROUP BY u.id, u.paterno, u.materno, u.name
ORDER BY asist_docentes_registradas DESC;
```
**Gráfica**: barras — asistencias de docentes registradas por auxiliar.

---

## 5. Gestión de estudiantes — habilitados y sincronizados

% de estudiantes de sus grupos que están habilitados / sincronizados.

```sql
SELECT
  CONCAT_WS(' ', u.paterno, u.materno, u.name)      AS auxiliar,
  COUNT(DISTINCT m.estudiantes_id)                  AS asignados,
  COUNT(DISTINCT CASE WHEN m.habilitado='1'        THEN m.estudiantes_id END) AS habilitados,
  COUNT(DISTINCT CASE WHEN m.habilitado_estado='1' THEN m.estudiantes_id END) AS sincronizados,
  ROUND(100*COUNT(DISTINCT CASE WHEN m.habilitado='1' THEN m.estudiantes_id END)
          / NULLIF(COUNT(DISTINCT m.estudiantes_id),0),1)                     AS pct_habilitados,
  ROUND(100*COUNT(DISTINCT CASE WHEN m.habilitado_estado='1' THEN m.estudiantes_id END)
          / NULLIF(COUNT(DISTINCT m.estudiantes_id),0),1)                     AS pct_sincronizados
FROM auxiliares aux
JOIN users u ON u.id = aux.users_id
JOIN auxiliar_grupos ag ON ag.auxiliares_id = aux.id
JOIN matriculas m ON m.grupo_aulas_id = ag.grupo_aulas_id
                  AND m.periodos_id = 1 AND m.estado = '0'
GROUP BY u.id, u.paterno, u.materno, u.name
ORDER BY pct_habilitados DESC;
```
**Gráfica**: barras — `pct_habilitados` y `pct_sincronizados` por auxiliar.

---

## 6. Modificaciones a estudiantes asignados  *(qué se cambió y cuándo)*

Rastrea en `audits` los cambios hechos a los estudiantes de cada auxiliar (solicitudes de modificación en el sistema).

### 6a. Resumen por auxiliar

```sql
SET @inicio := '2026-03-23';
SELECT
  CONCAT_WS(' ', ua.paterno, ua.materno, ua.name)   AS auxiliar,
  COUNT(*)                                          AS total_modificaciones,
  COUNT(DISTINCT e.id)                              AS estudiantes_modificados,
  COUNT(DISTINCT DATE(a.created_at))                AS dias_con_cambios,
  MIN(a.created_at)                                 AS primer_cambio,
  MAX(a.created_at)                                 AS ultimo_cambio
FROM auxiliares aux
JOIN users ua ON ua.id = aux.users_id
JOIN auxiliar_grupos ag ON ag.auxiliares_id = aux.id
JOIN matriculas m ON m.grupo_aulas_id = ag.grupo_aulas_id AND m.periodos_id=1 AND m.estado='0'
JOIN estudiantes e ON e.id = m.estudiantes_id
JOIN audits a ON a.auditable_type = 'App\\Models\\Estudiante'
             AND a.auditable_id = e.id
             AND a.event = 'updated'
             AND a.created_at >= @inicio
GROUP BY aux.id, ua.paterno, ua.materno, ua.name
ORDER BY total_modificaciones DESC;
```
**Gráfica**: barras — nº de modificaciones por auxiliar.

### 6b. Detalle — qué campo se modificó y en qué fecha

```sql
SET @inicio := '2026-03-23';
SELECT
  CONCAT_WS(' ', ua.paterno, ua.materno, ua.name)   AS auxiliar,
  e.nro_documento                                   AS dni_estudiante,
  CONCAT_WS(' ', e.paterno, e.materno, e.nombres)   AS estudiante,
  a.created_at                                      AS fecha_modificacion,
  a.old_values                                      AS antes,
  a.new_values                                      AS despues,
  a.user_id                                         AS modificado_por,
  a.ip_address
FROM auxiliares aux
JOIN users ua ON ua.id = aux.users_id
JOIN auxiliar_grupos ag ON ag.auxiliares_id = aux.id
JOIN matriculas m ON m.grupo_aulas_id = ag.grupo_aulas_id AND m.periodos_id=1 AND m.estado='0'
JOIN estudiantes e ON e.id = m.estudiantes_id
JOIN audits a ON a.auditable_type = 'App\\Models\\Estudiante'
             AND a.auditable_id = e.id
             AND a.event = 'updated'
             AND a.created_at >= @inicio
ORDER BY auxiliar, a.created_at;
```
Las columnas `antes` / `despues` (JSON) muestran **qué campo cambió** (ej. `{"celular":"999..."}` → `{"celular":"988..."}`).

> Para incluir también cambios de **inscripción** (modalidad, sede, turno) y **tarifas**, agrega al JOIN de `audits`:
> ```sql
> -- en vez de solo Estudiante, cruzar por estudiante en 3 modelos:
> --   'App\Models\Estudiante'      (auditable_id = e.id)
> --   'App\Models\Inscripciones'   (auditable_id IN sus inscripciones)
> --   'App\Models\TarifaEstudiante'(auditable_id IN sus tarifas)
> ```
> (te lo armo completo si lo necesitas).

---

## 7. Evolución semanal (tendencia del ciclo)

```sql
SET @inicio := '2026-03-23';
SELECT
  YEARWEEK(ae.fecha, 3)                             AS semana,
  MIN(ae.fecha)                                     AS inicio_semana,
  COUNT(DISTINCT ae.users_id)                       AS auxiliares_activos,
  COUNT(*)                                          AS listas_tomadas
FROM asistencia_estudiantes ae
WHERE ae.fecha >= @inicio
GROUP BY YEARWEEK(ae.fecha, 3)
ORDER BY semana;
```
**Gráfica**: línea — actividad por semana.

---

## Índice de eficiencia (opcional — combinar métricas)

Puedes construir un **score** por auxiliar combinando: cobertura (%), puntualidad, % habilitados, y penalizando ediciones/eliminaciones excesivas. Ejemplo simple ordenando por cobertura + gestión. Se arma en el backend a partir de las consultas 1, 2, 5.

---

## Gráficas sugeridas (resumen)

| Gráfica | Fuente |
|---|---|
| Ranking listas tomadas (barras H) | Consulta 1 |
| Puntualidad mañana/tarde/noche (barras apiladas) | Consulta 2 |
| Actividad: registros/ediciones/eliminaciones (apiladas) | Consulta 3 |
| Asistencias de docentes registradas (barras) | Consulta 4 |
| % habilitados / sincronizados (barras) | Consulta 5 |
| Modificaciones a estudiantes (barras) | Consulta 6a |
| Evolución semanal (línea) | Consulta 7 |
| KPIs globales (tarjetas/dona) | agregados de 1, 3, 5 |

## Notas

- `auditable_type` en `audits` usa doble backslash en SQL: `'App\\Models\\Estudiante'`.
- Todas las consultas devuelven **una fila por auxiliar** → JSON directo para las gráficas.
- Ajusta `@inicio` si el ciclo cambia; `m.estado='0'` es el filtro de matrícula que trae todas en producción.
- Un grupo con 2 auxiliares cuenta al estudiante/lista para ambos (correcto para medir gestión individual).
