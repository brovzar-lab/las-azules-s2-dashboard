'use strict';

// CLI-level coverage for `sweep-integrity.js audit` (LEMA-10625): stderr
// fingerprints, --json shape, exit codes, and the git-history degrade
// paths (not a repo, shallow clone, no history for the file).

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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function writeLedger(dir, entries) {
  const filePath = path.join(dir, 'fetch-blocklist.json');
  fs.writeFileSync(filePath, JSON.stringify({ entries }, null, 2));
  return filePath;
}

function writeData(dir, rows) {
  const filePath = path.join(dir, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
  return filePath;
}

// isoDate drives both the git log date used by check 3 AND the commit
// author/committer identity (this sandbox has no configured git identity,
// same constraint noted in project memory for the real repo).
function commit(dir, message, isoDate) {
  git(dir, ['add', '-A']);
  const result = spawnSync('git', ['commit', '-m', message], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Bot',
      GIT_AUTHOR_EMAIL: 'test-bot@example.invalid',
      GIT_COMMITTER_NAME: 'Test Bot',
      GIT_COMMITTER_EMAIL: 'test-bot@example.invalid',
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    },
  });
  if (result.status !== 0) {
    throw new Error(`git commit failed: ${result.stderr}`);
  }
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-audit-test-'));
  git(dir, ['init', '-q']);
  return dir;
}

// ---- --json shape, exit codes ----

