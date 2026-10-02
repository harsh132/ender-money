import { expect, test } from 'bun:test';
import { parseCode } from './codes';
import { phoneDisplay, phoneMasked, usd } from './format';

const ADDR = '0x7e9BcE1E34dAdC99A83da4EDcDb56D288afA84C5';
const addr = ADDR.toLowerCase();

test('parseCode reads addresses, payment URIs and numbers', () => {
  expect(parseCode(ADDR)).toEqual({ to: addr });
  expect(parseCode(`ethereum:${ADDR}@143?amount=2.5`)).toEqual({ to: addr, amount: '2.5' });
  expect(parseCode(`ethereum:pay-${ADDR}`)).toEqual({ to: addr });
  expect(parseCode(`ender:+919876543210?amount=10`)).toEqual({ to: '+919876543210', amount: '10' });
  expect(parseCode('98765 43210')).toEqual({ to: '+919876543210' });
  expect(parseCode(`ender:${ADDR}?amount=abc`)).toEqual({ to: addr }); // bad amount dropped, not trusted
  expect(parseCode('hello')).toBeNull();
  expect(parseCode('ethereum:0x1234')).toBeNull();
});

test('usd keeps at least two decimals and any extra precision', () => {
  expect(usd('45.2')).toBe('45.20');
  expect(usd('0.001')).toBe('0.001');
  expect(usd('1234')).toBe('1,234.00');
  expect(usd('0.048')).toBe('0.048');
});

test('phone display and mask', () => {
  expect(phoneDisplay('+919876543210')).toBe('+91 98765 43210');
  expect(phoneMasked('+919876543210')).toBe('+91 98••• ••210');
});
