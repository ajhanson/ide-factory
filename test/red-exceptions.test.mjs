import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { attemptPath, getAttempt } from '../src/lib/attempt.mjs';
import {
  bindRedException,
  exceptionFilePath,
  redSatisfaction,
} from '../src/lib/red-exceptions.mjs';
import { resolveGitBinding } from '../src/lib/verification-evidence.mjs';
import { cleanup, idefactory, tempProject } from './helpers.mjs';

function writeRegistry(dir, exitCode) {
  fs.writeFileSync(
    path.join(dir, '.factory/checks.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      checks: {
        unit: {
          argv: [process.execPath, '-e', `process.exit(${exitCode})`],
          cwdPolicy: 'project',
          timeoutMs: 30_000,
          artifacts: [],
        },
      },
    }, null, 2)}\n`,
  );
}

function ensureCleanGitCommit(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'idefactory-test']);
  }
  const ignore = path.join(dir, '.gitignore');
  const lines = [
    '.factory/attempts/*',
    '!.factory/attempts/.gitkeep',
    '.factory/work/',
    '.factory/ledger.jsonl',
    '.factory/orchestration/*',
    '!.factory/orchestration/.gitkeep',
  ];
  fs.writeFileSync(ignore, `${lines.join('\n')}\n`);
  git(dir, ['add', '-A']);
  const porcelain = spawnSync('git', ['status', '--porcelain', '--', '.', ':!.factory/exceptions'], {
    cwd: dir,
    encoding: 'utf8',
    shell: false,
  });
  if (porcelain.stdout.trim().length > 0) git(dir, ['commit', '-m', 'checkpoint']);
  return git(dir, ['rev-parse', 'HEAD']);
}

async function recordPass(dir, attemptId) {
  writeRegistry(dir, 0);
  ensureCleanGitCommit(dir);
  const result = await idefactory(dir, ['verify', 'run', attemptId, '--check', 'unit']);
  assert.equal(result.code, 0, result.err + result.out);
}

async function toImplementing(dir, attemptId, implementerId = 'engineer-1') {
  const result = await idefactory(dir, [
    'attempt', 'transition', attemptId, 'implementing',
    '--evidence', JSON.stringify({ implementerId }),
  ]);
  assert.equal(result.code, 0, result.err);
}

function transition(dir, attemptId, state, evidence = {}) {
  return idefactory(dir, [
    'attempt', 'transition', attemptId, state, '--evidence', JSON.stringify(evidence),
  ]);
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'idefactory-test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'idefactory-test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function setPolicyVersion(dir, version) {
  const configPath = path.join(dir, '.factory/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.governance.policyVersion = version;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function seedAttempt(dir) {
  assert.equal((await idefactory(dir, ['init'])).code, 0);
  setPolicyVersion(dir, 1);
  fs.mkdirSync(path.join(dir, 'openspec/changes/demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'openspec/changes/demo/tasks.md'),
    [
      '- [ ] 1.1 Add parser',
      '  factory:',
      '    kind: general',
      '    checks: [unit]',
      '    verificationProfile: frontend-low',
      '    roles: [engineer, reviewer, scribe]',
      '',
    ].join('\n'),
  );
  assert.equal((await idefactory(dir, ['sync-tasks', 'demo'])).code, 0);
  const started = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
  assert.equal(started.code, 0, started.err);
  return JSON.parse(started.out);
}

function exceptionRecord(attempt, overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'exc-1',
    type: 'waiver',
    change: attempt.change,
    task: attempt.taskId,
    attemptId: attempt.id,
    kind: 'unit',
    approver: 'human-1',
    reason: 'test exception',
    issuance: new Date().toISOString(),
    policyVersion: 1,
    sourceRevision: 'abc123',
    acknowledgedNotStuck: false,
    ...overrides,
  };
}

function writeCliRed(dir, attemptId, kind = 'unit') {
  const file = attemptPath(dir, attemptId);
  const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
  attempt.evidence.reds = {
    ...(attempt.evidence.reds || {}),
    [kind]: {
      kind,
      issuer: 'cli',
      exitCode: 1,
      passed: false,
      attemptId,
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(attempt, null, 2)}\n`);
}

