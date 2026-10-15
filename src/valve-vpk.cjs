'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SIGNATURE = 0x55aa1234;
const INLINE_ARCHIVE = 0x7fff;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 1000000;
class VpkError extends Error {
  constructor(code, message) { super(message); this.name = 'VpkError'; this.code = code; }
}
const fail = (code, message) => { throw new VpkError(code, message); };
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;

function safeResourcePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\x00-\x1f\x7f:]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('VPK_UNSAFE_PATH', 'Unsafe VPK resource path.');
  return value;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('VPK_INVALID_DATA', 'VPK resource data must be a Buffer.');
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) crc = CRC_TABLE[(crc ^ buffer[index]) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function readExactly(descriptor, buffer, offset) {
  let completed = 0;
  while (completed < buffer.length) {
    const read = fs.readSync(descriptor, buffer, completed, buffer.length - completed, offset + completed);
    if (!read) fail('VPK_TRUNCATED', 'Truncated VPK archive.');
    completed += read;
  }
}

function openVpk(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')) fail('VPK_INVALID_PATH', 'Invalid VPK directory filename.');
  const resolved = path.resolve(filename), descriptor = fs.openSync(resolved, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || !safeInteger(stat.size) || stat.size < 12) fail('VPK_TRUNCATED', 'Missing VPK directory header.');
    const header = Buffer.alloc(Math.min(28, stat.size)); readExactly(descriptor, header, 0);
    const version = header.readUInt32LE(4), headerSize = version === 1 ? 12 : version === 2 ? 28 : 0;
    if (header.readUInt32LE(0) !== SIGNATURE || !headerSize) fail('VPK_UNSUPPORTED', 'Unsupported VPK signature or version.');
    if (stat.size < headerSize) fail('VPK_TRUNCATED', 'Truncated VPK directory header.');
    const treeSize = header.readUInt32LE(8), dataOffset = headerSize + treeSize;
    if (!treeSize || treeSize > MAX_TREE_BYTES) fail('VPK_LIMIT', 'VPK directory tree exceeds the supported size.');
    if (dataOffset > stat.size) fail('VPK_TRUNCATED', 'Truncated VPK directory tree.');
    const inlineSize = version === 1 ? stat.size - dataOffset : header.readUInt32LE(12);
    if (version === 2) {
      const total = dataOffset + inlineSize + header.readUInt32LE(16) + header.readUInt32LE(20) + header.readUInt32LE(24);
      if (total !== stat.size) fail('VPK_TRUNCATED', 'Invalid VPK section lengths.');
    }
    const tree = Buffer.alloc(treeSize); readExactly(descriptor, tree, headerSize);
    const entries = new Map(); let cursor = 0;
    const string = () => {
      const end = tree.indexOf(0, cursor);
      if (end < cursor || end - cursor > 4096) fail('VPK_INVALID_TREE', 'Invalid VPK resource name.');
      const value = tree.toString('utf8', cursor, end); cursor = end + 1;
      if (value.includes('\ufffd')) fail('VPK_INVALID_TREE', 'Invalid UTF-8 VPK resource name.');
      return value;
    };
    for (let extension; (extension = string());) {
      if (extension !== ' ' && /[./\\:]/.test(extension)) fail('VPK_UNSAFE_PATH', 'Unsafe VPK extension.');
      for (let folder; (folder = string());) {
        for (let name; (name = string());) {
          if (/[\/\\:]/.test(name)) fail('VPK_UNSAFE_PATH', 'Unsafe VPK resource basename.');
          const resourcePath = safeResourcePath((folder === ' ' ? '' : folder + '/') + name + (extension === ' ' ? '' : '.' + extension));
          if (entries.has(resourcePath)) fail('VPK_INVALID_TREE', 'Duplicate VPK resource path.');
          if (cursor + 18 > tree.length || tree.readUInt16LE(cursor + 16) !== 0xffff) fail('VPK_INVALID_TREE', 'Invalid VPK directory entry.');
          const entry = { crc: tree.readUInt32LE(cursor), preloadLength: tree.readUInt16LE(cursor + 4), archiveIndex: tree.readUInt16LE(cursor + 6), offset: tree.readUInt32LE(cursor + 8), length: tree.readUInt32LE(cursor + 12) };
          cursor += 18;
          if (entry.archiveIndex > INLINE_ARCHIVE || cursor + entry.preloadLength > tree.length) fail('VPK_INVALID_TREE', 'Invalid VPK archive or preload.');
          if (entry.archiveIndex === INLINE_ARCHIVE && entry.offset + entry.length > inlineSize) fail('VPK_TRUNCATED', 'VPK inline resource exceeds its data section.');
          entry.preload = Buffer.from(tree.subarray(cursor, cursor + entry.preloadLength)); cursor += entry.preloadLength;
          entries.set(resourcePath, Object.freeze(entry));
          if (entries.size > MAX_ENTRIES) fail('VPK_LIMIT', 'Too many VPK directory entries.');
        }
      }
    }
    if (cursor !== tree.length) fail('VPK_INVALID_TREE', 'Unexpected data after the VPK directory tree.');
    return { filename: resolved, version, headerSize, treeSize, dataOffset, inlineSize, entries };
  } finally { fs.closeSync(descriptor); }
}