test('audit --json: reports ledgerOverlap, surfaceFamilyMatch, runDateProxySuspects, intersection', () => {
  const tmp = mkRepo();
  const ledgerPath = writeLedger(tmp, [
    {
      url: 'https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456',
      permanentSkip: true,
      skipReason: 'editorial_listing_or_database',
      failCount: 0,
      history: [],
    },
    {
      url: 'https://tv.apple.com/mx/show/las-azules/umc.cmc.def654321',
      permanentSkip: true,
      skipReason: 'editorial_listing_or_database',
      failCount: 0,
      history: [],
    },
    {
      url: 'https://youtube.com/watch?v=abc123',
      permanentSkip: true,
      skipReason: 'editorial_personal_repost',
      failCount: 0,
      history: [],
    },
  ]);
  const dataPath = writeData(tmp, [
    {
      outlet: 'Some Outlet',
      headline: 'ES show page',
      url: 'https://tv.apple.com/es/show/las-azules/umc.cmc.ghi999999',
      date: 'Sep 2, 2026',
      ts: 20260902,
      lang: 'ES',
      market: 'Spain',
      type: 'Entertainment',
      excerpt: 'x',
    },
    {
      outlet: 'Some Outlet',
      headline: 'Already-ledgered video',
      url: 'https://www.youtube.com/watch?v=abc123',
      date: 'Sep 1, 2026',
      ts: 20260901,
      lang: 'EN',
      market: 'US',
      type: 'Entertainment',
      excerpt: 'x',
    },
  ]);
  commit(tmp, 'add ES row', '2026-09-02T00:00:00Z');

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', ledgerPath, '--json']);

  assert.equal(result.status, 1, 'ledger overlap present -> exit 1');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.rowsChecked, 2);

  assert.equal(parsed.checks.ledgerOverlap.count, 1);
  assert.equal(parsed.checks.ledgerOverlap.findings[0].url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(parsed.checks.ledgerOverlapAdvisory.count, 0, 'no redundant-syndication overlap in this fixture');

  assert.equal(parsed.checks.surfaceFamilyMatch.count, 1);
  assert.equal(parsed.checks.surfaceFamilyMatch.findings[0].url, 'https://tv.apple.com/es/show/las-azules/umc.cmc.ghi999999');

  assert.equal(parsed.checks.runDateProxySuspects.skipped, false);
  assert.equal(parsed.checks.runDateProxySuspects.count, 1);
  assert.equal(parsed.checks.runDateProxySuspects.findings[0].url, 'https://tv.apple.com/es/show/las-azules/umc.cmc.ghi999999');

  assert.equal(parsed.checks.intersection.count, 1);
  assert.equal(parsed.checks.intersection.findings[0].url, 'https://tv.apple.com/es/show/las-azules/umc.cmc.ghi999999');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('audit: exits 0 when ledgerOverlap is empty, even with advisory findings present', () => {
  const tmp = mkRepo();
  const ledgerPath = writeLedger(tmp, [
    { url: 'https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456', permanentSkip: true, skipReason: 'editorial_listing_or_database', failCount: 0, history: [] },
    { url: 'https://tv.apple.com/mx/show/las-azules/umc.cmc.def654321', permanentSkip: true, skipReason: 'editorial_listing_or_database', failCount: 0, history: [] },
  ]);
  const dataPath = writeData(tmp, [
    { outlet: 'Some Outlet', headline: 'ES show page', url: 'https://tv.apple.com/es/show/las-azules/umc.cmc.ghi999999', date: 'Sep 2, 2026', ts: 20260902, lang: 'ES', market: 'Spain', type: 'Entertainment', excerpt: 'x' },
  ]);
  commit(tmp, 'add ES row', '2026-09-02T00:00:00Z');

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', ledgerPath, '--json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.ledgerOverlap.count, 0);
  assert.equal(parsed.checks.surfaceFamilyMatch.count, 1, 'advisory finding present but must not fail the exit');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- LEMA-10634: editorial_redundant_syndication overlap must not gate ----

test('audit: an editorial_redundant_syndication overlap does NOT gate the exit code and lands in ledgerOverlapAdvisory', () => {
  const tmp = mkRepo();
  const ledgerPath = writeLedger(tmp, [
    {
      url: 'https://m.imdb.com/news/ni64735557/?ref_=tt_nwr_1',
      permanentSkip: true,
      skipReason: 'editorial_redundant_syndication',
      reviewable: false,
      failCount: 0,
      history: [],
    },
  ]);
  const dataPath = writeData(tmp, [
    {
      outlet: 'IMDb',
      headline: 'Canonical article',
      url: 'https://www.imdb.com/news/ni64735557/',
      date: 'Sep 2, 2026',
      ts: 20260902,
      lang: 'EN',
      market: 'US',
      type: 'Entertainment',
      excerpt: 'x',
    },
  ]);
  commit(tmp, 'add canonical row', '2026-09-02T00:00:00Z');

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', ledgerPath, '--json']);
  assert.equal(result.status, 0, 'redundant-syndication overlap must not fail the exit');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.ledgerOverlap.count, 0, 'must not appear in the assertable bucket');
  assert.equal(parsed.checks.ledgerOverlapAdvisory.count, 1);
  assert.equal(parsed.checks.ledgerOverlapAdvisory.findings[0].url, 'https://www.imdb.com/news/ni64735557/');
  assert.equal(parsed.checks.ledgerOverlapAdvisory.findings[0].skipReason, 'editorial_redundant_syndication');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('audit: a non-syndication skipReason overlap still gates the exit code, alongside an unrelated redundant_syndication row', () => {
  const tmp = mkRepo();
  const ledgerPath = writeLedger(tmp, [
    {
      url: 'https://m.imdb.com/news/ni64735557/?ref_=tt_nwr_1',
      permanentSkip: true,
      skipReason: 'editorial_redundant_syndication',
      reviewable: false,
      failCount: 0,
      history: [],
    },
    {
      url: 'https://youtube.com/watch?v=abc123',
      permanentSkip: true,
      skipReason: 'editorial_personal_repost',
      failCount: 0,
      history: [],
    },
  ]);
  const dataPath = writeData(tmp, [
    {
      outlet: 'IMDb',
      headline: 'Canonical article',
      url: 'https://www.imdb.com/news/ni64735557/',
      date: 'Sep 2, 2026',
      ts: 20260902,
      lang: 'EN',
      market: 'US',
      type: 'Entertainment',
      excerpt: 'x',
    },
    {
      outlet: 'Some Outlet',
      headline: 'Already-ledgered video',
      url: 'https://www.youtube.com/watch?v=abc123',
      date: 'Sep 1, 2026',
      ts: 20260901,
      lang: 'EN',
      market: 'US',
      type: 'Entertainment',
      excerpt: 'x',
    },
  ]);
  commit(tmp, 'add both rows', '2026-09-02T00:00:00Z');

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', ledgerPath, '--json']);
  assert.equal(result.status, 1, 'genuine (non-syndication) overlap must still gate');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.ledgerOverlap.count, 1);
  assert.equal(parsed.checks.ledgerOverlap.findings[0].url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(parsed.checks.ledgerOverlapAdvisory.count, 1);
  assert.equal(parsed.checks.ledgerOverlapAdvisory.findings[0].url, 'https://www.imdb.com/news/ni64735557/');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('audit: prints the LEMA-10448-style stderr fingerprints for both input files, plus a run-date-proxy summary line', () => {
  const tmp = mkRepo();
  const ledgerPath = writeLedger(tmp, []);
  const dataPath = writeData(tmp, []);
  commit(tmp, 'empty', '2026-09-02T00:00:00Z');

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', ledgerPath]);
  assert.equal(result.status, 0);

  const ledgerRaw = fs.readFileSync(ledgerPath, 'utf8');
  const dataRaw = fs.readFileSync(dataPath, 'utf8');
  assert.match(result.stderr, new RegExp(`\\[audit\\] fetch-blocklist path=.*rows=0 sha256=${sha256(ledgerRaw)}`));
  assert.match(result.stderr, new RegExp(`\\[audit\\] data\\.json path=.*rows=0 sha256=${sha256(dataRaw)}`));
  assert.match(result.stderr, /\[audit\] run-date proxy check: 0 suspect\(s\) from 0 row\(s\)/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- readJsonWithRaw usage-error contract (LEMA-10595/LEMA-10597 conventions) ----

test('audit: a missing data.json exits 2 with a clean stderr message, not a crash', () => {
  const tmp = mkRepo();
  const ledgerPath = writeLedger(tmp, []);
  commit(tmp, 'ledger only', '2026-09-02T00:00:00Z');

  const result = runCli(['audit', '--data', path.join(tmp, 'does-not-exist.json'), '--fetch-blocklist', ledgerPath]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /data\.json not found/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('audit: rejects an unrecognized flag instead of silently dropping it', () => {
  const result = runCli(['audit', '--strict']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unrecognized flag/);
  assert.match(result.stderr, /Allowed flags for 'audit'/);
});

// ---- Check 3 degrade paths ----

test('audit: run-date proxy check degrades cleanly (skipped, not crashed) outside a git repository', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-audit-nogit-'));
  const ledgerPath = writeLedger(tmp, []);
  const dataPath = writeData(tmp, [
    { outlet: 'Some Outlet', headline: 'x', url: 'https://example.com/a', date: 'Sep 1, 2026', ts: 20260901, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'x' },
  ]);

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', ledgerPath, '--json']);
  assert.equal(result.status, 0, 'checks 1/2 still run and pass, only check 3 is skipped');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.runDateProxySuspects.skipped, true);
  assert.match(parsed.checks.runDateProxySuspects.reason, /not a git repository/);
  assert.equal(parsed.checks.runDateProxySuspects.count, 0);
  assert.match(result.stderr, /\[audit\] run-date proxy check skipped: not a git repository/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('audit: run-date proxy check degrades cleanly on a shallow checkout', () => {
  const source = mkRepo();
  writeLedger(source, []);
  writeData(source, [{ outlet: 'x', headline: 'x', url: 'https://example.com/a', date: 'Sep 1, 2026', ts: 20260901, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'x' }]);
  commit(source, 'first', '2026-09-01T00:00:00Z');
  writeData(source, [
    { outlet: 'x', headline: 'x', url: 'https://example.com/a', date: 'Sep 1, 2026', ts: 20260901, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'x' },
    { outlet: 'x', headline: 'y', url: 'https://example.com/b', date: 'Sep 2, 2026', ts: 20260902, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'x' },
  ]);
  commit(source, 'second', '2026-09-02T00:00:00Z');

  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-integrity-audit-shallow-'));
  // --no-local forces the smart-protocol clone path even for a local source
  // path -- a plain `--depth 1` local clone can skip actual truncation and
  // silently produce a full (non-shallow) clone.
  spawnSync('git', ['clone', '--depth', '1', '--no-local', source, shallow], { encoding: 'utf8' });
  assert.equal(git(shallow, ['rev-parse', '--is-shallow-repository']).trim(), 'true', 'test setup sanity check');

  const ledgerPath = path.join(shallow, 'fetch-blocklist.json');
  const dataPath = path.join(shallow, 'data.json');

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', ledgerPath, '--json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.runDateProxySuspects.skipped, true);
  assert.match(parsed.checks.runDateProxySuspects.reason, /shallow checkout/);

  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(shallow, { recursive: true, force: true });
});

test('audit: run-date proxy check degrades cleanly when the file has no git history (untracked)', () => {
  const tmp = mkRepo();
  writeLedger(tmp, []);
  commit(tmp, 'ledger only, no data.json yet', '2026-09-01T00:00:00Z');
  const dataPath = writeData(tmp, [
    { outlet: 'x', headline: 'x', url: 'https://example.com/a', date: 'Sep 1, 2026', ts: 20260901, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'x' },
  ]); // written but never committed

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', path.join(tmp, 'fetch-blocklist.json'), '--json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.runDateProxySuspects.skipped, true);
  assert.match(parsed.checks.runDateProxySuspects.reason, /no git history/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('audit: real run-date proxy check reproduces the LEMA-10623 finding shape via git history', () => {
  const tmp = mkRepo();
  writeLedger(tmp, []);
  const dataPath = writeData(tmp, [
    { outlet: 'x', headline: 'x', url: 'https://example.com/old', date: 'Aug 1, 2026', ts: 20260801, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'x' },
  ]);
  commit(tmp, 'first row, sourced date, unrelated to commit date', '2026-09-01T00:00:00Z');

  writeData(tmp, [
    { outlet: 'x', headline: 'x', url: 'https://example.com/old', date: 'Aug 1, 2026', ts: 20260801, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'x' },
    { outlet: 'x', headline: 'y', url: 'https://example.com/new', date: 'Sep 5, 2026', ts: 20260905, lang: 'EN', market: 'US', type: 'Entertainment', excerpt: 'x' },
  ]);
  commit(tmp, 'second row, ts equals this commit date -- the proxy-substitution suspect', '2026-09-05T00:00:00Z');

  const result = runCli(['audit', '--data', dataPath, '--fetch-blocklist', path.join(tmp, 'fetch-blocklist.json'), '--json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.checks.runDateProxySuspects.skipped, false);
  const urls = parsed.checks.runDateProxySuspects.findings.map((f) => f.url);
  assert.deepEqual(urls, ['https://example.com/new']);
  assert.equal(parsed.checks.runDateProxySuspects.findings[0].firstSeenCommitUtcDate, 20260905);

  fs.rmSync(tmp, { recursive: true, force: true });
});
