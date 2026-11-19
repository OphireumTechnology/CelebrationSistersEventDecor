-- Celebration Sisters Event Decor — Phase 13 Transactional Outbox, Session Revocation, MFA Recovery,
-- Normalized Indexes, Stripe Preparation Tables & Complete RLS Alignment Migration
-- Version: 006
-- Target: PostgreSQL 15+ / Supabase
-- Strictly additive & idempotent. Preserves app_state_snapshots and all existing customer data intact.

-- 1. Repair app_current_role() so direct Supabase Auth JWT connections resolve the authoritative
--    database role from user_roles + roles (NEVER trusting mutable JWT user_metadata claims).
CREATE OR REPLACE FUNCTION app_current_role() RETURNS TEXT AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_role', true), ''),
    (
      SELECT r.code
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = app_current_user_id()
      ORDER BY CASE r.code
        WHEN 'admin' THEN 1
        WHEN 'staff' THEN 2
        WHEN 'event_planner' THEN 3
        WHEN 'vendor' THEN 4
        WHEN 'client' THEN 5
        ELSE 6
      END
      LIMIT 1
    ),
    'guest'
  );
$$ LANGUAGE SQL STABLE;

-- 2. Durable Transactional Notification Outbox (Block 13.7)
CREATE TABLE IF NOT EXISTS notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('consultation_confirmation', 'staff_new_booking_alert', 'booking_status_update', 'admin_security_alert')
  ),
  channel TEXT NOT NULL DEFAULT 'Email' CHECK (channel IN ('Email', 'SMS', 'Internal Task')),
  recipient TEXT NOT NULL,
  booking_reference TEXT,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (
    status IN (
      'Pending', 'Claimed', 'Retrying', 'ProviderAccepted', 'Delivered',
      'DeadLetter', 'Skipped (Unconfigured)', 'Skipped (Unauthorized)'
    )
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_poll
  ON notification_outbox (status, next_attempt_at ASC)
  WHERE status IN ('Pending', 'Retrying', 'Claimed');

CREATE INDEX IF NOT EXISTS idx_notification_outbox_booking
  ON notification_outbox (booking_reference, created_at DESC);

-- 3. Server-Side Session Revocation Registry (Block 13.3 — prevents post-logout token replay)
CREATE TABLE IF NOT EXISTS revoked_sessions (
  jti TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires ON revoked_sessions (expires_at);

-- 4. Single-Use MFA Recovery Codes (Block 13.4 — SHA-256 hashes only; never returned to clients)
CREATE TABLE IF NOT EXISTS user_mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT UNIQUE NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_mfa_recovery_user ON user_mfa_recovery_codes (user_id, used_at);

-- 5. Stripe Payment Integration Preparation Tables (Block 13.9 — schema preparation only; live payments remain disabled)
CREATE TABLE IF NOT EXISTS payment_intents_prep (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_checkout_session_id TEXT UNIQUE,
  provider_payment_intent_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'created' CHECK (
    status IN ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'refunded')
  ),
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  payload_sha256 TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Additional Performance Indexes for Normalized Queries (Block 13.5)
CREATE INDEX IF NOT EXISTS idx_bookings_stage_date ON bookings (architectural_stage, event_date);
CREATE INDEX IF NOT EXISTS idx_payments_booking_status ON payments (booking_id, status);
CREATE INDEX IF NOT EXISTS idx_quotations_booking_version ON quotations (booking_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_created ON ai_sessions (created_at DESC);

-- 7. Complete RLS Coverage on New & Previously Uncovered Operational Tables (Block 13.6)
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents_prep ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_outbox_admin_only ON notification_outbox;
CREATE POLICY notification_outbox_admin_only ON notification_outbox
  FOR SELECT
  USING (app_current_role() = 'admin');

DROP POLICY IF EXISTS revoked_sessions_deny_client ON revoked_sessions;
CREATE POLICY revoked_sessions_deny_client ON revoked_sessions
  FOR SELECT
  USING (FALSE);

DROP POLICY IF EXISTS user_mfa_recovery_codes_deny_client ON user_mfa_recovery_codes;
CREATE POLICY user_mfa_recovery_codes_deny_client ON user_mfa_recovery_codes
  FOR SELECT
  USING (FALSE);

DROP POLICY IF EXISTS payment_intents_prep_client_isolation ON payment_intents_prep;
CREATE POLICY payment_intents_prep_client_isolation ON payment_intents_prep
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = payment_intents_prep.booking_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS payment_webhook_events_admin_only ON payment_webhook_events;
CREATE POLICY payment_webhook_events_admin_only ON payment_webhook_events
  FOR SELECT
  USING (app_current_role() = 'admin');

DROP POLICY IF EXISTS leads_operations_only ON leads;
CREATE POLICY leads_operations_only ON leads
  FOR SELECT
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'));

DROP POLICY IF EXISTS consultations_client_isolation ON consultations;
CREATE POLICY consultations_client_isolation ON consultations
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = consultations.booking_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS vendors_self_or_ops ON vendors;
CREATE POLICY vendors_self_or_ops ON vendors
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR user_id = app_current_user_id()
  );

DROP POLICY IF EXISTS staff_assignments_ops_only ON staff_assignments;
CREATE POLICY staff_assignments_ops_only ON staff_assignments
  FOR SELECT
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'));

DROP POLICY IF EXISTS event_tasks_client_or_ops ON event_tasks;
CREATE POLICY event_tasks_client_or_ops ON event_tasks
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = event_tasks.booking_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS inventory_reservations_ops_only ON inventory_reservations;
CREATE POLICY inventory_reservations_ops_only ON inventory_reservations
  FOR SELECT
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'));

DROP POLICY IF EXISTS notifications_admin_only ON notifications;
CREATE POLICY notifications_admin_only ON notifications
  FOR SELECT
  USING (app_current_role() = 'admin');

-- 8. Record migration 006 in schema_migrations ledger
INSERT INTO schema_migrations (version, filename)
VALUES ('006', '006_normalized_and_outbox.sql')
ON CONFLICT (version) DO NOTHING;
