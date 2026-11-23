import fs from 'node:fs';
import path from 'node:path';
import {
  ROLES,
  ledger,
  mergeMarked,
  readText,
  templatesRoot,
  writeIfMissing,
  writeText,
} from './layout.mjs';
import {
  CONSUMER_WORKFLOW_RELATIVE,
  writeConsumerWorkflowIfAbsent,
} from './ci-scaffold.mjs';
import { renderAdapters } from './adapters.mjs';
import { runOpenspec } from './openspec-cli.mjs';

const STATE_FILES = [
  'team.md',
  'routing.md',
  'decisions.md',
  'config.json',
  'governance.md',
  'ceremonies.md',
  'profiles.json',
  'checks.json',
  'README.md',
  'identity/now.md',
  'identity/wisdom.md',
];

export function initProject(project, options = {}) {
  fs.mkdirSync(project, { recursive: true });
  const created = writeState(project, options);
  writeAdapters(project);
  mergeInstructions(project);
  ensureWorkScaffold(project);
  if (options.withOpenspec) ensureOpenspec(project, options.env || process.env);
  if (options.withBacklog) {
    // Deprecated: Backlog.md is no longer required. Kept for one release as a no-op hint.
    created.push('(deprecated --with-backlog ignored; use .factory/work)');
  }
  if (writeConsumerWorkflowIfAbsent(project).created) {
    created.push(CONSUMER_WORKFLOW_RELATIVE);
  }
  ledger(project, 'init', { created });
  return created;
}

export function upgradeProject(project) {
  if (!fs.existsSync(path.join(project, '.factory', 'team.md'))) {
    throw new Error('No .factory/ team state. Run idefactory init first.');
  }
  writeAdapters(project);
  mergeInstructions(project);
  ledger(project, 'upgrade', {});
}

function writeState(project, options) {
  const created = [];
  const factory = path.join(project, '.factory');
  const force = Boolean(options.forceRoster);
  for (const rel of STATE_FILES) {
    const from = path.join(templatesRoot, 'factory', rel);
    const to = path.join(factory, rel);
    if (force && (rel === 'team.md' || rel === 'routing.md')) {
      writeText(to, readText(from));
      created.push(rel);
      continue;
    }
    if (writeIfMissing(to, readText(from))) created.push(rel);
  }
  for (const role of ROLES) {
    for (const leaf of ['charter.md', 'history.md']) {
      const rel = path.join('agents', role, leaf);
      const from = path.join(templatesRoot, 'factory', rel);
      const to = path.join(factory, rel);
      if (force && leaf === 'charter.md') {
        writeText(to, readText(from));
        created.push(rel);
        continue;
      }
      if (writeIfMissing(to, readText(from))) created.push(rel);
    }
  }
  writeIfMissing(path.join(factory, 'approvals', '.gitkeep'), '');
  writeIfMissing(path.join(factory, 'orchestration', '.gitkeep'), '');
  ensureWorkScaffold(project);
  return created;
}

function ensureWorkScaffold(project) {
  const work = path.join(project, '.factory', 'work');
  writeIfMissing(path.join(work, 'index.json'), JSON.stringify({ version: 1, items: [] }, null, 2));
  writeIfMissing(path.join(work, 'items', '.gitkeep'), '');
  writeIfMissing(path.join(project, '.factory', 'attempts', '.gitkeep'), '');
}

function writeAdapters(project) {
  for (const item of renderAdapters(project)) {
    if (item.scope !== 'file') continue;
    const file = path.join(project, item.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, item.content);
  }
}

function mergeInstructions(project) {
  const section = readText(path.join(templatesRoot, 'fragments/instructions.md'));
  const targets = [
    'AGENTS.md',
    'CLAUDE.md',
    path.join('.github', 'copilot-instructions.md'),
  ];
  for (const rel of targets) {
    const file = path.join(project, rel);
    const existing = fs.existsSync(file) ? readText(file) : '';
    writeText(file, mergeMarked(existing, section));
  }
}

function ensureOpenspec(project, env) {
  if (fs.existsSync(path.join(project, 'openspec', 'config.yaml'))) return;
  try {
    runOpenspec(project, [
      'init',
      '--tools', 'cursor,github-copilot,claude',
      '--no-copilot-cloud',
      '--no-animation',
    ], env);
  } catch (error) {
    if (error.code === 'NO_OPENSPEC') throw error;
    throw new Error(error.message || 'openspec init failed');
  }
}
