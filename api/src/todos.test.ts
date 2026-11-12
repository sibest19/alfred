// The to-do format the phones ring for, and completing plain and repeating to-dos.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ICAL from 'ical.js';
import { fromWall } from './clock.js';
import { collectionNames } from './radicale.js';
import { complete, newTodo, rename, setDue, vtodoOf } from './todos.js';

const lines = (ics: string) => ics.split('\r\n');

test('a new to-do has its due time in TZ, DTSTART alike, and an alarm at that moment', () => {
  const ics = newTodo({ title: 'Call the plumber', due: fromWall(2026, 11, 13, 15, 0), notes: '', repeat: null });
  assert.ok(lines(ics).includes('DUE;TZID=Europe/Rome:20261113T150000'));
  assert.ok(lines(ics).includes('DTSTART;TZID=Europe/Rome:20261113T150000'));
  assert.ok(lines(ics).includes('STATUS:NEEDS-ACTION'));
  const alarm = vtodoOf(ics)!.vtodo.getFirstSubcomponent('valarm')!;
  assert.equal(alarm.getFirstPropertyValue('action'), 'DISPLAY');
  assert.equal(alarm.getFirstProperty('trigger')!.toICALString(), 'TRIGGER:PT0S');
  assert.equal(alarm.getFirstPropertyValue('description'), 'Call the plumber');
});

test('a to-do without a date has no alarm', () => {
  const { vtodo } = vtodoOf(newTodo({ title: 'Buy milk', due: null, notes: 'two', repeat: null }))!;
  assert.equal(vtodo.getFirstPropertyValue('due'), null);
  assert.equal(vtodo.getAllSubcomponents('valarm').length, 0);
});

test('completing a plain to-do marks it completed', () => {
  const { vtodo } = vtodoOf(newTodo({ title: 'x', due: fromWall(2026, 11, 13, 9, 0), notes: '', repeat: null }))!;
  assert.deepEqual(complete(vtodo, fromWall(2026, 11, 13, 10, 0)), { next: null });
  assert.equal(vtodo.getFirstPropertyValue('status'), 'COMPLETED');
  assert.equal(vtodo.getFirstPropertyValue('percent-complete'), 100);
  assert.ok(vtodo.getFirstPropertyValue('completed'));
});

test('completing a repeating to-do moves it to its next occurrence after now, at the same wall-clock time across DST', () => {
  const ics = newTodo({ title: 'x', due: fromWall(2026, 10, 23, 9, 0), notes: '', repeat: ICAL.Recur.fromString('FREQ=WEEKLY') });
  const { vtodo } = vtodoOf(ics)!;
  // two weeks late, and the clocks went back on 2026-10-25
  const { next } = complete(vtodo, fromWall(2026, 11, 7, 12, 0));
  assert.deepEqual(next, fromWall(2026, 11, 13, 9, 0));
  assert.equal(vtodo.getFirstPropertyValue('status'), 'NEEDS-ACTION');
  assert.equal(vtodo.getFirstProperty('due')!.toICALString(), 'DUE;TZID=Europe/Rome:20261113T090000');
  assert.equal(vtodo.getAllSubcomponents('valarm').length, 1);
});

test('a repeating to-do done before its due time moves on to the next occurrence', () => {
  const { vtodo } = vtodoOf(newTodo({ title: 'x', due: fromWall(2026, 11, 20, 9, 0), notes: '', repeat: ICAL.Recur.fromString('FREQ=WEEKLY') }))!;
  assert.deepEqual(complete(vtodo, fromWall(2026, 11, 13, 12, 0)).next, fromWall(2026, 11, 27, 9, 0));
});

test('a repeat that has ended completes the to-do', () => {
  const ics = newTodo({ title: 'x', due: fromWall(2026, 11, 13, 9, 0), notes: '', repeat: ICAL.Recur.fromString('FREQ=DAILY;COUNT=2') });
  const { vtodo } = vtodoOf(ics)!;
  assert.deepEqual(complete(vtodo, fromWall(2026, 11, 13, 10, 0)).next, fromWall(2026, 11, 14, 9, 0));
  assert.deepEqual(complete(vtodo, fromWall(2026, 11, 14, 10, 0)), { next: null });
  assert.equal(vtodo.getFirstPropertyValue('status'), 'COMPLETED');
});

test('an iPhone to-do in UTC reads as its wall-clock time', () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:a\r\nDTSTART:20261112T115500Z\r\nDUE:20261112T115500Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n';
  const { vtodo } = vtodoOf(ics)!;
  // 11:55Z is 12:55 in Rome; the next occurrence keeps that instant's daily rhythm
  assert.deepEqual(complete(vtodo, fromWall(2026, 11, 12, 13, 0)).next, fromWall(2026, 11, 13, 12, 55));
});

