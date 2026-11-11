CREATE ROLE assistant_api LOGIN PASSWORD 'trial-api-db-password' IN ROLE api_access;
INSERT INTO chats (jid, kind, name) VALUES ('trial-group@g.us', 'group', 'Trial planning');
INSERT INTO contacts (jid, name) VALUES
  ('390000000001@s.whatsapp.net', 'Ada Example'),
  ('390000000002@s.whatsapp.net', 'Simone Example');
INSERT INTO messages (id, msg_id, chat_jid, from_me, sender_jid, sent_at, type, body, source, raw) VALUES
  (1001, 'trial-ada', 'trial-group@g.us', false, '390000000001@s.whatsapp.net', '2026-11-11 10:00:00+00', 'conversation', 'Trial dinner at 18:00?', 'live', '{}'),
  (1002, 'trial-me', 'trial-group@g.us', true, '390000000003@s.whatsapp.net', '2026-11-11 10:01:00+00', 'conversation', 'Yes, trial dinner at 18:00.', 'live', '{}'),
  (1003, 'trial-other-simone', 'trial-group@g.us', false, '390000000002@s.whatsapp.net', '2026-11-11 10:02:00+00', 'conversation', 'I cannot join the trial dinner.', 'live', '{}');
