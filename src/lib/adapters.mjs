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
