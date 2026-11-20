-- Celebration Sisters Event Decor — Phase 14 Consultation Scheduling, CRM Pipeline,
-- Extended Notification Outbox & Railway PostgreSQL RLS Compatibility Migration
-- Version: 007
-- Target: PostgreSQL 15+ (Railway PostgreSQL & Supabase PostgreSQL compatible)
-- Strictly additive & idempotent. Preserves all existing tables, app_state_snapshots, and customer data.
-- Never disables RLS, never creates an insecure auth shim, and never requires superuser runtime queries.

-- ============================================================================
-- 1. Railway PostgreSQL + Supabase Auth RLS Identity Context Reconciliation
-- ============================================================================
-- Replaces unconditional auth.uid() references from migrations 002/003/005 with
-- transaction-scoped session context (`SET LOCAL app.current_user_id` / `app.current_role`)
-- while safely delegating to Supabase `auth.uid()` ONLY when that function exists
-- in the database catalog. Returns NULL when no verified identity context is set,
-- ensuring RLS fails closed by default on both Railway PostgreSQL and Supabase.

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
DECLARE
  v_local_setting TEXT;
  v_provider_uid UUID;
  v_internal_id UUID;
BEGIN
  v_local_setting := NULLIF(current_setting('app.current_user_id', true), '');
  IF v_local_setting IS NOT NULL THEN
    BEGIN
      RETURN v_local_setting::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN NULL;
    END;
  END IF;

  v_provider_uid := app_resolve_provider_uid();
  IF v_provider_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.id INTO v_internal_id
  FROM users u
  WHERE u.supabase_user_id = v_provider_uid
  LIMIT 1;

  RETURN COALESCE(v_internal_id, v_provider_uid);
END;
$$ LANGUAGE plpgsql STABLE;

-- Re-issue users RLS policy without unconditional auth.uid() dependency
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

-- ============================================================================
-- 2. Extend Canonical `consultations` Table (Additive — No Duplicate Table)
-- ============================================================================
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS reference_code TEXT,
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS assigned_planner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Pending',
  ADD COLUMN IF NOT EXISTS consultation_start_utc TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consultation_end_utc TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS buffer_before_minutes INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS buffer_after_minutes INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS client_timezone TEXT NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS preferred_contact_method TEXT NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_consent_version TEXT NOT NULL DEFAULT '2026-11-v1',
  ADD COLUMN IF NOT EXISTS access_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS outcome_summary TEXT,
  ADD COLUMN IF NOT EXISTS crm_stage TEXT NOT NULL DEFAULT 'Consultation Scheduled',
  ADD COLUMN IF NOT EXISTS follow_up_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rescheduled_from_id UUID REFERENCES consultations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_status_check;
ALTER TABLE consultations
  ADD CONSTRAINT consultations_status_check
  CHECK (status IN ('Draft', 'Pending', 'Confirmed', 'Rescheduled', 'Completed', 'Cancelled', 'No-show'));

ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_preferred_contact_check;
ALTER TABLE consultations
  ADD CONSTRAINT consultations_preferred_contact_check
  CHECK (preferred_contact_method IN ('email', 'phone', 'sms'));

ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_crm_stage_check;
ALTER TABLE consultations
  ADD CONSTRAINT consultations_crm_stage_check
  CHECK (crm_stage IN (
    'New Inquiry',
    'Qualified Lead',
    'Consultation Scheduled',
    'Consultation Completed',
    'Proposal Prepared',
    'Proposal Sent',
    'Client Decision',
    'Event Booked'
  ));

ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_time_window_check;
ALTER TABLE consultations
  ADD CONSTRAINT consultations_time_window_check
  CHECK (
    consultation_start_utc IS NULL
    OR consultation_end_utc IS NULL
    OR consultation_end_utc > consultation_start_utc
  );

ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_buffers_check;
ALTER TABLE consultations
  ADD CONSTRAINT consultations_buffers_check
  CHECK (buffer_before_minutes BETWEEN 0 AND 120 AND buffer_after_minutes BETWEEN 0 AND 120);

-- Unique idempotency key & reference code indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_consultations_idempotency_key
  ON consultations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_consultations_reference_code
  ON consultations (reference_code)
  WHERE reference_code IS NOT NULL;

-- Active exclusive slot conflict prevention per planner (prevents concurrent double-booking)
CREATE UNIQUE INDEX IF NOT EXISTS uq_consultations_active_planner_slot
  ON consultations (assigned_planner_id, consultation_start_utc)
  WHERE status IN ('Pending', 'Confirmed', 'Rescheduled')
    AND assigned_planner_id IS NOT NULL
    AND consultation_start_utc IS NOT NULL;

