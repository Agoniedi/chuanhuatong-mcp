ALTER TABLE users DROP CONSTRAINT IF EXISTS users_nickname_key_key;
CREATE INDEX IF NOT EXISTS users_nickname_key_idx ON users(nickname_key);

ALTER TABLE user_devices
  ADD COLUMN kind text NOT NULL DEFAULT 'mcp'
    CHECK (kind IN ('mcp', 'web', 'legacy')),
  ADD COLUMN label text NOT NULL DEFAULT 'Existing device';

UPDATE user_devices
   SET kind = 'web', label = 'Existing web session'
 WHERE device_id LIKE 'web\_%' ESCAPE '\';

CREATE TABLE web_accounts (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL,
  username_key text NOT NULL UNIQUE,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE web_binding_codes (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE web_password_reset_codes (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE profile_resources (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  content bytea NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
  created_at timestamptz NOT NULL
);

CREATE INDEX profile_resources_owner_user_id_idx
  ON profile_resources(owner_user_id);

CREATE TABLE web_room_reads (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  read_seq bigint NOT NULL CHECK (read_seq >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, room_id)
);
