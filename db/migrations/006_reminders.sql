-- Reminders: an assistant's alarms. A scheduler claims the due ones (POST /reminders/due) and sends them.
-- A repeating reminder is one row per occurrence: when an occurrence fires, the next one is inserted and the
-- repeat moves to it, so snoozing or finishing a fired occurrence never touches the rest of the series.
CREATE TABLE reminders (
    id            bigserial   PRIMARY KEY,
    text          text        NOT NULL,
    due_at        timestamptz NOT NULL,
    status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'done', 'cancelled')),
    fired_at      timestamptz,
    done_at       timestamptz,
    -- repeat: every <repeat_every> <repeat_unit>s from repeat_anchor (local wall-clock time), on repeat_days
    -- (ISO weekdays, 1 = Monday) for weekly ones, until repeat_until
    repeat_unit   text        CHECK (repeat_unit IN ('day', 'week', 'month', 'year')),
    repeat_every  integer     NOT NULL DEFAULT 1 CHECK (repeat_every BETWEEN 1 AND 366),
    repeat_days   integer[],
    repeat_until  timestamptz,
    repeat_anchor timestamp,
    series_id     bigint,                                  -- on later occurrences: the first one's id
    source        text        NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'assistant')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (repeat_unit IS NULL OR repeat_anchor IS NOT NULL)
);
CREATE INDEX reminders_due ON reminders (due_at) WHERE status = 'pending';
CREATE INDEX reminders_series ON reminders (series_id);

/** The first occurrence of a repeat strictly after `after`, or NULL past `until`. Local wall-clock arithmetic in `zone`. */
CREATE FUNCTION reminder_next(anchor timestamp, unit text, step integer, days integer[], until timestamptz,
                              after timestamptz, zone text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
    local_after timestamp := after AT TIME ZONE zone;
    weekdays    integer[] := coalesce(nullif(days, '{}'), ARRAY[extract(isodow FROM anchor)::integer]);
    week0       date      := date_trunc('week', anchor)::date;
    d           date;
    n           integer;
    c           timestamp;
    result      timestamptz;
BEGIN
    IF unit = 'week' THEN
        d := greatest(anchor::date, local_after::date);
        -- a matching day lies within one cycle of step weeks
        FOR i IN 0 .. 7 * step + 7 LOOP
            c := (d + i) + anchor::time;
            IF c > anchor AND (c AT TIME ZONE zone) > after AND extract(isodow FROM c)::integer = ANY (weekdays)
               AND (((d + i) - week0) / 7) % step = 0 THEN
                result := c AT TIME ZONE zone;
                EXIT;
            END IF;
        END LOOP;
    ELSE
        -- start near the answer (counting from the anchor, so the 31st stays the 31st where it exists)
        n := greatest(1, CASE unit
            WHEN 'day' THEN floor(extract(epoch FROM local_after - anchor) / 86400 / step)::integer
            WHEN 'month' THEN ((extract(year FROM local_after) - extract(year FROM anchor)) * 12
                               + extract(month FROM local_after) - extract(month FROM anchor))::integer / step - 1
            ELSE (extract(year FROM local_after) - extract(year FROM anchor))::integer / step - 1
        END);
        LOOP
            c := anchor + CASE unit
                WHEN 'day' THEN make_interval(days => n * step)
                WHEN 'month' THEN make_interval(months => n * step)
                ELSE make_interval(years => n * step)
            END;
            IF (c AT TIME ZONE zone) > after THEN
                result := c AT TIME ZONE zone;
                EXIT;
            END IF;
            n := n + 1;
        END LOOP;
    END IF;
    IF until IS NOT NULL AND result > until THEN
        RETURN NULL;
    END IF;
    RETURN result;
END $$;

GRANT INSERT, UPDATE ON reminders TO api_access;
GRANT USAGE ON SEQUENCE reminders_id_seq TO api_access;
