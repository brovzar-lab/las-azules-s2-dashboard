'use strict';

// Full-feed audit checks (LEMA-10625). Unlike the rest of this kit, these
// functions look at *existing* data.json rows against the ledger's
// exclusion rules, not just candidates about to be fetched -- closing the
// structural gap where a row admitted before a rule hardened is otherwise
// never re-examined (see LEMA-10623). Report-only: nothing here edits
// data.json or fetch-blocklist.json, and nothing here makes an editorial
// call. Same division of labour as the rest of tools/, established on
// LEMA-9933: mechanics in the tool, judgment with the agent.

const { execFileSync } = require('child_process');
const { normalizeUrl } = require('./normalize');

// ---- shared path/host helpers ----

function hostOf(rawUrl) {
  const { key } = normalizeUrl(rawUrl);
  const slashIndex = key.indexOf('/');
  return slashIndex === -1 ? key.split('?')[0] : key.slice(0, slashIndex);
}

function pathSegments(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return [];
  }
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

// ---- Check 1: ledger overlap (assertable) ----
//
// A row cannot legitimately be both live coverage and a permanent
// exclusion. This is `lookup --strict`'s `inDataJson` signal (LEMA-10591)
// inverted into a first-class report: instead of checking one candidate
// against data.json, this checks every data.json row against the ledger.
function ledgerOverlapCheck(dataset, ledgerEntries) {
  const permanentSkipByKey = new Map();
  for (const row of ledgerEntries) {
    if (row.permanentSkip !== true) continue;
    const { key } = normalizeUrl(row.url);
    if (!permanentSkipByKey.has(key)) permanentSkipByKey.set(key, row);
  }

  const findings = [];
  for (const row of dataset) {
    const { key } = normalizeUrl(row.url);
    const ledgerRow = permanentSkipByKey.get(key);
    if (!ledgerRow) continue;
    findings.push({
      url: row.url,
      key,
      ledgerUrl: ledgerRow.url,
      skipReason: ledgerRow.skipReason || null,
      skipNote: ledgerRow.skipNote || null,
      reviewable: ledgerRow.reviewable === true,
    });
  }
  return findings;
}

// ---- Check 2: surface-family match (advisory) ----
//
// Families are derived from the ledger itself, not hard-coded, so this
// stays current as new locales/paths get ledgered (per the ticket's
// explicit ask). A "family" is a (host, keyword) pair: a literal path
// segment shared by at least FAMILY_MIN_PRECEDENT permanentSkip ledger
// rows on the same host.
//
// Deliberately restricted to skipReason === 'editorial_listing_or_database'
// (Rule F) rows only, not every permanentSkip row. Rule F is specifically
// "no written content, database/listing page" -- a structural, shape-based
// judgment, which is the only kind of exclusion reason a URL-shape family
// can legitimately generalize from. Other skipReasons (e.g.
// editorial_undateable, editorial_off_topic_false_positive,
// editorial_redundant_syndication) are per-article judgment calls that
// happen to share a path keyword with genuine coverage elsewhere on the
// same host -- e.g. imdb.com/news/... ledger rows exist for individual,
// unrelated reasons, while imdb.com/news/... also carries 12+ legitimate
// data.json rows. Widening this to all skipReasons would turn "news" into
// a spurious family and flood the report with false positives on exactly
// the busy, mixed hosts where signal matters most. Flagged here rather
// than in a comment on the ticket since it's a design decision, not an
// ambiguity in given instructions.
const FAMILY_MIN_PRECEDENT = 2;
const FAMILY_SKIP_REASON = 'editorial_listing_or_database';

function isLocaleSegment(segment) {
  return /^[a-z]{2}(-[a-z]{2,4})?$/i.test(segment);
}

function isOpaqueIdSegment(segment) {
  if (segment === '-') return true;
  if (/^\d+$/.test(segment)) return true;
  // A long alphanumeric token containing a digit -- IMDb tt-ids, Apple TV
  // umc.cmc.* ids, JustWatch/Prime Video opaque ids. Words are excluded by
  // requiring a digit: real path keywords ("show", "detail", "serie-tv")
  // never contain one.
  if (segment.length >= 8 && /\d/.test(segment)) return true;
  return false;
}

function deriveListingFamilies(ledgerEntries) {
  const byHostKeyword = new Map(); // host -> keyword -> [url, ...]

  for (const row of ledgerEntries) {
    if (row.permanentSkip !== true) continue;
    if (row.skipReason !== FAMILY_SKIP_REASON) continue;

    const host = hostOf(row.url);
    const keywords = new Set();
    for (const segment of pathSegments(row.url)) {
      if (isLocaleSegment(segment) || isOpaqueIdSegment(segment)) continue;
      keywords.add(segment.toLowerCase());
    }

    let hostMap = byHostKeyword.get(host);
    if (!hostMap) {
      hostMap = new Map();
      byHostKeyword.set(host, hostMap);
    }
    for (const keyword of keywords) {
      const urls = hostMap.get(keyword) || [];
      urls.push(row.url);
      hostMap.set(keyword, urls);
    }
  }

  const families = [];
  for (const [host, hostMap] of byHostKeyword) {
    for (const [keyword, urls] of hostMap) {
      if (urls.length < FAMILY_MIN_PRECEDENT) continue;
      families.push({
        host,
        keyword,
        precedentCount: urls.length,
        precedentUrls: urls.slice().sort(),
      });
    }
  }
  families.sort((a, b) => (a.host === b.host ? a.keyword.localeCompare(b.keyword) : a.host.localeCompare(b.host)));
  return families;
}

