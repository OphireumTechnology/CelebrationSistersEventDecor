-- Celebration Sisters Event Decor — Phase 15 Consultation Token Lifecycle,
-- Event Theme Persistence, Resend Webhook Audit Ledger & FORCE RLS Hardening
-- Version: 008
-- Target: PostgreSQL 15+ (Railway PostgreSQL & Supabase PostgreSQL compatible)
-- Strictly additive & idempotent. Preserves all existing tables, snapshots, and customer data.

-- ============================================================================
-- 1. Consultation Scoped Token Expiration, Revocation & Event Theme Columns
-- ============================================================================
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS event_theme TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_token_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_consultations_token_expiry
  ON consultations (access_token_expires_at)
  WHERE access_token_revoked_at IS NULL AND access_token_expires_at IS NOT NULL;

-- ============================================================================
-- 2. Resend Webhook Delivery Verification & Replay Prevention Ledger
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'resend' CHECK (provider IN ('resend')),
  svix_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  provider_message_id TEXT,
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('processed', 'ignored', 'duplicate')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_webhook_msg
  ON notification_webhook_events (provider_message_id, received_at DESC);

-- ============================================================================
-- 3. Harden Row-Level Security (FORCE RLS) on Consultation, Outbox & Webhook Tables
-- ============================================================================
ALTER TABLE consultations FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_webhook_events_ops_only ON notification_webhook_events;
CREATE POLICY notification_webhook_events_ops_only ON notification_webhook_events
  FOR ALL
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'))
  WITH CHECK (app_current_role() IN ('admin', 'staff', 'event_planner'));

-- ============================================================================
-- 4. Record Migration 008 in Schema Migrations Ledger
-- ============================================================================
INSERT INTO schema_migrations (version, filename)
VALUES ('008', '008_phase15_token_lifecycle_and_webhook_audit.sql')
ON CONFLICT (version) DO NOTHING;
