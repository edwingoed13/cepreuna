-- =============================================================================
-- Tabla de calificaciones de auxiliares en SUPABASE (Postgres)
-- =============================================================================
-- Ejecutar en Supabase → SQL Editor (una sola vez).
-- El backend escribe/lee con la clave service_role (solo servidor); RLS queda
-- habilitado sin políticas para bloquear todo acceso anónimo/directo.
-- Los nombres van desnormalizados (auxiliar_nombre, coordinador_nombre) para no
-- cruzar bases al leer: los ids siguen siendo los users.id del MySQL del sistema.

create table if not exists auxiliar_calificaciones (
  id bigint generated always as identity primary key,
  coordinador_users_id bigint not null,
  coordinador_nombre text,
  auxiliar_users_id bigint not null,
  auxiliar_nombre text,
  fecha date not null,
  pregunta_1 smallint not null check (pregunta_1 between 1 and 5),
  pregunta_2 smallint not null check (pregunta_2 between 1 and 5),
  pregunta_3 smallint not null check (pregunta_3 between 1 and 5),
  pregunta_4 smallint not null check (pregunta_4 between 1 and 5),
  pregunta_5 smallint not null check (pregunta_5 between 1 and 5),
  pregunta_6 smallint not null check (pregunta_6 between 1 and 5),
  promedio numeric(4,2) not null,
  observacion text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (coordinador_users_id, auxiliar_users_id, fecha)
);

create index if not exists idx_aux_calif_auxiliar on auxiliar_calificaciones (auxiliar_users_id);
create index if not exists idx_aux_calif_fecha on auxiliar_calificaciones (fecha);

-- Bloquear acceso directo (solo el backend con service_role puede operar).
alter table auxiliar_calificaciones enable row level security;
