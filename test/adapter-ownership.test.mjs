import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { digest, manifestPath, readManifest } from '../src/lib/adapters.mjs';
import { cleanup, idefactory, tempProject } from './helpers.mjs';
import { hashTree } from './adapter-helpers.mjs';

const REVIEW = '.cursor/commands/factory-review.md';

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

function ledgerEvents(dir) {
  const file = path.join(dir, '.factory/ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Simulate a file written by an older release: edited locally, with an older baseline recorded. */
function seedConflict(dir, rel = REVIEW) {
  const manifest = readManifest(dir);
  manifest.files[rel] = { digest: digest('what an older release wrote\n') };
  fs.writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, rel), 'Review as our team does.\n');
}

function reportBody(out) {
  return out
    .split('\n')
    .filter((line) => /^(\w+: \d+ current|  \S+\s+\S|    (incoming|diff):|Resolve with)/.test(line))
    .map((line) => line.replace(/^\w+: /, '').replace(/\.factory\/upgrade\/[^/]+\//g, '.factory/upgrade/RUN/'))
    .join('\n');
}

test('init prints the per-file report, writes the manifest, and records the summary', async () => {
  const dir = tempProject();
  try {
    const result = await idefactory(dir, ['init']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /init: 0 current, 0 update, \d+ create, 0 modified, 0 preserved/);
    const manifest = readManifest(dir);
    assert.ok(Object.keys(manifest.files).length > 80);
    assert.ok(manifest.files[REVIEW].digest);
    const event = ledgerEvents(dir).find((entry) => entry.event === 'init');
    assert.ok(event.adapters.create > 80);
    assert.equal(event.adapters.preserved, 0);
  } finally {
    cleanup(dir);
  }
});

test('a second run reports every file current and writes nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const before = hashTree(dir).filter((line) => !line.startsWith('.factory/ledger.jsonl'));
    const manifestBefore = read(dir, '.factory/adapters.json');
    const result = await idefactory(dir, ['upgrade']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /upgrade: \d+ current, 0 update, 0 create, 0 modified, 0 preserved/);
    assert.deepEqual(
      hashTree(dir).filter((line) => !line.startsWith('.factory/ledger.jsonl')),
      before,
    );
    assert.equal(read(dir, '.factory/adapters.json'), manifestBefore);
    assert.equal(fs.existsSync(path.join(dir, '.factory/upgrade')), false);
  } finally {
    cleanup(dir);
  }
});

test('upgrade exits 3 and reports a preserved file with its saved incoming rendering and diff', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const result = await idefactory(dir, ['upgrade']);
    assert.equal(result.code, 3, result.err + result.out);
    assert.equal(read(dir, REVIEW), 'Review as our team does.\n');
    assert.match(result.out, /1 preserved/);
    assert.match(result.out, new RegExp(`preserved\\s+${REVIEW.replace(/\./g, '\\.')}`));
    const incoming = result.out.match(/incoming: (\S+)/)[1];
    const diff = result.out.match(/diff:\s+(\S+)/)[1];
    assert.match(read(dir, incoming), /Follow the factory-build skill's review step/);
    assert.match(read(dir, diff), /^-Review as our team does\.$/m);
    assert.match(result.out, /Resolve with:/);
    assert.equal(ledgerEvents(dir).filter((entry) => entry.event === 'upgrade').at(-1).adapters.preserved, 1);
  } finally {
    cleanup(dir);
  }
});

test('an edit with no upstream change is listed as modified and exits 0', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.appendFileSync(path.join(dir, REVIEW), '\nOur extra rule.\n');
    const result = await idefactory(dir, ['upgrade']);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(result.out, /1 modified/);
    assert.match(result.out, new RegExp(`modified\\s+${REVIEW.replace(/\./g, '\\.')}`));
    assert.match(read(dir, REVIEW), /Our extra rule\./);
    assert.equal(fs.existsSync(path.join(dir, '.factory/upgrade')), false);
  } finally {
    cleanup(dir);
  }
});

test('re-init classifies an edited file the same way upgrade does', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const upgraded = await idefactory(dir, ['upgrade']);
    const reinit = await idefactory(dir, ['init']);
    assert.equal(upgraded.code, 3);
    assert.equal(reinit.code, 3);
    assert.equal(read(dir, REVIEW), 'Review as our team does.\n');
    assert.equal(reportBody(reinit.out), reportBody(upgraded.out));
    assert.match(reportBody(upgraded.out), /1 preserved/);
  } finally {
    cleanup(dir);
  }
});

test('setup gaps are still reported after the adapter report', async () => {
  const dir = tempProject();
  try {
    const result = await idefactory(dir, ['init']);
    assert.match(result.out, /Run idefactory setup to record the missing answer\./);
  } finally {
    cleanup(dir);
  }
});
