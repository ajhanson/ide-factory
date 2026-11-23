import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MARKER,
  SECTION_END,
  SECTION_START,
  readText,
  templatesRoot,
} from './layout.mjs';

export const SKILL_DIRS = [
  '.cursor/skills',
  '.claude/skills',
  '.github/skills',
  '.agents/skills',
  '.cline/skills',
];

export const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
];

export const COMMANDS = [
  {
    name: 'factory-status',
    description: 'Show factory team, OpenSpec, and work queue status',
  },
  {
    name: 'factory-plan',
    description: 'Staff a human-authored OpenSpec change into .factory/work',
  },
  {
    name: 'factory-build',
    description: 'Implement the next factory work item with the factory-build skill',
  },
  {
    name: 'factory-run',
    description: 'Bounded multi-task factory orchestration until a stop condition',
  },
  {
    name: 'factory-full',
    description: 'One-stop factory: explore, propose if needed, plan, and run',
  },
  {
    name: 'factory-review',
    description: 'Review the current factory task as a different role',
  },
  {
    name: 'factory-setup',
    description: 'Confirm the test command and governance mode, then record them',
  },
];

/**
 * Normalized digest: CRLF becomes LF and the text ends with exactly one newline.
 * @param {string} text
 * @returns {string}
 */
export function digest(text) {
  const normalized = `${String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
  return createHash('sha256').update(normalized).digest('hex');
}

function posix(...parts) {
  return parts.join('/').replace(/\/+/g, '/');
}

function walkFiles(root, rel = '') {
  const out = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const name of fs.readdirSync(dir).sort()) {
    const next = rel ? `${rel}/${name}` : name;
    if (fs.statSync(path.join(root, next)).isDirectory()) out.push(...walkFiles(root, next));
    else out.push(next);
  }
  return out;
}

function withNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function entry(filePath, content, kind, name, scope = 'file') {
  return {
    path: filePath,
    key: scope === 'section' ? `${filePath}#section` : filePath,
    content,
    kind,
    name,
    scope,
  };
}

/**
 * The full desired set of generated adapter files and instruction sections.
 * @param {string} project
 * @param {{ templates?: string }} [options]
 * @returns {{ path: string, key: string, content: string, kind: string, name: string, scope: 'file'|'section' }[]}
 */
export function renderAdapters(project, options = {}) {
  const templates = options.templates || templatesRoot;
  const entries = [];

  const skillsRoot = path.join(templates, 'skills');
  for (const name of fs.readdirSync(skillsRoot).sort()) {
    const from = path.join(skillsRoot, name);
    if (!fs.statSync(from).isDirectory()) continue;
    for (const rel of walkFiles(from)) {
      const content = fs.readFileSync(path.join(from, rel), 'utf8');
      for (const dest of SKILL_DIRS) {
        entries.push(entry(posix(dest, name, rel), content, 'skill', name));
      }
    }
  }

  for (const command of COMMANDS) {
    const body = readText(path.join(templates, 'commands', `${command.name}.md`)).trim();
    const owned = `${body}\n\n${MARKER}\n`;
    const plain = `---\ndescription: ${command.description}\n---\n\n${owned}`;
    entries.push(entry(`.cursor/commands/${command.name}.md`, plain, 'command', command.name));
    entries.push(entry(`.claude/commands/${command.name}.md`, plain, 'command', command.name));
    entries.push(entry(
      `.github/prompts/${command.name}.prompt.md`,
      `---\ndescription: ${command.description}\nagent: factory\n---\n\n${owned}`,
      'command',
      command.name,
    ));
    entries.push(entry(`.cline/workflows/${command.name}.md`, owned, 'command', command.name));
  }

  entries.push(entry(
    '.cursor/rules/factory.mdc',
    withNewline(readText(path.join(templates, 'cursor/rules/factory.mdc'))),
    'rule',
    'factory',
  ));
  entries.push(entry(
    '.github/agents/factory.agent.md',
    withNewline(readText(path.join(templates, 'copilot/factory.agent.md'))),
    'agent',
    'factory',
  ));
  entries.push(entry(
    '.cline/rules/factory.md',
    withNewline(readText(path.join(templates, 'cline/rules/factory.md'))),
    'rule',
    'factory',
  ));

  const section = readText(path.join(templates, 'fragments/instructions.md'));
  const block = `${SECTION_START}\n${section.trim()}\n${SECTION_END}\n`;
  for (const file of INSTRUCTION_FILES) {
    entries.push(entry(file, block, 'instructions', 'instructions', 'section'));
  }

  return entries;
}

const MANIFEST_VERSION = 1;

export function manifestPath(project) {
  return path.join(project, '.factory', 'adapters.json');
}

function toolVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(templatesRoot), 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * @param {string} project
 * @returns {{ version: number, tool?: string, files: Record<string, { digest: string, pinned?: boolean }> }}
 */
export function readManifest(project) {
  const file = manifestPath(project);
  if (!fs.existsSync(file)) return { version: MANIFEST_VERSION, files: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read .factory/adapters.json: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== MANIFEST_VERSION) {
    throw new Error(`.factory/adapters.json has an unsupported version (expected ${MANIFEST_VERSION}).`);
  }
  if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    throw new Error('.factory/adapters.json must hold a "files" object.');
  }
  return parsed;
}

/**
 * Writes the manifest through a temporary file in the same directory and a rename.
 * @param {string} project
 * @param {{ files: Record<string, object> }} manifest
 */