test('redSatisfaction is cli for a stored failing CLI red and missing for none', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    assert.equal(redSatisfaction(dir, getAttempt(dir, started.id), 'unit'), 'missing');
    writeCliRed(dir, started.id);
    assert.equal(redSatisfaction(dir, getAttempt(dir, started.id), 'unit'), 'cli');
    assert.equal(redSatisfaction(dir, getAttempt(dir, started.id), 'integration'), 'missing');
  } finally {
    cleanup(dir);
  }
});

test('a bound waiver or reuse exception satisfies red for its kind only', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    const attempt = getAttempt(dir, started.id);
    bindRedException(dir, attempt.id, exceptionRecord(attempt, { type: 'waiver' }));
    const bound = getAttempt(dir, attempt.id);
    assert.equal(redSatisfaction(dir, bound, 'unit'), 'waiver');
    assert.equal(redSatisfaction(dir, bound, 'integration'), 'missing');
    assert.equal(bound.evidence.redExceptions.unit.type, 'waiver');
    assert.match(bound.evidence.redExceptions.unit.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(bound.evidence.reds ?? null, null, 'exception must not be stored as a CLI red');
    assert.equal(fs.existsSync(exceptionFilePath(dir, 'exc-1')), true);

    const second = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const next = getAttempt(dir, JSON.parse(second.out).id);
    bindRedException(dir, next.id, exceptionRecord(next, {
      id: 'exc-2',
      type: 'reuse',
      source: { attemptId: attempt.id },
    }));
    assert.equal(redSatisfaction(dir, getAttempt(dir, next.id), 'unit'), 'reuse');
  } finally {
    cleanup(dir);
  }
});

test('an edited, deleted, or other-attempt exception file does not satisfy red', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    const attempt = getAttempt(dir, started.id);
    bindRedException(dir, attempt.id, exceptionRecord(attempt));
    const file = exceptionFilePath(dir, 'exc-1');
    const original = fs.readFileSync(file, 'utf8');

    fs.writeFileSync(file, original.replace('test exception', 'changed reason'));
    assert.equal(redSatisfaction(dir, getAttempt(dir, attempt.id), 'unit'), 'missing');

    fs.writeFileSync(file, original);
    assert.equal(redSatisfaction(dir, getAttempt(dir, attempt.id), 'unit'), 'waiver');

    const second = await idefactory(dir, ['attempt', 'start', 'demo', '1.1']);
    const other = getAttempt(dir, JSON.parse(second.out).id);
    const pointer = getAttempt(dir, attempt.id).evidence.redExceptions;
    const otherFile = attemptPath(dir, other.id);
    const otherStored = JSON.parse(fs.readFileSync(otherFile, 'utf8'));
    otherStored.evidence.redExceptions = pointer;
    fs.writeFileSync(otherFile, `${JSON.stringify(otherStored, null, 2)}\n`);
    assert.equal(redSatisfaction(dir, getAttempt(dir, other.id), 'unit'), 'missing');

    fs.rmSync(file);
    assert.equal(redSatisfaction(dir, getAttempt(dir, attempt.id), 'unit'), 'missing');
  } finally {
    cleanup(dir);
  }
});

test('a second exception for the same attempt and kind is refused and keeps the first', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    const attempt = getAttempt(dir, started.id);
    bindRedException(dir, attempt.id, exceptionRecord(attempt));
    const before = fs.readFileSync(exceptionFilePath(dir, 'exc-1'), 'utf8');
    assert.throws(
      () => bindRedException(dir, attempt.id, exceptionRecord(attempt, { id: 'exc-2' })),
      /already has an exception/,
    );
    assert.equal(fs.existsSync(exceptionFilePath(dir, 'exc-2')), false);
    assert.equal(fs.readFileSync(exceptionFilePath(dir, 'exc-1'), 'utf8'), before);
    assert.throws(
      () => bindRedException(dir, attempt.id, exceptionRecord(attempt, { type: 'bogus', kind: 'integration', id: 'exc-3' })),
      /type/,
    );
  } finally {
    cleanup(dir);
  }
});

