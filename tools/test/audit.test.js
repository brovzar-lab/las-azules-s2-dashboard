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
  queryVariantCheck,
  computeFirstSeenDates,
  runDateProxyCheck,
} = require('../lib/audit');
const { HOST_PARAM_ALLOWLIST } = require('../lib/normalize');

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

test('ledgerOverlapCheck: flags a data.json row whose normalized key matches a permanentSkip ledger row (assertable, non-syndication reason)', () => {
  const ledger = [ledgerRow('https://example.com/a', { skipReason: 'editorial_personal_repost' })];
  const dataset = [dataRow('https://example.com/a')];
  const { assertable, advisory } = ledgerOverlapCheck(dataset, ledger);
  assert.equal(assertable.length, 1);
  assert.equal(assertable[0].url, 'https://example.com/a');
  assert.equal(assertable[0].ledgerUrl, 'https://example.com/a');
  assert.equal(assertable[0].skipReason, 'editorial_personal_repost');
  assert.equal(advisory.length, 0);
});

// LEMA-10634: this is Rule I working as designed, not a conflict -- the m.
// mobile variant is a correctly-permanentSkipped second address for the
// canonical row that IS live in data.json. It must not gate the exit code,
// so it belongs in `advisory`, not `assertable`.
test('ledgerOverlapCheck: an editorial_redundant_syndication overlap is advisory, not assertable, and does not gate', () => {
  const ledger = [ledgerRow('https://m.imdb.com/news/ni1/?ref_=tt_nwr_1', { skipReason: 'editorial_redundant_syndication' })];
  const dataset = [dataRow('https://www.imdb.com/news/ni1/')];
  const { assertable, advisory } = ledgerOverlapCheck(dataset, ledger);
  assert.equal(assertable.length, 0);
  assert.equal(advisory.length, 1);
  assert.equal(advisory[0].url, 'https://www.imdb.com/news/ni1/');
  assert.equal(advisory[0].ledgerUrl, 'https://m.imdb.com/news/ni1/?ref_=tt_nwr_1');
  assert.equal(advisory[0].skipReason, 'editorial_redundant_syndication');
});

test('ledgerOverlapCheck: a ledger row with permanentSkip=false does not count as an overlap', () => {
  const ledger = [ledgerRow('https://example.com/a', { permanentSkip: false, skipReason: null })];
  const dataset = [dataRow('https://example.com/a')];
  const { assertable, advisory } = ledgerOverlapCheck(dataset, ledger);
  assert.equal(assertable.length, 0);
  assert.equal(advisory.length, 0);
});

test('ledgerOverlapCheck: no match when keys differ', () => {
  const ledger = [ledgerRow('https://example.com/a')];
  const dataset = [dataRow('https://example.com/b')];
  const { assertable, advisory } = ledgerOverlapCheck(dataset, ledger);
  assert.equal(assertable.length, 0);
  assert.equal(advisory.length, 0);
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

// ---- Check: query-variant pairs on unlisted hosts (LEMA-11733) ----

test('queryVariantCheck: flags a cross-file pair on an unlisted host (the reforma.com shape, pre-fix)', () => {
  // instagram.com has no HOST_PARAM_ALLOWLIST entry, so this reproduces the
  // reforma.com defect shape on a still-unlisted host: same path, one row
  // in data.json with a query param, one permanentSkip row in the ledger
  // without it. Uses a made-up, never-classified param name (`variant`)
  // rather than `hl` -- LEMA-11736 added `hl`/`lang`/`locale` to the global
  // tracking-param deny-list, so a real `?hl=` pair on any unlisted host no
  // longer survives normalization differently and would no longer
  // reproduce this shape.
  const dataset = [dataRow('https://www.instagram.com/someuser/?variant=alt')];
  const ledger = [ledgerRow('https://www.instagram.com/someuser/')];
  const findings = queryVariantCheck(dataset, ledger);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pathOnlyKey, 'instagram.com/someuser');
  assert.equal(findings[0].variantCount, 2);
  const fullKeys = findings[0].variants.map((v) => v.fullKey).sort();
  assert.deepEqual(fullKeys, ['instagram.com/someuser', 'instagram.com/someuser?variant=alt']);
});

test('queryVariantCheck: a PROVISIONAL allow-list entry IS still surfaced, unlike a decided one (LEMA-11736)', () => {
  // Reproduces the exact shape of the gap this ticket closed: tv.apple.com
  // sat in HOST_PARAM_ALLOWLIST with `l` kept but explicitly deferred to
  // the CEO between LEMA-11733 and LEMA-11736, so the judgment call had
  // NOT been made -- a provisional entry must not silently exclude its
  // host from this advisory the way a decided entry correctly does (see
  // the next test). Mutates the live HOST_PARAM_ALLOWLIST with a synthetic
  // host for the duration of this test only.
  const testHost = 'provisional-test-host.example';
  HOST_PARAM_ALLOWLIST.set(testHost, { keep: ['l'], provisional: true });
  try {
    const dataset = [dataRow(`https://${testHost}/show/las-azules?l=es`)];
    const ledger = [ledgerRow(`https://${testHost}/show/las-azules`)];
    const findings = queryVariantCheck(dataset, ledger);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].pathOnlyKey, `${testHost}/show/las-azules`);
    assert.equal(findings[0].variantCount, 2);
  } finally {
    HOST_PARAM_ALLOWLIST.delete(testHost);
  }
});

