ALTER TABLE rooms
  ADD COLUMN world_published boolean NOT NULL DEFAULT false,
  ADD COLUMN world_summary text NOT NULL DEFAULT '',
  ADD COLUMN world_invite_id text,
  ADD COLUMN world_invite_token text,
  ADD COLUMN world_published_at timestamptz;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_world_summary_length
  CHECK (char_length(world_summary) <= 300);
