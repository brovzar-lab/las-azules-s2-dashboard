'use strict';

// CLI-level coverage for `sweep-integrity.js reconcile` (LEMA-11956):
// usage/exit-code contracts, the stderr fingerprint lines, and --json vs
// plain-text output, exercised end to end through the real CLI entry
// point (not just the tools/lib/reconcile.js unit tests).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TOOLS_DIR = path.join(__dirname, '..');
const CLI = path.join(TOOLS_DIR, 'sweep-integrity.js');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-reconcile-test-'));
}

function writeJsonFile(dir, name, value) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

function dataRow(url, overrides = {}) {
  return {
    outlet: 'Some Outlet',
    headline: 'Some headline',
    url,
    date: 'Sep 1, 2026',
    ts: 20260901,
    lang: 'EN',
    market: 'US',
    type: 'Entertainment',
    excerpt: 'Some excerpt.',
    ...overrides,
  };
}

test('reconcile: missing --candidates prints usage and exits 2', () => {
  const tmp = mkTmp();
  const dataPath = writeJsonFile(tmp, 'data.json', []);
  const result = runCli(['reconcile', '--data', dataPath]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: sweep-integrity\.js reconcile/);
});

test('reconcile: missing pre-write data.json file exits 2 with a named error, not a stack trace', () => {
  const tmp = mkTmp();
  const candidatesPath = writeJsonFile(tmp, 'candidates.json', ['https://example.com/x']);
  const result = runCli(['reconcile', '--candidates', candidatesPath, '--data', path.join(tmp, 'missing.json')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pre-write data\.json not found/);
});

test('reconcile: unrecognized flag is rejected before any file is read', () => {
  const result = runCli(['reconcile', '--candidates', 'x.json', '--bogus', 'y']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unrecognized flag\(s\) for 'reconcile': --bogus/);
});

test('reconcile: prints [reconcile] fingerprint lines for candidates and pre-write data.json', () => {
  const tmp = mkTmp();
  const candidatesPath = writeJsonFile(tmp, 'candidates.json', ['https://example.com/new-story']);
  const preWrite = [dataRow('https://example.com/untouched')];
  const dataPath = writeJsonFile(tmp, 'data.json', preWrite);
  const addedPath = writeJsonFile(tmp, 'added.json', [dataRow('https://example.com/new-story')]);

  const result = runCli([
    'reconcile',
    '--candidates', candidatesPath,
    '--data', dataPath,
    '--added', addedPath,
  ]);

  assert.equal(result.status, 0);
  const candidatesRaw = fs.readFileSync(candidatesPath, 'utf8');
  const dataRaw = fs.readFileSync(dataPath, 'utf8');
  assert.match(
    result.stderr,
    new RegExp(
      `\\[reconcile\\] candidates path=${candidatesPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} count=1 sha256=${sha256(candidatesRaw)}`
    )
  );
  assert.match(
    result.stderr,
    new RegExp(
      `\\[reconcile\\] pre-write data\\.json path=${dataPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} rows=1 sha256=${sha256(dataRaw)}`
    )
  );
  assert.match(result.stderr, /\[reconcile\] added=1 removed=0/);
});

test('reconcile --json: end-to-end A and R together, matching the five ruling test cases', () => {
  const tmp = mkTmp();

  // A: literal-match candidate, absent at Pass 0, added at step 8.
  const literalUrl = 'https://example.com/literal-match';
  // A: within-batch key collision (cinefilos shape) -- two distinct
  // literal strings sharing one key, only one written.
  const collisionA = 'https://www.cinefilos.it/review-621572';
  const collisionB = 'https://cinefilos.it/review-621572';
  // R: multi-row key, only one of two rows removed -> must not decrement.
  const partialRemoveUrl = 'https://example.com/partial-remove?utm_source=a';
  const partialRemoveRowA = dataRow(partialRemoveUrl, { ts: 20260801 });
  const partialRemoveRowB = dataRow('https://example.com/partial-remove?utm_source=b', { ts: 20260802 });
  // R: multi-row key, every row removed -> decrements once.
  const fullRemoveRowA = dataRow('https://example.com/full-remove?utm_source=a', { ts: 20260801 });
  const fullRemoveRowB = dataRow('https://example.com/full-remove?utm_source=b', { ts: 20260802 });
  // Already inDataJson=true, key-collides with an added row: must not add to A.
  const alreadyTrackedUrl = 'https://example.com/already-tracked';
  const alreadyTrackedRow = dataRow(alreadyTrackedUrl, { ts: 20260701 });

  const preWriteDataset = [
    partialRemoveRowA,
    partialRemoveRowB,
    fullRemoveRowA,
    fullRemoveRowB,
    alreadyTrackedRow,
  ];

  const candidates = [
    literalUrl,
    collisionA,
    collisionB,
    'https://example.com/partial-remove',
    'https://example.com/full-remove',
    alreadyTrackedUrl,
  ];

  const addedRows = [
    dataRow(literalUrl),
    dataRow(collisionB),
    dataRow(alreadyTrackedUrl, { ts: 20260701, headline: 'Updated' }),
  ];
  const removedRows = [partialRemoveRowA, fullRemoveRowA, fullRemoveRowB];

  const candidatesPath = writeJsonFile(tmp, 'candidates.json', candidates);
  const dataPath = writeJsonFile(tmp, 'data.json', preWriteDataset);
  const addedPath = writeJsonFile(tmp, 'added.json', addedRows);
  const removedPath = writeJsonFile(tmp, 'removed.json', removedRows);

  const result = runCli([
    'reconcile',
    '--candidates', candidatesPath,
    '--data', dataPath,
    '--added', addedPath,
    '--removed', removedPath,
    '--json',
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);

  // A = literal-match (1) + both collision candidates (2) = 3.
  // already-tracked must NOT count even though it key-collides with an added row.
  assert.equal(parsed.a, 3);
  // R = full-remove (both rows gone) = 1. partial-remove must NOT count.
  assert.equal(parsed.r, 1);

  const addedUrls = parsed.addedMatches.map((m) => m.url).sort();
  assert.deepEqual(addedUrls, [collisionA, collisionB, literalUrl].sort());

  const removedUrls = parsed.removedMatches.map((m) => m.url);
  assert.deepEqual(removedUrls, ['https://example.com/full-remove']);
});

test('reconcile (plain text): prints "A=<n> R=<n>" summary line plus per-match detail lines', () => {
  const tmp = mkTmp();
  const candidatesPath = writeJsonFile(tmp, 'candidates.json', ['https://example.com/new-story']);
  const dataPath = writeJsonFile(tmp, 'data.json', [dataRow('https://example.com/untouched')]);
  const addedPath = writeJsonFile(tmp, 'added.json', [dataRow('https://example.com/new-story')]);

  const result = runCli([
    'reconcile',
    '--candidates', candidatesPath,
    '--data', dataPath,
    '--added', addedPath,
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^A=1 R=0$/m);
  assert.match(result.stdout, /- A: https:\/\/example\.com\/new-story \[example\.com\/new-story\]/);
});

test('reconcile: omitting --added/--removed defaults to empty lists (A=0 R=0 when nothing changed)', () => {
  const tmp = mkTmp();
  const candidatesPath = writeJsonFile(tmp, 'candidates.json', ['https://example.com/untouched']);
  const dataPath = writeJsonFile(tmp, 'data.json', [dataRow('https://example.com/untouched')]);

  const result = runCli(['reconcile', '--candidates', candidatesPath, '--data', dataPath, '--json']);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.a, 0);
  assert.equal(parsed.r, 0);
});
