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

// LEMA-10591: pre-fetch data.json presence check. Same fingerprint
// discipline as the ledger/candidates lines above (LEMA-10448), extended
// to data.json so a dedup decision made against it is mechanically
// auditable too.
test('lookup CLI: stderr fingerprint line for data.json matches the actual file bytes, and --data override is honored', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const dataPath = path.join(tmp, 'data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/covered', 'https://example.com/not-covered']));
  fs.writeFileSync(dataPath, JSON.stringify([
    { outlet: 'Test Outlet', headline: 'h', url: 'https://www.example.com/covered/', date: 'Sep 1, 2026', ts: 20260901, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'e' },
  ]));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', dataPath]);

  assert.equal(result.status, 0);
  const dataRaw = fs.readFileSync(dataPath, 'utf8');
  assert.match(result.stderr, new RegExp(`\\[lookup\\] data\\.json path=${dataPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} rows=1 sha256=${sha256(dataRaw)}`));

  assert.match(result.stdout, /https:\/\/example\.com\/covered\t.*inDataJson=true dataJsonTs=20260901 dataJsonOutlet="Test Outlet"/);
  assert.match(result.stdout, /https:\/\/example\.com\/not-covered\t.*inDataJson=false/);
});

test('lookup CLI --json: results carry inDataJson/dataJsonTs/dataJsonOutlet fields', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const dataPath = path.join(tmp, 'data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/covered']));
  fs.writeFileSync(dataPath, JSON.stringify([
    { outlet: 'Test Outlet', headline: 'h', url: 'https://example.com/covered', date: 'Sep 1, 2026', ts: 20260901, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'e' },
  ]));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', dataPath, '--json']);

  assert.equal(result.status, 0);
  const [r] = JSON.parse(result.stdout);
  assert.equal(r.inDataJson, true);
  assert.equal(r.dataJsonTs, 20260901);
  assert.equal(r.dataJsonOutlet, 'Test Outlet');
});

// LEMA-10592: without a data.json shape check, --strict validated the
// ledger and candidates files but let an unusable data.json through --
// lookupAll would receive `datasetEntries || []` and every candidate
// would silently report inDataJson=false (including ones demonstrably
// present in the real file), with the process still exiting 0.
test('lookup CLI --strict fails loudly on a data.json that is not a JSON array', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const badDataPath = path.join(tmp, 'bad-data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a']));
  fs.writeFileSync(badDataPath, JSON.stringify({ not: 'an array' }));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', badDataPath, '--strict']);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--strict guard failed/);
  assert.match(result.stderr, /data\.json is not a JSON array/);
});

test('lookup CLI --strict fails loudly on an empty data.json array', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const emptyDataPath = path.join(tmp, 'empty-data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a']));
  fs.writeFileSync(emptyDataPath, JSON.stringify([]));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', emptyDataPath, '--strict']);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--strict guard failed/);
  assert.match(result.stderr, /data\.json array is empty/);
});

// Explicit backward-compat pin, matching the same "guard is opt-in"
// contract already established for the ledger/candidates checks above:
// non-strict stays permissive on a bad data.json, and the pre-existing
// `rows=INVALID` stderr fingerprint remains the only signal there.
test('lookup CLI without --strict stays permissive on a bad data.json (guard is opt-in, matches ledger/candidates precedent)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const badDataPath = path.join(tmp, 'bad-data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a']));
  fs.writeFileSync(badDataPath, JSON.stringify({ not: 'an array' }));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', badDataPath]);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /data\.json path=.*rows=INVALID/);
  assert.match(result.stdout, /inDataJson=false/);
});

// LEMA-10595: --strict=true used to parse as an unrecognized flag named
// literally "strict=true", so flags.strict stayed undefined and the
// --strict guard silently never ran (fail open, exit 0, wrong answer).
test('lookup CLI: --strict=true (equals form) arms the guard exactly like a bare --strict', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const badDataPath = path.join(tmp, 'bad-data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a']));
  fs.writeFileSync(badDataPath, JSON.stringify({ not: 'an array' }));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', badDataPath, '--strict=true']);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--strict guard failed/);
  assert.match(result.stderr, /data\.json is not a JSON array/);
});

// LEMA-10595: --strict=false must actually disarm the guard, not just fail
// to arm it. Since flags now hold a real string value ("false") rather than
// silently vanishing, a naive truthy check would treat any non-empty string
// as "on" and re-arm a guard the caller explicitly asked to turn off.
test('lookup CLI: --strict=false does not arm the guard', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const badDataPath = path.join(tmp, 'bad-data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a']));
  fs.writeFileSync(badDataPath, JSON.stringify({ not: 'an array' }));

  const result = runCli(['lookup', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', badDataPath, '--strict=false']);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /\[lookup\] strict=off/);
});

// LEMA-10595: --data=path used to be parsed as an unrecognized flag named
// literally "data=path", so cmdLookup fell back to DEFAULT_DATA_PATH and
// silently answered against the wrong file while claiming (via the
// fingerprint line, which did print the real path used) that everything
// was fine.
test('lookup CLI: --data=path (equals form) is honored, not silently ignored in favor of the default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const dataPath = path.join(tmp, 'data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/covered']));
  fs.writeFileSync(dataPath, JSON.stringify([
    { outlet: 'Test Outlet', headline: 'h', url: 'https://example.com/covered', date: 'Sep 1, 2026', ts: 20260901, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'e' },
  ]));

  const result = runCli(['lookup', candidatesPath, `--fetch-blocklist=${LEDGER_PATH}`, `--data=${dataPath}`]);

  assert.equal(result.status, 0);
  const dataRaw = fs.readFileSync(dataPath, 'utf8');
  assert.match(result.stderr, new RegExp(`\\[lookup\\] data\\.json path=${dataPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} rows=1 sha256=${sha256(dataRaw)}`));
  assert.match(result.stdout, /https:\/\/example\.com\/covered\t.*inDataJson=true/);
});