const phone = (body: string) => vtodoOf(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:p\r\nSUMMARY:Old\r\n${body}END:VTODO\r\nEND:VCALENDAR\r\n`)!.vtodo;
const ADVANCE_ALARM = 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Old\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n';

test('a repeating to-do starting at 09:00 and due at 17:00 keeps both times when it moves on', () => {
  const vtodo = phone('DTSTART;TZID=Europe/Rome:20261113T090000\r\nDUE;TZID=Europe/Rome:20261113T170000\r\nRRULE:FREQ=DAILY\r\n');
  // done at 16:00, before today's 17:00: tomorrow's
  assert.deepEqual(complete(vtodo, fromWall(2026, 11, 13, 16, 0)).next, fromWall(2026, 11, 14, 17, 0));
  assert.equal(vtodo.getFirstProperty('dtstart')!.toICALString(), 'DTSTART;TZID=Europe/Rome:20261114T090000');
  assert.equal(vtodo.getFirstProperty('due')!.toICALString(), 'DUE;TZID=Europe/Rome:20261114T170000');
});

test('a UTC repeating to-do stays in UTC when it moves on, across a DST change', () => {
  const vtodo = phone('DTSTART:20261023T080000Z\r\nDUE:20261023T080000Z\r\nRRULE:FREQ=DAILY\r\n');
  complete(vtodo, fromWall(2026, 10, 24, 12, 0));
  assert.equal(vtodo.getFirstProperty('due')!.toICALString(), 'DUE:20261025T080000Z');
  assert.equal(vtodo.getFirstProperty('dtstart')!.toICALString(), 'DTSTART:20261025T080000Z');
});

test('moving on shifts an alarm set at a fixed time and clears its rang mark', () => {
  const vtodo = phone('DTSTART:20261113T080000Z\r\nDUE:20261113T080000Z\r\nRRULE:FREQ=DAILY\r\n'
    + 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nACKNOWLEDGED:20261113T080100Z\r\nTRIGGER;VALUE=DATE-TIME:20261113T080000Z\r\nEND:VALARM\r\n');
  complete(vtodo, fromWall(2026, 11, 13, 10, 0));
  const alarm = vtodo.getFirstSubcomponent('valarm')!;
  assert.equal(alarm.getFirstProperty('trigger')!.toICALString(), 'TRIGGER;VALUE=DATE-TIME:20261114T080000Z');
  assert.equal(alarm.hasProperty('acknowledged'), false);
});

test('a repeat too far behind to step through is refused, and the to-do stays open', () => {
  const vtodo = phone('DTSTART:19500101T080000Z\r\nDUE:19500101T080000Z\r\nRRULE:FREQ=DAILY\r\n');
  assert.throws(() => complete(vtodo, fromWall(2026, 11, 13, 10, 0)), /too far behind/);
  assert.equal(vtodo.getFirstPropertyValue('status'), null);
});

test('renaming keeps the times and the alarms, with the new text', () => {
  const vtodo = phone(`DTSTART;TZID=Europe/Rome:20261113T090000\r\nDUE;TZID=Europe/Rome:20261113T170000\r\n${ADVANCE_ALARM}`);
  rename(vtodo, 'New');
  assert.equal(vtodo.getFirstProperty('dtstart')!.toICALString(), 'DTSTART;TZID=Europe/Rome:20261113T090000');
  const alarm = vtodo.getFirstSubcomponent('valarm')!;
  assert.equal(alarm.getFirstProperty('trigger')!.toICALString(), 'TRIGGER:-PT15M');
  assert.equal(alarm.getFirstPropertyValue('description'), 'New');
});

test('a new due time keeps the start-to-due distance and a phone\'s advance alarm', () => {
  const vtodo = phone(`DTSTART:20261113T080000Z\r\nDUE:20261113T160000Z\r\n${ADVANCE_ALARM}`);
  setDue(vtodo, fromWall(2026, 11, 20, 18, 0));
  assert.equal(vtodo.getFirstProperty('due')!.toICALString(), 'DUE;TZID=Europe/Rome:20261120T180000');
  assert.equal(vtodo.getFirstProperty('dtstart')!.toICALString(), 'DTSTART;TZID=Europe/Rome:20261120T100000');
  assert.equal(vtodo.getAllSubcomponents('valarm').length, 1);
  assert.equal(vtodo.getFirstSubcomponent('valarm')!.getFirstProperty('trigger')!.toICALString(), 'TRIGGER:-PT15M');
});

test('a repeating to-do skips its excluded occurrences, which still count towards COUNT, and refuses extra dates', () => {
  const vtodo = phone('DTSTART:20261113T080000Z\r\nDUE:20261113T080000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEXDATE:20261114T080000Z\r\n');
  complete(vtodo, fromWall(2026, 11, 13, 10, 0));
  assert.equal(vtodo.getFirstProperty('due')!.toICALString(), 'DUE:20261115T080000Z');
  // 13, 14 (excluded) passed: 15, 16 and 17 are left
  assert.equal((vtodo.getFirstPropertyValue('rrule') as ICAL.Recur).count, 3);
  const extra = phone('DTSTART:20261113T080000Z\r\nDUE:20261113T080000Z\r\nRRULE:FREQ=WEEKLY\r\nRDATE:20261115T080000Z\r\n');
  assert.throws(() => complete(extra, fromWall(2026, 11, 13, 10, 0)), /RDATE/);
});

test('collection names pick exactly one, ignoring case', () => {
  const named = (...names: string[]) => [...collectionNames(names.map((displayName, i) => ({ url: `u${i}`, displayName }))).values()];
  const labels = collectionNames(['Family', 'Family', 'Family (2)'].map((displayName, i) => ({ url: `u${i}`, displayName })));
  assert.deepEqual([labels.get('u0'), labels.get('u1'), labels.get('u2')], ['Family', 'Family (3)', 'Family (2)']);
  assert.deepEqual(named('Work', 'work'), ['Work', 'work (2)']);
  assert.equal(new Set(named('A', 'a', 'A (2)', 'a').map((n) => n.toLowerCase())).size, 4);
});
