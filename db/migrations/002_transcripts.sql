-- Speech-to-text of downloaded audio (voice notes first). The transcript also becomes the message body,
-- so full-text search and messages_view see it; media.transcript keeps it next to the file.
ALTER TABLE media
    ADD COLUMN transcript            text,
    ADD COLUMN transcribed_at        timestamptz,
    ADD COLUMN transcribe_attempts   integer NOT NULL DEFAULT 0,
    ADD COLUMN transcribe_error      text;
CREATE INDEX media_transcribe_queue ON media (message_id)
    WHERE kind = 'audio' AND status = 'done' AND transcribed_at IS NULL;
