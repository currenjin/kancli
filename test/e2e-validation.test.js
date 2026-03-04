const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedlineState, evaluateRedline } = require('../lib/redline');

test('scenario#1 generic action/request loop shape', () => {
  const pendingAction = {
    type: 'selection',
    prompt: 'choose next',
    options: [{ id: 'approve', label: 'Approve', payload: { advance: true } }],
  };
  assert.equal(pendingAction.type, 'selection');
  assert.equal(pendingAction.options[0].id, 'approve');
  assert.equal(pendingAction.options[0].payload.advance, true);
});

test('scenario#2 artifact accumulation/review transition model', () => {
  const ticket = { artifacts: [], status: 'running' };
  ticket.artifacts.push({ type: 'plan', name: 'A-plan.md' });
  ticket.artifacts.push({ type: 'report', name: 'report.json' });
  ticket.status = 'review';
  assert.equal(ticket.artifacts.length, 2);
  assert.equal(ticket.status, 'review');
});

test('scenario#3 redline halt transition after repeated failures and signals', () => {
  let state = createRedlineState();
  let out;
  out = evaluateRedline(state, { text: 'FAIL test 1' });
  state = out.state;
  out = evaluateRedline(state, { text: 'tests failed again' });
  state = out.state;
  out = evaluateRedline(state, { text: 'failing tests third time' });
  assert.equal(out.halted, true);
  assert.equal(out.reason, 'repeated test failures');

  state = createRedlineState();
  out = evaluateRedline(state, { signal: 'plan_violation' });
  assert.equal(out.halted, true);
  assert.equal(out.reason, 'plan-violation signal');

  state = createRedlineState();
  out = evaluateRedline(state, { signal: 'invalid_plan' });
  assert.equal(out.halted, true);
  assert.equal(out.reason, 'invalid-plan signal');
});
