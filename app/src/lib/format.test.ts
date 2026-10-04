import { expect, test } from 'bun:test';
import { phoneDisplay, phoneMasked, usd } from './format';

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
