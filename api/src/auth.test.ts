import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorizer, SCOPES } from './auth.js';

const legacy = 'legacy-test-token-0123456789';
const reader = 'reader-test-token-0123456789';
const scoped = JSON.stringify({ hermes: { token: reader, scopes: ['archive.read'] } });

test('legacy credential remains compatible with every current scope', () => {
  const authorize = createAuthorizer(legacy);
  assert.deepEqual([...authorize('Bearer ' + legacy)!], [...SCOPES]);
  assert.ok(authorize(legacy)?.has('calendar.delete'));
});

test('archive reader cannot read personal notes/mail or write/claim anything', () => {
  const authorize = createAuthorizer(legacy, scoped);
  assert.deepEqual([...authorize('bearer ' + reader)!], ['archive.read']);
  for (const scope of SCOPES.filter((s) => s !== 'archive.read')) {
    assert.equal(authorize('Bearer ' + reader)?.has(scope), false, scope);
  }
  assert.ok(authorize('Bearer ' + legacy)?.has('reminders.claim'));
});

test('separate callers receive only their own explicit scopes', () => {
  const calendar = 'calendar-test-token-0123456789';
  const authorize = createAuthorizer(legacy, JSON.stringify({
    hermes: { token: reader, scopes: ['archive.read'] },
    calendar: { token: calendar, scopes: ['calendar.read', 'calendar.create'] },
  }));
  assert.deepEqual([...authorize('Bearer ' + calendar)!], ['calendar.read', 'calendar.create']);
  assert.equal(authorize('Bearer ' + calendar)?.has('calendar.delete'), false);
  assert.equal(authorize('Bearer ' + calendar)?.has('archive.read'), false);
  assert.equal(authorize('Bearer ' + reader)?.has('calendar.read'), false);
});

test('absent, wrong and partial credentials never authenticate', () => {
  const authorize = createAuthorizer(legacy, scoped);
  for (const header of [undefined, '', 'Bearer ', 'Bearer wrong', 'Basic ' + reader, 'Bearer ' + reader.slice(1)]) {
    assert.equal(authorize(header), undefined);
  }
});

test('misconfigured permissions fail closed without exposing credentials', () => {
  assert.throws(() => createAuthorizer('short'), /API_TOKEN/);
  for (const value of ['{', 'null', '[]', '"string"', '{"bad":null}']) {
    assert.throws(() => createAuthorizer(legacy, value));
  }
  for (const credential of [
    { token: 'short', scopes: ['archive.read'] },
    { token: reader, scopes: [] },
    { token: reader, scopes: ['*'] },
    { token: reader, scopes: ['archive.reed'] },
    { token: reader, scopes: 'archive.read' },
    { token: reader, scope: ['archive.read'] },
    { token: reader + ' ', scopes: ['archive.read'] },
    { token: legacy, scopes: ['archive.read'] },
  ]) {
    assert.throws(() => createAuthorizer(legacy, JSON.stringify({ hermes: credential })), (error: Error) => {
      assert.ok(!error.message.includes(reader) && !error.message.includes(legacy));
      return true;
    });
  }
  assert.throws(() => createAuthorizer(legacy, JSON.stringify({
    first: { token: reader, scopes: ['archive.read'] }, second: { token: reader, scopes: ['calendar.delete'] },
  })), /distinct/);
});
