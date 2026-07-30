CREATE TABLE user_devices (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, device_id),
  UNIQUE (device_id)
);

INSERT INTO user_devices(user_id, device_id, created_at, updated_at)
SELECT id, device_id, created_at, updated_at
  FROM users;

ALTER TABLE sessions ADD COLUMN device_id text;

UPDATE sessions s
   SET device_id = u.device_id
  FROM users u
 WHERE u.id = s.user_id;

ALTER TABLE sessions ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_user_device_fk
  FOREIGN KEY (user_id, device_id)
  REFERENCES user_devices(user_id, device_id);

ALTER TABLE agent_runtimes
  DROP CONSTRAINT agent_runtimes_device_id_fkey;
ALTER TABLE agent_runtimes
  ADD CONSTRAINT agent_runtimes_user_device_fk
  FOREIGN KEY (owner_user_id, device_id)
  REFERENCES user_devices(user_id, device_id)
  ON DELETE CASCADE;

ALTER TABLE generation_requests
  DROP CONSTRAINT generation_requests_creator_device_id_fkey,
  DROP CONSTRAINT generation_requests_claimed_device_id_fkey,
  DROP CONSTRAINT generation_requests_draft_device_id_fkey;
ALTER TABLE generation_requests
  ADD CONSTRAINT generation_requests_creator_user_device_fk
    FOREIGN KEY (owner_user_id, creator_device_id)
    REFERENCES user_devices(user_id, device_id),
  ADD CONSTRAINT generation_requests_claimed_user_device_fk
    FOREIGN KEY (owner_user_id, claimed_device_id)
    REFERENCES user_devices(user_id, device_id),
  ADD CONSTRAINT generation_requests_draft_user_device_fk
    FOREIGN KEY (owner_user_id, draft_device_id)
    REFERENCES user_devices(user_id, device_id);

ALTER TABLE room_agent_bindings
  DROP CONSTRAINT room_agent_bindings_trigger_scope_check;
ALTER TABLE room_agent_bindings
  ADD CONSTRAINT room_agent_bindings_trigger_scope_check
  CHECK (trigger_scope IN ('mentionsOnly', 'allHumanMessages', 'allMessages'));

ALTER TABLE room_agent_bindings
  ADD COLUMN runtime_lease_device_id text,
  ADD COLUMN runtime_lease_id text,
  ADD COLUMN runtime_lease_epoch bigint NOT NULL DEFAULT 0
    CHECK (runtime_lease_epoch >= 0),
  ADD COLUMN runtime_lease_expires_at timestamptz;

ALTER TABLE room_agent_bindings
  ADD CONSTRAINT room_agent_bindings_runtime_lease_shape_check
  CHECK (
    (runtime_lease_device_id IS NULL AND runtime_lease_id IS NULL AND
      runtime_lease_expires_at IS NULL) OR
    (runtime_lease_device_id IS NOT NULL AND runtime_lease_id IS NOT NULL)
  );
