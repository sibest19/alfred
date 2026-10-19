-- Notes get a place in a hierarchy (topic, a path like "people/giulia"), one summary note per topic
-- (kind 'summary'), and a link to the note they were merged into. A consolidation job (an agent) keeps
-- them tidy; consolidations records its runs, so it only works when notes changed since the last one.
ALTER TABLE notes
    ADD COLUMN topic       text,                                -- lowercase path, first segment from a fixed list
    ADD COLUMN merged_into bigint REFERENCES notes (id);        -- set with deleted_at when merged into another note
CREATE INDEX notes_topic ON notes (topic text_pattern_ops) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX notes_one_summary_per_topic ON notes (topic) WHERE kind = 'summary' AND deleted_at IS NULL;

CREATE TABLE consolidations (
    id          bigserial PRIMARY KEY,
    started_at  timestamptz NOT NULL,
    finished_at timestamptz NOT NULL DEFAULT now(),
    changes     integer     NOT NULL DEFAULT 0,
    report      text
);

GRANT INSERT ON consolidations TO api_access;
GRANT USAGE ON SEQUENCE consolidations_id_seq TO api_access;
