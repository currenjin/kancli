const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecoveryPendingAction } = require('../server');

test('recovery action includes retry/advance/halt guidance', () => {
  const pending = createRecoveryPendingAction('process_error', 'recover now');
  const optionIds = pending.options.map((o) => o.id);
  assert.deepEqual(optionIds, ['retry', 'advance', 'halt']);
  assert.equal(pending.metadata.reason, 'process_error');
});
