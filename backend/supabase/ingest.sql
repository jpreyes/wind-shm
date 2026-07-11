-- ═════════════════════════════════════════════════════════════════════════════
-- ReWind · Frente 4 — ingesta del sensor (Supabase)
--
-- Complementa schema.sql (que YA define `features` y `waves`). Agrega:
--   · el bucket de Storage `waves` (ventanas crudas)
--   · la tabla `sensor_commands` (on-demand por *command-polling*, sin puertos)
-- Correr DESPUÉS de schema.sql. El sensor escribe con la SERVICE_ROLE key
-- (bypassa RLS); el front usa anon/publishable + sesión.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Bucket de ventanas crudas (privado) ──────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('waves', 'waves', false)
on conflict (id) do nothing;

-- Acceso al bucket: lectura para autenticados; escritura solo service_role (el
-- sensor). (Si preferís, hacelo desde el dashboard → Storage → Policies.)
drop policy if exists waves_read on storage.objects;
create policy waves_read on storage.objects
  for select to authenticated using (bucket_id = 'waves');

-- ── On-demand: comandos que el sensor sondea (pull, no webhook) ───────────────
create table if not exists sensor_commands (
  id            bigint generated always as identity primary key,
  structure_id  text not null,
  kind          text not null default 'window',   -- window | reboot | set_fs | ...
  status        text not null default 'pending',  -- pending | done | error
  params        jsonb default '{}'::jsonb,
  wave_id       bigint,                            -- ventana producida (si aplica)
  note          text,
  created_at    timestamptz default now(),
  done_at       timestamptz
);
create index if not exists sensor_cmd_pending on sensor_commands (structure_id, status, created_at);

-- ── RLS: el front autenticado crea/lee comandos; el sensor usa service_role ───
do $$
declare tbl text;
begin
  foreach tbl in array array['sensor_commands']
  loop
    execute format('alter table %I enable row level security;', tbl);
    execute format('drop policy if exists read_auth on %I;', tbl);
    execute format('create policy read_auth on %I for select to authenticated using (true);', tbl);
    execute format('drop policy if exists write_editor on %I;', tbl);
    -- crear una petición «pending» requiere estar autenticado (editor/admin si
    -- is_editor() existe; si corrés el piloto anon, usá rls_pilot.sql).
    execute format('create policy write_editor on %I for all to authenticated using (true) with check (true);', tbl);
  end loop;
end $$;

-- Realtime opcional: el sensor podría suscribirse en vez de sondear (menos latencia).
-- alter publication supabase_realtime add table sensor_commands;

-- Retención de ventanas crudas: borrar objetos/punteros > 90 días. Programar como
-- cron (pg_cron) o Edge Function. Ejemplo del puntero (el objeto se borra aparte):
--   delete from waves where ts < now() - interval '90 days';
