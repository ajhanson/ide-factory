import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readTransitionEvidence } from '../src/lib/evidence-input.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idefactory-evidence-'));
}

function withFile(content, fn) {
  const dir = tempDir();
  const file = path.join(dir, 'evidence.json');
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE = {
  reviewerId: 'reviewer-1',
  verdict: 'ACCEPT',
  notes: 'He said "ship it" \\ and left — café, naïve, 日本語',
};

test('no evidence flag yields an empty object', () => {
  assert.deepEqual(readTransitionEvidence({}), {});
});

test('inline JSON returns the parsed object', () => {
  assert.deepEqual(readTransitionEvidence({ evidence: JSON.stringify(SAMPLE) }), SAMPLE);
});

test('a file holding a JSON object returns the same object as inline JSON', () => {
  const text = JSON.stringify(SAMPLE, null, 2);
  withFile(text, (file) => {
    assert.deepEqual(readTransitionEvidence({ 'evidence-file': file }), SAMPLE);
    assert.deepEqual(
      readTransitionEvidence({ 'evidence-file': file }),
      readTransitionEvidence({ evidence: text }),
    );
  });
});

test('spaces, escaped quotes, and non-ASCII text round-trip unchanged', () => {
  const evidence = { verdict: 'ACCEPT', notes: 'test with spaces and \\"escaped\\" quotes \\\\ ünï' };
  withFile(JSON.stringify(evidence), (file) => {
    assert.equal(readTransitionEvidence({ 'evidence-file': file }).notes, evidence.notes);
  });
});

test('a UTF-8 byte-order mark is accepted', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(SAMPLE), 'utf8')]);
  withFile(bytes, (file) => {
    assert.deepEqual(readTransitionEvidence({ 'evidence-file': file }), SAMPLE);
  });
});

test('UTF-16LE content with a byte-order mark is accepted', () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(SAMPLE), 'utf16le')]);
  withFile(bytes, (file) => {
    assert.deepEqual(readTransitionEvidence({ 'evidence-file': file }), SAMPLE);
  });
});

test('reading leaves the evidence file untouched', () => {
  withFile(JSON.stringify(SAMPLE), (file) => {
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    readTransitionEvidence({ 'evidence-file': file });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.statSync(file).mtimeMs, mtime);
  });
});

test('both sources given names both flags and asks for only one', () => {
  withFile(JSON.stringify(SAMPLE), (file) => {
    assert.throws(
      () => readTransitionEvidence({ evidence: '{}', 'evidence-file': file }),
      (error) => /--evidence/.test(error.message)
        && /--evidence-file/.test(error.message)
        && /only one/.test(error.message),
    );
  });
});

test('the conflict is reported before the file is read', () => {
  assert.throws(
    () => readTransitionEvidence({ evidence: '{}', 'evidence-file': '/no/such/file.json' }),
    /only one/,
  );
});

test('a flag given with no value fails with the transition usage', () => {
  for (const flags of [{ evidence: true }, { 'evidence-file': true }, { 'evidence-file': '' }]) {
    assert.throws(
      () => readTransitionEvidence(flags),
      /Usage: idefactory attempt transition .*--evidence-file/,
      JSON.stringify(flags),
    );
  }
});

test('a missing path names the path', () => {
  const missing = path.join(tempDir(), 'nope.json');
  assert.throws(
    () => readTransitionEvidence({ 'evidence-file': missing }),
    (error) => error.message.includes(`evidence file not found: ${missing}`),
  );
});

test('JSON text passed as the file value fails as a missing file and points to --evidence', () => {
  const inline = '{"verdict":"ACCEPT"}';
  assert.throws(
    () => readTransitionEvidence({ 'evidence-file': inline }),
    (error) => error.message.includes(`evidence file not found: ${inline}`)
      && /--evidence takes inline JSON/.test(error.message),
  );
});

test('a directory fails naming the path', () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => readTransitionEvidence({ 'evidence-file': dir }),
      (error) => error.message.includes(`evidence file is a directory: ${dir}`),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty file fails saying it is empty and names the path', () => {
  withFile('', (file) => {
    assert.throws(
      () => readTransitionEvidence({ 'evidence-file': file }),
      (error) => error.message.includes(`evidence file is empty: ${file}`),
    );
  });
  withFile(Buffer.from([0xef, 0xbb, 0xbf]), (file) => {
    assert.throws(
      () => readTransitionEvidence({ 'evidence-file': file }),
      /evidence file is empty/,
    );
  });
});

test('malformed JSON in the file fails naming the path', () => {
  withFile('{not json', (file) => {
    assert.throws(
      () => readTransitionEvidence({ 'evidence-file': file }),
      (error) => error.message.includes(`evidence file ${file} is not valid JSON`),
    );
  });
});

test('JSON that is not an object fails naming the path', () => {
  for (const text of ['[]', '[1]', '"text"', '12', 'true', 'null']) {
    withFile(text, (file) => {
      assert.throws(
        () => readTransitionEvidence({ 'evidence-file': file }),
        (error) => error.message.includes(`evidence file ${file} must hold a JSON object`),
        text,
      );
    });
  }
});

test('malformed inline JSON names --evidence-file as the alternative', () => {
  assert.throws(
    () => readTransitionEvidence({ evidence: '{verdict:ACCEPT}' }),
    (error) => /--evidence-file <path>/.test(error.message)
      && /shell quoting/.test(error.message),
  );
});
