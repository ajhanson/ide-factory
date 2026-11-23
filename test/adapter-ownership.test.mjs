import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { digest, manifestPath, readManifest } from '../src/lib/adapters.mjs';
import { acquireWriterLease } from '../src/lib/writer-lease.mjs';
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

test('upgrade --dry-run prints the plan, exits like a real run, and writes nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const before = hashTree(dir);
    const result = await idefactory(dir, ['upgrade', '--dry-run']);
    assert.equal(result.code, 3, result.err + result.out);
    assert.match(result.out, /upgrade \(dry run\): .*1 preserved/);
    assert.match(result.out, new RegExp(`preserved\\s+${REVIEW.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(result.out, /incoming:/);
    assert.deepEqual(hashTree(dir), before);
    assert.equal(fs.existsSync(path.join(dir, '.factory/upgrade')), false);
  } finally {
    cleanup(dir);
  }
});

test('upgrade --dry-run with nothing to do exits 0', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const result = await idefactory(dir, ['upgrade', '--dry-run']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /0 update, 0 create, 0 modified, 0 preserved/);
  } finally {
    cleanup(dir);
  }
});

test('init --dry-run in an empty directory writes nothing and lists what it would create', async () => {
  const dir = tempProject();
  try {
    const result = await idefactory(dir, ['init', '--dry-run']);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.match(result.out, /Dry run: nothing was written\./);
    assert.match(result.out, /Would create: .*\.factory\/team\.md|Would create: .*team\.md/);
    assert.match(result.out, /init \(dry run\): 0 current, 0 update, \d+ create/);
  } finally {
    cleanup(dir);
  }
});

test('init --dry-run in an existing install changes nothing, including the ledger', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const before = hashTree(dir);
    const result = await idefactory(dir, ['init', '--dry-run']);
    assert.equal(result.code, 3);
    assert.deepEqual(hashTree(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('a dry run does not need the writer lease but a real run does', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    acquireWriterLease(dir, 'run');
    const dry = await idefactory(dir, ['upgrade', '--dry-run']);
    assert.equal(dry.code, 0, dry.err + dry.out);
    const real = await idefactory(dir, ['upgrade']);
    assert.notEqual(real.code, 0);
    assert.match(real.err, /lease/i);
  } finally {
    cleanup(dir);
  }
});

test('--json prints one document with a status and a digest for each generated path', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const result = await idefactory(dir, ['upgrade', '--json']);
    assert.equal(result.code, 3, result.err);
    const doc = JSON.parse(result.out);
    assert.equal(doc.version, 1);
    assert.equal(doc.dryRun, false);
    assert.equal(doc.summary.preserved, 1);
    assert.equal(doc.exitCode, 3);
    assert.ok(doc.files.length > 80);
    for (const file of doc.files) {
      assert.equal(typeof file.path, 'string');
      assert.equal(typeof file.status, 'string');
      assert.match(file.digest, /^[0-9a-f]{64}$/);
    }
    const review = doc.files.find((file) => file.path === REVIEW);
    assert.equal(review.status, 'preserved');
    assert.ok(read(dir, review.incoming));
    assert.ok(read(dir, review.diff));
  } finally {
    cleanup(dir);
  }
});

test('--json with --dry-run stages nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const before = hashTree(dir);
    const result = await idefactory(dir, ['upgrade', '--dry-run', '--json']);
    const doc = JSON.parse(result.out);
    assert.equal(doc.dryRun, true);
    assert.equal(doc.run, null);
    assert.equal(doc.files.find((file) => file.path === REVIEW).incoming, undefined);
    assert.deepEqual(hashTree(dir), before);
  } finally {
    cleanup(dir);
  }
});

const CLAUDE_REVIEW = '.claude/commands/factory-review.md';

function runDirOf(out) {
  return out.match(/\.factory\/upgrade\/[^/\s]+/)[0];
}

test('--replace replaces one preserved file after backing it up and leaves the other preserved', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir, REVIEW);
    seedConflict(dir, CLAUDE_REVIEW);
    const result = await idefactory(dir, ['upgrade', '--replace', REVIEW]);
    assert.equal(result.code, 3, result.err + result.out);
    assert.match(read(dir, REVIEW), /Follow the factory-build skill's review step/);
    assert.equal(read(dir, CLAUDE_REVIEW), 'Review as our team does.\n');
    const runDir = runDirOf(result.out);
    assert.equal(read(dir, `${runDir}/backups/${REVIEW}`), 'Review as our team does.\n');
    assert.equal(readManifest(dir).files[REVIEW].digest, digest(read(dir, REVIEW)));
    assert.match(result.out, /1 replace, /);
    assert.match(result.out, /1 preserved/);
  } finally {
    cleanup(dir);
  }
});

test('--replace can be repeated', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir, REVIEW);
    seedConflict(dir, CLAUDE_REVIEW);
    const result = await idefactory(dir, ['upgrade', '--replace', REVIEW, '--replace', CLAUDE_REVIEW]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(read(dir, REVIEW), /Follow the factory-build skill's review step/);
    assert.match(read(dir, CLAUDE_REVIEW), /Follow the factory-build skill's review step/);
  } finally {
    cleanup(dir);
  }
});

test('--force replaces every preserved file after a backup and exits 0', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir, REVIEW);
    seedConflict(dir, CLAUDE_REVIEW);
    const result = await idefactory(dir, ['upgrade', '--force']);
    assert.equal(result.code, 0, result.err + result.out);
    const runDir = runDirOf(result.out);
    for (const rel of [REVIEW, CLAUDE_REVIEW]) {
      assert.match(read(dir, rel), /Follow the factory-build skill's review step/);
      assert.equal(read(dir, `${runDir}/backups/${rel}`), 'Review as our team does.\n');
    }
    const again = await idefactory(dir, ['upgrade']);
    assert.equal(again.code, 0);
    assert.match(again.out, /0 preserved/);
  } finally {
    cleanup(dir);
  }
});

test('--replace also resets an edited file that only differs locally', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.appendFileSync(path.join(dir, REVIEW), '\nOur extra rule.\n');
    const result = await idefactory(dir, ['upgrade', '--replace', REVIEW]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.doesNotMatch(read(dir, REVIEW), /Our extra rule/);
    assert.match(read(dir, `${runDirOf(result.out)}/backups/${REVIEW}`), /Our extra rule/);
  } finally {
    cleanup(dir);
  }
});

test('--replace and --force leave a pinned file alone and say so', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const manifest = readManifest(dir);
    manifest.files[REVIEW] = { digest: digest('an older rendering\n'), pinned: true };
    fs.writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, REVIEW), 'Pinned and ours.\n');
    const replaced = await idefactory(dir, ['upgrade', '--replace', REVIEW]);
    assert.equal(replaced.code, 0, replaced.err + replaced.out);
    assert.match(replaced.out, /note: .*pinned/i);
    const forced = await idefactory(dir, ['upgrade', '--force']);
    assert.equal(forced.code, 0);
    assert.equal(read(dir, REVIEW), 'Pinned and ours.\n');
  } finally {
    cleanup(dir);
  }
});

test('--replace and --force leave a malformed instruction file alone and say so', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Ours\n<!-- idefactory:start -->\nhalf\n');
    const replaced = await idefactory(dir, ['upgrade', '--replace', 'AGENTS.md']);
    assert.equal(replaced.code, 3);
    assert.match(replaced.out, /note: .*AGENTS\.md.*malformed/i);
    const forced = await idefactory(dir, ['upgrade', '--force']);
    assert.equal(forced.code, 3);
    assert.equal(read(dir, 'AGENTS.md'), '# Ours\n<!-- idefactory:start -->\nhalf\n');
  } finally {
    cleanup(dir);
  }
});

test('--replace for a current file notes there is nothing to replace', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const result = await idefactory(dir, ['upgrade', '--replace', REVIEW]);
    assert.equal(result.code, 0);
    assert.match(result.out, /note: .*nothing to replace.*current/i);
    assert.equal(fs.existsSync(path.join(dir, '.factory/upgrade')), false);
  } finally {
    cleanup(dir);
  }
});

test('--replace for a path the factory does not generate fails and writes nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const before = hashTree(dir);
    const result = await idefactory(dir, ['upgrade', '--replace', 'src/app.js']);
    assert.equal(result.code, 1);
    assert.match(result.err, /not a generated adapter file/);
    assert.deepEqual(hashTree(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('--force followed by a value fails and names --replace and --path', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const before = hashTree(dir);
    const result = await idefactory(dir, ['upgrade', '--force', 'somewhere']);
    assert.equal(result.code, 1);
    assert.match(result.err, /--force takes no value/);
    assert.match(result.err, /--replace <path>/);
    assert.match(result.err, /--path/);
    assert.deepEqual(hashTree(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('--replace without a path fails', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const result = await idefactory(dir, ['upgrade', '--replace']);
    assert.equal(result.code, 1);
    assert.match(result.err, /--replace needs a path/);
  } finally {
    cleanup(dir);
  }
});

test('--force with --dry-run plans a replacement and writes nothing', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const before = hashTree(dir);
    const result = await idefactory(dir, ['upgrade', '--dry-run', '--force']);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(result.out, new RegExp(`replace\\s+${REVIEW.replace(/\./g, '\\.')}`));
    assert.deepEqual(hashTree(dir), before);
  } finally {
    cleanup(dir);
  }
});

test('init accepts --replace and --force like upgrade', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    seedConflict(dir);
    const result = await idefactory(dir, ['init', '--force']);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(read(dir, REVIEW), /Follow the factory-build skill's review step/);
  } finally {
    cleanup(dir);
  }
});
