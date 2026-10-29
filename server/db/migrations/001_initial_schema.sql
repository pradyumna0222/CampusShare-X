-- CampusShare X PostgreSQL Schema Migration 001
-- Initial schema definition for Neon PostgreSQL & Render deployment

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(120) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL CHECK (role IN ('student', 'owner', 'admin')),
  title VARCHAR(120) NOT NULL,
  verification_status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verified_at TIMESTAMPTZ,
  verified_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users (role, verification_status);

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS resources (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  category VARCHAR(80) NOT NULL,
  description TEXT NOT NULL,
  location VARCHAR(180) NOT NULL,
  owner_id VARCHAR(64) NOT NULL REFERENCES users(id),
  capability_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_training JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance', 'inactive')),
  icon VARCHAR(50) NOT NULL DEFAULT 'package',
  gradient VARCHAR(50) NOT NULL DEFAULT 'violet',
  asset_code VARCHAR(50) NOT NULL UNIQUE,
  uses INTEGER NOT NULL DEFAULT 0,
  instructions TEXT NOT NULL DEFAULT '',
  value_label VARCHAR(100) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources (owner_id);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources (status);
CREATE INDEX IF NOT EXISTS idx_resources_category ON resources (category);

CREATE TABLE IF NOT EXISTS training_records (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  training_code VARCHAR(80) NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('pending', 'verified', 'expired', 'rejected')),
  valid_until DATE,
  verified_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_training UNIQUE(user_id, training_code)
);
CREATE INDEX IF NOT EXISTS idx_training_user ON training_records (user_id, status);

CREATE TABLE IF NOT EXISTS bookings (
  id VARCHAR(64) PRIMARY KEY,
  resource_id VARCHAR(64) NOT NULL REFERENCES resources(id),
  user_id VARCHAR(64) NOT NULL REFERENCES users(id),
  start_date DATE NOT NULL,
  start_time VARCHAR(10) NOT NULL,
  end_time VARCHAR(10) NOT NULL,
  purpose TEXT NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'waitlisted', 'checked_out', 'returned', 'cancelled')),
  decision_reason TEXT,
  condition_before VARCHAR(32),
  condition_before_notes TEXT,
  condition_after VARCHAR(32),
  condition_after_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bookings_resource_schedule ON bookings (resource_id, start_date, status, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);

CREATE TABLE IF NOT EXISTS condition_reports (
  id VARCHAR(64) PRIMARY KEY,
  booking_id VARCHAR(64) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  stage VARCHAR(32) NOT NULL CHECK (stage IN ('before', 'after')),
  condition VARCHAR(32) NOT NULL CHECK (condition IN ('good', 'minor', 'damage')),
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(64) NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_condition_reports_booking ON condition_reports (booking_id);

CREATE TABLE IF NOT EXISTS incidents (
  id VARCHAR(64) PRIMARY KEY,
  booking_id VARCHAR(64) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  reporter_id VARCHAR(64) NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  severity VARCHAR(32) NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  status VARCHAR(32) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved')),
  resolution TEXT,
  resolved_by VARCHAR(64) REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_booking ON incidents (booking_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(64) PRIMARY KEY,
  actor_id VARCHAR(64),
  actor_name VARCHAR(120) NOT NULL,
  action VARCHAR(120) NOT NULL,
  target VARCHAR(200) NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  resource_id VARCHAR(64) REFERENCES resources(id) ON DELETE SET NULL,
  booking_id VARCHAR(64) REFERENCES bookings(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events (resource_id);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id VARCHAR(64) REFERENCES bookings(id) ON DELETE CASCADE,
  kind VARCHAR(80) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_with_booking ON notifications (user_id, booking_id, kind) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_without_booking ON notifications (user_id, kind) WHERE booking_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS resource_blocks (
  id VARCHAR(64) PRIMARY KEY,
  resource_id VARCHAR(64) NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  start_time VARCHAR(10) NOT NULL,
  end_time VARCHAR(10) NOT NULL,
  reason TEXT NOT NULL,
  created_by VARCHAR(64) NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resource_blocks_schedule ON resource_blocks (resource_id, start_date, start_time, end_time);

CREATE TABLE IF NOT EXISTS booking_extensions (
  id VARCHAR(64) PRIMARY KEY,
  booking_id VARCHAR(64) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  requested_by VARCHAR(64) NOT NULL REFERENCES users(id),
  original_end_time VARCHAR(10) NOT NULL,
  requested_end_time VARCHAR(10) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decision_reason TEXT,
  decided_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_booking_extensions_booking ON booking_extensions (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_extensions_status ON booking_extensions (status, created_at ASC);
