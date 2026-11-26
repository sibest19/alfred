-- Drops the notes, consolidations and reminders of the retired n8n agent (003-007); the API no longer reads them.
-- A pending reminder would be lost without notice, so the migration refuses while one exists.
DO $$ BEGIN
    IF to_regclass('reminders') IS NOT NULL THEN
        -- a separate statement: it is only parsed when the table exists
        IF EXISTS (SELECT FROM reminders WHERE status = 'pending') THEN
            RAISE EXCEPTION 'migration 008 refuses to drop reminders: pending reminders exist; export them, then cancel them'
                USING HINT = 'Export the pending reminders (SELECT * FROM reminders WHERE status = ''pending''), '
                    'move them to another reminder system, cancel them (UPDATE reminders SET status = ''cancelled'' '
                    'WHERE status = ''pending''), then restart ingest.';
        END IF;
    END IF;
END $$;

DROP TABLE IF EXISTS consolidations, reminders, notes;
DROP FUNCTION IF EXISTS reminder_next(timestamp, text, integer, integer[], timestamptz, timestamptz, text);