// LEMA-10595: a fourth stderr line makes the armed/disarmed state of
// --strict provable from the transcript alone, since a passing run used to
// look byte-identical with and without --strict.
test('lookup CLI: emits "[lookup] strict=on"/"strict=off" as a fourth stderr line without altering the three existing fingerprint lines', () => {
  const args = ['lookup', FIXTURE_CANDIDATES_PATH, '--fetch-blocklist', FIXTURE_LEDGER_PATH];
  const plain = runCli(args);
  const strict = runCli([...args, '--strict']);

  assert.equal(plain.status, 0);
  assert.equal(strict.status, 0);
  assert.match(plain.stderr, /\[lookup\] strict=off/);
  assert.match(strict.stderr, /\[lookup\] strict=on/);

  const stripStrictLine = (s) => s.split('\n').filter((l) => !/^\[lookup\] strict=/.test(l)).join('\n');
  assert.equal(stripStrictLine(plain.stderr), stripStrictLine(strict.stderr));
  assert.equal(plain.stdout, strict.stdout);
});

// LEMA-10595: unrecognized flags used to be parsed silently into a key
// nobody read (`--stict` -> flags.stict, `--foo` -> flags.foo) with no
// error of any kind. Every command should now reject them loudly, naming
// the offending flag.
test('lookup CLI: rejects an unrecognized flag (typo) instead of silently ignoring it', () => {
  const result = runCli(['lookup', FIXTURE_CANDIDATES_PATH, '--fetch-blocklist', FIXTURE_LEDGER_PATH, '--stict']);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unrecognized flag/);
  assert.match(result.stderr, /--stict/);
});

test('normalize CLI: rejects any flag (command takes none)', () => {
  const result = runCli(['normalize', 'https://example.com/a', '--json']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized flag/);
  assert.match(result.stderr, /--json/);
});

test('assert-integrity CLI: rejects an unrecognized flag', () => {
  const result = runCli(['assert-integrity', '--fetch-blocklist', LEDGER_PATH, '--data', DATA_PATH, '--targett', 'ledger']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized flag/);
  assert.match(result.stderr, /--targett/);
});

test('evidence CLI: rejects an unrecognized flag', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/a']));

  const result = runCli(['evidence', '--candidates', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', DATA_PATH, '--verbose']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized flag/);
  assert.match(result.stderr, /--verbose/);
});

// assert-integrity's boolean flags (--fix, --json) go through the same
// coercion path as lookup's --strict; pin the equals-form for at least one
// of them here since assert-integrity has no dedicated test file of its
// own. Deliberately uses the default (non-JSON) text output rather than
// --json: the live fetch-blocklist.json/data.json are large enough that a
// full --json dump exceeds spawnSync's default 1MB stdout buffer, which
// truncates non-deterministically and has nothing to do with this flag.
test('assert-integrity CLI: --target=ledger (equals form) behaves like a bare --target ledger', () => {
  const bare = runCli(['assert-integrity', '--fetch-blocklist', LEDGER_PATH, '--data', DATA_PATH, '--target', 'ledger']);
  const equals = runCli(['assert-integrity', '--fetch-blocklist', LEDGER_PATH, '--data', DATA_PATH, '--target=ledger']);

  assert.equal(bare.status, equals.status);
  assert.equal(bare.stdout, equals.stdout);
  assert.match(bare.stdout, /^- Ledger integrity:/);
  assert.doesNotMatch(bare.stdout, /data\.json integrity/);
});

// Boolean-coercion coverage for assert-integrity specifically (lookup's
// --strict is covered above): --fix=false must behave exactly like no
// --fix at all, not like a truthy "--fix" that starts writing merges back
// to the ledger/data.json files.
test('assert-integrity CLI: --fix=false behaves like no --fix at all (read-only)', () => {
  const noFlag = runCli(['assert-integrity', '--fetch-blocklist', LEDGER_PATH, '--data', DATA_PATH, '--target', 'ledger']);
  const fixFalse = runCli(['assert-integrity', '--fetch-blocklist', LEDGER_PATH, '--data', DATA_PATH, '--target', 'ledger', '--fix=false']);

  assert.equal(noFlag.status, fixFalse.status);
  assert.equal(noFlag.stdout, fixFalse.stdout);
});

test('evidence CLI: "Ledger check" line includes an "already in data.json=<n>" count', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-test-'));
  const candidatesPath = path.join(tmp, 'candidates.json');
  const dataPath = path.join(tmp, 'data.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(['https://example.com/covered', 'https://example.com/not-covered']));
  fs.writeFileSync(dataPath, JSON.stringify([
    { outlet: 'Test Outlet', headline: 'h', url: 'https://example.com/covered', date: 'Sep 1, 2026', ts: 20260901, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'e' },
  ]));

  const result = runCli(['evidence', '--candidates', candidatesPath, '--fetch-blocklist', LEDGER_PATH, '--data', dataPath]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /- Ledger check: candidates surfaced=2, ledger-checked=2, hits=0 \(permanentSkip=0, active cooldown=0, expired cooldown retried=0\), already in data\.json=1/);
});
