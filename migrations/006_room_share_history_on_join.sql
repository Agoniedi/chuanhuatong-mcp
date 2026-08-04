-- Handoff rooms expose their history from the seeded context onward.
-- Normal rooms keep the existing after_join history boundary.
ALTER TABLE rooms DROP CONSTRAINT rooms_history_visibility_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_history_visibility_check
  CHECK (history_visibility IN ('after_join', 'from_start'));
