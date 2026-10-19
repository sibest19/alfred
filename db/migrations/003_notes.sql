-- Notes: long-term memory written by an assistant (on request or on its own), read and written through the API.
CREATE TABLE notes (
    id         bigserial PRIMARY KEY,
    kind       text        NOT NULL DEFAULT 'note',    -- note | fact | preference | idea | link | todo
    title      text        NOT NULL,
    content    text        NOT NULL,
    tags       text[]      NOT NULL DEFAULT '{}',      -- lowercase
    source     text        NOT NULL DEFAULT 'assistant', -- user (asked to save it) | assistant (chose to)
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,                             -- soft delete: the row is kept
    search     tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', content), 'C')) STORED
);
CREATE INDEX notes_search ON notes USING gin (search);
CREATE INDEX notes_tags ON notes USING gin (tags);
CREATE INDEX notes_recent ON notes (updated_at DESC) WHERE deleted_at IS NULL;

-- The API's privileges: read the archive, write notes. Grant this role to the API's login
-- (see the README); wa_auth stays private to the ingester.
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_access') THEN
        CREATE ROLE api_access NOLOGIN;
    END IF;
END $$;
GRANT archive_reader TO api_access;
GRANT INSERT, UPDATE ON notes TO api_access;
GRANT USAGE ON SEQUENCE notes_id_seq TO api_access;
