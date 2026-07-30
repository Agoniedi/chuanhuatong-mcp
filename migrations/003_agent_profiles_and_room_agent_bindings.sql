CREATE TABLE agent_profiles (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL
    CHECK (char_length(display_name) BETWEEN 1 AND 80 AND btrim(display_name) <> ''),
  avatar_resource_id text
    CHECK (avatar_resource_id IS NULL OR char_length(avatar_resource_id) BETWEEN 1 AND 128),
  short_bio text NOT NULL CHECK (char_length(short_bio) <= 500),
  profile_revision bigint NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, owner_user_id)
);

CREATE INDEX agent_profiles_owner_user_id_idx
  ON agent_profiles(owner_user_id);

CREATE TABLE room_agent_bindings (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_profile_id text NOT NULL,
  participation_mode text NOT NULL
    CHECK (participation_mode IN ('off', 'manual', 'automatic')),
  publish_mode text NOT NULL
    CHECK (publish_mode IN ('reviewRequired', 'automatic')),
  trigger_scope text NOT NULL
    CHECK (trigger_scope IN ('mentionsOnly', 'allHumanMessages')),
  preferred_runtime_device_id text,
  generation_limit_per_24h integer NOT NULL
    CHECK (generation_limit_per_24h BETWEEN 1 AND 1000),
  policy_revision bigint NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  updated_at timestamptz NOT NULL,
  UNIQUE (room_id, owner_user_id),
  FOREIGN KEY (agent_profile_id, owner_user_id)
    REFERENCES agent_profiles(id, owner_user_id)
);

CREATE INDEX room_agent_bindings_room_id_idx
  ON room_agent_bindings(room_id);
