-- WhatsApp archive. JIDs are stored normalized (no device suffix). A person can appear as a phone
-- JID (…@s.whatsapp.net) or a LID (…@lid); chat_jid and sender_jid prefer the phone form when the
-- mapping is known, and lid_map holds every mapping seen.

-- Baileys auth state (credentials and Signal keys), one row per key. type 'creds' / id '' = credentials.
CREATE TABLE wa_auth (
    type       text        NOT NULL,
    id         text        NOT NULL,
    value      text        NOT NULL,  -- JSON with Baileys' BufferJSON encoding
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (type, id)
);

CREATE TABLE lid_map (
    lid        text PRIMARY KEY,
    pn         text        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
    jid           text PRIMARY KEY,
    lid           text,
    pn            text,
    name          text,  -- name saved in the address book
    notify        text,  -- name the contact set for themselves
    verified_name text,  -- business name
    username      text,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chats (
    jid             text PRIMARY KEY,
    kind            text        NOT NULL,  -- user | group | broadcast
    name            text,                  -- group subject, or chat name from WhatsApp
    archived        boolean,
    unread_count    integer,
    meta            jsonb,                 -- group metadata (description, owner, creation, …)
    last_message_at timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_participants (
    group_jid       text NOT NULL,
    participant_jid text NOT NULL,
    role            text,  -- admin | superadmin | null
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_jid, participant_jid)
);

CREATE TABLE messages (
    id            bigserial PRIMARY KEY,
    msg_id        text        NOT NULL UNIQUE,  -- WhatsApp message id (random, unique per account)
    chat_jid      text        NOT NULL,
    from_me       boolean     NOT NULL,
    sender_jid    text,                         -- author: own JID when from_me, participant in groups
    push_name     text,                         -- author's display name at send time
    sent_at       timestamptz NOT NULL,
    type          text        NOT NULL,         -- Baileys content type (conversation, imageMessage, …), 'stub' or 'ciphertext'
    body          text,                         -- text, caption, or a short description for other types
    quoted_msg_id text,                         -- the message this one replies to
    forwarded     boolean     NOT NULL DEFAULT false,
    edited_at     timestamptz,
    deleted_at    timestamptz,                  -- revoked ("deleted for everyone"); body is kept
    revision      integer     NOT NULL DEFAULT 0,
    source        text        NOT NULL,         -- live | history | append
    raw           jsonb       NOT NULL,         -- the full WAMessage, for reprocessing and media download
    ingested_at   timestamptz NOT NULL DEFAULT now(),
    search        tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED
);
CREATE INDEX messages_chat_sent ON messages (chat_jid, sent_at);
CREATE INDEX messages_sent ON messages (sent_at);
CREATE INDEX messages_search ON messages USING gin (search);

CREATE TABLE message_revisions (
    id          bigserial PRIMARY KEY,
    message_id  bigint      NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    kind        text        NOT NULL,  -- edit | delete
    prev_body   text,
    new_body    text,
    changed_at  timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_revisions_message ON message_revisions (message_id, changed_at);

-- Keyed by the target message id, so a reaction can arrive before (or without) its message.
CREATE TABLE reactions (
    target_msg_id text        NOT NULL,
    chat_jid      text        NOT NULL,
    sender_jid    text        NOT NULL,
    emoji         text        NOT NULL,
    reacted_at    timestamptz NOT NULL,
    PRIMARY KEY (target_msg_id, sender_jid)
);

-- Download queue and result for every media message.
CREATE TABLE media (
    message_id      bigint PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    kind            text        NOT NULL,  -- image | video | audio | document | sticker
    mimetype        text,
    file_name       text,
    file_length     bigint,
    seconds         integer,               -- audio/video duration
    voice_note      boolean     NOT NULL DEFAULT false,
    status          text        NOT NULL DEFAULT 'pending',  -- pending | done | failed | expired | skipped
    attempts        integer     NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    path            text,                  -- relative to the media directory
    sha256          text,
    downloaded_at   timestamptz
);
CREATE INDEX media_queue ON media (next_attempt_at) WHERE status = 'pending';

-- Convenience view: one row per message with readable chat and sender names.
CREATE VIEW messages_view AS
SELECT m.id, m.msg_id, m.chat_jid,
       coalesce(c.name, cc.name, cc.notify, cc.verified_name, split_part(m.chat_jid, '@', 1)) AS chat_name,
       c.kind AS chat_kind,
       m.from_me, m.sender_jid,
       CASE WHEN m.from_me THEN 'me'
            ELSE coalesce(sc.name, sc.notify, m.push_name, sc.verified_name, split_part(m.sender_jid, '@', 1))
       END AS sender_name,
       m.sent_at, m.type, m.body, m.quoted_msg_id, m.forwarded, m.edited_at, m.deleted_at,
       md.kind AS media_kind, md.status AS media_status, md.path AS media_path
FROM messages m
LEFT JOIN chats c ON c.jid = m.chat_jid
LEFT JOIN contacts cc ON cc.jid = m.chat_jid
LEFT JOIN contacts sc ON sc.jid = m.sender_jid
LEFT JOIN media md ON md.message_id = m.id;
