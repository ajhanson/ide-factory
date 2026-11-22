import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attemptPath, getAttempt } from './attempt.mjs';
import { writeText } from './layout.mjs';
import { isFailingRed, redForKind } from './red-evidence.mjs';

export const EXCEPTION_TYPES = ['reuse', 'waiver'];

const REQUIRED_RECORD_FIELDS = [
  'schemaVersion',
  'id',
  'type',
  'change',
  'task',
  'attemptId',
  'kind',
  'approver',
  'reason',
  'issuance',
  'policyVersion',
  'sourceRevision',
];

const EXCEPTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function exceptionsDir(project) {
  return path.join(project, '.factory', 'exceptions', 'red');
}

export function exceptionFilePath(project, id) {
  return path.join(exceptionsDir(project), `${id}.json`);
}

function digestText(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('red exception must be an object');
  }
  for (const field of REQUIRED_RECORD_FIELDS) {
    if (record[field] === undefined || record[field] === null || record[field] === '') {
      throw new Error(`red exception missing required field: ${field}`);
    }
  }
  if (!EXCEPTION_TYPES.includes(record.type)) {
    throw new Error(`red exception type must be one of: ${EXCEPTION_TYPES.join(', ')}`);
  }
  if (typeof record.id !== 'string' || !EXCEPTION_ID.test(record.id)) {
    throw new Error('red exception id is invalid');
  }
}

/**
 * Write one immutable exception file, then bind it to the attempt by digest.
 * The file is written first so a crash leaves an unbound file that satisfies nothing.
 *
 * @param {string} project
 * @param {string} attemptId
 * @param {object} record
 * @returns {{ file: string, digest: string, attempt: object }}
 */
export function bindRedException(project, attemptId, record) {
  validateRecord(record);
  if (record.attemptId !== attemptId) {
    throw new Error('red exception attemptId does not match the target attempt');
  }
  const attempt = getAttempt(project, attemptId);
  if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
  if (attempt.evidence?.redExceptions?.[record.kind]) {
    throw new Error(`attempt already has an exception for ${record.kind}`);
  }

  const file = exceptionFilePath(project, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(file, text, { flag: 'wx' });
  const digest = digestText(text);

  attempt.evidence = attempt.evidence || {};
  attempt.evidence.redExceptions = {
    ...(attempt.evidence.redExceptions || {}),
    [record.kind]: { id: record.id, type: record.type, digest },
  };
  attempt.updatedAt = new Date().toISOString();
  writeText(attemptPath(project, attemptId), JSON.stringify(attempt, null, 2));
  return { file, digest, attempt };
}

/**
 * Load the exception bound to an attempt and kind, or null when the pointer is
 * absent or the file is missing, altered, or bound to something else.
 */
export function readBoundException(project, attempt, kind) {
  const pointer = attempt?.evidence?.redExceptions?.[kind];
  if (!pointer || typeof pointer !== 'object') return null;
  if (!EXCEPTION_TYPES.includes(pointer.type)) return null;
  if (typeof pointer.id !== 'string' || !EXCEPTION_ID.test(pointer.id)) return null;
  let text;
  try {
    text = fs.readFileSync(exceptionFilePath(project, pointer.id), 'utf8');
  } catch {
    return null;
  }
  if (digestText(text) !== pointer.digest) return null;
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    record.id !== pointer.id
    || record.type !== pointer.type
    || record.attemptId !== attempt.id
    || record.kind !== kind
    || record.change !== attempt.change
    || record.task !== attempt.taskId
  ) {
    return null;
  }
  return record;
}

/**
 * Whether red is satisfied for one kind, and by what.
 * @returns {'cli'|'reuse'|'waiver'|'missing'}
 */
export function redSatisfaction(project, attempt, kind) {
  if (isFailingRed(redForKind(attempt, kind))) return 'cli';
  const record = readBoundException(project, attempt, kind);
  return record ? record.type : 'missing';
}