test('queryVariantCheck: the same shape on a non-provisional (decided) entry is NOT surfaced', () => {
  // Control for the test above: identical keep-list and identical pair
  // shape, only the provisional flag differs, to isolate that the flag
  // (not the keep-list contents) is what drives exclusion.
  const testHost = 'decided-test-host.example';
  HOST_PARAM_ALLOWLIST.set(testHost, { keep: ['l'] });
  try {
    const dataset = [dataRow(`https://${testHost}/show/las-azules?l=es`)];
    const ledger = [ledgerRow(`https://${testHost}/show/las-azules`)];
    assert.equal(queryVariantCheck(dataset, ledger).length, 0);
  } finally {
    HOST_PARAM_ALLOWLIST.delete(testHost);
  }
});

test('queryVariantCheck: a host already in HOST_PARAM_ALLOWLIST is never flagged (decision already on record)', () => {
  // reforma.com IS listed (LEMA-11733 ships it with an empty keep-list), so
  // a same-path pair there must not be re-flagged even though the raw
  // query strings differ -- normalize() already collapses them to one key,
  // and re-flagging an already-decided host would be noise.
  const dataset = [
    dataRow('https://www.reforma.com/muestran-las-azules-a-las-mujeres-policias-en-mexico/ar2848897?v=3'),
  ];
  const ledger = [
    ledgerRow('https://www.reforma.com/muestran-las-azules-a-las-mujeres-policias-en-mexico/ar2848897'),
  ];
  assert.equal(queryVariantCheck(dataset, ledger).length, 0);
});

test('queryVariantCheck: diarioimagen.net is never flagged even though two rows share a bare path with different ?p= values (identity param, not a bug)', () => {
  // diarioimagen.net IS listed (keep=['p']) precisely because ?p= is the
  // identity here -- two different articles legitimately share the bare
  // "/" path. This must not be treated as a query-variant defect.
  const dataset = [
    dataRow('https://www.diarioimagen.net/?p=736623'),
    dataRow('https://www.diarioimagen.net/?p=736624'),
  ];
  assert.equal(queryVariantCheck(dataset, []).length, 0);
});

test('queryVariantCheck: a single occurrence of a path (no variant) is not flagged', () => {
  const dataset = [dataRow('https://www.instagram.com/someuser/?hl=en')];
  assert.equal(queryVariantCheck(dataset, []).length, 0);
});

test('queryVariantCheck: same URL string appearing in both files is not double-counted as its own variant', () => {
  const url = 'https://www.instagram.com/someuser/?hl=en';
  const dataset = [dataRow(url)];
  const ledger = [ledgerRow(url)];
  assert.equal(queryVariantCheck(dataset, ledger).length, 0);
});

test('queryVariantCheck: two distinct, unlisted-host paths with no query overlap at all are not flagged', () => {
  const dataset = [dataRow('https://example.com/article-one'), dataRow('https://example.com/article-two')];
  assert.equal(queryVariantCheck(dataset, []).length, 0);
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
