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

test('validateActionResolutionPayload rejects empty input and bad metadata', () => {
  const pending = createPendingAction('selection', 'pick', [{ id: 'approve', label: 'Approve' }], {});
  const empty = validateActionResolutionPayload({ input: '' }, pending);
  assert.equal(empty.error, 'input은 필수입니다.');

  const badMeta = validateActionResolutionPayload({ input: 'approve', metadata: [] }, pending);
  assert.equal(badMeta.error, 'metadata는 객체여야 합니다.');
});

test('stale pending action is detected and converted to recovery action', () => {
  const ticket = {
    status: 'waiting',
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

test('validateActionResolutionPayload supports text and option input', () => {
  const pending = createPendingAction('hybrid', 'why?', [{ id: 'reply', label: '답변 제출' }], { source: 'runtime' });

  const ok = validateActionResolutionPayload({ input: 'because test', metadata: { via: 'ui' } }, pending);
  assert.equal(ok.error, undefined);
  assert.equal(ok.actionId, 'submit_text');
  assert.equal(ok.input, 'because test');

  const optionPick = validateActionResolutionPayload({ input: 'reply' }, pending);
  assert.equal(optionPick.actionId, 'reply');
  assert.ok(optionPick.selected);

  const empty = validateActionResolutionPayload({ input: '   ' }, pending);
  assert.equal(empty.error, 'input은 필수입니다.');
});
