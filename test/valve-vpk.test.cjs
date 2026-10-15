'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openVpk, readResource, createVpk, crc32, VpkError } = require('../src/valve-vpk.cjs');

function fixture(t) {
  const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'core-coach-vpk-'));
  t.after(() => { const target = path.resolve(root); assert.ok(target.startsWith(parent + path.sep) && path.basename(target).startsWith('core-coach-vpk-')); fs.rmSync(target, { recursive: true, force: true }); });
  return (name, data) => { const destination = path.join(root, name); fs.writeFileSync(destination, data); return destination; };
}
const hasCode = code => error => error instanceof VpkError && error.code === code;

test('standard CRC32 matches its published check vector and the empty file checksum', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('single-file VPK roundtrip preserves binary resources, multiple extensions, root files and empty files', t => {
  const save = fixture(t);
  const resources = new Map([
    ['models/heroes/drow/drow_base.vmdl_c', Buffer.from([0, 255, 3, 10, 0, 13])],
    ['models/heroes/drow/drow_weapon.vmdl_c', Buffer.from('weapon')],
    ['materials/models/drow/base.vmat_c', Buffer.from('material')],
    ['README', Buffer.from('root file without extension')],
    ['.meta', Buffer.alloc(0)],
  ]);
  const packed = createVpk(resources), filename = save('pak01_dir.vpk', packed), index = openVpk(filename);
  assert.equal(index.version, 1); assert.equal(index.entries.size, resources.size);
  for (const [name, bytes] of resources) {
    assert.equal(index.entries.get(name).archiveIndex, 0x7fff);
    assert.deepEqual(readResource(index, name), bytes);
  }
  assert.deepEqual(createVpk(resources), packed);
});

test('an empty archive is valid and missing resource lookup is explicit', t => {
  const save = fixture(t), index = openVpk(save('empty.vpk', createVpk(new Map())));
  assert.equal(index.entries.size, 0);
  assert.throws(() => readResource(index, 'missing.txt'), hasCode('VPK_NOT_FOUND'));
});

test('VPK2 external archives concatenate preload bytes with the exact external slice and verify the combined checksum', t => {
  const save = fixture(t), preload = Buffer.from('prefix:'), body = Buffer.from([0, 10, 255, 20]);
  const entry = Buffer.alloc(18); entry.writeUInt32LE(crc32(Buffer.concat([preload, body])), 0); entry.writeUInt16LE(preload.length, 4); entry.writeUInt16LE(7, 6); entry.writeUInt32LE(3, 8); entry.writeUInt32LE(body.length, 12); entry.writeUInt16LE(0xffff, 16);
  const tree = Buffer.concat([Buffer.from('bin\0scripts\0sample\0'), entry, preload, Buffer.from([0, 0, 0])]);
  const header = Buffer.alloc(28); header.writeUInt32LE(0x55aa1234, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(tree.length, 8);
  save('pak01_007.vpk', Buffer.concat([Buffer.from('pad'), body, Buffer.from('not part of resource')]));
  const index = openVpk(save('pak01_dir.vpk', Buffer.concat([header, tree])));
  assert.equal(index.version, 2);
  assert.deepEqual(readResource(index, 'scripts/sample.bin'), Buffer.concat([preload, body]));
  assert.throws(() => readResource(index, 'scripts/sample.bin', { maxBytes: 3 }), hasCode('VPK_LIMIT'));
});

test('VPK2 inline data is bounded separately from trailing checksum sections', t => {
  const save = fixture(t), original = createVpk(new Map([['a.txt', Buffer.from('content')]]));
  const treeLength = original.readUInt32LE(8), tree = original.subarray(12, 12 + treeLength), body = original.subarray(12 + treeLength);
  const header = Buffer.alloc(28); header.writeUInt32LE(0x55aa1234, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(tree.length, 8); header.writeUInt32LE(body.length, 12); header.writeUInt32LE(48, 20);
  const index = openVpk(save('v2-inline.vpk', Buffer.concat([header, tree, body, Buffer.alloc(48)])));
  assert.deepEqual(readResource(index, 'a.txt'), Buffer.from('content'));
});

test('modified payloads fail the source entry CRC without returning corrupt bytes', t => {
  const save = fixture(t), original = createVpk(new Map([['model.bin', Buffer.from('original payload')]]));
  const destination = save('corrupt.vpk', original), index = openVpk(destination);
  original[original.length - 1] ^= 1; fs.writeFileSync(destination, original);
  assert.throws(() => readResource(index, 'model.bin'), hasCode('VPK_CRC_MISMATCH'));
});

test('truncated headers, trees, inline resources and external archive slices fail closed', t => {
  const save = fixture(t), packed = createVpk(new Map([['sample.bin', Buffer.from('abcdef')]]));
  assert.throws(() => openVpk(save('tiny.vpk', packed.subarray(0, 11))), hasCode('VPK_TRUNCATED'));
  assert.throws(() => openVpk(save('tree-cut.vpk', packed.subarray(0, 15))), hasCode('VPK_TRUNCATED'));
  assert.throws(() => openVpk(save('inline-cut.vpk', packed.subarray(0, packed.length - 1))), hasCode('VPK_TRUNCATED'));
  const external = Buffer.from(packed), entryOffset = 12 + Buffer.byteLength('bin\0 \0sample\0');
  external.writeUInt16LE(0, entryOffset + 6);
  const treeEnd = 12 + external.readUInt32LE(8);
  const index = openVpk(save('pak01_dir.vpk', external.subarray(0, treeEnd)));
  save('pak01_000.vpk', Buffer.from('abc'));
  assert.throws(() => readResource(index, 'sample.bin'), hasCode('VPK_TRUNCATED'));
});

test('archive paths cannot escape through parent traversal, absolute paths or Windows separators', t => {
  for (const name of ['../a.bin', 'ok/../../a.bin', '/a.bin', 'C:/a.bin', 'ok\\a.bin', 'ok//a.bin', './a.bin', 'a\0.bin']) assert.throws(() => createVpk(new Map([[name, Buffer.from('data')]])), hasCode('VPK_UNSAFE_PATH'));
  const save = fixture(t), bad = createVpk(new Map([['ok/a.txt', Buffer.from('data')]]));
  bad.write('..', 12 + Buffer.byteLength('txt\0'), 'ascii');
  assert.throws(() => openVpk(save('unsafe.vpk', bad)), hasCode('VPK_UNSAFE_PATH'));
});

test('duplicate resources and malformed entry terminators are rejected before reading archive data', t => {
  const save = fixture(t), duplicate = createVpk(new Map([['a.txt', Buffer.from('a')], ['b.txt', Buffer.from('b')]]));
  const secondName = duplicate.indexOf(Buffer.from('b\0'), 12);
  assert.ok(secondName > 12); duplicate[secondName] = 'a'.charCodeAt(0);
  assert.throws(() => openVpk(save('duplicate.vpk', duplicate)), hasCode('VPK_INVALID_TREE'));
  const malformed = createVpk(new Map([['sample.bin', Buffer.from('x')]]));
  const entry = 12 + Buffer.byteLength('bin\0 \0sample\0'); malformed.writeUInt16LE(0, entry + 16);
  assert.throws(() => openVpk(save('terminator.vpk', malformed)), hasCode('VPK_INVALID_TREE'));
});

test('unsupported formats and invalid source data do not become packages', t => {
  const save = fixture(t), invalid = createVpk(new Map()); invalid.writeUInt32LE(3, 4);
  assert.throws(() => openVpk(save('future.vpk', invalid)), hasCode('VPK_UNSUPPORTED'));
  assert.throws(() => createVpk({ 'a.txt': Buffer.alloc(0) }), hasCode('VPK_INVALID_DATA'));
  assert.throws(() => createVpk(new Map([['a.txt', 'not binary']])) , hasCode('VPK_INVALID_DATA'));
});
