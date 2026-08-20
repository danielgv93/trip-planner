-- Until now `trips.owner_id` carried two jobs at once: it said who owned a trip
-- AND it was the authorization predicate of every query (`WHERE owner_id = $1`).
-- Collaboration splits them. `trip_members` becomes the access list;
-- `trips.owner_id` stays the single source of truth for ownership — deletion
-- rights and the account cascade — mirrored by exactly one 'owner' member row.
CREATE TABLE trip_members (
    trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
    -- Archiving is per collaborator: tidying your own library must never hide
    -- the trip from the rest of the group.
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (trip_id, user_id)
);
CREATE INDEX trip_members_user_idx ON trip_members(user_id);
CREATE UNIQUE INDEX trip_members_single_owner_idx ON trip_members(trip_id) WHERE role = 'owner';

INSERT INTO trip_members(trip_id, user_id, role, archived_at)
SELECT id, owner_id, 'owner', archived_at FROM trips;

DROP INDEX trips_owner_updated_idx;
CREATE INDEX trips_updated_idx ON trips(updated_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE trips DROP COLUMN archived_at;

-- Idempotency belongs to the trip and the mutation id, not to the account: two
-- collaborators mint different client mutation ids, and replaying one must
-- return the same revision no matter who asks.
ALTER TABLE trip_mutations RENAME COLUMN owner_id TO actor_user_id;
ALTER INDEX trip_mutations_owner_idx RENAME TO trip_mutations_actor_idx;
