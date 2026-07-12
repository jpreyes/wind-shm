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

-- ── 1b · MULTITENANCY (id de tenant; HOY un solo tenant «default») ───────────
-- Andamiaje para separar por organización/cliente aunque no se use todavía: cada
-- fila cuelga de un `tenant_id`; el tenant «default» cubre todo lo actual. Para
-- activar el AISLAMIENTO por tenant, ver el bloque comentado en la sección RLS.
create extension if not exists pgcrypto;   -- gen_random_uuid()

create table if not exists tenants (
  id   uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text,
  created_at timestamptz default now()
);
insert into tenants (slug, name) values ('default', 'ReWind (default)')
on conflict (slug) do nothing;

create or replace function default_tenant() returns uuid language sql stable as $$
  select id from tenants where slug = 'default' limit 1;
$$;

-- `tenant_id` en cada tabla de dominio (default = tenant «default»); backfill de
-- las filas viejas + índice por tenant.
do $$
declare tbl text;
begin
  foreach tbl in array array['structures','features','waves','protocolos','ciclos',
                             'ensayos','wbs_config','import_profiles','inspections','members']
  loop
    execute format('alter table %I add column if not exists tenant_id uuid default default_tenant() references tenants(id);', tbl);
    execute format('update %I set tenant_id = default_tenant() where tenant_id is null;', tbl);
    execute format('create index if not exists %I on %I (tenant_id);', tbl || '_tenant', tbl);
  end loop;
end $$;

-- Tenant del usuario (de su fila en members; default si no tiene).
create or replace function tenant_of(uid uuid) returns uuid language sql stable as $$
  select coalesce((select tenant_id from members where user_id = uid), default_tenant());
$$;

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
-- (El CHECK de members.role lo maneja la sección 5, tras migrar los roles viejos.)

-- ── 4 · Índices ──────────────────────────────────────────────────────────────
create index if not exists features_struct_ts on features (structure_id, ts desc);
create index if not exists features_ts on features (ts desc);
create index if not exists waves_struct_ts on waves (structure_id, ts desc);
create index if not exists protocolos_struct on protocolos (structure_id);
create index if not exists ciclos_proto on ciclos (protocolo_id);
create index if not exists inspections_struct on inspections (structure_id, date desc);

-- ── 5 · ROLES (7, con segregación de funciones) ──────────────────────────────
-- admin · gestor · calidad_inspector · calidad_aprobador · inspector · operador ·
-- visualizador.  (ISO/IEC 27001 A.5.15/A.5.3 · ISO 9001 §8.6 · IEC 61400-28.)
-- Migra los roles viejos (viewer/editor) al vocabulario nuevo y fija el CHECK.
update members set role = 'visualizador' where role in ('viewer', 'lectura');
update members set role = 'gestor'       where role = 'editor';
alter table members drop constraint if exists members_role_check;
alter table members add constraint members_role_check check (role in
  ('admin','gestor','calidad_inspector','calidad_aprobador','inspector','operador','visualizador'));

create or replace function role_of(uid uuid) returns text language sql stable as $$
  select coalesce((select role from members where user_id = uid), 'visualizador');
$$;
create or replace function my_role() returns text language sql stable as $$ select role_of(auth.uid()); $$;
create or replace function is_admin()            returns boolean language sql stable as $$ select my_role() = 'admin'; $$;
create or replace function can_gestion()         returns boolean language sql stable as $$ select my_role() in ('admin','gestor'); $$;
create or replace function can_quality_edit()    returns boolean language sql stable as $$ select my_role() in ('admin','calidad_inspector','calidad_aprobador'); $$;
create or replace function can_quality_approve() returns boolean language sql stable as $$ select my_role() in ('admin','calidad_aprobador'); $$;
create or replace function can_inspect()         returns boolean language sql stable as $$ select my_role() in ('admin','inspector'); $$;
create or replace function can_operate()         returns boolean language sql stable as $$ select my_role() in ('admin','operador'); $$;
create or replace function is_editor()           returns boolean language sql stable as $$ select my_role() <> 'visualizador'; $$;  -- legacy: cualquier rol que escribe

