-- ═════════════════════════════════════════════════════════════════════════════
-- ReWind · Backend Supabase — esquema (telemetría + calidad + CMMS + auth)
--
-- IDEMPOTENTE y MIGRATORIO: se puede correr sobre una base NUEVA o sobre una que
-- ya tenía un esquema viejo (o `rls_pilot`). Crea lo que falte, agrega columnas
-- nuevas a tablas existentes, relaja constraints obsoletas y limpia las políticas
-- del piloto (anon) para dejar el CANDADO DURO (solo autenticados). No borra datos.
--
--   1) Telemetría SHM   → structures, features (serie 1/min), waves (ventanas)
--   2) Calidad de obra  → protocolos, ciclos, ensayos, wbs_config, import_profiles
--   3) CMMS             → inspections
--   4) Auth / roles     → members (viewer/editor/admin) + RLS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1 · TABLAS (crea si faltan) ──────────────────────────────────────────────
create table if not exists structures (
  id          text primary key,
  park        text, zone text, type text default 'turbine', label text,
  lat double precision, lon double precision, height real, built real,
  meta jsonb default '{}'::jsonb, updated_at timestamptz default now()
);
create table if not exists features (
  id            bigint generated always as identity primary key,
  structure_id  text not null, ts timestamptz not null default now(),
  f1 real, f2 real, rms real, wind real, temp real, tilt real, cls smallint,
  extra jsonb default '{}'::jsonb
);
create table if not exists waves (
  id            bigint generated always as identity primary key,
  structure_id  text not null, sensor text, ts timestamptz not null default now(),
  fs integer, n integer, storage_path text, meta jsonb default '{}'::jsonb
);
create table if not exists protocolos (
  id            text primary key, structure_id text, item integer, codigo text,
  area text, elemento text, hito_pago text, especialidad text, descripcion text,
  documento text, estado text, estado_raw text, partida_id text,
  meta jsonb default '{}'::jsonb, updated_at timestamptz default now()
);
create table if not exists ciclos (
  id            bigint generated always as identity primary key,
  protocolo_id  text not null references protocolos(id) on delete cascade,
  n integer, estado text, estado_raw text, fecha_envio date, fecha_retorno date,
  dias_habiles integer, comentarios text
);
create table if not exists ensayos (
  id text primary key, structure_id text, tipo text, grado text, norma text,
  fecha date, estado text, meta jsonb default '{}'::jsonb
);
create table if not exists wbs_config (
  id bigint generated always as identity primary key, park text, type text,
  partidas jsonb not null default '[]'::jsonb, overrides jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(), unique (park, type)
);
create table if not exists import_profiles (
  id bigint generated always as identity primary key, name text not null,
  config jsonb not null, owner uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
create table if not exists inspections (
  id text primary key, structure_id text not null, inspector text, date date,
  score real, damages jsonb default '[]'::jsonb, meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create table if not exists members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'viewer', created_at timestamptz default now()
);

-- ── 2 · MIGRACIÓN: agrega columnas que falten en tablas ya existentes ────────
alter table structures     add column if not exists park text;
alter table structures     add column if not exists zone text;
alter table structures     add column if not exists type text default 'turbine';
alter table structures     add column if not exists label text;
alter table structures     add column if not exists lat double precision;
alter table structures     add column if not exists lon double precision;
alter table structures     add column if not exists height real;
alter table structures     add column if not exists built real;
alter table structures     add column if not exists meta jsonb default '{}'::jsonb;
alter table structures     add column if not exists updated_at timestamptz default now();
alter table features       add column if not exists f1 real;
alter table features       add column if not exists f2 real;
alter table features       add column if not exists rms real;
alter table features       add column if not exists wind real;
alter table features       add column if not exists temp real;
alter table features       add column if not exists tilt real;
alter table features       add column if not exists cls smallint;
alter table features       add column if not exists extra jsonb default '{}'::jsonb;
alter table waves          add column if not exists sensor text;
alter table waves          add column if not exists fs integer;
alter table waves          add column if not exists n integer;
alter table waves          add column if not exists storage_path text;
alter table waves          add column if not exists meta jsonb default '{}'::jsonb;
alter table protocolos     add column if not exists partida_id text;
alter table protocolos     add column if not exists estado_raw text;
alter table protocolos     add column if not exists meta jsonb default '{}'::jsonb;
alter table protocolos     add column if not exists updated_at timestamptz default now();
alter table ensayos        add column if not exists norma text;
alter table ensayos        add column if not exists meta jsonb default '{}'::jsonb;
alter table inspections    add column if not exists damages jsonb default '[]'::jsonb;
alter table inspections    add column if not exists meta jsonb default '{}'::jsonb;

-- ── 3 · RELAJAR constraints obsoletas ────────────────────────────────────────
-- `structures.type` ya NO se limita a turbine/hv (Fase 3: camino, zanja, plataforma…).
alter table structures  drop constraint if exists structures_type_check;
-- FK de inspecciones a structures relajada (un Excel/insp. puede citar ids no sembrados).
alter table inspections drop constraint if exists inspections_structure_id_fkey;
-- El rol de members se valida en la app; sin CHECK rígido para no romper migraciones.
alter table members     drop constraint if exists members_role_check;

-- ── 4 · Índices ──────────────────────────────────────────────────────────────
create index if not exists features_struct_ts on features (structure_id, ts desc);
create index if not exists features_ts on features (ts desc);
create index if not exists waves_struct_ts on waves (structure_id, ts desc);
create index if not exists protocolos_struct on protocolos (structure_id);
create index if not exists ciclos_proto on ciclos (protocolo_id);
create index if not exists inspections_struct on inspections (structure_id, date desc);

-- ── 5 · Funciones de rol ─────────────────────────────────────────────────────
create or replace function role_of(uid uuid) returns text language sql stable as $$
  select coalesce((select role from members where user_id = uid), 'viewer');
$$;
create or replace function is_editor() returns boolean language sql stable as $$
  select role_of(auth.uid()) in ('editor','admin');
$$;

-- ── 6 · RLS: CANDADO DURO (solo autenticados) + limpieza del piloto ──────────
-- Lectura = cualquier autenticado; escritura = editor/admin. Se BORRAN las
-- políticas abiertas del piloto (pilot_read/pilot_write de rls_pilot.sql) para
-- que anon NO pueda leer/escribir. El ingestor usa service_role (bypassa RLS).
do $$
declare tbl text;
begin
  foreach tbl in array array['structures','features','waves','protocolos','ciclos',
                             'ensayos','wbs_config','import_profiles','inspections','members']
  loop
    execute format('alter table %I enable row level security;', tbl);
    execute format('drop policy if exists pilot_read  on %I;', tbl);   -- limpia el piloto (anon)
    execute format('drop policy if exists pilot_write on %I;', tbl);
    execute format('drop policy if exists read_auth on %I;', tbl);
    execute format('create policy read_auth on %I for select to authenticated using (true);', tbl);
    execute format('drop policy if exists write_editor on %I;', tbl);
    execute format('create policy write_editor on %I for all to authenticated using (is_editor()) with check (is_editor());', tbl);
  end loop;
end $$;

-- ── 7 · Realtime: publicar `features` (guardado para no duplicar) ────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'features') then
    alter publication supabase_realtime add table features;
  end if;
end $$;

-- Listo. Siguiente: correr `ingest.sql` (bucket waves + sensor_commands), crear tu
-- usuario (Auth → Users) y darte rol admin en `members`.
