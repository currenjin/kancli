const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeJsonAtomic,
  loadJsonWithRecovery,
  repairDbState,
} = require('../server');

test('writeJsonAtomic persists data and creates backup on overwrite', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kancli-atomic-'));
  const file = path.join(tempDir, 'db.json');

  writeJsonAtomic(file, { value: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { value: 1 });

  writeJsonAtomic(file, { value: 2 });
  assert.equal(fs.existsSync(`${file}.bak`), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { value: 2 });
});

test('loadJsonWithRecovery restores from backup on corruption', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kancli-recover-'));
  const file = path.join(tempDir, 'db.json');
  fs.writeFileSync(file, '{bad json');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ ok: true }));

  const loaded = loadJsonWithRecovery(file, { ok: false });
  assert.deepEqual(loaded, { ok: true });
  assert.equal(fs.existsSync(file), true);
  const corruptFiles = fs.readdirSync(tempDir).filter((name) => name.startsWith('db.json.corrupt-'));
  assert.equal(corruptFiles.length, 1);
});

test('repairDbState removes invalid queue references and normalizes defaults', () => {
  const repaired = repairDbState({
    nextId: 0,
    queue: ['1', '2', 3],
    tickets: [{ id: '1' }, { id: 2 }, null],
  });

  assert.equal(repaired.nextId, 1);
  assert.deepEqual(repaired.queue, ['1']);
  assert.equal(repaired.tickets.length, 1);
});
