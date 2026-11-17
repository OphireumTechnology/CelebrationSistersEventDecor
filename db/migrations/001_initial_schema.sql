-- Celebration Sisters Event Decor — PostgreSQL Initial Schema Migration
-- Version: 001
-- Target: PostgreSQL 15+ / Supabase

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- 1. Users & Role-Based Access Control
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL CHECK (code IN ('guest', 'client', 'vendor', 'staff', 'admin')),
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_key TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  organization TEXT,
  mfa_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

-- 2. Clients & Leads
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  preferred_contact TEXT NOT NULL DEFAULT 'email',
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_email TEXT NOT NULL,
  client_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('website_form', 'ai_concierge', 'referral', 'direct')),
  event_category TEXT NOT NULL,
  target_date DATE,
  location TEXT,
  guest_count INTEGER CHECK (guest_count IS NULL OR guest_count > 0),
  budget_range TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'qualified', 'converted', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Service Catalog (12 Divisions)
CREATE TABLE IF NOT EXISTS service_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  division_number TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  tagline TEXT NOT NULL,
  description TEXT NOT NULL,
  published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Events, Consultations, Blackout Dates & Availability Holds
CREATE TABLE IF NOT EXISTS blackout_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blackout_date DATE UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS availability_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_date DATE NOT NULL,
  venue_name_normalized TEXT NOT NULL,
  client_email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_active_hold_venue_date UNIQUE (event_date, venue_name_normalized)
);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code TEXT UNIQUE NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  event_title TEXT NOT NULL,
  event_type TEXT NOT NULL,
  package_tier TEXT NOT NULL,
  event_date DATE NOT NULL,
  location TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  venue_name_normalized TEXT GENERATED ALWAYS AS (LOWER(TRIM(venue_name))) STORED,
  guest_count INTEGER NOT NULL CHECK (guest_count BETWEEN 10 AND 5000),
  budget_range TEXT NOT NULL,
  legacy_status TEXT NOT NULL,
  architectural_stage TEXT NOT NULL CHECK (
    architectural_stage IN (
      'INQUIRY', 'CONSULTATION_SCHEDULED', 'CONSULTATION_DONE',
      'QUOTE_DRAFT', 'QUOTE_PENDING_APPROVAL', 'QUOTE_SENT', 'QUOTE_ACCEPTED',
      'CONTRACT_SENT', 'CONTRACT_SIGNED', 'DEPOSIT_PAID', 'BOOKED',
      'IN_PLANNING', 'FINAL_DETAILS_LOCKED', 'BALANCE_PAID',
      'EVENT_DAY', 'WRAP_UP', 'COMPLETED', 'REVIEW_REQUESTED',
      'EXPIRED', 'DECLINED', 'CANCELLED', 'POSTPONED'
    )
  ),
  assigned_lead_planner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent double-booking of the same venue on the same date for active bookings
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_booking_venue_date
  ON bookings (event_date, venue_name_normalized)
  WHERE architectural_stage NOT IN ('CANCELLED', 'EXPIRED', 'DECLINED');

CREATE INDEX IF NOT EXISTS idx_bookings_client_id ON bookings (client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_event_date ON bookings (event_date);

CREATE TABLE IF NOT EXISTS consultations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ,
  meeting_channel TEXT NOT NULL DEFAULT 'video' CHECK (meeting_channel IN ('in_person_columbia', 'video', 'phone')),
  planner_notes TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Quotations & Immutable Versions
CREATE TABLE IF NOT EXISTS quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  discount_reason TEXT,
  discount_approved BOOLEAN NOT NULL DEFAULT FALSE,
  discount_approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_booking_quote_version UNIQUE (booking_id, version_number)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  division_title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);

-- 6. Contracts & Signatures
CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  terms_summary TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  client_signed BOOLEAN NOT NULL DEFAULT FALSE,
  client_signed_by TEXT,
  client_signed_at TIMESTAMPTZ,
  client_signature_ip INET,
  staff_countersigned BOOLEAN NOT NULL DEFAULT FALSE,
  staff_countersigned_by TEXT,
  staff_countersigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Invoices & Payments (Idempotency Protected)
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  invoice_number TEXT UNIQUE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  due_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'partially_paid', 'paid', 'void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  milestone_label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  provider TEXT NOT NULL DEFAULT 'stripe_sandbox' CHECK (provider IN ('stripe_sandbox', 'paypal_sandbox', 'manual_ledger')),
  idempotency_key TEXT UNIQUE NOT NULL,
  provider_event_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Paid', 'Overdue', 'Refunded')),
  due_date DATE NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Vendors, Staff Assignments & Event Tasks
CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  availability_status TEXT NOT NULL DEFAULT 'Available' CHECK (availability_status IN ('Available', 'Booked', 'On Hold')),
  insurance_verified BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  task_description TEXT NOT NULL,
  call_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'In Progress', 'Completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_vendor_booking_task UNIQUE (booking_id, vendor_id, task_description)
);

CREATE TABLE IF NOT EXISTS staff_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  staff_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role_title TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_staff_booking UNIQUE (booking_id, staff_user_id)
);

CREATE TABLE IF NOT EXISTS event_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  area TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('Client', 'Planner', 'Production')),
  due_date DATE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Inventory & Date-Scoped Reservations
CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0),
  unit_rental_price_cents INTEGER NOT NULL CHECK (unit_rental_price_cents >= 0),
  condition TEXT NOT NULL DEFAULT 'Pristine' CHECK (condition IN ('Pristine', 'Inspection Needed', 'In Maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  reserved_quantity INTEGER NOT NULL CHECK (reserved_quantity > 0),
  status TEXT NOT NULL DEFAULT 'Reserved' CHECK (status IN ('Reserved', 'CheckedOut', 'Returned', 'Cancelled')),
  CONSTRAINT uq_inventory_booking_item UNIQUE (inventory_item_id, booking_id)
);

-- 10. Messages, AI Sessions, Concept Studio, Notifications & Audit Logs
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name TEXT,
  event_category TEXT,
  event_date TEXT,
  location TEXT,
  guest_count INTEGER,
  budget_range TEXT,
  theme TEXT,
  summary TEXT NOT NULL,
  escalated_to_human BOOLEAN NOT NULL DEFAULT FALSE,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS design_concepts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  event_type TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  revisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_approved BOOLEAN NOT NULL DEFAULT FALSE,
  client_approved_at TIMESTAMPTZ,
  staff_approved BOOLEAN NOT NULL DEFAULT FALSE,
  staff_approved_by TEXT,
  staff_approved_at TIMESTAMPTZ,
  is_conceptual_visualization BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_conceptual_visualization = TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('Email', 'SMS', 'Internal Task')),
  booking_reference TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('Queued', 'Dispatched', 'Skipped (Unauthorized)', 'Failed')),
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at ON audit_logs (occurred_at DESC);
