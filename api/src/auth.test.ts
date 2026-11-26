import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorizer, SCOPES } from './auth.js';

const retired = 'legacy-test-token-0123456789';
const reader = 'reader-test-token-0123456789';
const scoped = JSON.stringify({ hermes: { token: reader, scopes: ['archive.read'] } });

test('scoped credentials are the only credential source', () => {
  for (const value of ['', '  ', '{}']) assert.throws(() => createAuthorizer(value), /API_SCOPED_TOKENS/);
});

test('archive reader cannot read mail or write anything', () => {
  const authorize = createAuthorizer(scoped);
  assert.deepEqual([...authorize('bearer ' + reader)!.scopes], ['archive.read']);
  for (const scope of SCOPES.filter((s) => s !== 'archive.read')) {
    assert.equal(authorize('Bearer ' + reader)?.scopes.has(scope), false, scope);
  }
  assert.equal(authorize('Bearer ' + reader)?.name, 'hermes');
});

test('separate callers receive only their own explicit scopes', () => {
  const calendar = 'calendar-test-token-0123456789';
  const authorize = createAuthorizer(JSON.stringify({
    hermes: { token: reader, scopes: ['archive.read'] },
    calendar: { token: calendar, scopes: ['calendar.read', 'calendar.create'] },
  }));
  assert.deepEqual([...authorize('Bearer ' + calendar)!.scopes], ['calendar.read', 'calendar.create']);
  assert.equal(authorize('Bearer ' + calendar)?.scopes.has('calendar.delete'), false);
  assert.equal(authorize('Bearer ' + calendar)?.scopes.has('archive.read'), false);
  assert.equal(authorize('Bearer ' + reader)?.scopes.has('calendar.read'), false);
});

test('absent, wrong, partial and retired credentials never authenticate', () => {
  const authorize = createAuthorizer(scoped);
  for (const header of [undefined, '', 'Bearer ', 'Bearer wrong', 'Basic ' + reader, 'Bearer ' + reader.slice(1), 'Bearer ' + retired]) {
    assert.equal(authorize(header), undefined);
  }
});

test('misconfigured permissions fail closed without exposing credentials', () => {
  for (const value of ['{', 'null', '[]', '"string"', '{"bad":null}']) {
    assert.throws(() => createAuthorizer(value));
  }
  for (const credential of [
    { token: 'short', scopes: ['archive.read'] },
    { token: reader, scopes: [] },
    { token: reader, scopes: ['*'] },
    { token: reader, scopes: ['archive.reed'] },
    // scopes of the removed notes, reminders and speech-to-text routes
    { token: reader, scopes: ['notes.read'] },
    { token: reader, scopes: ['reminders.claim'] },
    { token: reader, scopes: ['audio.transcribe'] },
    { token: reader, scopes: 'archive.read' },
    { token: reader, scope: ['archive.read'] },
    { token: reader + ' ', scopes: ['archive.read'] },
  ]) {
    assert.throws(() => createAuthorizer(JSON.stringify({ hermes: credential })), (error: Error) => {
      assert.ok(!error.message.includes(reader));
      return true;
    });
  }
  assert.throws(() => createAuthorizer(JSON.stringify({
    first: { token: reader, scopes: ['archive.read'] }, second: { token: reader, scopes: ['calendar.delete'] },
  })), /distinct/);
});
