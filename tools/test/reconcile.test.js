'use strict';

// Unit coverage for tools/lib/reconcile.js (LEMA-11956): offline A/R
// computation per the LEMA-11952 normalized-key reconciliation ruling.
// All five required cases from the ticket, plus the regression baseline.

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeReconciliation } = require('../lib/reconcile');

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

test('literal-match case: a single candidate absent at Pass 0 whose literal URL was added counts A=1, R=0', () => {
  const candidates = ['https://www.example.com/las-azules-review'];
  const preWriteDataset = [dataRow('https://other.example.com/unrelated')];
  const addedRows = [dataRow('https://www.example.com/las-azules-review')];

  const result = computeReconciliation(candidates, preWriteDataset, addedRows, []);

  assert.equal(result.a, 1);
  assert.equal(result.r, 0);
  assert.deepEqual(
    result.addedMatches.map((m) => m.url),
    ['https://www.example.com/las-azules-review']
  );
});

test('within-batch key collision (cinefilos shape): two distinct literal candidate strings sharing one key each count toward A independently', () => {
  // Mirrors the real trigger case: www.cinefilos.it/...621572 and apex
  // cinefilos.it/...621572 normalize to the same key; only the apex form
  // was actually written to data.json at step 8.
  const candidates = [
    'https://www.cinefilos.it/las-azules-recensione-621572',
    'https://cinefilos.it/las-azules-recensione-621572',
  ];
  const preWriteDataset = [dataRow('https://other.example.com/unrelated')];
  const addedRows = [dataRow('https://cinefilos.it/las-azules-recensione-621572')];

  const result = computeReconciliation(candidates, preWriteDataset, addedRows, []);

  // Per the ruling's own wording ("entries in candidates.json..."), the
  // counted population is candidate entries, not distinct keys -- both
  // colliding literal strings satisfy the condition independently.
  assert.equal(result.a, 2);
  assert.equal(result.r, 0);
});

test('multi-row key, only one row removed: R must NOT decrement', () => {
  const dupUrlA = 'https://example.com/multi-row-story?utm_source=a';
  const dupUrlB = 'https://example.com/multi-row-story?utm_source=b';
  const rowA = dataRow(dupUrlA, { ts: 20260901 });
  const rowB = dataRow(dupUrlB, { ts: 20260902 });
  const preWriteDataset = [rowA, rowB];
  const candidates = ['https://example.com/multi-row-story'];

  // Only rowA is removed; rowB (same normalized key) remains.
  const result = computeReconciliation(candidates, preWriteDataset, [], [rowA]);

  assert.equal(result.a, 0);
  assert.equal(result.r, 0, 'R must not decrement while a row at this key still remains');
});

test('multi-row key, every row removed: R decrements once, not once per row', () => {
  const dupUrlA = 'https://example.com/fully-removed-story?utm_source=a';
  const dupUrlB = 'https://example.com/fully-removed-story?utm_source=b';
  const rowA = dataRow(dupUrlA, { ts: 20260901 });
  const rowB = dataRow(dupUrlB, { ts: 20260902 });
  const preWriteDataset = [rowA, rowB];
  const candidates = ['https://example.com/fully-removed-story'];

  const result = computeReconciliation(candidates, preWriteDataset, [], [rowA, rowB]);

  assert.equal(result.a, 0);
  assert.equal(result.r, 1, 'R must decrement exactly once for this one qualifying candidate, not once per removed row');
});

test('candidate key-collides with an added row but was already inDataJson=true at Pass 0: must NOT count toward A', () => {
  const url = 'https://example.com/already-tracked-story';
  const existingRow = dataRow(url, { ts: 20260901 });
  const preWriteDataset = [existingRow];
  const candidates = [url];
  // Simulate a re-add at step 8 under the same key (e.g. an update/merge).
  const addedRows = [dataRow(url, { ts: 20260901, headline: 'Updated headline' })];

  const result = computeReconciliation(candidates, preWriteDataset, addedRows, []);

  assert.equal(result.a, 0, 'A is gated on the false->true flip, not on key match alone');
  assert.equal(result.r, 0, 'the row was not removed, so R must not fire either');
});

test('a candidate not present in either added or removed rows contributes nothing', () => {
  const preWriteDataset = [dataRow('https://example.com/untouched')];
  const candidates = ['https://example.com/never-seen-before'];

  const result = computeReconciliation(candidates, preWriteDataset, [], []);

  assert.equal(result.a, 0);
  assert.equal(result.r, 0);
});

test('a candidate inDataJson=true whose key is untouched by any removal does not count toward R', () => {
  const url = 'https://example.com/still-present';
  const preWriteDataset = [dataRow(url)];
  const candidates = [url];

  const result = computeReconciliation(candidates, preWriteDataset, [], []);

  assert.equal(result.r, 0);
});
