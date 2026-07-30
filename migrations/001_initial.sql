CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id text PRIMARY KEY,
  device_id text NOT NULL UNIQUE,
  handle text NOT NULL UNIQUE,
  display_name text NOT NULL,
  nickname_key text NOT NULL UNIQUE,
  avatar_resource_id text,
  profile_revision integer NOT NULL CHECK (profile_revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);

CREATE TABLE rooms (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id),
  title text NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  history_visibility text NOT NULL DEFAULT 'after_join'
    CHECK (history_visibility = 'after_join'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE room_members (
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_seq bigint NOT NULL CHECK (joined_seq >= 0),
  read_seq bigint NOT NULL CHECK (read_seq >= 0),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX room_members_user_id_idx ON room_members(user_id);

CREATE TABLE room_invites (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_by_user_id text NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  remaining_uses integer NOT NULL CHECK (remaining_uses BETWEEN 0 AND max_uses),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX room_invites_room_id_idx ON room_invites(room_id);

CREATE TABLE messages (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq > 0),
  client_message_id text NOT NULL,
  sender jsonb NOT NULL,
  content jsonb NOT NULL,
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_to_message_id text REFERENCES messages(id),
  generation_request_id text,
  trigger_through_seq bigint,
  created_at timestamptz NOT NULL,
  UNIQUE (room_id, seq),
  UNIQUE (room_id, client_message_id)
);

CREATE INDEX messages_room_seq_idx ON messages(room_id, seq);

CREATE TABLE idempotency_records (
  principal_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (principal_id, operation, idempotency_key)
);

CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  room_id text,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  dispatched_at timestamptz
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events(id)
  WHERE dispatched_at IS NULL;
