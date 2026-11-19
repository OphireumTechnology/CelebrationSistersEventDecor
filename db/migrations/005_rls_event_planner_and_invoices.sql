-- Celebration Sisters Event Decor — RLS Alignment, Missing Financial Policies & View Security Migration
-- Version: 005
-- Target: PostgreSQL 15+ / Supabase
-- Strictly additive & idempotent. Resolves RLS gaps identified during Phase 11 database audit:
--   1. Resolves app_current_user_id() cleanly from either SET LOCAL app.current_user_id or Supabase auth.uid() via users.supabase_user_id.
--   2. Grants operational RLS coverage to the 'event_planner' role introduced in migration 003.
--   3. Adds missing RLS policies on quote_items, invoices, and booking_idempotency_keys.
--   4. Hardens v_vendor_booking_briefs with security_invoker = true (prevents SECURITY DEFINER RLS bypass).
--   5. Creates schema_migrations ledger to track applied SQL migration versions safely.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. Map Supabase auth.uid() (when present) to internal users.id via immutable supabase_user_id binding
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS UUID AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_user_id', true), '')::UUID,
    (
      SELECT u.id
      FROM users u
      WHERE app_resolve_provider_uid() IS NOT NULL
        AND u.supabase_user_id = app_resolve_provider_uid()
      LIMIT 1
    ),
    app_resolve_provider_uid()
  );
$$ LANGUAGE SQL STABLE;

-- 2. Re-issue RLS policies idempotently with event_planner included alongside staff & admin
DROP POLICY IF EXISTS clients_select_policy ON clients;
CREATE POLICY clients_select_policy ON clients
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR user_id = app_current_user_id()
  );

DROP POLICY IF EXISTS bookings_select_policy ON bookings;
CREATE POLICY bookings_select_policy ON bookings
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM clients c
      WHERE c.id = bookings.client_id AND c.user_id = app_current_user_id()
    )
    OR (
      app_current_role() = 'vendor'
      AND EXISTS (
        SELECT 1
        FROM vendor_assignments va
        JOIN vendors v ON v.id = va.vendor_id
        WHERE va.booking_id = bookings.id AND v.user_id = app_current_user_id()
      )
    )
  );

DROP POLICY IF EXISTS bookings_modify_staff_admin ON bookings;
CREATE POLICY bookings_modify_staff_admin ON bookings
  FOR ALL
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'))
  WITH CHECK (app_current_role() IN ('admin', 'staff', 'event_planner'));

DROP POLICY IF EXISTS quotations_client_isolation ON quotations;
CREATE POLICY quotations_client_isolation ON quotations
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = quotations.booking_id AND c.user_id = app_current_user_id()
    )
  );

-- 3. Missing RLS policy on quote_items (RLS was enabled in 002 with zero policies)
DROP POLICY IF EXISTS quote_items_client_isolation ON quote_items;
CREATE POLICY quote_items_client_isolation ON quote_items
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM quotations q
      JOIN bookings b ON b.id = q.booking_id
      JOIN clients c ON c.id = b.client_id
      WHERE q.id = quote_items.quotation_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS contracts_client_isolation ON contracts;
CREATE POLICY contracts_client_isolation ON contracts
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = contracts.booking_id AND c.user_id = app_current_user_id()
    )
  );

-- 4. Missing RLS policy on invoices (RLS was enabled in 002 with zero policies)
DROP POLICY IF EXISTS invoices_client_isolation ON invoices;
CREATE POLICY invoices_client_isolation ON invoices
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = invoices.booking_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS payments_client_isolation ON payments;
CREATE POLICY payments_client_isolation ON payments
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = payments.booking_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS messages_client_isolation ON messages;
CREATE POLICY messages_client_isolation ON messages
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = messages.booking_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS concepts_client_isolation ON design_concepts;
CREATE POLICY concepts_client_isolation ON design_concepts
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM clients c
      WHERE c.id = design_concepts.client_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS vendor_assignments_isolation ON vendor_assignments;
CREATE POLICY vendor_assignments_isolation ON vendor_assignments
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM vendors v
      WHERE v.id = vendor_assignments.vendor_id AND v.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS vendor_assignments_update_self ON vendor_assignments;
CREATE POLICY vendor_assignments_update_self ON vendor_assignments
  FOR UPDATE
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM vendors v
      WHERE v.id = vendor_assignments.vendor_id AND v.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS ai_sessions_restricted ON ai_sessions;
CREATE POLICY ai_sessions_restricted ON ai_sessions
  FOR SELECT
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'));

-- Explicit deny-all client policy for internal idempotency ledger
DROP POLICY IF EXISTS booking_idempotency_keys_deny_client ON booking_idempotency_keys;
CREATE POLICY booking_idempotency_keys_deny_client ON booking_idempotency_keys
  FOR SELECT
  USING (FALSE);

-- 5. Enforce security_invoker on vendor view so caller RLS is respected (PostgreSQL 15+)
ALTER VIEW v_vendor_booking_briefs SET (security_invoker = true);

-- Record applied migration ledger entries idempotently
INSERT INTO schema_migrations (version, filename)
VALUES
  ('001', '001_initial_schema.sql'),
  ('002', '002_rls_policies.sql'),
  ('003', '003_auth_identity.sql'),
  ('004', '004_production_hardening.sql'),
  ('005', '005_rls_event_planner_and_invoices.sql')
ON CONFLICT (version) DO NOTHING;
