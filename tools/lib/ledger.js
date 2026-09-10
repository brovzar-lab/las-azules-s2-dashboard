'use strict';

const { normalizeUrl } = require('./normalize');

// Builds the URL -> entry lookup dict described in Pass 0, keyed on the
// normalized comparison key. A well-formed ledger has exactly one row per
// key; if Step 10 has not run yet there can be more than one, so each key
// maps to an array.
function buildLedgerIndex(ledger) {
  const index = new Map();
  (ledger.entries || []).forEach((entry, position) => {
    const { key } = normalizeUrl(entry.url);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ entry, position });
  });
  return index;
}

// When more than one row shares a key (pre-Step-10 state), prefer the
// permanentSkip row (permanent dispositions outrank cooldown state), else
// the row with the most recent lastAttempt. This is read-only tie-break
// for lookup purposes; it does not merge or write anything.
function pickAuthoritativeRow(rows) {
  if (rows.length === 1) return rows[0].entry;
  const skip = rows.find((r) => r.entry.permanentSkip === true);
  if (skip) return skip.entry;
  return rows
    .slice()
    .sort((a, b) => new Date(b.entry.lastAttempt || 0) - new Date(a.entry.lastAttempt || 0))[0].entry;
}

// Pass 0 disposition rules for a single candidate URL.
function lookupCandidate(candidateUrl, index, now = new Date()) {
  const { key } = normalizeUrl(candidateUrl);
  const rows = index.get(key);
  if (!rows || rows.length === 0) {
    return { url: candidateUrl, key, disposition: 'not-found' };
  }
  const row = pickAuthoritativeRow(rows);

  if (row.permanentSkip === true) {
    return {
      url: candidateUrl,
      key,
      disposition: 'permanentSkip',
      skipReason: row.skipReason,
      skipNote: row.skipNote,
      reviewable: row.reviewable === true,
    };
  }

  const cooldownUntil = row.cooldownUntil ? new Date(row.cooldownUntil) : null;
  if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) {
    return {
      url: candidateUrl,
      key,
      disposition: 'active-cooldown',
      cooldownUntil: row.cooldownUntil,
      failCount: row.failCount,
    };
  }

  // cooldownUntil has passed, or is null: proceed to fetch normally (the
  // spec's "one retry"). Also covers a row that never had a cooldown set.
  return {
    url: candidateUrl,
    key,
    disposition: 'expired-cooldown-retry',
    cooldownUntil: row.cooldownUntil || null,
    failCount: row.failCount,
  };
}

function lookupAll(candidates, ledger, now = new Date()) {
  const index = buildLedgerIndex(ledger);
  return candidates.map((c) => lookupCandidate(typeof c === 'string' ? c : c.url, index, now));
}

// ---- Step 10: post-write ledger integrity assertion ----

function findDuplicateGroups(entries) {
  const byKey = new Map();
  entries.forEach((entry, index) => {
    const { key } = normalizeUrl(entry.url);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ entry, index });
  });
  const groups = [];
  for (const [key, rows] of byKey) {
    if (rows.length > 1) groups.push({ key, rows });
  }
  return { rows: entries.length, distinctNormalizedUrls: byKey.size, groups };
}

// A group agrees on disposition when every row shares the same
// permanentSkip value, and (if permanentSkip is true) the same skipReason
// -- a missing skipReason on one row agrees with a present skipReason on
// another row in the same group, adopting the present value.
function groupAgrees(rows) {
  const skipValues = new Set(rows.map((r) => r.entry.permanentSkip === true));
  if (skipValues.size > 1) return false;
  const isSkip = rows[0].entry.permanentSkip === true;
  if (!isSkip) return true;
  const reasons = new Set(rows.map((r) => r.entry.skipReason).filter(Boolean));
  return reasons.size <= 1;
}

function agreedSkipReason(rows) {
  const found = rows.find((r) => r.entry.skipReason);
  return found ? found.entry.skipReason : undefined;
}

