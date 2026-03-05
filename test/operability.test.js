const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecoveryPendingAction } = require('../server');

test('recovery action includes retry/fallback/advance/halt guidance', () => {
  const pending = createRecoveryPendingAction({ currentStep: 0, failure: { retryUsedByStep: {} } }, 'process_error', 'recover now');
  const optionIds = pending.options.map((o) => o.id);
  assert.ok(optionIds.includes('retry'));
  assert.ok(optionIds.includes('fallback'));
  assert.ok(optionIds.includes('advance'));
  assert.ok(optionIds.includes('halt'));
  assert.equal(pending.metadata.reason, 'process_error');
});
