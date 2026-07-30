CREATE TABLE agent_runtimes (
  binding_id text NOT NULL REFERENCES room_agent_bindings(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES users(device_id) ON DELETE CASCADE,
  readiness text NOT NULL CHECK (readiness IN ('ready', 'notReady')),
  ready_for_binding_policy_revision bigint
    CHECK (ready_for_binding_policy_revision IS NULL OR ready_for_binding_policy_revision > 0),
  runtime_capabilities_version bigint NOT NULL CHECK (runtime_capabilities_version >= 0),
  local_config_revision bigint NOT NULL CHECK (local_config_revision >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (binding_id, device_id),
  CHECK (
    (readiness = 'ready' AND ready_for_binding_policy_revision IS NOT NULL) OR
    (readiness = 'notReady' AND ready_for_binding_policy_revision IS NULL)
  )
);

CREATE INDEX agent_runtimes_owner_device_idx
  ON agent_runtimes(owner_user_id, device_id);

CREATE TABLE generation_requests (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  binding_id text NOT NULL,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_device_id text NOT NULL REFERENCES users(device_id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('manual', 'automatic')),
  client_generation_request_id text,
  trigger_batch_id text,
  trigger_message_ids jsonb NOT NULL,
  trigger_from_seq bigint NOT NULL CHECK (trigger_from_seq >= 0),
  trigger_through_seq bigint NOT NULL CHECK (trigger_through_seq >= trigger_from_seq),
  context_through_seq bigint NOT NULL CHECK (context_through_seq >= trigger_through_seq),
  min_visible_seq bigint NOT NULL CHECK (min_visible_seq >= 0),
  history_policy_revision bigint NOT NULL CHECK (history_policy_revision > 0),
  binding_policy_revision bigint NOT NULL CHECK (binding_policy_revision > 0),
  status text NOT NULL CHECK (status IN (
    'queued', 'claimed', 'generating', 'review_pending', 'published',
    'discarded', 'failed', 'cancelled', 'expired', 'execution_uncertain'
  )),
  request_version bigint NOT NULL CHECK (request_version > 0),
  claimed_device_id text REFERENCES users(device_id),
  lease_id text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at timestamptz,
  draft_device_id text REFERENCES users(device_id),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  supersedes_request_id text REFERENCES generation_requests(id),
  started_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(trigger_message_ids) = 'array'),
  CHECK (jsonb_array_length(trigger_message_ids) BETWEEN 1 AND 128),
  CHECK (
    (source = 'manual' AND client_generation_request_id IS NOT NULL AND trigger_batch_id IS NULL) OR
    (source = 'automatic' AND client_generation_request_id IS NULL AND trigger_batch_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX generation_requests_manual_idempotency_idx
  ON generation_requests(room_id, owner_user_id, client_generation_request_id)
  WHERE source = 'manual';

CREATE INDEX generation_requests_owner_device_created_idx
  ON generation_requests(owner_user_id, creator_device_id, created_at DESC, id DESC);

CREATE INDEX generation_requests_binding_started_idx
  ON generation_requests(binding_id, started_at)
  WHERE started_at IS NOT NULL;

ALTER TABLE messages
  ADD CONSTRAINT messages_generation_request_fk
  FOREIGN KEY (generation_request_id) REFERENCES generation_requests(id);

CREATE UNIQUE INDEX messages_generation_request_id_unique_idx
  ON messages(generation_request_id)
  WHERE generation_request_id IS NOT NULL;
