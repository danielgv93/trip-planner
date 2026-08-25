-- Additive rollout metadata for the granular collaboration protocol. Legacy
-- snapshot rows deliberately keep NULL operation metadata and remain readable.
ALTER TABLE trips
    ADD COLUMN sync_protocol_version smallint NOT NULL DEFAULT 0
        CHECK (sync_protocol_version BETWEEN 0 AND 1);

ALTER TABLE trip_revisions
    ADD COLUMN protocol_version smallint,
    ADD COLUMN client_mutation_id uuid,
    ADD COLUMN operation_kind text,
    ADD COLUMN target_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN operation jsonb;

ALTER TABLE trip_revisions
    ADD CONSTRAINT trip_revisions_protocol_shape CHECK (
        (protocol_version IS NULL AND client_mutation_id IS NULL AND operation_kind IS NULL AND operation IS NULL)
        OR
        (protocol_version = 1 AND client_mutation_id IS NOT NULL AND operation_kind IS NOT NULL AND operation IS NOT NULL)
    ),
    ADD CONSTRAINT trip_revisions_target_keys_array CHECK (jsonb_typeof(target_keys) = 'array');

ALTER TABLE trip_mutations
    ADD COLUMN protocol_version smallint,
    ADD COLUMN operation_kind text,
    ADD COLUMN target_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN operation jsonb,
    ADD COLUMN result_kind text NOT NULL DEFAULT 'accepted'
        CHECK (result_kind IN ('accepted', 'no-op', 'conflict')),
    ADD COLUMN result jsonb;

ALTER TABLE trip_mutations
    ADD CONSTRAINT trip_mutations_protocol_shape CHECK (
        (protocol_version IS NULL AND operation_kind IS NULL AND operation IS NULL)
        OR
        (protocol_version = 1 AND operation_kind IS NOT NULL AND operation IS NOT NULL)
    ),
    ADD CONSTRAINT trip_mutations_target_keys_array CHECK (jsonb_typeof(target_keys) = 'array');

CREATE INDEX trip_revisions_operations_idx
    ON trip_revisions(trip_id, revision)
    WHERE protocol_version = 1;
CREATE INDEX trip_mutations_expiry_idx ON trip_mutations(created_at);

-- Presence is intentionally unlogged: losing it on restart is safe and every
-- browser recreates it via heartbeat. TTL is the correctness mechanism.
CREATE UNLOGGED TABLE trip_presence (
    trip_id uuid NOT NULL,
    presence_session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    state text NOT NULL CHECK (state IN ('viewing', 'editing')),
    target_type text NOT NULL,
    target_id text NOT NULL,
    target_field text,
    sequence bigint NOT NULL CHECK (sequence >= 0),
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (trip_id, presence_session_id),
    FOREIGN KEY (trip_id, user_id)
        REFERENCES trip_members(trip_id, user_id) ON DELETE CASCADE
);
CREATE INDEX trip_presence_trip_expiry_idx ON trip_presence(trip_id, expires_at);
CREATE INDEX trip_presence_expiry_idx ON trip_presence(expires_at);
