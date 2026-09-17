'use strict';

// Regression coverage for LEMA-10448 (investigation of the LEMA-10447
// nondeterministic-lookup report): the `lookup` --strict guard + stderr
// fingerprint, and the `assert-integrity` stdout-truncation fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { lookupAll } = require('../lib/ledger');

const TOOLS_DIR = path.join(__dirname, '..');
const CLI = path.join(TOOLS_DIR, 'sweep-integrity.js');
const REPO_ROOT = path.join(TOOLS_DIR, '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'fetch-blocklist.json');
const DATA_PATH = path.join(REPO_ROOT, 'data.json');
const FIXTURE_CANDIDATES_PATH = path.join(TOOLS_DIR, 'test', 'fixtures', 'candidates.json');
const FIXTURE_LEDGER_PATH = path.join(TOOLS_DIR, 'test', 'fixtures', 'mini-ledger.json');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

// LEMA-10448: this is the exact reported symptom -- two `lookup` runs
// against the same ledger disagreeing on one URL's disposition. lookupAll
// is a pure function of its two arguments; if it's actually deterministic
// this loop can never find a mismatch, and if it isn't, this catches it
// directly instead of relying on the much slower/rarer CLI-subprocess
// reproduction used during the investigation (550 subprocess runs, 0
// mismatches -- this test encodes the same check permanently and fast).
test('lookupAll: 200 repeated calls against the real ledger produce byte-identical results', () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const candidateUrls = ledger.entries.map((e) => e.url);
  assert.ok(candidateUrls.length > 100, 'expected a substantial real ledger for this test to be meaningful');

  const baseline = JSON.stringify(lookupAll(candidateUrls, ledger));
  for (let i = 0; i < 200; i++) {
    const attempt = JSON.stringify(lookupAll(candidateUrls, ledger));
    assert.equal(attempt, baseline, `run ${i} diverged from the baseline`);
  }
});

test('lookupAll: the LEMA-10447 primevideo URL resolves to permanentSkip consistently across 200 runs', () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const url = 'https://www.primevideo.com/-/es/detail/0JFCKSNHTRBNJA50K5E6QG2HHN?tr=mx';
  const row = ledger.entries.find((e) => e.url === url);
  if (!row) {
    // fetch-blocklist.json content is Research Specialist's, not this
    // ticket's -- skip rather than false-fail if this exact row is ever
    // remediated/renamed away.
    return;
  }
  for (let i = 0; i < 200; i++) {
    const [result] = lookupAll([url], ledger);
    assert.equal(result.disposition, 'permanentSkip');
    assert.equal(result.skipReason, row.skipReason);
  }
});

test('lookup CLI --strict fails loudly (non-zero exit, no stdout result lines) on an empty ledger', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const emptyLedgerPath = path.join(tmp, 'empty-ledger.json');
  const candidatesPath = path.join(tmp, 'candidates.json');
  fs.writeFileSync(emptyLedgerPath, JSON.stringify({ entries: [] }));
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a']));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', emptyLedgerPath, '--strict']);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--strict guard failed/);
  assert.match(result.stderr, /entries.*empty/);
});

test('lookup CLI --strict fails loudly on an empty candidates array', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'empty-candidates.json');
  fs.writeFileSync(candidatesPath, JSON.stringify([]));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--strict']);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /candidates file is an empty array/);
});

test('lookup CLI without --strict does not fail on the same empty-ledger input (guard is opt-in)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const emptyLedgerPath = path.join(tmp, 'empty-ledger.json');
  const candidatesPath = path.join(tmp, 'candidates.json');
  fs.writeFileSync(emptyLedgerPath, JSON.stringify({ entries: [] }));
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a']));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', emptyLedgerPath]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /not-found/);
});

test('lookup CLI emits a stderr fingerprint whose row count and sha256 match the actual file bytes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a', 'https://example.com/b']));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH]);

  assert.equal(result.status, 0);
  const ledgerRaw = fs.readFileSync(LEDGER_PATH, 'utf8');
  const ledgerEntries = JSON.parse(ledgerRaw).entries.length;
  assert.match(result.stderr, new RegExp(`rows=${ledgerEntries} sha256=${sha256(ledgerRaw)}`));

  const candidatesRaw = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(result.stderr, new RegExp(`count=2 sha256=${sha256(candidatesRaw)}`));
});

test('lookup CLI: two independent runs against the same files produce identical fingerprints and output (mechanical comparability)', () => {
  const args = ['lookup', FIXTURE_CANDIDATES_PATH, '--fetch-blocklist', FIXTURE_LEDGER_PATH];
  const a = runCli(args);
  const b = runCli(args);
  assert.equal(a.status, 0);
  assert.equal(a.stderr, b.stderr);
  assert.equal(a.stdout, b.stdout);
});

// Regression test for the real bug found while investigating LEMA-10447:
// cmdAssertIntegrity used to call process.exit() immediately after its
// final console.log, which can drop buffered stdout once the reader is
// slow enough to backpressure the pipe (reproduced during the
// investigation: truncated at exactly 65536 bytes, the default pipe
// buffer size, leaving invalid JSON on the reading end). This pins the
// fix (LEMA-10448): output must survive a slow/backpressured consumer.
test('assert-integrity CLI: --json output is not truncated by a slow/backpressured pipe consumer', () => {
  const shellCmd = `node ${JSON.stringify(CLI)} assert-integrity --fetch-blocklist ${JSON.stringify(LEDGER_PATH)} --data ${JSON.stringify(DATA_PATH)} --json | { sleep 1; cat; }`;
  const result = spawnSync('sh', ['-c', shellCmd], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 50 });
  assert.equal(result.status, 0);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(result.stdout);
  }, `assert-integrity --json output was truncated/invalid under backpressure: ...${result.stdout.slice(-200)}`);
  assert.ok(parsed.ledger, 'expected a ledger key in the parsed result');
  assert.ok(parsed.dataset, 'expected a dataset key in the parsed result');
});
