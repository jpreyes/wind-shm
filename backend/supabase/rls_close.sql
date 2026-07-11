-- ═════════════════════════════════════════════════════════════════════════════
-- ReWind · CERRAR RLS (producción con login) — revertir el piloto
--
-- Correr DESPUÉS de tener login (Supabase Auth) funcionando. Quita las políticas
-- abiertas a `anon` que dejó rls_pilot.sql y restaura las de schema.sql:
--   · lectura  → cualquier usuario AUTENTICADO
--   · escritura → solo rol 'editor' o 'admin' (tabla members)
-- Sin sesión (anon key sola) ya NO se puede leer ni escribir → 401.
--
-- Recordá: desactivá el signup público en Supabase (Auth → Providers → Email →
-- "Allow new users to sign up" OFF) y creá los usuarios a mano (Auth → Users →
-- Add user), asignándoles su fila en `members(user_id, role)`.
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare tbl text;
begin
  foreach tbl in array array['structures','features','waves','protocolos','ciclos',
                             'ensayos','wbs_config','import_profiles','inspections','members']
  loop
    execute format('alter table %I enable row level security;', tbl);
    -- Quitar las políticas del piloto (anon).
    execute format('drop policy if exists pilot_read  on %I;', tbl);
    execute format('drop policy if exists pilot_write on %I;', tbl);
    -- Restaurar las de producción (solo authenticated / editor).
    execute format('drop policy if exists read_auth on %I;', tbl);
    execute format('create policy read_auth on %I for select to authenticated using (true);', tbl);
    execute format('drop policy if exists write_editor on %I;', tbl);
    execute format('create policy write_editor on %I for all to authenticated using (is_editor()) with check (is_editor());', tbl);
  end loop;
end $$;

-- El ingestor de telemetría (Pi / Edge Function / sim) escribe `features` con la
-- service_role key (bypassa RLS) o con un usuario 'editor' dedicado. El front usa
-- la anon/publishable key + la sesión del usuario logueado.

-- Ejemplo: dar rol admin al primer usuario (reemplazá el email):
--   insert into members (user_id, role)
--   select id, 'admin' from auth.users where email = 'jpreyes.c@gmail.com'
--   on conflict (user_id) do update set role = excluded.role;
