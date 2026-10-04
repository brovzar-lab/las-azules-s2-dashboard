'use strict';

// Offline A/R computation (LEMA-11956), implementing the normalized-key
// reconciliation rule from the LEMA-11952 CEO ruling (shipped to the Media
// Sweep routine via LEMA-11955):
//
//   A = candidates.json entries with Pass 0 inDataJson=false whose
//       normalizeUrl().key equals the key of at least one row this run
//       ADDED to data.json at step 8.
//   R = candidates.json entries with Pass 0 inDataJson=true whose key,
//       after this run's step 8 removals, matches NO remaining data.json
//       row. Removing one row of a multi-row key does not flip the flag
//       and does not count.
//
// Offline only: every input below is a file already on disk before this
// run's writes (or the literal rows this run added/removed), so this never
// opens a network connection, never re-runs `lookup` against the post-write
// data.json, and never prints a new `lookup`-style fingerprint line. The
// standing prohibition on re-deriving A/R from a post-write `lookup` call
// (see the `lookup` section of tools/README.md) is untouched -- this is a
// different, offline code path, not a loophole in that prohibition.
//
// "Pass 0 inDataJson" is derived here by indexing the SAME pre-write
// data.json Pass 0 itself ran `lookup` against (buildDatasetIndex, the
// identical primitive tools/lib/dataset.js:186 lookupInDataJson uses), not
// by re-reading a saved Pass 0 result file -- there is no other data.json
// state to index against before this run's writes land, so this is the
// authoritative reconstruction of what Pass 0 saw, not an approximation.

const { normalizeUrl } = require('./normalize');
const { buildDatasetIndex } = require('./dataset');

function urlOf(candidate) {
  return typeof candidate === 'string' ? candidate : candidate.url;
}

// Deliberately structural (JSON.stringify), not object-identity: callers
// reconstruct added/removed rows from parsed JSON, so `===` would never
// match even for the exact same logical row. Key order matters for
// stringify equality; every row here comes from JSON.parse of a data.json-
// shaped file, so field order is stable within a single run.
function fingerprint(row) {
  return JSON.stringify(row);
}

// Consumes one physical pre-write row per matching removed-row fingerprint
// (a multiset match, not a boolean "was this key removed at all") so that
// a multi-row key only loses the rows actually named in `removedRows` --
// the exact guard the LEMA-11952 ruling calls out: "removing one row of a
// multi-row key does not flip the flag and does not count."
function countRemainingByKey(preWriteDataset, removedRows) {
  const preWriteIndex = buildDatasetIndex(preWriteDataset);
  const removedAvailable = new Map();
  for (const row of removedRows || []) {
    const fp = fingerprint(row);
    removedAvailable.set(fp, (removedAvailable.get(fp) || 0) + 1);
  }

  const remainingByKey = new Map();
  for (const [key, rows] of preWriteIndex) {
    let remaining = 0;
    for (const row of rows) {
      const fp = fingerprint(row);
      const available = removedAvailable.get(fp) || 0;
      if (available > 0) {
        removedAvailable.set(fp, available - 1);
      } else {
        remaining++;
      }
    }
    remainingByKey.set(key, remaining);
  }
  return remainingByKey;
}

/**
 * Computes A and R directly from this run's own inputs, per candidates.json
 * entry (not per distinct key -- see the within-batch-collision test case:
 * two literal candidate strings sharing one key each count independently
 * when the condition holds for both, matching the ruling's "entries in
 * candidates.json" wording).
 *
 * @param {Array} candidates - candidates.json contents (strings or {url}).
 * @param {Array} preWriteDataset - the Pass-0-pinned data.json, BEFORE this
 *   run's step 8 writes. Never the post-write file.
 * @param {Array} addedRows - full row objects this run ADDED to data.json
 *   at step 8.
 * @param {Array} removedRows - full row objects this run REMOVED from
 *   data.json at step 8 (e.g. via an assert-integrity --fix auto-merge).
 */
function computeReconciliation(candidates, preWriteDataset, addedRows, removedRows) {
  const preWriteIndex = buildDatasetIndex(preWriteDataset);
  const remainingByKey = countRemainingByKey(preWriteDataset, removedRows || []);

  const addedKeys = new Set((addedRows || []).map((row) => normalizeUrl(urlOf(row)).key));

  let a = 0;
  let r = 0;
  const addedMatches = [];
  const removedMatches = [];

  for (const candidate of candidates || []) {
    const url = urlOf(candidate);
    const { key } = normalizeUrl(url);
    const wasInDataJson = preWriteIndex.has(key);

    if (!wasInDataJson) {
      // A is gated on the false -> true flip (candidate was absent at Pass
      // 0), never on key match alone -- a candidate already inDataJson=true
      // at Pass 0 that happens to key-collide with an added row (e.g. a
      // re-add/update) must fall through to the R branch below instead.
      if (addedKeys.has(key)) {
        a++;
        addedMatches.push({ url, key });
      }
    } else if ((remainingByKey.get(key) || 0) === 0) {
      r++;
      removedMatches.push({ url, key });
    }
  }

  return { a, r, addedMatches, removedMatches };
}

module.exports = { computeReconciliation };
