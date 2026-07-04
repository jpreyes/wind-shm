-- ═════════════════════════════════════════════════════════════════════════════
-- ReWind · Backend Supabase — esquema Sprint 0 (telemetría + calidad + auth)
--
-- Pegar en el SQL Editor de Supabase (o `supabase db push`). Es idempotente en lo
-- posible (IF NOT EXISTS). Cubre las tres áreas pedidas:
--   1) Telemetría SHM   → structures, features (serie 1/min), waves (ventanas)
--   2) Calidad de obra  → protocolos, ciclos, ensayos, wbs, import_profiles
--   3) CMMS             → inspections
--   4) Auth / roles     → members (viewer/editor/admin) sobre auth.users + RLS
--
-- Supabase = PostgreSQL. No hay InfluxDB: la serie temporal va en `features`
-- (indexada por structure_id, ts). Las ventanas crudas del ADXL355 NO van en la
-- BD — van a Storage (bucket `waves`); `waves` guarda sólo el puntero + metadatos.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1 · TELEMETRÍA ───────────────────────────────────────────────────────────
create table if not exists structures (
  id          text primary key,              -- 'T01', 'AT-03', …
  park        text,
  zone        text,
  type        text check (type in ('turbine','hv')) default 'turbine',
  label       text,
  lat         double precision,
  lon         double precision,
  height      real,
  built       real,                            -- avance 4D [0..1]
  meta        jsonb default '{}'::jsonb,
  updated_at  timestamptz default now()
);

-- Serie de features (1 punto/min por estructura). El ingestor (Pi/EdgeFn/sim)
-- inserta filas; el front las lee por Realtime o polling.
create table if not exists features (
  id            bigint generated always as identity primary key,
  structure_id  text not null references structures(id) on delete cascade,
  ts            timestamptz not null default now(),
  f1            real,        -- 1ª frecuencia natural (Hz)
  f2            real,
  rms           real,        -- RMS de aceleración (g)
  wind          real,        -- viento (m/s)
  temp          real,        -- temperatura (°C)
  tilt          real,        -- inclinación (°)
  cls           smallint,    -- clase ML de daño (0..4)
  extra         jsonb default '{}'::jsonb
);
create index if not exists features_struct_ts on features (structure_id, ts desc);
create index if not exists features_ts on features (ts desc);

-- Punteros a ventanas crudas archivadas (10/30 min) en Storage → OMA (R-21).
create table if not exists waves (
  id            bigint generated always as identity primary key,
  structure_id  text not null references structures(id) on delete cascade,
  sensor        text,
  ts            timestamptz not null default now(),
  fs            integer,          -- frecuencia de muestreo (Hz)
  n             integer,          -- nº de muestras
  storage_path  text not null,    -- objeto en el bucket `waves`
  meta          jsonb default '{}'::jsonb
);
create index if not exists waves_struct_ts on waves (structure_id, ts desc);

-- ── 2 · CALIDAD DE OBRA ──────────────────────────────────────────────────────
create table if not exists protocolos (
  id            text primary key,              -- id canónico del modelo ReWind
  structure_id  text references structures(id) on delete set null,
  item          integer,
  codigo        text,
  area          text,
  elemento      text,
  hito_pago     text,
  especialidad  text,
  descripcion   text,
  documento     text,
  estado        text,                          -- canónico: aprobado/conComentarios/…
  estado_raw    text,
  partida_id    text,                          -- override manual protocolo→partida (WBS)
  meta          jsonb default '{}'::jsonb,
  updated_at    timestamptz default now()
);
create index if not exists protocolos_struct on protocolos (structure_id);

create table if not exists ciclos (
  id            bigint generated always as identity primary key,
  protocolo_id  text not null references protocolos(id) on delete cascade,
  n             integer,
  estado        text,
  estado_raw    text,
  fecha_envio   date,
  fecha_retorno date,
  dias_habiles  integer,
  comentarios   text
);
create index if not exists ciclos_proto on ciclos (protocolo_id);

create table if not exists ensayos (
  id            text primary key,
  structure_id  text references structures(id) on delete set null,
  tipo          text,
  grado         text,
  norma         text,                          -- NCh/ASTM/EN (catálogo normativo)
  fecha         date,
  estado        text,
  meta          jsonb default '{}'::jsonb
);

-- WBS (partidas/hitos) por parque+tipo y perfiles de importación: config JSON.
create table if not exists wbs_config (
  id          bigint generated always as identity primary key,
  park        text,
  type        text,
  partidas    jsonb not null default '[]'::jsonb,
  overrides   jsonb not null default '{}'::jsonb,
  updated_at  timestamptz default now(),
  unique (park, type)
);

create table if not exists import_profiles (
  id          bigint generated always as identity primary key,
  name        text not null,
  config      jsonb not null,
  owner       uuid references auth.users(id) on delete set null,
  created_at  timestamptz default now()
);

-- ── 3 · CMMS (inspecciones) ──────────────────────────────────────────────────
create table if not exists inspections (
  id            text primary key,
  structure_id  text not null references structures(id) on delete cascade,
  inspector     text,
  date          date,
  score         real,
  damages       jsonb default '[]'::jsonb,     -- hallazgos (con refs a fotos en Storage)
  meta          jsonb default '{}'::jsonb,
  created_at    timestamptz default now()
);
create index if not exists inspections_struct on inspections (structure_id, date desc);

-- ── 4 · AUTH / ROLES ─────────────────────────────────────────────────────────
-- Roles sobre auth.users. viewer = solo lectura; editor = CMMS/calidad; admin = todo.
create table if not exists members (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('viewer','editor','admin')) default 'viewer',
  created_at  timestamptz default now()
);

create or replace function role_of(uid uuid) returns text language sql stable as $$
  select coalesce((select role from members where user_id = uid), 'viewer');
$$;
create or replace function is_editor() returns boolean language sql stable as $$
  select role_of(auth.uid()) in ('editor','admin');
$$;

-- ── RLS: lectura para autenticados; escritura para editor/admin ──────────────
do $$
declare tbl text;
begin
  foreach tbl in array array['structures','features','waves','protocolos','ciclos',
                             'ensayos','wbs_config','import_profiles','inspections','members']
  loop
    execute format('alter table %I enable row level security;', tbl);
    execute format('drop policy if exists read_auth on %I;', tbl);
    execute format('create policy read_auth on %I for select to authenticated using (true);', tbl);
    execute format('drop policy if exists write_editor on %I;', tbl);
    execute format('create policy write_editor on %I for all to authenticated using (is_editor()) with check (is_editor());', tbl);
  end loop;
end $$;

-- Realtime: publicar `features` (el front se suscribe a los INSERT).
alter publication supabase_realtime add table features;

-- Nota: el ingestor (Pi/EdgeFn/sim) inserta con la service_role key (bypassa RLS)
-- o con un usuario 'editor'. El front usa la anon key + sesión de usuario.
