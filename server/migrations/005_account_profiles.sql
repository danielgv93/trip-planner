ALTER TABLE users ADD COLUMN display_name text;
ALTER TABLE users ADD COLUMN avatar_data_url text;

UPDATE users
SET display_name = left(coalesce(nullif(split_part(email, '@', 1), ''), 'Viajero'), 80)
WHERE display_name IS NULL;

ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80);
ALTER TABLE users ADD CONSTRAINT users_avatar_data_url_length CHECK (avatar_data_url IS NULL OR char_length(avatar_data_url) <= 700000);