-- Buffered time-range overlap exclusion constraint using btree_gist
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'excl_consultations_planner_buffered_overlap'
  ) THEN
    ALTER TABLE consultations
      ADD CONSTRAINT excl_consultations_planner_buffered_overlap
      EXCLUDE USING gist (
        assigned_planner_id WITH =,
        tsrange(
          consultation_start_utc AT TIME ZONE 'UTC',
          (consultation_end_utc AT TIME ZONE 'UTC') + (buffer_after_minutes * INTERVAL '1 minute'),
          '[)'
        ) WITH &&
      )
      WHERE (
        status IN ('Pending', 'Confirmed', 'Rescheduled')
        AND assigned_planner_id IS NOT NULL
        AND consultation_start_utc IS NOT NULL
        AND consultation_end_utc IS NOT NULL
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_consultations_booking_id ON consultations (booking_id);
CREATE INDEX IF NOT EXISTS idx_consultations_client_id ON consultations (client_id);
CREATE INDEX IF NOT EXISTS idx_consultations_planner_time ON consultations (assigned_planner_id, consultation_start_utc);
CREATE INDEX IF NOT EXISTS idx_consultations_status_start ON consultations (status, consultation_start_utc);
CREATE INDEX IF NOT EXISTS idx_consultations_crm_stage ON consultations (crm_stage, updated_at DESC);

-- ============================================================================
-- 3. Staff Availability Rules & Short-Lived Consultation Slot Holds
-- ============================================================================
CREATE TABLE IF NOT EXISTS staff_availability_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time_local TIME NOT NULL,
  end_time_local TIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  slot_duration_minutes INTEGER NOT NULL DEFAULT 45 CHECK (slot_duration_minutes BETWEEN 15 AND 180),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 15 CHECK (buffer_before_minutes BETWEEN 0 AND 120),
  buffer_after_minutes INTEGER NOT NULL DEFAULT 15 CHECK (buffer_after_minutes BETWEEN 0 AND 120),
  allowed_channels TEXT[] NOT NULL DEFAULT ARRAY['in_person_columbia', 'video', 'phone']::TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_staff_availability_window CHECK (end_time_local > start_time_local),
  CONSTRAINT uq_staff_availability_planner_day UNIQUE (planner_user_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS consultation_slot_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_start_utc TIMESTAMPTZ NOT NULL,
  slot_end_utc TIMESTAMPTZ NOT NULL,
  holder_fingerprint_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_consultation_hold_window CHECK (slot_end_utc > slot_start_utc),
  CONSTRAINT uq_consultation_slot_hold UNIQUE (planner_user_id, slot_start_utc)
);

CREATE INDEX IF NOT EXISTS idx_consultation_slot_holds_expires ON consultation_slot_holds (expires_at);

-- ============================================================================
-- 4. CRM Follow-Up Tasks (Connected to Existing Clients, Bookings & Consultations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS crm_follow_up_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id UUID REFERENCES consultations(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Completed', 'Cancelled')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_follow_up_tasks_status_due ON crm_follow_up_tasks (status, due_at ASC);
CREATE INDEX IF NOT EXISTS idx_crm_follow_up_tasks_consultation ON crm_follow_up_tasks (consultation_id);

-- ============================================================================
-- 5. Expand Notification Outbox Categories for Complete Consultation Lifecycle
-- ============================================================================
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_category_check;
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_category_check
  CHECK (
    category IN (
      'consultation_confirmation',
      'consultation_confirmed',
      'consultation_rescheduled',
      'consultation_cancelled',
      'consultation_reminder',
      'consultation_followup',
      'proposal_available',
      'staff_new_booking_alert',
      'staff_appointment_assigned',
      'staff_upcoming_consultation',
      'staff_reschedule_alert',
      'staff_cancellation_alert',
      'staff_followup_required',
      'staff_proposal_awaiting_action',
      'booking_status_update',
      'admin_security_alert'
    )
  );

-- ============================================================================
-- 6. Row-Level Security (RLS) on All New & Updated Consultation/CRM Tables
-- ============================================================================
ALTER TABLE staff_availability_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_availability_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE consultation_slot_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultation_slot_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE crm_follow_up_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_follow_up_tasks FORCE ROW LEVEL SECURITY;

-- Updated consultations policies (client sees own; planner/staff/admin manage operational records)
DROP POLICY IF EXISTS consultations_client_isolation ON consultations;
CREATE POLICY consultations_client_isolation ON consultations
  FOR SELECT
  USING (
    app_current_role() IN ('admin', 'staff', 'event_planner')
    OR EXISTS (
      SELECT 1 FROM clients c
      WHERE c.id = consultations.client_id AND c.user_id = app_current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM bookings b
      JOIN clients c ON c.id = b.client_id
      WHERE b.id = consultations.booking_id AND c.user_id = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS consultations_modify_ops ON consultations;
CREATE POLICY consultations_modify_ops ON consultations
  FOR ALL
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'))
  WITH CHECK (app_current_role() IN ('admin', 'staff', 'event_planner'));

-- Staff availability rules: read by operations (and backend availability computation); modified by admin/staff/planner
DROP POLICY IF EXISTS staff_availability_rules_ops_select ON staff_availability_rules;
CREATE POLICY staff_availability_rules_ops_select ON staff_availability_rules
  FOR SELECT
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'));

DROP POLICY IF EXISTS staff_availability_rules_ops_modify ON staff_availability_rules;
CREATE POLICY staff_availability_rules_ops_modify ON staff_availability_rules
  FOR ALL
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'))
  WITH CHECK (app_current_role() IN ('admin', 'staff', 'event_planner'));

-- Consultation slot holds: backend-managed internal table; deny direct client reads
DROP POLICY IF EXISTS consultation_slot_holds_ops_only ON consultation_slot_holds;
CREATE POLICY consultation_slot_holds_ops_only ON consultation_slot_holds
  FOR SELECT
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'));

-- CRM follow-up tasks: operations-only (never exposed directly to clients or vendors)
DROP POLICY IF EXISTS crm_follow_up_tasks_ops_only ON crm_follow_up_tasks;
CREATE POLICY crm_follow_up_tasks_ops_only ON crm_follow_up_tasks
  FOR ALL
  USING (app_current_role() IN ('admin', 'staff', 'event_planner'))
  WITH CHECK (app_current_role() IN ('admin', 'staff', 'event_planner'));

-- ============================================================================
-- 7. Record Migration 007 in Schema Migrations Ledger
-- ============================================================================
INSERT INTO schema_migrations (version, filename)
VALUES ('007', '007_consultation_scheduling_and_railway_rls.sql')
ON CONFLICT (version) DO NOTHING;
