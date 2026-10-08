import { expect, test } from 'bun:test';

import { MAX_LABEL, validateLabel } from '../../protocol/names';
import { generateLabel, NAME_SPACE } from './names';
import { ADJECTIVES, NOUNS } from './words';

/**
 * The mechanical half of the word-list rules; `words.ts` holds the judgement
 * half. A failure here is a word to fix in the list, not a rule to relax.
 */

test('every word is 3 to 9 lowercase letters, and appears once across both lists', () => {
  const all = [...ADJECTIVES, ...NOUNS];
  expect(all.filter((word) => !/^[a-z]{3,9}$/.test(word))).toEqual([]);
  expect(all.filter((word, index) => all.indexOf(word) !== index)).toEqual([]);
});

/**
 * Pairs that sound alike. At most one of each may be in the lists, or a name
 * read aloud could land on someone else's. Not exhaustive — it pins the pairs
 * that are easy to reintroduce while adding words.
 */
const HOMOPHONES = [
  ['pear', 'pair'], ['bear', 'bare'], ['deer', 'dear'], ['sun', 'son'],
  ['rain', 'reign'], ['sail', 'sale'], ['whale', 'wail'], ['moose', 'mousse'],
  ['flower', 'flour'], ['carrot', 'carat'], ['chili', 'chilly'],
  ['plum', 'plumb'], ['horse', 'hoarse'], ['beet', 'beat'], ['bean', 'been'],
  ['leek', 'leak'], ['thyme', 'time'], ['mussel', 'muscle'], ['maize', 'maze'],
  ['wood', 'would'], ['fir', 'fur'], ['boar', 'bore'], ['hare', 'hair'],
  ['mane', 'main'], ['tail', 'tale'], ['night', 'knight'], ['rose', 'rows'],
  ['sea', 'see'], ['bee', 'be'], ['pail', 'pale'], ['plane', 'plain'],
  ['cymbal', 'symbol'], ['lute', 'loot'], ['desert', 'dessert'],
  ['currant', 'current'], ['colonel', 'kernel'], ['yolk', 'yoke'],
  ['sundae', 'sunday'], ['isle', 'aisle'], ['sleigh', 'slay'], ['oar', 'ore'],
  ['steel', 'steal'], ['flea', 'flee'], ['hay', 'hey'], ['knot', 'not'],
];

test('no two words sound alike', () => {
  const words = new Set([...ADJECTIVES, ...NOUNS]);
  expect(HOMOPHONES.filter(([a, b]) => words.has(a!) && words.has(b!))).toEqual([]);
});

/**
 * Half a billion names (counting only the pairs that fit MAX_LABEL), more than
 * the six random characters they replaced in the old Ender Wallet.
 * Guessing names matters less than it did — the resolver caps how many
 * addresses one name can burn — but the list is kept large enough that names
 * stay hard to walk, and so a typo rarely lands on a real one.
 */
test('the name space is at least half a billion', () => {
  expect(NAME_SPACE).toBeGreaterThanOrEqual(500_000_000);
});

test('generated IDs: <adjective>-<noun>-<100..999> from the lists, every one a valid Ender ID, no repeats', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const label = generateLabel();
    const [adjective, noun, number] = label.split('-');
    expect(ADJECTIVES).toContain(adjective!);
    expect(NOUNS).toContain(noun!);
    expect(Number(number)).toBeGreaterThanOrEqual(100);
    expect(Number(number)).toBeLessThanOrEqual(999);
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL);
    expect(validateLabel(label)).toBeUndefined();
    seen.add(label);
  }
  // 500 draws from half a billion names: a repeat means the randomness is broken.
  expect(seen.size).toBe(500);
});

test('every word fits beside the shortest word of the other list, so none is dead weight', () => {
  const shortest = (words: readonly string[]) => Math.min(...words.map((w) => w.length));
  expect(ADJECTIVES.filter((a) => a.length + shortest(NOUNS) + 5 > MAX_LABEL)).toEqual([]);
  expect(NOUNS.filter((n) => n.length + shortest(ADJECTIVES) + 5 > MAX_LABEL)).toEqual([]);
});
