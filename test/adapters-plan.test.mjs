import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  classify,
  digest,
  manifestPath,
  planAdapters,
  readManifest,
  renderAdapters,
  writeManifest,
} from '../src/lib/adapters.mjs';
import { cleanup, repoRoot, tempProject } from './helpers.mjs';

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

function walkTree(root, rel = '') {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const name of fs.readdirSync(dir).sort()) {
    const next = rel ? `${rel}/${name}` : name;
    if (fs.statSync(path.join(root, next)).isDirectory()) out.push(...walkTree(root, next));
    else out.push(next);
  }
  return out;
}

function hashTree(root) {
  return walkTree(root).map((rel) => `${rel}:${digest(fs.readFileSync(path.join(root, rel), 'utf8'))}`);
}

function writeRendering(dir, entries) {
  for (const item of entries) {
    if (item.scope !== 'file') continue;
    const file = path.join(dir, item.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, item.content);
  }
}

function historyOf(entries) {
  const files = {};
  for (const item of entries) files[item.key] = [digest(item.content)];
  return { version: 1, files };
}

function changedTemplates() {
  const templates = fs.mkdtempSync(path.join(os.tmpdir(), 'idefactory-templates-'));
  fs.cpSync(path.join(repoRoot, 'templates'), templates, { recursive: true });
  const skill = path.join(templates, 'skills/factory-build/SKILL.md');
  fs.appendFileSync(skill, '\nNEW UPSTREAM LINE\n');
  const command = path.join(templates, 'commands/factory-review.md');
  fs.appendFileSync(command, '\nNEW REVIEW LINE\n');
  return templates;
}

function byStatus(plan) {
  const out = {};
  for (const item of plan.files) (out[item.status] ||= []).push(item.key);
  return out;
}

test('planAdapters plans every file as create in an empty project', () => {
  const dir = tempProject();
  try {
    const plan = planAdapters(dir);
    const files = plan.files.filter((item) => item.scope === 'file');
    assert.ok(files.length > 80);
    assert.ok(files.every((item) => item.status === 'create'));
  } finally {
    cleanup(dir);
  }
});

test('planAdapters plans update for a pristine legacy install and keeps the rest current', () => {
  const dir = tempProject();
  const templates = changedTemplates();
  try {
    const old = renderAdapters(dir);
    writeRendering(dir, old);
    const plan = planAdapters(dir, { templates, history: historyOf(old) });
    const grouped = byStatus(plan);
    assert.deepEqual(
      grouped.update.filter((key) => !key.includes('#')).sort(),
      [
        ...['.cursor', '.claude', '.github', '.agents', '.cline'].map((d) => `${d}/skills/factory-build/SKILL.md`),
        '.cursor/commands/factory-review.md',
        '.claude/commands/factory-review.md',
        '.github/prompts/factory-review.prompt.md',
        '.cline/workflows/factory-review.md',
      ].sort(),
    );
    assert.equal(grouped.preserved, undefined);
    assert.ok(grouped.current.length > 70);
  } finally {
    fs.rmSync(templates, { recursive: true, force: true });
    cleanup(dir);
  }
});

test('planAdapters preserves one edited file and still updates the others', () => {
  const dir = tempProject();
  const templates = changedTemplates();
  try {
    const old = renderAdapters(dir);
    writeRendering(dir, old);
    fs.appendFileSync(path.join(dir, '.cursor/commands/factory-review.md'), '\nPROJECT RULE\n');
    const plan = planAdapters(dir, { templates, history: historyOf(old) });
    const grouped = byStatus(plan);
    assert.deepEqual(grouped.preserved, ['.cursor/commands/factory-review.md']);
    assert.ok(grouped.update.includes('.claude/commands/factory-review.md'));
    assert.ok(grouped.update.includes('.cursor/skills/factory-build/SKILL.md'));
  } finally {
    fs.rmSync(templates, { recursive: true, force: true });
    cleanup(dir);
  }
});

test('planAdapters preserves a file at a generated path that no release wrote', () => {
  const dir = tempProject();
  try {
    const file = path.join(dir, '.cursor/commands/factory-status.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'My own status command\n');
    const plan = planAdapters(dir);
    const item = plan.files.find((entry) => entry.key === '.cursor/commands/factory-status.md');
    assert.equal(item.status, 'preserved');
    assert.equal(plan.files.find((entry) => entry.key === '.claude/commands/factory-status.md').status, 'create');
  } finally {
    cleanup(dir);
  }
});

test('planAdapters uses the manifest baseline when there is one', () => {
  const dir = tempProject();
  const templates = changedTemplates();
  try {
    const old = renderAdapters(dir);
    writeRendering(dir, old);
    const files = {};
    for (const item of old) files[item.key] = { digest: digest(item.content) };
    writeManifest(dir, { version: 1, files });
    const plan = planAdapters(dir, { templates, history: { version: 1, files: {} } });
    assert.equal(byStatus(plan).update.filter((key) => !key.includes('#')).length, 9);
    assert.equal(byStatus(plan).preserved, undefined);
  } finally {
    fs.rmSync(templates, { recursive: true, force: true });
    cleanup(dir);
  }
});

test('planAdapters never lists or touches unrelated files and writes nothing', () => {
  const dir = tempProject();
  try {
    const own = path.join(dir, '.cursor/skills/team-skill/SKILL.md');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'team\n');
    fs.mkdirSync(path.join(dir, '.cline/rules'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cline/rules/team-style.md'), 'style\n');
    const before = hashTree(dir);
    const plan = planAdapters(dir);
    assert.deepEqual(hashTree(dir), before);
    const keys = plan.files.map((item) => item.key);
    assert.ok(!keys.includes('.cursor/skills/team-skill/SKILL.md'));
    assert.ok(!keys.includes('.cline/rules/team-style.md'));
  } finally {
    cleanup(dir);
  }
});
