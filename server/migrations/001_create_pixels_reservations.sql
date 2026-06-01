-- Migration: add a reservation table and track reservation tokens for reserved pixels.

CREATE TABLE IF NOT EXISTS pixels_reservations (
  reservation_token text PRIMARY KEY,
  pixel_count integer NOT NULL CHECK (pixel_count > 0),
  expected_total_wei text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pixels_reservations_expires_at ON pixels_reservations (expires_at);

ALTER TABLE IF EXISTS pixels
  ADD COLUMN IF NOT EXISTS reservation_token text;

CREATE INDEX IF NOT EXISTS idx_pixels_reservation_token ON pixels (reservation_token);
