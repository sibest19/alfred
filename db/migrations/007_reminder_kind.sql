-- A reminder is for the user (kind 'reminder': the scheduler sends its text) or for the assistant itself
-- (kind 'check': the scheduler wakes the agent with it, to look into something and report only if needed).
ALTER TABLE reminders ADD COLUMN kind text NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder', 'check'));
