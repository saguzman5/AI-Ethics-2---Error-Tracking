-- =====================================================================
-- Production Tracking & Error Reporting System - Centralized Database
-- Engine: SQLite 3 (via Node.js built-in node:sqlite), WAL mode.
-- Portable to PostgreSQL/Supabase with minor type changes (see
-- Documentation/DATABASE.md).
--
-- All timestamps are ISO-8601 UTC strings: YYYY-MM-DDTHH:MM:SS.sssZ
-- This file is idempotent: it is applied on every server start.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- Users (workers and managers) and login sessions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  full_name      TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('worker', 'manager')),
  password_hash  TEXT    NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,          -- SHA-256 of the cookie token
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------
-- Production orders and products (boxes)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_orders (
  order_id      TEXT PRIMARY KEY,
  customer      TEXT,
  product_name  TEXT,
  quantity      INTEGER CHECK (quantity IS NULL OR quantity >= 0),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS products (
  box_id        TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES production_orders(order_id),
  product_name  TEXT,
  produced_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_products_order    ON products(order_id);
CREATE INDEX IF NOT EXISTS idx_products_produced ON products(produced_at);

-- ---------------------------------------------------------------------
-- Configurable lookup lists. Rows are deactivated, never deleted, so
-- historical reports keep their meaning.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_stages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS error_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- ---------------------------------------------------------------------
-- Photographs. Files live outside the web root (DATA_DIR/photos) and are
-- only served through an authenticated or signed URL.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photos (
  id           TEXT    PRIMARY KEY,         -- random UUID, unguessable
  file_path    TEXT    NOT NULL,            -- relative to DATA_DIR/photos
  mime_type    TEXT    NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT    NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------
-- Error reports
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_reports (
  seq                   INTEGER PRIMARY KEY AUTOINCREMENT,
  error_id              TEXT    NOT NULL UNIQUE,          -- e.g. ERR-000123
  client_submission_id  TEXT    NOT NULL UNIQUE,          -- idempotency key from the app
  box_id                TEXT    NOT NULL REFERENCES products(box_id),
  order_id              TEXT    NOT NULL REFERENCES production_orders(order_id),
  stage_id              INTEGER NOT NULL REFERENCES production_stages(id),
  category_id           INTEGER NOT NULL REFERENCES error_categories(id),
  severity              TEXT    NOT NULL CHECK (severity IN ('Low', 'Medium', 'High', 'Critical')),
  description           TEXT    NOT NULL CHECK (length(trim(description)) >= 3),
  photo_id              TEXT    REFERENCES photos(id),
  status                TEXT    NOT NULL DEFAULT 'Open'
                                CHECK (status IN ('Open', 'Under Review', 'In Rework', 'Resolved')),
  requires_rework       INTEGER NOT NULL DEFAULT 0 CHECK (requires_rework IN (0, 1)),
  resolution_notes      TEXT,                              -- latest note (full log in history)
  reported_by           INTEGER NOT NULL REFERENCES users(id),
  reported_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status_changed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at           TEXT,
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_reported_at ON error_reports(reported_at);
CREATE INDEX IF NOT EXISTS idx_reports_status      ON error_reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_box         ON error_reports(box_id);
CREATE INDEX IF NOT EXISTS idx_reports_order       ON error_reports(order_id);
CREATE INDEX IF NOT EXISTS idx_reports_stage       ON error_reports(stage_id);
CREATE INDEX IF NOT EXISTS idx_reports_category    ON error_reports(category_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter    ON error_reports(reported_by);

-- Every status change and every resolution note (append-only).
CREATE TABLE IF NOT EXISTS error_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  error_id     TEXT    NOT NULL REFERENCES error_reports(error_id),
  from_status  TEXT,                         -- NULL for the initial "Open" entry
  to_status    TEXT    NOT NULL,
  note         TEXT,
  changed_by   INTEGER NOT NULL REFERENCES users(id),
  changed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_history_error ON error_status_history(error_id, changed_at);

-- Corrections made by managers to classification fields (append-only).
CREATE TABLE IF NOT EXISTS error_report_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  error_id    TEXT    NOT NULL REFERENCES error_reports(error_id),
  field       TEXT    NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  INTEGER NOT NULL REFERENCES users(id),
  changed_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_revisions_error ON error_report_revisions(error_id);

-- Key/value settings (e.g. spreadsheet sync key)
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- ---------------------------------------------------------------------
-- Integrity rules enforced by the database itself
-- ---------------------------------------------------------------------

-- Error reports are never deleted.
CREATE TRIGGER IF NOT EXISTS trg_reports_no_delete
BEFORE DELETE ON error_reports
BEGIN
  SELECT RAISE(ABORT, 'Error reports cannot be deleted');
END;

-- The original submission is immutable.
CREATE TRIGGER IF NOT EXISTS trg_reports_original_immutable
BEFORE UPDATE OF error_id, client_submission_id, box_id, order_id, description,
                 photo_id, reported_by, reported_at ON error_reports
WHEN NEW.error_id IS NOT OLD.error_id
  OR NEW.client_submission_id IS NOT OLD.client_submission_id
  OR NEW.box_id IS NOT OLD.box_id
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.description IS NOT OLD.description
  OR NEW.photo_id IS NOT OLD.photo_id
  OR NEW.reported_by IS NOT OLD.reported_by
  OR NEW.reported_at IS NOT OLD.reported_at
BEGIN
  SELECT RAISE(ABORT, 'Original error report fields are immutable');
END;

-- History tables are append-only.
CREATE TRIGGER IF NOT EXISTS trg_history_no_update
BEFORE UPDATE ON error_status_history
BEGIN
  SELECT RAISE(ABORT, 'Status history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_history_no_delete
BEFORE DELETE ON error_status_history
BEGIN
  SELECT RAISE(ABORT, 'Status history is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_revisions_no_update
BEFORE UPDATE ON error_report_revisions
BEGIN
  SELECT RAISE(ABORT, 'Revision log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_revisions_no_delete
BEFORE DELETE ON error_report_revisions
BEGIN
  SELECT RAISE(ABORT, 'Revision log is append-only');
END;

-- A report's order_id must match its product's order.
CREATE TRIGGER IF NOT EXISTS trg_reports_order_matches_product
BEFORE INSERT ON error_reports
WHEN NEW.order_id IS NOT (SELECT order_id FROM products WHERE box_id = NEW.box_id)
BEGIN
  SELECT RAISE(ABORT, 'order_id does not match the product box');
END;

-- ---------------------------------------------------------------------
-- Reporting view: the exact column set used by the spreadsheet,
-- dashboard and exports. Every consumer reads from here.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_error_reports;
CREATE VIEW v_error_reports AS
SELECT
  r.error_id,
  r.box_id,
  r.order_id,
  s.name              AS stage,
  c.name              AS error_type,
  r.severity,
  r.reported_at       AS timestamp,
  r.status,
  r.photo_id          AS photo_image,
  r.description,
  r.requires_rework,
  r.resolution_notes,
  r.status_changed_at,
  r.resolved_at,
  r.updated_at,
  r.stage_id,
  r.category_id,
  r.reported_by,
  u.full_name         AS reported_by_name,
  p.product_name,
  p.produced_at
FROM error_reports r
JOIN production_stages s ON s.id = r.stage_id
JOIN error_categories  c ON c.id = r.category_id
JOIN users             u ON u.id = r.reported_by
JOIN products          p ON p.box_id = r.box_id;
