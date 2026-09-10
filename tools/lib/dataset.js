'use strict';

const { normalizeUrl } = require('./normalize');

const AGREE_FIELDS = ['date', 'ts', 'outlet', 'lang', 'market', 'type'];

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

// A group agrees when every entry shares the same value on each of
// AGREE_FIELDS; a field absent on one entry agrees with a value present
// on another.
function groupAgrees(rows) {
  for (const field of AGREE_FIELDS) {
    const values = new Set(
      rows.map((r) => r.entry[field]).filter((v) => v !== undefined && v !== null)
    );
    if (values.size > 1) return false;
  }
  return true;
}

function agreedField(rows, field) {
  const found = rows.map((r) => r.entry[field]).find((v) => v !== undefined && v !== null);
  return found;
}

// "More complete text" is not defined by the spec beyond the merge
// direction ("from the entry with the more complete text"); this
// implementation uses trimmed character length as the completeness
// measure. Flagged as an ambiguity in the LEMA-9933 deliverable.
function moreComplete(a, b) {
  const la = (a || '').trim().length;
  const lb = (b || '').trim().length;
  return lb > la ? b : a;
}

// storyGroup is preserved on a merged row only if, after collapsing this
// group to one URL, the tag still spans two or more distinct normalized
// URLs elsewhere in the full dataset.
function shouldKeepStoryGroup(tag, groupRows, allEntries) {
  const groupIndexes = new Set(groupRows.map((r) => r.index));
  const otherKeys = new Set();
  allEntries.forEach((entry, index) => {
    if (groupIndexes.has(index)) return;
    if (entry.storyGroup === tag) {
      otherKeys.add(normalizeUrl(entry.url).key);
    }
  });
  return otherKeys.size >= 1; // plus this merged row itself = >= 2 total
}

function mergeDatasetGroup(rows, allEntries) {
  const entries = rows.map((r) => r.entry);
  const { url: normalizedUrl } = normalizeUrl(entries[0].url);

  const headline = entries.reduce((best, e) => moreComplete(best, e.headline), entries[0].headline);
  const excerpt = entries.reduce((best, e) => moreComplete(best, e.excerpt), entries[0].excerpt);

  const merged = {
    outlet: agreedField(rows, 'outlet'),
    headline,
    url: normalizedUrl,
    date: agreedField(rows, 'date'),
    ts: agreedField(rows, 'ts'),
    lang: agreedField(rows, 'lang'),
    market: agreedField(rows, 'market'),
    type: agreedField(rows, 'type'),
    excerpt,
  };

  const tag = entries.map((e) => e.storyGroup).find(Boolean);
  if (tag && shouldKeepStoryGroup(tag, rows, allEntries)) {
    merged.storyGroup = tag;
  }

  return merged;
}

/**
 * Step 11: recompute normalized keys across data.json, report rows /
 * distinct normalized URLs / duplicate groups, and (only when fix=true)
 * auto-merge groups that agree on date/ts/outlet/lang/market/type. Groups
 * that disagree are never merged here -- escalation is the agent's call,
 * same as the ledger assertion. This function only reports them, plus the
 * "shared storyGroup across a disagreeing group" second-defect flag.
 */
function assertDatasetIntegrity(dataset, { fix = false } = {}) {
  let entries = dataset.slice();
  const autoMerged = [];
  const conflicts = [];
  const pendingMerge = [];

  let scan = findDuplicateGroups(entries);

  if (fix) {
    let changed = true;
    while (changed) {
      changed = false;
      scan = findDuplicateGroups(entries);
      for (const group of scan.groups) {
        if (!groupAgrees(group.rows)) continue;
        const merged = mergeDatasetGroup(group.rows, entries);
        const dropIndexes = new Set(group.rows.map((r) => r.index));
        const before = group.rows.map((r) => r.entry.url);
        entries = entries.filter((_, i) => !dropIndexes.has(i)).concat([merged]);
        autoMerged.push({ key: group.key, before, after: merged.url });
        changed = true;
        break;
      }
    }
    scan = findDuplicateGroups(entries);
  }

  // Same rationale as assertLedgerIntegrity: whatever remains in the final
  // scan when fix=false is either a genuine conflict or an agreeing group
  // that just hasn't been merged and written yet.
  for (const group of scan.groups) {
    if (groupAgrees(group.rows)) {
      pendingMerge.push({ key: group.key, urls: group.rows.map((r) => r.entry.url) });
      continue;
    }
    const sharedStoryGroup = group.rows.every((r) => r.entry.storyGroup) &&
      new Set(group.rows.map((r) => r.entry.storyGroup)).size === 1
      ? group.rows[0].entry.storyGroup
      : null;
    conflicts.push({
      key: group.key,
      urls: group.rows.map((r) => r.entry.url),
      fields: group.rows.map((r) => {
        const f = {};
        for (const field of AGREE_FIELDS) f[field] = r.entry[field];
        return { url: r.entry.url, ...f };
      }),
      sharedStoryGroupDefect: sharedStoryGroup,
    });
  }

  return {
    rows: scan.rows,
    distinctNormalizedUrls: scan.distinctNormalizedUrls,
    duplicateGroups: scan.groups.length,
    autoMerged,
    pendingMerge,
    conflicts,
    entries,
    passes: scan.rows === scan.distinctNormalizedUrls,
  };
}

module.exports = {
  findDuplicateGroups,
  groupAgrees,
  mergeDatasetGroup,
  assertDatasetIntegrity,
};
