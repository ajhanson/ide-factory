import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, idefactory, repoRoot, tempProject } from './helpers.mjs';

const REVIEW_COMMAND_PATHS = [
  '.cursor/commands/factory-review.md',
  '.claude/commands/factory-review.md',
  '.github/prompts/factory-review.prompt.md',
  '.cline/workflows/factory-review.md',
];

const BUILD_SKILL_PATHS = [
  'templates/skills/factory-build/SKILL.md',
  '.cursor/skills/factory-build/SKILL.md',
  '.claude/skills/factory-build/SKILL.md',
  '.github/skills/factory-build/SKILL.md',
  '.agents/skills/factory-build/SKILL.md',
  '.cline/skills/factory-build/SKILL.md',
];

const FORBIDDEN = [
  /Accept only if a failing test was written first/i,
  /Acceptance requires red evidence and verification evidence/i,
];

const CONDITIONAL_MARKERS = [
  [/`code` item whose checks include a test kind/, 'code item with a test kind'],
  [/`unit`, `integration`, `playwright`, `contract`, or `unit-\*`/, 'test kinds'],
  [/`lightweight` item/, 'lightweight item'],
  [/no test check/i, 'no test check'],
  [/red exception is not a red that ran/i, 'exception is not a red that ran'],
  [/clean HEAD/, 'clean HEAD'],
  [/different role/i, 'different role'],
];

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assertConditionalGuidance(text, label) {
  for (const pattern of FORBIDDEN) {
    assert.doesNotMatch(text, pattern, `${label} must not carry ${pattern}`);
  }
  for (const [pattern, name] of CONDITIONAL_MARKERS) {
    assert.match(text, pattern, `${label} must state: ${name}`);
  }
}

test('the source review command states the conditional red rule', () => {
  assertConditionalGuidance(read(repoRoot, 'templates/commands/factory-review.md'), 'templates review command');
});

test('a fresh init writes the conditional review command in every adapter', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    for (const rel of REVIEW_COMMAND_PATHS) {
      assertConditionalGuidance(read(dir, rel), `init ${rel}`);
    }
  } finally {
    cleanup(dir);
  }
});

test('the checked-in review commands carry the conditional red rule', () => {
  for (const rel of REVIEW_COMMAND_PATHS) {
    assertConditionalGuidance(read(repoRoot, rel), rel);
  }
});

test('every copy of the factory-build skill states the conditional red rule', async () => {
  for (const rel of BUILD_SKILL_PATHS) {
    assertConditionalGuidance(read(repoRoot, rel), rel);
  }
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    for (const rel of BUILD_SKILL_PATHS.slice(1)) {
      assertConditionalGuidance(read(dir, rel), `init ${rel}`);
    }
  } finally {
    cleanup(dir);
  }
});

test('upgrade replaces the old unconditional review command with the conditional one', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const file = path.join(dir, '.cursor/commands/factory-review.md');
    fs.writeFileSync(
      file,
      '---\ndescription: old\n---\n\nAccept only if a failing test was written first and a verification command passed.\n\n<!-- idefactory:owned -->\n',
    );
    assert.equal((await idefactory(dir, ['upgrade'])).code, 0);
    assertConditionalGuidance(fs.readFileSync(file, 'utf8'), 'upgraded review command');
  } finally {
    cleanup(dir);
  }
});

test('a fresh init writes charters that state the conditional red rule', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const engineer = read(dir, '.factory/agents/engineer/charter.md');
    assert.match(engineer, /`code` item whose checks include a test kind/);
    assert.match(engineer, /`lightweight`/);
    assert.match(engineer, /red exception/i);
    assert.doesNotMatch(engineer, /when the verification profile includes unit or equivalent checks/);
    const reviewer = read(dir, '.factory/agents/reviewer/charter.md');
    assert.match(reviewer, /valid recorded red exception/i);
    assert.match(reviewer, /`code` item whose checks include a test kind/);
    assert.doesNotMatch(reviewer, /failing-test-first evidence when required/);
  } finally {
    cleanup(dir);
  }
});

test('a second init leaves an edited charter byte-identical', async () => {
  const dir = tempProject();
  try {
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    const file = path.join(dir, '.factory/agents/reviewer/charter.md');
    fs.writeFileSync(file, '# Reviewer\n\nProject-specific charter.\n');
    assert.equal((await idefactory(dir, ['init'])).code, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '# Reviewer\n\nProject-specific charter.\n');
  } finally {
    cleanup(dir);
  }
});
