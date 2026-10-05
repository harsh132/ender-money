import { expect, test } from 'bun:test';
import { cleanLabel, nameStatus, RULES } from './names';

test('cleanLabel: lowercase, no spaces, without @ or .ender.my', () => {
  expect(cleanLabel(' Harsh P ')).toBe('harshp');
  expect(cleanLabel('@Harsh')).toBe('harsh');
  expect(cleanLabel('Harsh.Ender.My')).toBe('harsh');
});

test('nameStatus: rules, typing hints, local errors, then the gateway answer for this exact label', () => {
  expect(nameStatus('')).toEqual({ text: RULES, tone: 'plain', ok: false });
  expect(RULES).toBe("5 to 20 letters, numbers or hyphens. You can't change it later.");
  expect(nameStatus('x'.repeat(21))).toMatchObject({ tone: 'negative', ok: false, text: 'At most 20 characters.' });
  expect(nameStatus('har')).toMatchObject({ tone: 'plain', ok: false, text: 'At least 5 characters.' });
  expect(nameStatus('harsh-')).toMatchObject({ tone: 'plain', ok: false }); // a letter may follow
  expect(nameStatus('ha--rsh')).toMatchObject({ tone: 'negative', ok: false });
  expect(nameStatus('-harsh')).toMatchObject({ tone: 'negative', ok: false });
  expect(nameStatus('harsh_p')).toMatchObject({ tone: 'negative', ok: false });
  expect(nameStatus('support')).toMatchObject({ tone: 'negative', ok: false, text: "That one's reserved. Pick another." });
  expect(nameStatus('harsh')).toMatchObject({ text: 'Checking…', ok: false });
  expect(nameStatus('harsh', { label: 'hars', available: true })).toMatchObject({ text: 'Checking…', ok: false }); // stale answer
  expect(nameStatus('harsh', { label: 'harsh', available: true })).toEqual({ text: 'harsh.ender.my is free.', tone: 'positive', ok: true });
  expect(nameStatus('harsh', { label: 'harsh', available: false, reason: 'taken' })).toEqual({ text: 'Taken. Pick another.', tone: 'negative', ok: false });
  expect(nameStatus('harsh', { label: 'harsh', failed: true })).toMatchObject({ tone: 'plain', ok: true });
});
