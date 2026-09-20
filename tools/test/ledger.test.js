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

// LEMA-10591: minimal synthetic data.json, one row deliberately keyed to
// the same normalized URL as FIXTURE_CANDIDATES' expired-cooldown-story
// entry (via a www/no-trailing-slash variant, same normalization the
// ledger side already relies on) so the "already in data.json" axis and
// the ledger `disposition` axis can be checked as independent of each
// other. Everything else in FIXTURE_CANDIDATES is deliberately absent
// from this dataset.
const FIXTURE_DATASET_FOR_LOOKUP = [
  {
    outlet: 'Some Outlet',
    headline: 'Already-covered story',
    url: 'https://www.example.com/news/expired-cooldown-story',
    date: 'Sep 5, 2026',
    ts: 20260905,
    lang: 'EN',
    market: 'US',
    type: 'Entertainment',
    excerpt: 'Already sitting in data.json under a www/no-trailing-slash variant.',
  },
];

test('lookup: dataset param supplied -- inDataJson=true for a candidate already in data.json, disposition unchanged', () => {
  const results = lookupAll(FIXTURE_CANDIDATES, FIXTURE_LEDGER, NOW, FIXTURE_DATASET_FOR_LOOKUP);
  const r = results.find((x) => x.url === 'https://example.com/news/expired-cooldown-story/');
  assert.equal(r.disposition, 'expired-cooldown-retry'); // unaffected by the new axis
  assert.equal(r.inDataJson, true);
  assert.equal(r.dataJsonTs, 20260905);
  assert.equal(r.dataJsonOutlet, 'Some Outlet');
});

test('lookup: dataset param supplied -- inDataJson=false for a candidate not in data.json', () => {
  const results = lookupAll(FIXTURE_CANDIDATES, FIXTURE_LEDGER, NOW, FIXTURE_DATASET_FOR_LOOKUP);
  const r = results.find((x) => x.url === 'https://example.com/news/brand-new-story');
  assert.equal(r.disposition, 'not-found');
  assert.equal(r.inDataJson, false);
  assert.equal(r.dataJsonTs, undefined);
  assert.equal(r.dataJsonOutlet, undefined);
});

test('lookup: dataset param omitted -- output has no inDataJson field at all (backward compatible)', () => {
  const results = lookupAll(FIXTURE_CANDIDATES, FIXTURE_LEDGER, NOW);
  for (const r of results) {
    assert.equal('inDataJson' in r, false);
    assert.equal('dataJsonTs' in r, false);
    assert.equal('dataJsonOutlet' in r, false);
  }
});

test('lookup: a data.json duplicate group (same normalized key, two rows) resolves deterministically to the most recent ts', () => {
  const datasetWithDupe = [
    ...FIXTURE_DATASET_FOR_LOOKUP,
    {
      outlet: 'Older Duplicate Outlet',
      headline: 'Same story, older crawl',
      url: 'https://example.com/news/expired-cooldown-story',
      date: 'Sep 1, 2026',
      ts: 20260901,
      lang: 'EN',
      market: 'US',
      type: 'Entertainment',
      excerpt: 'Earlier duplicate of the same story.',
    },
  ];
  const results = lookupAll(FIXTURE_CANDIDATES, FIXTURE_LEDGER, NOW, datasetWithDupe);
  const r = results.find((x) => x.url === 'https://example.com/news/expired-cooldown-story/');
  assert.equal(r.inDataJson, true);
  assert.equal(r.dataJsonTs, 20260905); // the more recent of the two rows, not the first one in the array
  assert.equal(r.dataJsonOutlet, 'Some Outlet');
});

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