export function writeManifest(project, manifest) {
  const file = manifestPath(project);
  const files = {};
  for (const key of Object.keys(manifest.files).sort()) files[key] = manifest.files[key];
  const body = `${JSON.stringify({ version: MANIFEST_VERSION, tool: toolVersion(), files }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, body);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Decide what to do with one generated file.
 * @param {{ local: string|null, rendering: string, baseline?: string|null, history?: string[], pinned?: boolean }} input
 * @returns {{ status: 'pinned'|'create'|'current'|'update'|'preserved', upstreamChanged?: boolean }}
 */
export function classify({ local, rendering, baseline = null, history = [], pinned = false }) {
  if (pinned) return { status: 'pinned', upstreamChanged: rendering !== baseline };
  if (local === null || local === undefined) return { status: 'create' };
  if (local === rendering) return { status: 'current' };
  if (local === baseline || history.includes(local)) return { status: 'update' };
  return { status: 'preserved' };
}

function indexesOf(text, needle) {
  const out = [];
  let at = text.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
}

function locateSection(text) {
  const starts = indexesOf(text, SECTION_START);
  const ends = indexesOf(text, SECTION_END);
  if (starts.length === 0 && ends.length === 0) return { kind: 'none' };
  if (starts.length !== 1 || ends.length !== 1) {
    return {
      kind: 'malformed',
      reason: `expected one ${SECTION_START} and one ${SECTION_END} marker, found ${starts.length} and ${ends.length}`,
    };
  }
  if (ends[0] < starts[0]) {
    return { kind: 'malformed', reason: 'the end marker comes before the start marker' };
  }
  return { kind: 'one', start: starts[0], end: ends[0] + SECTION_END.length };
}

/** CRLF only when every line break in the text is CRLF. */
export function detectEol(text) {
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

function withEol(text, eol) {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

function planSection(project, item, manifest, history) {
  const local = readLocal(path.join(project, item.path));
  const recorded = manifest.files[item.key] || {};
  const rendering = digest(item.content);
  const base = {
    key: item.key,
    path: item.path,
    scope: item.scope,
    kind: item.kind,
    name: item.name,
    content: item.content,
    rendering,
    baseline: recorded.digest || null,
    local: null,
    localText: null,
  };
  if (!local.exists) return { ...base, status: 'create', mode: 'file' };
  if (!local.regular) return { ...base, status: 'preserved', reason: 'not a regular file', mode: 'none' };
  const found = locateSection(local.text);
  if (found.kind === 'malformed') {
    return { ...base, status: 'malformed', reason: found.reason, localText: local.text, mode: 'none' };
  }
  if (found.kind === 'none') {
    return { ...base, status: 'create', mode: 'append', localText: local.text };
  }
  const localDigest = digest(`${local.text.slice(found.start, found.end)}\n`);
  const result = classify({
    local: localDigest,
    rendering,
    baseline: base.baseline,
    history: history.files[item.key] || [],
    pinned: Boolean(recorded.pinned),
  });
  return {
    ...base,
    ...result,
    local: localDigest,
    localText: local.text,
    mode: 'replace',
    range: [found.start, found.end],
  };
}

/**
 * The full file text after writing this section item. Only the marked block changes.
 * @param {object} item a planned section item
 * @returns {string}
 */
export function renderSectionInto(item) {
  if (item.status === 'malformed') {
    throw new Error(`${item.path} is malformed: ${item.reason}`);
  }
  if (item.mode === 'file') return item.content;
  const eol = detectEol(item.localText);
  if (item.mode === 'append') {
    return `${item.localText.replace(/\s*$/, '')}${eol}${eol}${withEol(item.content, eol)}`;
  }
  const [start, end] = item.range;
  const block = withEol(item.content.replace(/\n$/, ''), eol);
  return `${item.localText.slice(0, start)}${block}${item.localText.slice(end)}`;
}

export function historyPath() {
  return path.join(templatesRoot, 'adapter-history.json');
}

/** @returns {{ version: number, files: Record<string, string[]> }} */
export function loadHistory() {
  const file = historyPath();
  if (!fs.existsSync(file)) return { version: 1, files: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLocal(file) {
  if (!fs.existsSync(file)) return { exists: false };
  if (!fs.statSync(file).isFile()) return { exists: true, regular: false };
  return { exists: true, regular: true, text: fs.readFileSync(file, 'utf8') };
}

function planFile(project, item, manifest, history) {
  const local = readLocal(path.join(project, item.path));
  const recorded = manifest.files[item.key] || {};
  const rendering = digest(item.content);
  const baseline = recorded.digest || null;
  const base = {
    key: item.key,
    path: item.path,
    scope: item.scope,
    kind: item.kind,
    name: item.name,
    content: item.content,
    rendering,
    baseline,
    local: null,
    localText: null,
  };
  if (local.exists && !local.regular) {
    return { ...base, status: 'preserved', reason: 'not a regular file' };
  }
  const localDigest = local.exists ? digest(local.text) : null;
  const result = classify({
    local: localDigest,
    rendering,
    baseline,
    history: history.files[item.key] || [],
    pinned: Boolean(recorded.pinned),
  });
  return {
    ...base,
    ...result,
    local: localDigest,
    localText: local.exists ? local.text : null,
  };
}

/**
 * Classify every generated file without writing anything.
 * @param {string} project
 * @param {{ templates?: string, history?: object, manifest?: object }} [options]
 */
export function planAdapters(project, options = {}) {
  const history = options.history || loadHistory();
  const manifest = options.manifest || readManifest(project);
  const entries = renderAdapters(project, { templates: options.templates });
  const files = [];
  for (const item of entries) {
    files.push(item.scope === 'file'
      ? planFile(project, item, manifest, history)
      : planSection(project, item, manifest, history));
  }
  return { files, orphans: [], manifest };
}
