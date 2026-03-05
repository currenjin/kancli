const test = require('node:test');
const assert = require('node:assert/strict');

const { getPipelineColumns, sanitizeTicket } = require('../server');

test('pipeline columns preserve skill order', () => {
  const columns = getPipelineColumns(['plan', 'implement', 'review']);
  assert.deepEqual(columns.map((c) => c.name), ['plan', 'implement', 'review']);
  assert.deepEqual(columns.map((c) => c.order), [0, 1, 2]);
});

test('sanitizeTicket exposes currentSkill and done flag', () => {
  const ticket = {
    id: '10',
    jiraTicket: 'T-10',
    currentStep: 1,
    status: 'review',
    proc: { pid: 1 },
  };

  const sanitized = sanitizeTicket(ticket, ['discover', 'implement']);
  assert.equal(sanitized.currentSkill, 'implement');
  assert.equal(sanitized.isDone, false);
  assert.equal('proc' in sanitized, false);

  const done = sanitizeTicket({ ...ticket, status: 'done', currentStep: 2 }, ['discover', 'implement']);
  assert.equal(done.currentSkill, null);
  assert.equal(done.isDone, true);
});
