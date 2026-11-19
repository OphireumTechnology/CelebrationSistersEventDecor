\set ON_ERROR_STOP on
\pset pager off
SELECT current_database() database_name,current_user connected_role,current_setting('transaction_read_only') transaction_read_only;
SELECT to_regclass('public.schema_migrations') migration_ledger;
SELECT c.relname table_name,c.relrowsecurity rls_enabled,c.relforcerowsecurity rls_forced,count(p.oid) policy_count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_policy p ON p.polrelid=c.oid WHERE n.nspname='public' AND c.relkind IN ('r','p') GROUP BY c.oid ORDER BY c.relname;
SELECT schemaname,tablename,policyname,permissive,roles,cmd FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname;
SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolcanlogin ORDER BY rolname;
SELECT c.relname table_name,has_table_privilege('public',c.oid,'SELECT') public_select,has_table_privilege('public',c.oid,'INSERT') public_insert,has_table_privilege('public',c.oid,'UPDATE') public_update,has_table_privilege('public',c.oid,'DELETE') public_delete FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname;