test('uncommitted exception files stay run-state but product changes do not', () => {
  const dir = tempProject();
  try {
    git(dir, ['init']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
    fs.mkdirSync(path.join(dir, '.factory'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.factory/config.json'), '{}\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'init']);
    fs.mkdirSync(path.join(dir, '.factory/exceptions/red'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.factory/exceptions/red/x.json'), '{}\n');
    assert.equal(resolveGitBinding(dir).worktreeClean, true);
    fs.writeFileSync(path.join(dir, 'product.js'), 'x\n');
    assert.equal(resolveGitBinding(dir).worktreeClean, false);
  } finally {
    cleanup(dir);
  }
});

test('verifying accepts a valid exception and rejects a kind with neither red nor exception', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    await toImplementing(dir, started.id);
    await recordPass(dir, started.id);

    const refused = await transition(dir, started.id, 'verifying');
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /verifying requires a recorded failing CLI red for: unit/);
    assert.equal(getAttempt(dir, started.id).state, 'implementing');

    bindRedException(dir, started.id, exceptionRecord(getAttempt(dir, started.id)));
    const ok = await transition(dir, started.id, 'verifying');
    assert.equal(ok.code, 0, ok.err);
    const stored = getAttempt(dir, started.id);
    assert.equal(stored.state, 'verifying');
    assert.equal(stored.evidence.reds ?? null, null);
  } finally {
    cleanup(dir);
  }
});

test('verifying rejects an altered exception', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    await toImplementing(dir, started.id);
    await recordPass(dir, started.id);
    bindRedException(dir, started.id, exceptionRecord(getAttempt(dir, started.id)));
    const file = exceptionFilePath(dir, 'exc-1');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('test exception', 'edited'));
    const refused = await transition(dir, started.id, 'verifying');
    assert.notEqual(refused.code, 0);
    assert.equal(getAttempt(dir, started.id).state, 'implementing');
  } finally {
    cleanup(dir);
  }
});

test('red-confirmed still needs a genuine CLI red', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    await toImplementing(dir, started.id);
    bindRedException(dir, started.id, exceptionRecord(getAttempt(dir, started.id)));
    const refused = await transition(dir, started.id, 'red-confirmed');
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /red-confirmed requires stored evidence\.red/);
    assert.equal(getAttempt(dir, started.id).state, 'implementing');
  } finally {
    cleanup(dir);
  }
});

test('an attempt transition rejects a caller-supplied exception object', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    await toImplementing(dir, started.id);
    await recordPass(dir, started.id);
    const refused = await transition(dir, started.id, 'verifying', {
      redExceptions: { unit: { id: 'x', type: 'waiver', digest: 'sha256:0' } },
    });
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /caller-supplied/);
    const stored = getAttempt(dir, started.id);
    assert.equal(stored.state, 'implementing');
    assert.equal(stored.evidence.redExceptions ?? null, null);
  } finally {
    cleanup(dir);
  }
});

async function acceptWithException(dir, attemptId) {
  await toImplementing(dir, attemptId);
  await recordPass(dir, attemptId);
  bindRedException(dir, attemptId, exceptionRecord(getAttempt(dir, attemptId)));
  assert.equal((await transition(dir, attemptId, 'verifying')).code, 0);
  assert.equal((await transition(dir, attemptId, 'awaiting-review')).code, 0);
  const accepted = await transition(dir, attemptId, 'accepted', {
    reviewerId: 'reviewer-1',
    verdict: 'ACCEPT',
  });
  assert.equal(accepted.code, 0, accepted.err);
}

test('complete accepts a valid exception in place of a CLI red', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    await acceptWithException(dir, started.id);
    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', started.id]);
    assert.equal(done.code, 0, done.err + done.out);
    const stored = getAttempt(dir, started.id);
    assert.equal(stored.state, 'finalized');
    assert.equal(stored.evidence.reds ?? null, null);
  } finally {
    cleanup(dir);
  }
});

test('complete fails when the only red is an altered exception', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    await acceptWithException(dir, started.id);
    const file = exceptionFilePath(dir, 'exc-1');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('test exception', 'edited'));
    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', started.id]);
    assert.notEqual(done.code, 0);
    assert.match(done.err, /complete requires a recorded failing CLI red or red exception for: unit/);
    assert.notEqual(getAttempt(dir, started.id).state, 'finalized');
  } finally {
    cleanup(dir);
  }
});

test('complete still rejects a code attempt with neither a red nor an exception', async () => {
  const dir = tempProject();
  try {
    const started = await seedAttempt(dir);
    await acceptWithException(dir, started.id);
    const file = attemptPath(dir, started.id);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete stored.evidence.redExceptions;
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const done = await idefactory(dir, ['complete', 'demo', '1.1', '--attempt', started.id]);
    assert.notEqual(done.code, 0);
    assert.match(done.err, /complete requires a recorded failing CLI red/);
  } finally {
    cleanup(dir);
  }
});
