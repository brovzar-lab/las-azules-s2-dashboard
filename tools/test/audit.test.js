'use strict';

// Unit coverage for tools/lib/audit.js (LEMA-10625): the three full-feed
// audit checks, tested against synthetic fixtures so they don't depend on
// the live, fast-churning fetch-blocklist.json/data.json.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hostOf,
  pathSegments,
  ledgerOverlapCheck,
  deriveListingFamilies,
  surfaceFamilyCheck,
  computeFirstSeenDates,
  runDateProxyCheck,
} = require('../lib/audit');

function ledgerRow(url, overrides = {}) {
  return {
    url,
    firstSeen: '2026-08-01T00:00:00Z',
    failCount: 0,
    lastStatus: 200,
    lastAttempt: '2026-08-01T00:00:00Z',
    cooldownUntil: null,
    permanentSkip: true,
    skipReason: 'editorial_listing_or_database',
    skipNote: null,
    history: [],
    ...overrides,
  };
}

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

// ---- hostOf / pathSegments ----

test('hostOf: applies the same normalization host folding as normalizeUrl (www/m./alias)', () => {
  assert.equal(hostOf('https://www.example.com/a'), 'example.com');
  assert.equal(hostOf('https://m.imdb.com/title/tt1'), 'imdb.com');
  assert.equal(hostOf('https://twitter.com/foo/status/1'), 'x.com');
});

test('pathSegments: splits and decodes, dropping empty segments', () => {
  assert.deepEqual(pathSegments('https://example.com/a/b%20c/'), ['a', 'b c']);
  assert.deepEqual(pathSegments('https://example.com/'), []);
});

test('pathSegments: a malformed URL degrades to an empty segment list instead of throwing', () => {
  assert.deepEqual(pathSegments('not a url'), []);
});

// ---- Check 1: ledger overlap ----

test('ledgerOverlapCheck: flags a data.json row whose normalized key matches a permanentSkip ledger row', () => {
  const ledger = [ledgerRow('https://m.imdb.com/news/ni1/?ref_=tt_nwr_1', { skipReason: 'editorial_redundant_syndication' })];
  const dataset = [dataRow('https://www.imdb.com/news/ni1/')];
  const findings = ledgerOverlapCheck(dataset, ledger);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].url, 'https://www.imdb.com/news/ni1/');
  assert.equal(findings[0].ledgerUrl, 'https://m.imdb.com/news/ni1/?ref_=tt_nwr_1');
  assert.equal(findings[0].skipReason, 'editorial_redundant_syndication');
});

test('ledgerOverlapCheck: a ledger row with permanentSkip=false does not count as an overlap', () => {
  const ledger = [ledgerRow('https://example.com/a', { permanentSkip: false, skipReason: null })];
  const dataset = [dataRow('https://example.com/a')];
  assert.equal(ledgerOverlapCheck(dataset, ledger).length, 0);
});

test('ledgerOverlapCheck: no match when keys differ', () => {
  const ledger = [ledgerRow('https://example.com/a')];
  const dataset = [dataRow('https://example.com/b')];
  assert.equal(ledgerOverlapCheck(dataset, ledger).length, 0);
});

// ---- Check 2: surface-family match ----

test('deriveListingFamilies: a keyword shared by >=2 editorial_listing_or_database rows on the same host becomes a family', () => {
  const ledger = [
    ledgerRow('https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456'),
    ledgerRow('https://tv.apple.com/mx/show/las-azules/umc.cmc.def654321'),
  ];
  const families = deriveListingFamilies(ledger);
  const family = families.find((f) => f.host === 'tv.apple.com' && f.keyword === 'show');
  assert.ok(family, 'expected a tv.apple.com/show family to be derived');
  assert.equal(family.precedentCount, 2);
  assert.deepEqual(
    family.precedentUrls.slice().sort(),
    ['https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456', 'https://tv.apple.com/mx/show/las-azules/umc.cmc.def654321'].sort()
  );
});

test('deriveListingFamilies: a keyword seen only once does not clear the precedent threshold', () => {
  const ledger = [ledgerRow('https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456')];
  const families = deriveListingFamilies(ledger);
  assert.equal(families.filter((f) => f.host === 'tv.apple.com').length, 0);
});

test('deriveListingFamilies: locale segments and opaque ids are never candidate keywords', () => {
  const ledger = [
    ledgerRow('https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456'),
    ledgerRow('https://tv.apple.com/mx/show/las-azules/umc.cmc.def654321'),
  ];
  const families = deriveListingFamilies(ledger);
  const keywords = families.filter((f) => f.host === 'tv.apple.com').map((f) => f.keyword);
  assert.ok(!keywords.includes('do'));
  assert.ok(!keywords.includes('mx'));
  assert.ok(!keywords.some((k) => k.startsWith('umc.cmc')));
});

test('deriveListingFamilies: only editorial_listing_or_database rows contribute, other skipReasons on the same keyword do not', () => {
  // Two genuinely distinct per-article exclusions that happen to share the
  // "news" path segment -- must NOT become a family, or every legitimate
  // .../news/... data.json row on the host would get flagged.
  const ledger = [
    ledgerRow('https://imdb.com/news/ni1/', { skipReason: 'editorial_redundant_syndication' }),
    ledgerRow('https://imdb.com/news/ni2/', { skipReason: 'editorial_off_topic_false_positive' }),
  ];
  const families = deriveListingFamilies(ledger);
  assert.equal(families.filter((f) => f.host === 'imdb.com' && f.keyword === 'news').length, 0);
});

