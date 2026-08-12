CREATE TABLE trips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    document jsonb NOT NULL,
    document_hash text NOT NULL,
    current_revision bigint NOT NULL CHECK (current_revision >= 1),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (owner_id, id)
);
CREATE INDEX trips_owner_updated_idx ON trips(owner_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE trip_revisions (
    trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    revision bigint NOT NULL CHECK (revision >= 1),
    document jsonb NOT NULL,
    document_hash text NOT NULL,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    device_id text,
    origin text NOT NULL DEFAULT 'user',
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (trip_id, revision)
);
CREATE INDEX trip_revisions_recent_idx ON trip_revisions(trip_id, revision DESC);

CREATE TABLE trip_mutations (
    trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    client_mutation_id uuid NOT NULL,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base_revision bigint NOT NULL,
    result_revision bigint NOT NULL,
    result_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (trip_id, client_mutation_id)
);
CREATE INDEX trip_mutations_owner_idx ON trip_mutations(owner_id, created_at DESC);