function surfaceFamilyCheck(dataset, families) {
  const findings = [];
  for (const row of dataset) {
    const host = hostOf(row.url);
    const relevant = families.filter((f) => f.host === host);
    if (relevant.length === 0) continue;
    const segments = new Set(pathSegments(row.url).map((s) => s.toLowerCase()));
    const matched = relevant.filter((f) => segments.has(f.keyword));
    if (matched.length === 0) continue;
    findings.push({
      url: row.url,
      ts: row.ts,
      matchedFamilies: matched.map((f) => ({
        host: f.host,
        keyword: f.keyword,
        precedentCount: f.precedentCount,
        precedentUrls: f.precedentUrls,
      })),
    });
  }
  return findings;
}

// ---- Check 3: run-date proxy suspects (advisory only, never gates) ----

function utcDateStamp(isoDate) {
  return new Date(isoDate).toISOString().slice(0, 10).replace(/-/g, '');
}

// Pure computation: commits is [{hash, date}] oldest-first, contentsByHash
// is a Map of hash -> parsed data.json array at that commit (or null if
// unreadable at that commit -- skipped, not fatal). Exported separately
// from the git IO below so it's testable without a real git repo.
function computeFirstSeenDates(commits, contentsByHash) {
  const firstSeen = new Map();
  for (const commit of commits) {
    const arr = contentsByHash.get(commit.hash);
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      if (!row || typeof row.url !== 'string') continue;
      if (!firstSeen.has(row.url)) firstSeen.set(row.url, commit.date);
    }
  }
  return firstSeen;
}

function runDateProxyCheck(dataset, firstSeenDates) {
  const findings = [];
  for (const row of dataset) {
    const firstSeenDate = firstSeenDates.get(row.url);
    if (!firstSeenDate) continue;
    const proxyDate = utcDateStamp(firstSeenDate);
    if (String(row.ts) !== proxyDate) continue;
    findings.push({
      url: row.url,
      ts: row.ts,
      firstSeenCommitDate: firstSeenDate,
      firstSeenCommitUtcDate: Number(proxyDate),
      // LEMA-10625 requirement: tolerate absence, which is the case for all
      // 727 rows as of this ticket -- dateSource is introduced forward-only
      // by a sibling ticket. Included here only as extra context when a
      // future row does carry it.
      dateSource: row.dateSource || null,
    });
  }
  return findings;
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128 }).trim();
}

// Never throws. Returns { skipped, reason, firstSeenDates }. `relPath` is
// resolved against `repoDir` via `git -C`, so a scratch checkout used only
// for testing doesn't have to be the real repo root.
function getFirstSeenDates(repoDir, relPath) {
  try {
    if (git(repoDir, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      return { skipped: true, reason: 'not a git repository', firstSeenDates: new Map() };
    }
  } catch (err) {
    return { skipped: true, reason: `not a git repository: ${err.message.split('\n')[0]}`, firstSeenDates: new Map() };
  }

  try {
    if (git(repoDir, ['rev-parse', '--is-shallow-repository']) === 'true') {
      return { skipped: true, reason: 'shallow checkout, git history unavailable', firstSeenDates: new Map() };
    }
  } catch (err) {
    return { skipped: true, reason: `could not determine checkout depth: ${err.message.split('\n')[0]}`, firstSeenDates: new Map() };
  }

  let commits;
  try {
    const log = git(repoDir, ['log', '--format=%H|%cI', '--reverse', '--', relPath]);
    commits = log.length
      ? log.split('\n').map((line) => {
          const sep = line.indexOf('|');
          return { hash: line.slice(0, sep), date: line.slice(sep + 1) };
        })
      : [];
  } catch (err) {
    return { skipped: true, reason: `git log failed: ${err.message.split('\n')[0]}`, firstSeenDates: new Map() };
  }

  if (commits.length === 0) {
    return { skipped: true, reason: 'no git history found for this file', firstSeenDates: new Map() };
  }

  const contentsByHash = new Map();
  for (const commit of commits) {
    try {
      const raw = git(repoDir, ['show', `${commit.hash}:${relPath}`]);
      contentsByHash.set(commit.hash, JSON.parse(raw));
    } catch {
      // Unreadable/unparseable content at one historical commit degrades
      // that commit only, not the whole check -- same posture as every
      // other per-item degrade in this tool.
      contentsByHash.set(commit.hash, null);
    }
  }

  return { skipped: false, reason: null, firstSeenDates: computeFirstSeenDates(commits, contentsByHash) };
}

module.exports = {
  hostOf,
  pathSegments,
  ledgerOverlapCheck,
  deriveListingFamilies,
  surfaceFamilyCheck,
  computeFirstSeenDates,
  runDateProxyCheck,
  getFirstSeenDates,
  FAMILY_MIN_PRECEDENT,
  FAMILY_SKIP_REASON,
};
