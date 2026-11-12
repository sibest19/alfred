// The to-do format the phones ring for, and completing plain and repeating to-dos.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ICAL from 'ical.js';
import { fromWall } from './clock.js';
import { complete, newTodo, vtodoOf } from './todos.js';

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
