'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('node-cron');
const { normalizePollInterval, isWithinHours } = require('../lib/schedule-utils');

// Regression test for the crash-loop bug (audit TZ-01): onboarding's "не проверять"
// stored email_poll_interval=0, which built the cron expression `*/0 * * * *` —
// node-cron throws on that, crashing the process on every restart.
test('normalizePollInterval: disables on 0, negative, NaN, empty, garbage', () => {
  for (const raw of [0, '0', '', 'abc', -5, null, undefined]) {
    const plan = normalizePollInterval(raw);
    assert.equal(plan.disabled, true, `expected disabled for ${JSON.stringify(raw)}`);
  }
});

test('normalizePollInterval: every produced cron expression is valid for node-cron', () => {
  for (const raw of [1, 3, 5, 15, 30, 59, 60, 61, 120, '30', '60']) {
    const plan = normalizePollInterval(raw);
    assert.equal(plan.disabled, undefined);
    assert.equal(cron.validate(plan.cron), true, `invalid cron "${plan.cron}" for input ${raw}`);
  }
});

test('normalizePollInterval: 60 schedules a true hourly cron (fires on the hour), not */59', () => {
  const plan = normalizePollInterval(60);
  assert.equal(plan.cron, '0 * * * *');
  assert.equal(plan.minutes, 60);
});

test('normalizePollInterval: below the 5-minute floor is clamped up to 5', () => {
  assert.equal(normalizePollInterval(1).minutes, 5);
  assert.equal(normalizePollInterval(3).minutes, 5);
});

test('normalizePollInterval: values already in range pass through unchanged', () => {
  assert.equal(normalizePollInterval(15).minutes, 15);
  assert.equal(normalizePollInterval(30).minutes, 30);
});

test('isWithinHours: normal same-day range', () => {
  assert.equal(isWithinHours('10:00', '09:00', '22:00'), true);
  assert.equal(isWithinHours('08:59', '09:00', '22:00'), false);
  assert.equal(isWithinHours('22:00', '09:00', '22:00'), false); // end is exclusive
  assert.equal(isWithinHours('21:59', '09:00', '22:00'), true);
});

test('isWithinHours: overnight range (start > end)', () => {
  assert.equal(isWithinHours('23:00', '22:00', '06:00'), true);
  assert.equal(isWithinHours('03:00', '22:00', '06:00'), true);
  assert.equal(isWithinHours('12:00', '22:00', '06:00'), false);
  assert.equal(isWithinHours('06:00', '22:00', '06:00'), false); // end is exclusive
});
