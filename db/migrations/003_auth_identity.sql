-- Celebration Sisters Event Decor — Identity, Auth Provider & Invitation Migration
-- Version: 003
-- Target: PostgreSQL 15+ / Supabase Auth
-- Prepared for Block 3.2.2 / Executed only upon approved database migration in Block 3.2.3+

-- 1. Expand roles constraint to include explicit event_planner operational role
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_code_check;
ALTER TABLE roles
  ADD CONSTRAINT roles_code_check
  CHECK (code IN ('guest', 'client', 'vendor', 'event_planner', 'staff', 'admin'));

INSERT INTO roles (code, description)
VALUES
  ('guest', 'Public prospect browsing catalog and inquiries'),
  ('client', 'Authenticated client restricted to own events and financials'),
  ('vendor', 'External production partner restricted to assigned event briefs'),
  ('event_planner', 'Lead planner managing assigned client planning and timelines'),
  ('staff', 'Production coordinator with event-day logistics and checklists'),
  ('admin', 'Executive director with full oversight and mandatory MFA')
ON CONFLICT (code) DO NOTHING;

-- 2. Bind users table cleanly to Supabase Auth UIDs without storing raw passwords
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS supabase_user_id UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('pending_verification', 'active', 'suspended', 'deactivated')),
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mfa_assurance_level TEXT NOT NULL DEFAULT 'aal1'
    CHECK (mfa_assurance_level IN ('aal1', 'aal2')),
  ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_supabase_user_id ON users (supabase_user_id);
CREATE INDEX IF NOT EXISTS idx_users_account_status ON users (account_status);

-- 3. Privileged Role Invitations (Vendors, Event Planners, Staff, Executive Admins)
CREATE TABLE IF NOT EXISTS staff_vendor_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  assigned_role TEXT NOT NULL CHECK (assigned_role IN ('vendor', 'event_planner', 'staff', 'admin')),
  token_hash TEXT UNIQUE NOT NULL,
  invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invitations_email_status ON staff_vendor_invitations (LOWER(email), status);

-- 4. Security & Authentication Event Telemetry
CREATE TABLE IF NOT EXISTS auth_security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email_hash TEXT,
  ip_address INET,
  user_agent TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_security_events_occurred ON auth_security_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_security_events_user ON auth_security_events (user_id, occurred_at DESC);

-- 5. Enable Row-Level Security on Identity Tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_vendor_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_security_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self_or_admin_select ON users;
CREATE POLICY users_self_or_admin_select ON users
  FOR SELECT
  USING (
    app_current_role() = 'admin'
    OR id = app_current_user_id()
    OR (
      app_resolve_provider_uid() IS NOT NULL
      AND supabase_user_id = app_resolve_provider_uid()
    )
  );

DROP POLICY IF EXISTS invitations_admin_only ON staff_vendor_invitations;
CREATE POLICY invitations_admin_only ON staff_vendor_invitations
  FOR ALL
  USING (app_current_role() = 'admin')
  WITH CHECK (app_current_role() = 'admin');

DROP POLICY IF EXISTS auth_security_events_admin_only ON auth_security_events;
CREATE POLICY auth_security_events_admin_only ON auth_security_events
  FOR SELECT
  USING (app_current_role() = 'admin');