test('surfaceFamilyCheck: flags a data.json row matching a derived family, with precedent attached', () => {
  const ledger = [
    ledgerRow('https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456'),
    ledgerRow('https://tv.apple.com/mx/show/las-azules/umc.cmc.def654321'),
  ];
  const families = deriveListingFamilies(ledger);
  const dataset = [dataRow('https://tv.apple.com/es/show/las-azules/umc.cmc.ghi999999')];
  const findings = surfaceFamilyCheck(dataset, families);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].url, 'https://tv.apple.com/es/show/las-azules/umc.cmc.ghi999999');
  const shown = findings[0].matchedFamilies.find((m) => m.keyword === 'show');
  assert.ok(shown);
  assert.equal(shown.precedentCount, 2);
});

test('surfaceFamilyCheck: a row on the same host but a different path shape (no shared keyword) is not flagged', () => {
  const ledger = [
    ledgerRow('https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456'),
    ledgerRow('https://tv.apple.com/mx/show/las-azules/umc.cmc.def654321'),
  ];
  const families = deriveListingFamilies(ledger);
  const dataset = [dataRow('https://tv.apple.com/pe/episode/alma/umc.cmc.zzz111111')];
  assert.equal(surfaceFamilyCheck(dataset, families).length, 0);
});

test('surfaceFamilyCheck: a row on a different host entirely is never flagged even with a matching keyword', () => {
  const ledger = [
    ledgerRow('https://tv.apple.com/do/show/las-azules/umc.cmc.abc123456'),
    ledgerRow('https://tv.apple.com/mx/show/las-azules/umc.cmc.def654321'),
  ];
  const families = deriveListingFamilies(ledger);
  const dataset = [dataRow('https://example.com/show/las-azules')];
  assert.equal(surfaceFamilyCheck(dataset, families).length, 0);
});

// ---- Check 3: run-date proxy suspects (pure computation) ----

test('computeFirstSeenDates: earliest commit containing a URL wins, later re-appearances do not overwrite it', () => {
  const commits = [
    { hash: 'c1', date: '2026-09-01T00:00:00Z' },
    { hash: 'c2', date: '2026-09-02T00:00:00Z' },
  ];
  const contentsByHash = new Map([
    ['c1', [{ url: 'https://example.com/a' }]],
    ['c2', [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]],
  ]);
  const firstSeen = computeFirstSeenDates(commits, contentsByHash);
  assert.equal(firstSeen.get('https://example.com/a'), '2026-09-01T00:00:00Z');
  assert.equal(firstSeen.get('https://example.com/b'), '2026-09-02T00:00:00Z');
});

test('computeFirstSeenDates: a null (unreadable) commit content is skipped, not fatal', () => {
  const commits = [
    { hash: 'c1', date: '2026-09-01T00:00:00Z' },
    { hash: 'c2', date: '2026-09-02T00:00:00Z' },
  ];
  const contentsByHash = new Map([
    ['c1', null],
    ['c2', [{ url: 'https://example.com/a' }]],
  ]);
  const firstSeen = computeFirstSeenDates(commits, contentsByHash);
  assert.equal(firstSeen.get('https://example.com/a'), '2026-09-02T00:00:00Z');
});

test('runDateProxyCheck: flags a row whose ts equals the UTC date of its introducing commit (the LEMA-10623 ES/LU reproduction)', () => {
  const firstSeenDates = new Map([
    ['https://tv.apple.com/lu/show/las-azules/umc.cmc.x', '2026-09-01T22:03:49-06:00'], // -06:00 -> 2026-09-02 UTC
  ]);
  const dataset = [dataRow('https://tv.apple.com/lu/show/las-azules/umc.cmc.x', { ts: 20260902 })];
  const findings = runDateProxyCheck(dataset, firstSeenDates);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].firstSeenCommitUtcDate, 20260902);
});

test('runDateProxyCheck: a row whose ts differs from its introducing commit date is not flagged (the common, legitimate case)', () => {
  const firstSeenDates = new Map([['https://example.com/a', '2026-09-05T00:00:00Z']]);
  const dataset = [dataRow('https://example.com/a', { ts: 20260501 })]; // sourced date, unrelated to crawl date
  assert.equal(runDateProxyCheck(dataset, firstSeenDates).length, 0);
});

test('runDateProxyCheck: a row with no known first-seen commit (not in this history) is not flagged', () => {
  const firstSeenDates = new Map();
  const dataset = [dataRow('https://example.com/a', { ts: 20260901 })];
  assert.equal(runDateProxyCheck(dataset, firstSeenDates).length, 0);
});

test('runDateProxyCheck: tolerates a row with no dateSource field, and passes it through when present', () => {
  const firstSeenDates = new Map([['https://example.com/a', '2026-09-01T00:00:00Z']]);
  const noField = runDateProxyCheck([dataRow('https://example.com/a', { ts: 20260901 })], firstSeenDates);
  assert.equal(noField[0].dateSource, null);

  const withField = runDateProxyCheck(
    [dataRow('https://example.com/a', { ts: 20260901, dateSource: 'firstSeen' })],
    firstSeenDates
  );
  assert.equal(withField[0].dateSource, 'firstSeen');
});