// Field rules per Step 10. `rows` is the group's [{entry, index}] array.
function mergeLedgerGroup(rows) {
  const entries = rows.map((r) => r.entry);
  const { url: normalizedUrl } = normalizeUrl(entries[0].url);

  const byRecency = entries
    .slice()
    .sort((a, b) => new Date(b.lastAttempt || 0) - new Date(a.lastAttempt || 0));
  const mostRecent = byRecency[0];

  const firstSeen = entries.reduce((earliest, e) => {
    if (!e.firstSeen) return earliest;
    if (!earliest) return e.firstSeen;
    return new Date(e.firstSeen) < new Date(earliest) ? e.firstSeen : earliest;
  }, null);

  const history = [];
  const seen = new Set();
  for (const e of entries) {
    for (const h of e.history || []) {
      const dedupeKey = `${h.attempt}|${h.method}|${h.issue}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        history.push(h);
      }
    }
  }
  history.sort((a, b) => new Date(a.attempt) - new Date(b.attempt));

  const isSkip = entries.some((e) => e.permanentSkip === true);
  const skipReason = isSkip ? agreedSkipReason(rows.map((r) => ({ entry: r.entry }))) : undefined;
  const reviewable = entries.some((e) => e.reviewable === true);

  // skipNote: most-recent row's note first, then other rows' notes prefixed
  // "Prior note (<issue-id>): ". The spec does not say which field supplies
  // <issue-id> for a row with no top-level issue id of its own; this
  // implementation uses that row's own most recent history entry's `issue`
  // field, since no other candidate field exists on a ledger row.
  // Flagged as an ambiguity in the LEMA-9933 deliverable.
  const noteParts = [];
  const mostRecentNote = mostRecent.skipNote || mostRecent.note;
  if (mostRecentNote) noteParts.push(mostRecentNote);
  for (const e of entries) {
    if (e === mostRecent) continue;
    const note = e.skipNote || e.note;
    if (!note) continue;
    const lastHistoryEntry = e.history && e.history.length ? e.history[e.history.length - 1] : null;
    const issueId = (lastHistoryEntry && lastHistoryEntry.issue) || 'unknown';
    noteParts.push(`Prior note (${issueId}): ${note}`);
  }

  const merged = {
    url: normalizedUrl,
    firstSeen,
    failCount: mostRecent.failCount,
    lastStatus: mostRecent.lastStatus,
    lastAttempt: mostRecent.lastAttempt,
    cooldownUntil: mostRecent.cooldownUntil,
  };
  if (isSkip) {
    merged.permanentSkip = true;
    if (skipReason) merged.skipReason = skipReason;
  }
  if (reviewable) merged.reviewable = true;
  if (noteParts.length) merged.skipNote = noteParts.join(' ');
  merged.history = history;
  return merged;
}

/**
 * Step 10: recompute normalized keys across fetch-blocklist.json, report
 * rows / distinct normalized URLs / duplicate groups, and (only when
 * fix=true) auto-merge groups that agree on disposition. Groups that
 * disagree are never merged here -- that is the judgment call the ticket
 * requires stay with the agent, including the search-existing-issues
 * dedup check. This function only reports them.
 */
function assertLedgerIntegrity(ledger, { fix = false } = {}) {
  let entries = ledger.entries || [];
  const autoMerged = [];
  const conflicts = [];
  const pendingMerge = [];

  let scan = findDuplicateGroups(entries);

  if (fix) {
    // Repeatedly merge agreeing groups until none remain mergeable, since
    // a merge can in principle reveal a key already shared with another
    // row (it doesn't in practice here, but re-scanning is cheap and safe).
    let changed = true;
    while (changed) {
      changed = false;
      scan = findDuplicateGroups(entries);
      for (const group of scan.groups) {
        if (!groupAgrees(group.rows)) continue;
        const merged = mergeLedgerGroup(group.rows);
        const dropIndexes = new Set(group.rows.map((r) => r.index));
        const before = group.rows.map((r) => r.entry.url);
        entries = entries.filter((_, i) => !dropIndexes.has(i)).concat([merged]);
        autoMerged.push({ key: group.key, before, after: merged.url });
        changed = true;
        break; // indexes shifted, rescan from the top
      }
    }
    scan = findDuplicateGroups(entries);
  }

  // Any group still present in the final scan when fix=false is one this
  // call chose not to touch: classify it as a conflict (disagrees) or as
  // pending-merge (agrees, but --fix was not passed so nothing was written).
  // When fix=true every agreeing group was already merged above, so the
  // final scan only ever contains genuine conflicts.
  for (const group of scan.groups) {
    if (!groupAgrees(group.rows)) {
      conflicts.push({
        key: group.key,
        urls: group.rows.map((r) => r.entry.url),
        dispositions: group.rows.map((r) => ({
          url: r.entry.url,
          permanentSkip: r.entry.permanentSkip === true,
          skipReason: r.entry.skipReason || null,
        })),
      });
    } else {
      pendingMerge.push({
        key: group.key,
        urls: group.rows.map((r) => r.entry.url),
      });
    }
  }

  return {
    rows: scan.rows,
    distinctNormalizedUrls: scan.distinctNormalizedUrls,
    duplicateGroups: scan.groups.length,
    autoMerged,
    pendingMerge,
    conflicts,
    entries, // possibly-merged entries (only differs from input when fix=true)
    passes: scan.rows === scan.distinctNormalizedUrls,
  };
}

module.exports = {
  buildLedgerIndex,
  lookupCandidate,
  lookupAll,
  findDuplicateGroups,
  groupAgrees,
  mergeLedgerGroup,
  assertLedgerIntegrity,
};
