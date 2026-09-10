'use strict';

// Integration coverage against the actual repo artifacts (not synthetic
// fixtures). These files grow every 2 hours via the Media Sweep routine,
// so this test asserts invariants (integrity holds, no duplicate groups),
// not fixed row counts, which would go stale.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { assertLedgerIntegrity } = require('../lib/ledger');
const { assertDatasetIntegrity } = require('../lib/dataset');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'fetch-blocklist.json');
const DATA_PATH = path.join(REPO_ROOT, 'data.json');

test('real fetch-blocklist.json: no duplicate normalized-key groups as of this checkout', () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const result = assertLedgerIntegrity(ledger, { fix: false });
  assert.equal(result.rows, ledger.entries.length);
  assert.equal(
    result.duplicateGroups,
    0,
    `expected 0 duplicate groups, found ${result.duplicateGroups}: ${JSON.stringify(result.conflicts)}`
  );
  assert.equal(result.passes, true);
});

test('real data.json: no duplicate normalized-key groups as of this checkout', () => {
  const dataset = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const result = assertDatasetIntegrity(dataset, { fix: false });
  assert.equal(result.rows, dataset.length);
  assert.equal(
    result.duplicateGroups,
    0,
    `expected 0 duplicate groups, found ${result.duplicateGroups}: ${JSON.stringify(result.conflicts)}`
  );
  assert.equal(result.passes, true);
});
