// Mail ids across accounts, and the GMAIL_ACCOUNTS check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGmailAccounts } from './config.js';
import { splitMailId } from './mail.js';

test('Gmail ids and iCloud ids never collide; legacy iCloud ids keep their meaning', () => {
  assert.deepEqual(splitMailId('INBOX:4521'), { name: 'icloud', mailbox: 'INBOX', uid: 4521 });
  assert.deepEqual(splitMailId('Sent Messages:7'), { name: 'icloud', mailbox: 'Sent Messages', uid: 7 });
  // an iCloud mailbox named like a Gmail account stays iCloud, whatever accounts exist
  assert.deepEqual(splitMailId('personal:4521'), { name: 'icloud', mailbox: 'personal', uid: 4521 });
  assert.deepEqual(splitMailId('personal:INBOX:4521'), { name: 'icloud', mailbox: 'personal:INBOX', uid: 4521 });
  assert.deepEqual(splitMailId('personal#1781234567890123456'), { name: 'personal', gmailId: '1781234567890123456' });
  // a mailbox containing # still ends in :<uid>, so it is iCloud
  assert.deepEqual(splitMailId('personal#1:5'), { name: 'icloud', mailbox: 'personal#1', uid: 5 });
  for (const bad of ['INBOX', 'personal#', 'Personal#12', 'personal#12x', '#12', 'icloud#12'])
    assert.equal(splitMailId(bad), undefined, bad);
});

test('GMAIL_ACCOUNTS needs short names and both credentials', () => {
  assert.deepEqual(parseGmailAccounts('{}'), {});
  assert.deepEqual(parseGmailAccounts('{"work":{"user":"a@example.com","password":"x"}}'), { work: { user: 'a@example.com', password: 'x' } });
  for (const bad of ['[]', '{"icloud":{"user":"a","password":"x"}}', '{"Work":{"user":"a","password":"x"}}', '{"work":{"user":"a"}}'])
    assert.throws(() => parseGmailAccounts(bad));
});
