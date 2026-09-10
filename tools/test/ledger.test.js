'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { lookupAll, assertLedgerIntegrity } = require('../lib/ledger');

const FIXTURE_LEDGER = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'mini-ledger.json'), 'utf8')
);
const FIXTURE_CANDIDATES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'candidates.json'), 'utf8')
);

const NOW = new Date('2026-09-10T00:00:00Z');

test('lookup: permanentSkip disposition, matched via a www/trailing-slash variant', () => {
  const results = lookupAll(FIXTURE_CANDIDATES, FIXTURE_LEDGER, NOW);
  const r = results.find((x) => x.url === 'https://www.example.com/news/permanent-skip-story');
  assert.equal(r.disposition, 'permanentSkip');
  assert.equal(r.skipReason, 'editorial_redundant_syndication');
});

test('lookup: active-cooldown disposition when cooldownUntil is in the future', () => {
  const results = lookupAll(FIXTURE_CANDIDATES, FIXTURE_LEDGER, NOW);
  const r = results.find((x) => x.url === 'https://example.com/news/active-cooldown-story');
  assert.equal(r.disposition, 'active-cooldown');
});

test('lookup: expired-cooldown-retry when cooldownUntil has passed', () => {
  const results = lookupAll(FIXTURE_CANDIDATES, FIXTURE_LEDGER, NOW);
  const r = results.find((x) => x.url === 'https://example.com/news/expired-cooldown-story/');
  assert.equal(r.disposition, 'expired-cooldown-retry');
});

test('lookup: not-found for a URL absent from the ledger', () => {
  const results = lookupAll(FIXTURE_CANDIDATES, FIXTURE_LEDGER, NOW);
  const r = results.find((x) => x.url === 'https://example.com/news/brand-new-story');
  assert.equal(r.disposition, 'not-found');
});

test('assertLedgerIntegrity: reports duplicate groups without mutating rows by default', () => {
  const result = assertLedgerIntegrity(FIXTURE_LEDGER, { fix: false });
  assert.equal(result.rows, 6);
  assert.equal(result.duplicateGroups, 2);
  assert.equal(result.passes, false);
  assert.equal(result.entries.length, 6); // untouched
});

test('assertLedgerIntegrity --fix: auto-merges the agreeing group, leaves the conflict group in place', () => {
  const result = assertLedgerIntegrity(FIXTURE_LEDGER, { fix: true });

  assert.equal(result.autoMerged.length, 1);
  assert.equal(result.conflicts.length, 1);

  const merged = result.entries.find((e) => e.url.includes('permanent-skip-story'));
  assert.ok(merged, 'merged row should exist');
  assert.equal(merged.url, 'https://example.com/news/permanent-skip-story'); // scheme from most-recent row, host/path normalized
  assert.equal(merged.firstSeen, '2026-09-01T00:00:00Z'); // earliest of the two
  assert.equal(merged.lastAttempt, '2026-09-02T00:00:00Z'); // most recent of the two
  assert.equal(merged.permanentSkip, true);
  assert.equal(merged.skipReason, 'editorial_redundant_syndication');
  assert.ok(merged.skipNote.startsWith('Newer note, from the second row (www variant).'));
  assert.ok(merged.skipNote.includes('Prior note (LEMA-1001): Older note, from the first row.'));
  assert.equal(merged.history.length, 2);

  const conflictUrls = result.conflicts[0].urls;
  assert.equal(conflictUrls.length, 2);
  assert.ok(conflictUrls.some((u) => u.includes('conflict-a')));

  // Conflict rows must still exist untouched in entries, never merged.
  const conflictRows = result.entries.filter((e) => e.url.includes('conflict-a'));
  assert.equal(conflictRows.length, 2);

  assert.equal(result.entries.length, 5); // 6 - 2 merged + 1 merged row
  assert.equal(result.passes, false); // conflict group still unresolved
});
