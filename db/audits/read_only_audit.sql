-- PostgreSQL catalog-only audit. No customer rows, DDL, or writes.
-- Run through scripts/audit-postgres.ps1 with a read-only database role.
SELECT current_database() AS database_name, current_user AS database_role,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('server_version') AS server_version;
SELECT version, filename, applied_at FROM public.schema_migrations ORDER BY version;
SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       COUNT(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid=c.oid
WHERE n.nspname='public' AND c.relkind IN ('r','p')
GROUP BY n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity
ORDER BY c.relname;
SELECT n.nspname AS schema_name,c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS table_owner
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
ORDER BY c.relname;
