ALTER TABLE users ADD COLUMN password_hash text;

COMMENT ON COLUMN users.password_hash IS
    'Versioned scrypt derivation. Nullable only for accounts created by the retired passwordless preview.';
