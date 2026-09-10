'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { assertDatasetIntegrity } = require('../lib/dataset');

const FIXTURE_DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'mini-data.json'), 'utf8')
);

test('assertDatasetIntegrity: reports duplicate groups without mutating rows by default', () => {
  const result = assertDatasetIntegrity(FIXTURE_DATA, { fix: false });
  assert.equal(result.rows, 8);
  assert.equal(result.duplicateGroups, 3);
  assert.equal(result.passes, false);
  assert.equal(result.entries.length, 8); // untouched
});

test('assertDatasetIntegrity --fix: drops storyGroup when the merge leaves it spanning only one URL', () => {
  const result = assertDatasetIntegrity(FIXTURE_DATA, { fix: true });
  const merged = result.entries.find((e) => e.url === 'https://outlet.com/solo-tag-story');
  assert.ok(merged);
  assert.equal(merged.storyGroup, undefined);
  // More-complete (longer) excerpt wins.
  assert.ok(merged.excerpt.startsWith('Longer excerpt with more detail'));
});

test('assertDatasetIntegrity --fix: keeps storyGroup when it still spans >= 2 distinct URLs after the merge', () => {
  const result = assertDatasetIntegrity(FIXTURE_DATA, { fix: true });
  const merged = result.entries.find((e) => e.url === 'https://outlet.com/shared-tag-story');
  assert.ok(merged);
  assert.equal(merged.storyGroup, 'shared-tag-cluster');
});

test('assertDatasetIntegrity --fix: never merges a group that disagrees on an agree-field', () => {
  const result = assertDatasetIntegrity(FIXTURE_DATA, { fix: true });
  const conflictRows = result.entries.filter((e) => e.url.includes('conflict.example.com/story'));
  assert.equal(conflictRows.length, 2, 'both conflicting rows must survive untouched');
  assert.equal(result.conflicts.length, 1);
});

test('assertDatasetIntegrity: flags a shared storyGroup across a field-disagreeing group as a second defect', () => {
  const result = assertDatasetIntegrity(FIXTURE_DATA, { fix: false });
  const conflict = result.conflicts.find((c) => c.urls.some((u) => u.includes('conflict.example.com/story')));
  assert.equal(conflict.sharedStoryGroupDefect, 'conflict-defect-cluster');
});

test('assertDatasetIntegrity --fix: standalone entry and the resolved conflict pair are untouched, integrity still fails on the conflict', () => {
  const result = assertDatasetIntegrity(FIXTURE_DATA, { fix: true });
  const standalone = result.entries.find((e) => e.url === 'https://standalone.example.com/story');
  assert.ok(standalone);
  assert.equal(result.passes, false); // conflict group is irreducible
  assert.equal(result.duplicateGroups, 1); // only the conflict group remains
});
