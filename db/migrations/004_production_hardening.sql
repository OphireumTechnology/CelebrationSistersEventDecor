-- Celebration Sisters Event Decor — Production Hardening, Transactional State & Notifications Migration
-- Version: 004
-- Target: PostgreSQL 15+ / Supabase
-- Additive, non-destructive migration preserving all existing tables and customer records.

-- 1. Transactional Durable State Coordinator (Supports atomic booking, quote, contract & payment writes)
CREATE TABLE IF NOT EXISTS app_state_snapshots (
  state_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Booking Request Idempotency Registry (Prevents duplicate bookings on network retries)
CREATE TABLE IF NOT EXISTS booking_idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  reference_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_idempotency_created ON booking_idempotency_keys (created_at DESC);

-- 3. Notification Delivery Ledger (Tracks Resend provider acceptance, retries & failures)
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('Email', 'SMS', 'Internal Task')),
  provider TEXT NOT NULL,
  recipient TEXT NOT NULL,
  booking_reference TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('Queued', 'ProviderAccepted', 'Delivered', 'Failed', 'Skipped (Unconfigured)', 'Skipped (Unauthorized)')
  ),
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_booking ON notification_deliveries (booking_reference, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries (status, updated_at DESC);

-- 4. Administrator TOTP MFA Factor Storage (Server-side only; never exposed to browser clients)
CREATE TABLE IF NOT EXISTS user_mfa_factors (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  factor_type TEXT NOT NULL DEFAULT 'totp' CHECK (factor_type = 'totp'),
  encrypted_secret TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ
);

-- 5. Multi-Replica Distributed Rate Limit Buckets
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 1,
  reset_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_reset ON rate_limit_buckets (reset_at);

-- 6. Enable RLS on all new tables (Service-role backend manages writes; direct client access restricted)
ALTER TABLE app_state_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_state_snapshots_admin_only ON app_state_snapshots;
CREATE POLICY app_state_snapshots_admin_only ON app_state_snapshots
  FOR SELECT
  USING (app_current_role() = 'admin');

DROP POLICY IF EXISTS notification_deliveries_admin_only ON notification_deliveries;
CREATE POLICY notification_deliveries_admin_only ON notification_deliveries
  FOR SELECT
  USING (app_current_role() = 'admin');

DROP POLICY IF EXISTS user_mfa_factors_deny_client ON user_mfa_factors;
CREATE POLICY user_mfa_factors_deny_client ON user_mfa_factors
  FOR SELECT
  USING (FALSE);

DROP POLICY IF EXISTS rate_limit_buckets_deny_client ON rate_limit_buckets;
CREATE POLICY rate_limit_buckets_deny_client ON rate_limit_buckets
  FOR SELECT
  USING (FALSE);
