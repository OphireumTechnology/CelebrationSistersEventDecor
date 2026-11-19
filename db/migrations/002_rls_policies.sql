-- Celebration Sisters Event Decor — Row-Level Security (RLS) Policies
-- Version: 002
-- Enforces strict client isolation, vendor assignment scoping, and protected admin telemetry.
-- Expects session context via SET LOCAL app.current_user_id / app.current_role,
-- safely delegating to Supabase auth.uid() ONLY if that function exists in the catalog.
-- Returns NULL when unauthenticated (fail-closed on both Railway PostgreSQL and Supabase).

CREATE OR REPLACE FUNCTION app_resolve_provider_uid() RETURNS UUID AS $$
DECLARE
  v_uid UUID;
BEGIN
  IF to_regprocedure('auth.uid()') IS NOT NULL THEN
    EXECUTE 'SELECT auth.uid()' INTO v_uid;
    RETURN v_uid;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS UUID AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_user_id', true), '')::UUID,
    app_resolve_provider_uid()
  );
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION app_current_role() RETURNS TEXT AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_role', true), ''),
    'guest'
  );
$$ LANGUAGE SQL STABLE;

-- Enable RLS across all sensitive customer, commercial, and operational tables
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- 1. Clients table: Client sees own profile; Staff & Admin see all
CREATE POLICY clients_select_policy ON clients
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff')
    OR user_id = app_current_user_id()
  );

-- 2. Bookings table:
--    Client A cannot access Client B.
--    Vendor can only read bookings where they hold an assignment (financial details excluded via v_vendor_booking_briefs).
CREATE POLICY bookings_select_policy ON bookings
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff')
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

CREATE POLICY bookings_modify_staff_admin ON bookings
  FOR ALL
  USING (app_current_role() IN ('admin', 'staff'))
  WITH CHECK (app_current_role() IN ('admin', 'staff'));

-- 3. Financial tables (Quotations, Contracts, Invoices, Payments):
--    Strictly restricted to owning Client, Staff, or Admin. Vendors NEVER have direct select access.
CREATE POLICY quotations_client_isolation ON quotations
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = quotations.booking_id AND c.user_id = app_current_user_id()
    )
  );

CREATE POLICY contracts_client_isolation ON contracts
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = contracts.booking_id AND c.user_id = app_current_user_id()
    )
  );

CREATE POLICY payments_client_isolation ON payments
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = payments.booking_id AND c.user_id = app_current_user_id()
    )
  );

-- 4. Messages & Design Concepts: Scoped to owning client or staff/admin
CREATE POLICY messages_client_isolation ON messages
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = messages.booking_id AND c.user_id = app_current_user_id()
    )
  );

CREATE POLICY concepts_client_isolation ON design_concepts
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff')
    OR EXISTS (
      SELECT 1 FROM clients c
      WHERE c.id = design_concepts.client_id AND c.user_id = app_current_user_id()
    )
  );

-- 5. Vendor Assignments: Vendor A cannot access Vendor B assignments
CREATE POLICY vendor_assignments_isolation ON vendor_assignments
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff')
    OR EXISTS (
      SELECT 1 FROM vendors v
      WHERE v.id = vendor_assignments.vendor_id AND v.user_id = app_current_user_id()
    )
  );

CREATE POLICY vendor_assignments_update_self ON vendor_assignments
  FOR UPDATE
  USING (
    app_current_role() IN ('admin', 'staff')
    OR EXISTS (
      SELECT 1 FROM vendors v
      WHERE v.id = vendor_assignments.vendor_id AND v.user_id = app_current_user_id()
    )
  );

-- 6. AI Sessions & Audit Logs: Strictly restricted to Executive Admin (and Staff for AI review)
CREATE POLICY ai_sessions_restricted ON ai_sessions
  FOR SELECT
  USING (app_current_role() IN ('admin', 'staff'));

CREATE POLICY audit_logs_admin_only ON audit_logs
  FOR SELECT
  USING (app_current_role() = 'admin');

-- 7. Redacted Vendor Operational View (omits client email, phone, budget_range, and notes)
CREATE OR REPLACE VIEW v_vendor_booking_briefs AS
SELECT
  b.id,
  b.reference_code,
  b.event_title,
  b.event_type,
  b.event_date,
  b.location,
  b.venue_name,
  b.guest_count,
  b.architectural_stage,
  va.vendor_id,
  va.task_description,
  va.call_time,
  va.status AS deliverable_status
FROM bookings b
JOIN vendor_assignments va ON va.booking_id = b.id;
