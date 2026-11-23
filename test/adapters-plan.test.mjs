import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  classify,
  digest,
  manifestPath,
  readManifest,
  writeManifest,
} from '../src/lib/adapters.mjs';
import { cleanup, tempProject } from './helpers.mjs';

test('a missing manifest reads as empty', () => {
  const dir = tempProject();
  try {
    const manifest = readManifest(dir);
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.files, {});
    assert.equal(fs.existsSync(manifestPath(dir)), false);
  } finally {
    cleanup(dir);
  }
});

test('writeManifest sorts keys and a rewrite with no change is byte-identical', () => {
  const dir = tempProject();
  try {
    writeManifest(dir, {
      version: 1,
      files: { 'b.md': { digest: 'bb' }, 'a.md': { digest: 'aa', pinned: true } },
    });
    const first = fs.readFileSync(manifestPath(dir), 'utf8');
    const parsed = JSON.parse(first);
    assert.deepEqual(Object.keys(parsed.files), ['a.md', 'b.md']);
    assert.equal(parsed.version, 1);
    assert.match(parsed.tool, /^\d+\.\d+\.\d+/);
    assert.ok(first.endsWith('\n'));

    writeManifest(dir, readManifest(dir));
    assert.equal(fs.readFileSync(manifestPath(dir), 'utf8'), first);
  } finally {
    cleanup(dir);
  }
});

test('writeManifest goes through a temporary file and a rename', () => {
  const dir = tempProject();
  const original = fs.renameSync;
  const calls = [];
  try {
    fs.renameSync = (from, to) => {
      calls.push({ from, to, fromExisted: fs.existsSync(from), toExisted: fs.existsSync(to) });
      return original(from, to);
    };
    writeManifest(dir, { version: 1, files: { 'a.md': { digest: 'aa' } } });
  } finally {
    fs.renameSync = original;
  }
  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, manifestPath(dir));
    assert.notEqual(calls[0].from, manifestPath(dir));
    assert.equal(calls[0].fromExisted, true);
    assert.deepEqual(
      fs.readdirSync(path.dirname(manifestPath(dir))).filter((name) => name.includes('.tmp')),
      [],
    );
  } finally {
    cleanup(dir);
  }
});

test('an unreadable or wrong-version manifest fails and names the file', () => {
  const dir = tempProject();
  try {
    fs.mkdirSync(path.dirname(manifestPath(dir)), { recursive: true });
    fs.writeFileSync(manifestPath(dir), '{not json');
    assert.throws(() => readManifest(dir), /adapters\.json/);
    fs.writeFileSync(manifestPath(dir), JSON.stringify({ version: 2, files: {} }));
    assert.throws(() => readManifest(dir), /adapters\.json.*version/i);
    fs.writeFileSync(manifestPath(dir), JSON.stringify({ version: 1, files: [] }));
    assert.throws(() => readManifest(dir), /adapters\.json/);
  } finally {
    cleanup(dir);
  }
});

const OLD = digest('old\n');
const NEW = digest('new\n');
const EDIT = digest('edited\n');
const ANCIENT = digest('ancient\n');

function status(input) {
  return classify({ rendering: NEW, history: [ANCIENT, OLD], ...input }).status;
}

test('classify: a pinned entry is skipped even when the file is absent or edited', () => {
  assert.equal(status({ local: EDIT, baseline: OLD, pinned: true }), 'pinned');
  assert.equal(status({ local: null, baseline: OLD, pinned: true }), 'pinned');
  assert.equal(
    classify({ rendering: NEW, local: EDIT, baseline: OLD, pinned: true, history: [] }).upstreamChanged,
    true,
  );
  assert.equal(
    classify({ rendering: NEW, local: EDIT, baseline: NEW, pinned: true, history: [] }).upstreamChanged,
    false,
  );
});

test('classify: an absent file is created', () => {
  assert.equal(status({ local: null, baseline: OLD }), 'create');
  assert.equal(status({ local: null, baseline: null }), 'create');
});

test('classify: a file equal to the new rendering is current', () => {
  assert.equal(status({ local: NEW, baseline: OLD }), 'current');
  assert.equal(status({ local: NEW, baseline: null }), 'current');
  assert.equal(status({ local: NEW, baseline: NEW }), 'current');
});

test('classify: a file equal to its baseline is updated', () => {
  assert.equal(status({ local: OLD, baseline: OLD, history: [] }), 'update');
});

test('classify: with no manifest entry a past rendering is updated', () => {
  assert.equal(status({ local: ANCIENT, baseline: null }), 'update');
  assert.equal(status({ local: OLD, baseline: null }), 'update');
});

test('classify: a past rendering that differs from a recorded baseline is still updated', () => {
  assert.equal(status({ local: ANCIENT, baseline: OLD }), 'update');
});

test('classify: an edited file is preserved with or without a baseline', () => {
  assert.equal(status({ local: EDIT, baseline: OLD }), 'preserved');
  assert.equal(status({ local: EDIT, baseline: null }), 'preserved');
  assert.equal(status({ local: EDIT, baseline: null, history: [] }), 'preserved');
});

test('classify: line endings alone never preserve a file', () => {
  const crlf = digest('old\r\n');
  assert.equal(status({ local: crlf, baseline: OLD }), 'update');
  assert.equal(status({ local: digest('new\r\n'), baseline: OLD }), 'current');
});
