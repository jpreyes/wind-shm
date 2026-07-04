-- ═════════════════════════════════════════════════════════════════════════════
-- ReWind · RLS de PILOTO (sin login) — abrir acceso al rol `anon`
--
-- ⚠ SOLO PARA EL PILOTO / PRUEBAS. Con esto, cualquiera que tenga la anon key
-- (que es pública, va en el navegador) puede LEER y ESCRIBIR estas tablas. Para
-- producción: quitar estas políticas y usar login (Supabase Auth) → las políticas
-- `to authenticated` de schema.sql + `members(role)` gobiernan el acceso.
--
-- Correr DESPUÉS de schema.sql. Reemplaza las políticas por unas que incluyen anon.
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare tbl text;
begin
  foreach tbl in array array['structures','features','waves','protocolos','ciclos',
                             'ensayos','wbs_config','import_profiles','inspections']
  loop
    -- Lectura y escritura para anon + authenticated (piloto).
    execute format('drop policy if exists read_auth on %I;', tbl);
    execute format('drop policy if exists write_editor on %I;', tbl);
    execute format('drop policy if exists pilot_read on %I;', tbl);
    execute format('drop policy if exists pilot_write on %I;', tbl);
    execute format('create policy pilot_read  on %I for select to anon, authenticated using (true);', tbl);
    execute format('create policy pilot_write on %I for all    to anon, authenticated using (true) with check (true);', tbl);
  end loop;
end $$;

-- Para VOLVER a cerrar (producción con login): correr de nuevo el bloque de RLS
-- de schema.sql (las políticas read_auth/write_editor), que sustituyen a estas.
