-- ═════════════════════════════════════════════════════════════════════════════
-- ReWind · Frente 4 — ingesta del sensor (Supabase). IDEMPOTENTE y MIGRATORIO.
--
-- Complementa schema.sql (que ya define `features` y `waves`). Agrega:
--   · el bucket de Storage `waves` (ventanas crudas)
--   · la tabla `sensor_commands` (on-demand por *command-polling*, sin puertos)
-- Se puede correr varias veces / sobre una base que ya tenía algo. Correr DESPUÉS
-- de schema.sql. El sensor escribe con la SERVICE_ROLE key (bypassa RLS).
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Bucket de ventanas crudas (privado) ──────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('waves', 'waves', false)
on conflict (id) do update set public = false;

-- Acceso al bucket: lectura para autenticados; escritura solo service_role (sensor).
drop policy if exists waves_read on storage.objects;
create policy waves_read on storage.objects
  for select to authenticated using (bucket_id = 'waves');

-- ── On-demand: comandos que el sensor sondea (pull, no webhook) ───────────────
create table if not exists sensor_commands (
  id            bigint generated always as identity primary key,
  structure_id  text not null,
  kind          text not null default 'window',
  status        text not null default 'pending',
  params        jsonb default '{}'::jsonb,
  wave_id       bigint,
  note          text,
  created_at    timestamptz default now(),
  done_at       timestamptz
);
-- Migración: agrega columnas que falten si la tabla ya existía de una corrida previa.
alter table sensor_commands add column if not exists kind       text not null default 'window';
alter table sensor_commands add column if not exists status     text not null default 'pending';
alter table sensor_commands add column if not exists params     jsonb default '{}'::jsonb;
alter table sensor_commands add column if not exists wave_id    bigint;
alter table sensor_commands add column if not exists note       text;
alter table sensor_commands add column if not exists created_at timestamptz default now();
alter table sensor_commands add column if not exists done_at    timestamptz;
-- Multitenancy (default_tenant() lo define schema.sql, que corre antes).
alter table sensor_commands add column if not exists tenant_id  uuid default default_tenant() references tenants(id);
update sensor_commands set tenant_id = default_tenant() where tenant_id is null;
create index if not exists sensor_cmd_pending on sensor_commands (structure_id, status, created_at);
create index if not exists sensor_cmd_tenant on sensor_commands (tenant_id);

-- ── RLS: autenticados crean/leen comandos; el sensor usa service_role ─────────
-- (limpia también políticas del piloto por si `rls_pilot` las hubiera dejado).
alter table sensor_commands enable row level security;
drop policy if exists pilot_read   on sensor_commands;
drop policy if exists pilot_write  on sensor_commands;
drop policy if exists read_auth    on sensor_commands;
drop policy if exists write_editor on sensor_commands;
create policy read_auth    on sensor_commands for select to authenticated using (true);
create policy write_editor on sensor_commands for all    to authenticated using (true) with check (true);

-- Realtime opcional para el sensor (en vez de sondear). Guardado para no duplicar:
-- do $$ begin if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
--   and schemaname='public' and tablename='sensor_commands') then
--   alter publication supabase_realtime add table sensor_commands; end if; end $$;

-- Retención de ventanas crudas: borrar objetos/punteros > 90 días (cron/pg_cron):
--   delete from waves where ts < now() - interval '90 days';