-- ── 5b · AUDITORÍA: quién creó/actualizó cada fila (ISO 27001 A.8.15) ─────────
-- Columnas actor + trigger que las llena solas con auth.uid() (el front no las manda).
-- Las tablas ya traen su timestamp. Para historial inmutable completo → audit_log (futuro).
do $$
declare tbl text;
begin
  foreach tbl in array array['structures','protocolos','ciclos','ensayos',
                             'wbs_config','import_profiles','inspections','members'] loop
    execute format('alter table %I add column if not exists created_by uuid;', tbl);
    execute format('alter table %I add column if not exists updated_by uuid;', tbl);
  end loop;
end $$;
create or replace function set_audit() returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  new.updated_by := auth.uid();
  return new;
end $$;
do $$
declare tbl text;
begin
  foreach tbl in array array['structures','protocolos','ciclos','ensayos',
                             'wbs_config','import_profiles','inspections','members'] loop
    execute format('drop trigger if exists trg_audit on %I;', tbl);
    execute format('create trigger trg_audit before insert or update on %I for each row execute function set_audit();', tbl);
  end loop;
end $$;

-- ── 5c · MAKER-CHECKER: solo calidad_aprobador/admin APRUEBA (SoD ISO 9001 §8.6)
-- Bloquea que quien llena el protocolo se lo auto-apruebe.
create or replace function guard_quality_approval() returns trigger language plpgsql as $$
begin
  if new.estado = 'aprobado' and (tg_op = 'INSERT' or old.estado is distinct from 'aprobado')
     and not can_quality_approve() then
    raise exception 'Segregación de funciones: solo calidad_aprobador/admin puede aprobar.';
  end if;
  return new;
end $$;
drop trigger if exists trg_approve_protocolos on protocolos;
create trigger trg_approve_protocolos before insert or update on protocolos for each row execute function guard_quality_approval();
drop trigger if exists trg_approve_ensayos on ensayos;
create trigger trg_approve_ensayos before insert or update on ensayos for each row execute function guard_quality_approval();

-- ── 6 · RLS: candado duro + MATRIZ de permisos por rol (mínimo privilegio) ────
-- Lectura = cualquier autenticado. Escritura = por dominio. Limpia el piloto (anon).
-- El ingestor de telemetría (sensor) usa service_role → bypassa RLS.
do $$
declare tbl text; pol text;
begin
  foreach tbl in array array['structures','features','waves','protocolos','ciclos',
                             'ensayos','wbs_config','import_profiles','inspections','members'] loop
    execute format('alter table %I enable row level security;', tbl);
    foreach pol in array array['pilot_read','pilot_write','read_auth','write_editor',
                               'write_gestion','write_quality','write_inspect','write_admin'] loop
      execute format('drop policy if exists %I on %I;', pol, tbl);
    end loop;
    execute format('create policy read_auth on %I for select to authenticated using (true);', tbl);
  end loop;
end $$;
-- Escritura por dominio:
create policy write_gestion on structures     for all to authenticated using (can_gestion())      with check (can_gestion());
create policy write_gestion on wbs_config      for all to authenticated using (can_gestion())      with check (can_gestion());
create policy write_quality on protocolos      for all to authenticated using (can_quality_edit()) with check (can_quality_edit());
create policy write_quality on ciclos          for all to authenticated using (can_quality_edit()) with check (can_quality_edit());
create policy write_quality on ensayos         for all to authenticated using (can_quality_edit()) with check (can_quality_edit());
create policy write_quality on import_profiles for all to authenticated using (can_quality_edit() or can_gestion()) with check (can_quality_edit() or can_gestion());
create policy write_inspect on inspections     for all to authenticated using (can_inspect())      with check (can_inspect());
create policy write_admin   on members         for all to authenticated using (is_admin())         with check (is_admin());
-- features/waves: desde el navegador solo admin (el sensor real escribe con service_role).
create policy write_admin   on features        for all to authenticated using (is_admin())         with check (is_admin());
create policy write_admin   on waves           for all to authenticated using (is_admin())         with check (is_admin());

-- ▸ MULTITENANT (cuando se use): sumar a cada policy el filtro por tenant, p.ej.
--   using (tenant_id = tenant_of(auth.uid())) with check (tenant_id = tenant_of(auth.uid()) and can_...()).
--   Hoy deshabilitado (un solo tenant «default»).

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
