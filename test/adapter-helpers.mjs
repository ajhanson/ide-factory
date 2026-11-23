import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/lib/adapters.mjs';
import { repoRoot } from './helpers.mjs';

export function walkTree(root, rel = '') {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const name of fs.readdirSync(dir).sort()) {
    const next = rel ? `${rel}/${name}` : name;
    if (fs.statSync(path.join(root, next)).isDirectory()) out.push(...walkTree(root, next));
    else out.push(next);
  }
  return out;
}

export function hashTree(root) {
  return walkTree(root).map((rel) => `${rel}:${digest(fs.readFileSync(path.join(root, rel), 'utf8'))}`);
}

export function writeRendering(dir, entries, { crlf = false } = {}) {
  for (const item of entries) {
    if (item.scope !== 'file') continue;
    const file = path.join(dir, item.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crlf ? item.content.replace(/\n/g, '\r\n') : item.content);
  }
}

export function historyOf(entries) {
  const files = {};
  for (const item of entries) files[item.key] = [digest(item.content)];
  return { version: 1, files };
}

export function changedTemplates() {
  const templates = fs.mkdtempSync(path.join(os.tmpdir(), 'idefactory-templates-'));
  fs.cpSync(path.join(repoRoot, 'templates'), templates, { recursive: true });
  fs.appendFileSync(path.join(templates, 'skills/factory-build/SKILL.md'), '\nNEW UPSTREAM LINE\n');
  fs.appendFileSync(path.join(templates, 'commands/factory-review.md'), '\nNEW REVIEW LINE\n');
  return templates;
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Record every rename while fn runs; optionally fail a rename whose target matches. */
export function spyRenames(fn, { failOn } = {}) {
  const original = fs.renameSync;
  const targets = [];
  fs.renameSync = (from, to) => {
    if (failOn && failOn(to)) throw new Error(`injected failure for ${to}`);
    targets.push(to);
    return original(from, to);
  };
  try {
    fn();
  } finally {
    fs.renameSync = original;
  }
  return targets;
}