function readResource(index, resourcePath, options = {}) {
  safeResourcePath(resourcePath);
  const entry = index?.entries?.get(resourcePath);
  if (!entry) fail('VPK_NOT_FOUND', 'Resource not found in the VPK directory.');
  const maxBytes = Math.min(MAX_RESOURCE_BYTES, options.maxBytes ?? MAX_RESOURCE_BYTES);
  if (!safeInteger(maxBytes) || ![entry.preloadLength, entry.offset, entry.length].every(safeInteger) || entry.preloadLength + entry.length > maxBytes) fail('VPK_LIMIT', 'VPK resource exceeds the supported size.');
  let archive, offset;
  if (entry.archiveIndex === INLINE_ARCHIVE) { archive = index.filename; offset = index.dataOffset + entry.offset; }
  else {
    if (!safeInteger(entry.archiveIndex) || entry.archiveIndex > INLINE_ARCHIVE || !/_dir\.vpk$/i.test(index.filename)) fail('VPK_INVALID_PATH', 'External VPK resources require a directory archive filename.');
    archive = index.filename.replace(/_dir\.vpk$/i, `_${String(entry.archiveIndex).padStart(3, '0')}.vpk`); offset = entry.offset;
  }
  const descriptor = fs.openSync(archive, 'r');
  let body;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || !safeInteger(offset) || offset + entry.length > stat.size) fail('VPK_TRUNCATED', 'VPK resource exceeds its archive file.');
    body = Buffer.alloc(entry.length); readExactly(descriptor, body, offset);
  } finally { fs.closeSync(descriptor); }
  const result = Buffer.concat([entry.preload, body]);
  if (crc32(result) !== entry.crc) fail('VPK_CRC_MISMATCH', 'VPK resource checksum does not match the source directory.');
  return result;
}

function createVpk(resources) {
  if (!(resources instanceof Map) || resources.size > MAX_ENTRIES) fail('VPK_INVALID_DATA', 'VPK resources must be a bounded Map.');
  const groups = new Map(), bodies = []; let dataSize = 0;
  for (const [resourcePath, data] of resources) {
    safeResourcePath(resourcePath);
    if (!Buffer.isBuffer(data)) fail('VPK_INVALID_DATA', 'VPK resource data must be a Buffer.');
    if (data.length > MAX_RESOURCE_BYTES) fail('VPK_LIMIT', 'VPK resource exceeds the supported size.');
    const slash = resourcePath.lastIndexOf('/'), filename = resourcePath.slice(slash + 1), dot = filename.lastIndexOf('.');
    const extension = dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1) : ' ';
    const name = extension === ' ' ? filename : filename.slice(0, dot), folder = slash < 0 ? ' ' : resourcePath.slice(0, slash);
    const folders = groups.get(extension) || new Map(), files = folders.get(folder) || [];
    files.push({ name, crc: crc32(data), offset: dataSize, length: data.length }); folders.set(folder, files); groups.set(extension, folders);
    bodies.push(data); dataSize += data.length;
    if (dataSize > MAX_OUTPUT_BYTES) fail('VPK_LIMIT', 'VPK output exceeds the supported size.');
  }
  const pieces = [], string = value => pieces.push(Buffer.from(value + '\0', 'utf8'));
  for (const [extension, folders] of groups) {
    string(extension);
    for (const [folder, files] of folders) {
      string(folder);
      for (const file of files) {
        string(file.name);
        const entry = Buffer.alloc(18); entry.writeUInt32LE(file.crc, 0); entry.writeUInt16LE(INLINE_ARCHIVE, 6); entry.writeUInt32LE(file.offset, 8); entry.writeUInt32LE(file.length, 12); entry.writeUInt16LE(0xffff, 16); pieces.push(entry);
      }
      string('');
    }
    string('');
  }
  string('');
  const tree = Buffer.concat(pieces);
  if (tree.length > MAX_TREE_BYTES || 12 + tree.length + dataSize > MAX_OUTPUT_BYTES) fail('VPK_LIMIT', 'VPK directory or output exceeds the supported size.');
  const header = Buffer.alloc(12); header.writeUInt32LE(SIGNATURE, 0); header.writeUInt32LE(1, 4); header.writeUInt32LE(tree.length, 8);
  return Buffer.concat([header, tree, ...bodies]);
}

module.exports = { openVpk, readResource, createVpk, crc32, safeResourcePath, VpkError, MAX_RESOURCE_BYTES, MAX_TREE_BYTES, MAX_OUTPUT_BYTES };
