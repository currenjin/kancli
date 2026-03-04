const test = require('node:test');
const assert = require('node:assert/strict');

const { planDispatch } = require('../server');

test('dispatch limits starts to 3 workers', () => {
  const plan = planDispatch(0, ['1', '2', '3', '4', '5'], 3);
  assert.deepEqual(plan.toStart, ['1', '2', '3']);
  assert.deepEqual(plan.remaining, ['4', '5']);
});

test('dispatch keeps fifo fairness when workers are partially occupied', () => {
  const plan = planDispatch(2, ['10', '11', '12'], 3);
  assert.deepEqual(plan.toStart, ['10']);
  assert.deepEqual(plan.remaining, ['11', '12']);
});

test('dispatch is stable when no slots are available', () => {
  const plan = planDispatch(3, ['20', '21'], 3);
  assert.deepEqual(plan.toStart, []);
  assert.deepEqual(plan.remaining, ['20', '21']);
});
