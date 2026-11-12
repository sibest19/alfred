// Mail ids across accounts, and the GMAIL_ACCOUNTS check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGmailAccounts } from './config.js';
import { splitMailId } from './mail.js';

test('mail ids name their account; plain ids are iCloud', () => {
  const names = ['personal'];
  assert.deepEqual(splitMailId('INBOX:4521', names), { name: 'icloud', mailbox: 'INBOX', uid: 4521 });
  assert.deepEqual(splitMailId('Sent Messages:7', names), { name: 'icloud', mailbox: 'Sent Messages', uid: 7 });
  assert.deepEqual(splitMailId('personal:[Gmail]/All Mail:12', names), { name: 'personal', mailbox: '[Gmail]/All Mail', uid: 12 });
  assert.deepEqual(splitMailId('other:INBOX:3', names), { name: 'icloud', mailbox: 'other:INBOX', uid: 3 });
  assert.equal(splitMailId('personal:INBOX', names), undefined);
  assert.equal(splitMailId('INBOX', names), undefined);
});

test('GMAIL_ACCOUNTS needs short names and both credentials', () => {
  assert.deepEqual(parseGmailAccounts('{}'), {});
  assert.deepEqual(parseGmailAccounts('{"work":{"user":"a@example.com","password":"x"}}'), { work: { user: 'a@example.com', password: 'x' } });
  for (const bad of ['[]', '{"icloud":{"user":"a","password":"x"}}', '{"Work":{"user":"a","password":"x"}}', '{"work":{"user":"a"}}'])
    assert.throws(() => parseGmailAccounts(bad));
});
