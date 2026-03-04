const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPendingAction,
  isPendingActionExpired,
  validateActionResolutionPayload,
  expireStalePendingAction,
} = require('../server');

test('createPendingAction normalizes shape and injects ttl fields', () => {
  const pending = createPendingAction('', '', [{ label: 'Retry' }, null], null);
  assert.equal(pending.type, 'selection');
  assert.equal(pending.prompt, '입력이 필요합니다.');
  assert.equal(pending.options.length, 1);
  assert.equal(pending.options[0].id, 'option_1');
  assert.equal(typeof pending.createdAt, 'number');
  assert.equal(typeof pending.expiresAt, 'number');
  assert.ok(pending.expiresAt > pending.createdAt);
});

test('validateActionResolutionPayload rejects unknown action and bad metadata', () => {
  const pending = createPendingAction('selection', 'pick', [{ id: 'approve', label: 'Approve' }], {});
  const unknown = validateActionResolutionPayload({ actionId: 'nope' }, pending);
  assert.match(unknown.error, /알 수 없는 actionId/);

  const badMeta = validateActionResolutionPayload({ actionId: 'approve', metadata: [] }, pending);
  assert.equal(badMeta.error, 'metadata는 객체여야 합니다.');
});

test('stale pending action is detected and converted to recovery action', () => {
  const ticket = {
    status: 'awaiting_input',
    pendingAction: {
      ...createPendingAction('selection', 'old action', [{ id: 'approve', label: 'Approve' }], {}),
      expiresAt: Date.now() - 1,
    },
  };

  assert.equal(isPendingActionExpired(ticket.pendingAction), true);
  const changed = expireStalePendingAction(ticket);
  assert.equal(changed, true);
  assert.equal(ticket.status, 'blocked');
  assert.equal(ticket.pendingAction.metadata.reason, 'stale_action_expired');
  assert.equal(ticket.pendingAction.options[0].id, 'retry');
});
