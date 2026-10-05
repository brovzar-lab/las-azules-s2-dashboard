'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUrl, looksLikeUnresolvedIdPermalink } = require('../lib/normalize');

test('trailing-slash variant collapses to the same key', () => {
  const a = normalizeUrl('https://example.com/article/las-azules');
  const b = normalizeUrl('https://example.com/article/las-azules/');
  assert.equal(a.key, b.key);
});

test('www versus non-www collapses to the same key', () => {
  const a = normalizeUrl('https://example.com/article');
  const b = normalizeUrl('https://www.example.com/article');
  assert.equal(a.key, b.key);
});

test('http versus https collapses to the same key, real scheme kept in url', () => {
  const a = normalizeUrl('http://example.com/article');
  const b = normalizeUrl('https://example.com/article');
  assert.equal(a.key, b.key);
  assert.equal(a.url, 'http://example.com/article');
  assert.equal(b.url, 'https://example.com/article');
});

test('host and scheme are lowercased, path case is preserved', () => {
  const { url, key } = normalizeUrl('HTTPS://Example.COM/Article/Las-Azules');
  assert.equal(url, 'https://example.com/Article/Las-Azules');
  assert.equal(key, 'example.com/Article/Las-Azules');
});

test('known tracking query params are dropped, non-tracking params survive', () => {
  const { key } = normalizeUrl('https://example.com/article?utm_source=twitter&utm_medium=social&id=42');
  assert.equal(key, 'example.com/article?id=42');
});

test('surviving query params are sorted for a stable key regardless of input order', () => {
  const a = normalizeUrl('https://example.com/article?b=2&a=1');
  const b = normalizeUrl('https://example.com/article?a=1&b=2');
  assert.equal(a.key, b.key);
});

test('fragments are dropped from both url and key', () => {
  const { url, key } = normalizeUrl('https://example.com/article#section-2');
  assert.equal(url, 'https://example.com/article');
  assert.equal(key, 'example.com/article');
});

// KNOWN SPEC GAP, flagged in the LEMA-9933 deliverable: the routine prose
// claims locale-path variants (e.g. an /es-es/ segment) resolve to the same
// ledger entry via "this same normalization rule", but the rule as written
// (lowercase scheme/host, strip www, strip trailing slash, drop tracking
// query params) defines no transformation that would strip a locale path
// segment. This test documents the literal, current behavior: a locale
// variant does NOT collapse to the same key. It is not a bug in this
// implementation; it is the prose's own gap, ported faithfully rather than
// silently patched.
test('locale path variant does NOT collapse under the literal spec (flagged ambiguity, not resolved here)', () => {
  const bare = normalizeUrl('https://example.com/article/las-azules');
  const locale = normalizeUrl('https://example.com/es-es/article/las-azules');
  assert.notEqual(bare.key, locale.key);
});

test('throws on a malformed URL rather than silently producing a wrong key', () => {
  assert.throws(() => normalizeUrl('not-a-url'));
});

// YouTube-family per-host whitelist (LEMA-9942, approved LEMA-9904 Item 5):
// keep only v and list on youtube.com / m.youtube.com / youtu.be, drop
// everything else -- including params the generic strip list would not
// otherwise touch, like the locale flag `vl`.

test('YouTube vl locale param variant collapses to the same key as the bare watch URL', () => {
  const bare = normalizeUrl('https://www.youtube.com/watch?v=Z9n3TkdcGLY');
  const withLocale = normalizeUrl('https://www.youtube.com/watch?v=Z9n3TkdcGLY&vl=en-US');
  assert.equal(bare.key, withLocale.key);
});

test('YouTube playlist param is preserved intact', () => {
  const { key } = normalizeUrl('https://www.youtube.com/playlist?list=PLPDDDmhRE2s8abc123');
  assert.equal(key, 'youtube.com/playlist?list=PLPDDDmhRE2s8abc123');
});

test('YouTube case-mixed video id is preserved byte-for-byte, not lowercased', () => {
  const { key, url } = normalizeUrl('https://www.youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(key, 'youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(url, 'https://youtube.com/watch?v=Z9n3TkdcGLY');
});

// youtu.be -> youtube.com/watch?v=<id> fold (LEMA-9942 pre-approval,
// shipped LEMA-11959): youtu.be only ever redirects to the watch form, so
// it folds to the same key as its youtube.com/watch?v= equivalent, with
// the per-host param whitelist (si= share token dropped) still applying.

test('youtu.be folds to the youtube.com/watch?v= key, the YouTube whitelist still applies (si= share token dropped)', () => {
  const { key, url } = normalizeUrl('https://youtu.be/Z9n3TkdcGLY?si=shareToken123');
  assert.equal(key, 'youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(url, 'https://youtube.com/watch?v=Z9n3TkdcGLY');
});

test('youtu.be and its watch?v= equivalent collapse to the same key', () => {
  const short = normalizeUrl('https://youtu.be/Z9n3TkdcGLY');
  const watch = normalizeUrl('https://www.youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(short.key, watch.key);
});

// youtube.com/shorts/<id> -> watch?v=<id> fold (LEMA-9942 pre-approval,
// shipped LEMA-11959). The live trigger: a youtube.com/shorts/<id> row has
// been in fetch-blocklist.json since 2026-09-26 (LEMA-11250), with no
// competing watch?v= row for the same id -- this pins that exact id so a
// regression would be caught against the real corpus shape, not just a
// synthetic one.

test('youtube.com/shorts/<id> folds to the watch?v= key (the live LEMA-11250 fetch-blocklist.json row)', () => {
  const shorts = normalizeUrl('https://youtube.com/shorts/SSsG4MybyTU');
  const watch = normalizeUrl('https://www.youtube.com/watch?v=SSsG4MybyTU');
  assert.equal(shorts.key, watch.key);
  assert.equal(shorts.key, 'youtube.com/watch?v=SSsG4MybyTU');
  assert.equal(shorts.url, 'https://youtube.com/watch?v=SSsG4MybyTU');
});

test('m.youtube.com/shorts/<id> also folds to the watch?v= key (m. strip runs before the shorts fold)', () => {
  const { key } = normalizeUrl('https://m.youtube.com/shorts/SSsG4MybyTU');
  assert.equal(key, 'youtube.com/watch?v=SSsG4MybyTU');
});

test('youtube.com/shorts/<id> whitelist still applies: a tracking param alongside it is dropped', () => {
  const { key } = normalizeUrl('https://youtube.com/shorts/SSsG4MybyTU?feature=share');
  assert.equal(key, 'youtube.com/watch?v=SSsG4MybyTU');
});

test('youtube.com/<single-segment> that is NOT /shorts/ is left alone (a channel vanity path, not a video id)', () => {
  const { key } = normalizeUrl('https://www.youtube.com/@SomeChannel');
  assert.equal(key, 'youtube.com/@SomeChannel');
});

test('youtube.com/watch?v= itself is unaffected by the shorts/youtu.be fold (already canonical, passes through unchanged)', () => {
  const { key, url } = normalizeUrl('https://www.youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(key, 'youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(url, 'https://youtube.com/watch?v=Z9n3TkdcGLY');
});

// Three evidence-backed params added to the generic strip list (LEMA-9942,
// approved LEMA-9904 Item 5 condition).

test('srsltid (Google search-result id) is stripped on non-YouTube hosts', () => {
  const { key } = normalizeUrl('https://example.com/article?srsltid=AbCdEf123&id=42');
  assert.equal(key, 'example.com/article?id=42');
});

test('SESSIONID is stripped (case-insensitive), aId survives as the identity', () => {
  const { key } = normalizeUrl('https://www.webwire.com/ViewPressRel.asp?SESSIONID=&aId=358842');
  assert.equal(key, 'webwire.com/ViewPressRel.asp?aId=358842');
});

test('ref_ (IMDb nav referrer) is stripped, the news id survives, host is m.-folded (LEMA-10275)', () => {
  const { key } = normalizeUrl('https://m.imdb.com/news/ni64735557/?ref_=tt_nwr_1');
  assert.equal(key, 'imdb.com/news/ni64735557');
});

// Regression guard: on a host with NO per-host allow-list entry, an
// arbitrary unrecognized query param still survives the generic deny-list
// default untouched (this is the "unlisted host never silently merges"
// guarantee the LEMA-11733 per-host table is built to preserve).

test('unlisted-host params survive untouched: aId, p, f (generic hosts)', () => {
  assert.equal(
    normalizeUrl('https://example.com/article?aId=1').key,
    'example.com/article?aId=1'
  );
  assert.equal(
    normalizeUrl('https://example.com/article?p=1').key,
    'example.com/article?p=1'
  );
  assert.equal(
    normalizeUrl('https://example.com/article?f=1').key,
    'example.com/article?f=1'
  );
});

// m. mobile-subdomain fold (LEMA-10275, falls out of the LEMA-10247 ruling:
// two of the six editorial_redundant_syndication ledger rows turned out to
// be m.<host> variants of an already-tracked URL, not editorial judgments).

test('m. mobile subdomain collapses to the same key as the bare host', () => {
  const bare = normalizeUrl('https://example.com/article');
  const mobile = normalizeUrl('https://m.example.com/article');
  assert.equal(bare.key, mobile.key);
  assert.equal(mobile.key, 'example.com/article');
});

test('m.imdb.com collapses to the same key as www.imdb.com (the real LEMA-10247 case)', () => {
  const tracked = normalizeUrl('https://www.imdb.com/news/ni64735557/');
  const mobileWithTracking = normalizeUrl('https://m.imdb.com/news/ni64735557/?ref_=tt_nwr_1');
  assert.equal(tracked.key, mobileWithTracking.key);
});

// m.youtube.com was exempted from the generic m. fold between LEMA-9942
// and LEMA-11959 (kept its own distinct key, deliberately). LEMA-11959
// found a live m.youtube.com candidate the exemption hid from the Pass 0
// dedup gate and removed it -- m.youtube.com now folds like every other m.
// host, the same CEO ruling that shipped the youtu.be/shorts video-ID fold
// above.

test('m.youtube.com now folds to the same key as youtube.com (LEMA-11959, exemption removed)', () => {
  const mobile = normalizeUrl('https://m.youtube.com/watch?v=Z9n3TkdcGLY');
  const desktop = normalizeUrl('https://www.youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(mobile.key, desktop.key);
  assert.equal(mobile.key, 'youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(mobile.url, 'https://youtube.com/watch?v=Z9n3TkdcGLY');
});

test('YouTube per-host param whitelist still applies to m.youtube.com after the fold (vl= locale flag dropped)', () => {
  const { key } = normalizeUrl('https://m.youtube.com/watch?v=Z9n3TkdcGLY&vl=en-US');
  assert.equal(key, 'youtube.com/watch?v=Z9n3TkdcGLY');
});

test('a host that merely starts with "m" but is not an m. subdomain is left alone', () => {
  const { key } = normalizeUrl('https://movies.example.com/article');
  assert.equal(key, 'movies.example.com/article');
});

// twitter.com -> x.com host alias (LEMA-10553, dedup gap found on LEMA-10552):
// X redirects twitter.com to x.com in the live product, so both hosts are
// the same tracked source and must collapse to the same comparison key.

test('twitter.com collapses to the same key as x.com', () => {
  const tw = normalizeUrl('https://twitter.com/AppleTV/status/1837519173062479974');
  const x = normalizeUrl('https://x.com/AppleTV/status/1837519173062479974');
  assert.equal(tw.key, x.key);
  // x.com is case-insensitive-path-folded for the key (LEMA-11825); url
  // display form below keeps the real-world handle case regardless.
  assert.equal(tw.key, 'x.com/appletv/status/1837519173062479974');
});

test('www.twitter.com also collapses to x.com (www strip runs before the alias)', () => {
  const { key, url } = normalizeUrl('https://www.twitter.com/AppleTV');
  assert.equal(key, 'x.com/appletv');
  assert.equal(url, 'https://x.com/AppleTV');
});

test('mobile.twitter.com collapses to x.com even though it does not match the generic m. fold', () => {
  const { key, url } = normalizeUrl('https://mobile.twitter.com/AppleTV/status/1837519173062479974');
  assert.equal(key, 'x.com/appletv/status/1837519173062479974');
  assert.equal(url, 'https://x.com/AppleTV/status/1837519173062479974');
});

test('canonical url display form uses the aliased host, real scheme kept, and keeps real-world case (LEMA-11825: case-folding applies to the key, never to url)', () => {
  const { url } = normalizeUrl('http://twitter.com/AppleTV/status/1837519173062479974');
  assert.equal(url, 'http://x.com/AppleTV/status/1837519173062479974');
});

test('twitter.com alias composes with tracking-param stripping', () => {
  const { key } = normalizeUrl('https://twitter.com/AppleTV/status/1666105302134009856?ref_src=twsrc%5Etfw');
  assert.equal(key, 'x.com/appletv/status/1666105302134009856');
});

// Facebook /<page>/<type>/<slug>/<id> -> /<page>/<type>/<id> path fold
// (LEMA-10602): the <slug> is generated by Facebook from the post's own
// body text and carries no identity, so a slug-form URL and its
// short-ID-only equivalent are the same tracked post.

test('CNNee real group: slug form and short-ID form collapse to the same key (LEMA-10602 live disagreement)', () => {
  const slugForm = normalizeUrl(
    'https://facebook.com/CNNee/videos/la-serie-las-azules-prepara-el-lanzamiento-de-su-segunda-temporada-en-la-que-el-/1343457514667233'
  );
  const shortForm = normalizeUrl('https://www.facebook.com/CNNee/videos/1343457514667233/');
  assert.equal(slugForm.key, shortForm.key);
  assert.equal(slugForm.key, 'facebook.com/CNNee/videos/1343457514667233');
});

test('thefemalelead real group: slug form and short-ID form collapse to the same key (LEMA-10602 duplicate ledger rows)', () => {
  const slugForm = normalizeUrl(
    'https://www.facebook.com/thefemalelead/videos/when-filming-las-azules-the-series-inspired-by-the-true-story-of-mexicos-first-f/1370329548535537/'
  );
  const shortForm = normalizeUrl('https://www.facebook.com/thefemalelead/videos/1370329548535537/');
  assert.equal(slugForm.key, shortForm.key);
  assert.equal(slugForm.key, 'facebook.com/thefemalelead/videos/1370329548535537');
});

test('facebook.com /posts/<slug>/<id> folds the same way as /videos/', () => {
  const { key, url } = normalizeUrl('https://www.facebook.com/SomePage/posts/a-post-about-something/9876543210');
  assert.equal(key, 'facebook.com/SomePage/posts/9876543210');
  assert.equal(url, 'https://facebook.com/SomePage/posts/9876543210');
});

test('facebook.com /reel/<slug>/<id> folds the same way as /videos/', () => {
  const { key } = normalizeUrl('https://www.facebook.com/SomePage/reel/a-reel-caption-slug/1122334455');
  assert.equal(key, 'facebook.com/SomePage/reel/1122334455');
});

test('facebook.com /groups/<gid>/posts/<id> is NOT folded (type position is a numeric group id, not videos/posts/reel)', () => {
  const { key } = normalizeUrl('https://www.facebook.com/groups/123456789012345/posts/9876543210987654/');
  assert.equal(key, 'facebook.com/groups/123456789012345/posts/9876543210987654');
});

test('facebook.com bare /<page>/videos/<id> (no slug) is unchanged by the fold', () => {
  const { key } = normalizeUrl('https://www.facebook.com/CNNee/videos/1343457514667233/');
  assert.equal(key, 'facebook.com/CNNee/videos/1343457514667233');
});

test('a non-facebook host with a similar /page/videos/slug/id path shape is left alone', () => {
  const { key } = normalizeUrl('https://example.com/SomePage/videos/some-slug-here/1122334455');
  assert.equal(key, 'example.com/SomePage/videos/some-slug-here/1122334455');
});

// LEMA-11733: generalized per-host query-param allow-list, CEO ruling on
// LEMA-11732 (reforma.com's ?v=3 cache-buster surviving normalization
// because the generic deny-list's default is keep, not drop). Same
// mechanism as the YouTube allow-list above, applied to hosts measured
// against the live data.json/fetch-blocklist.json as of 2026-09-28. See
// tools/lib/normalize.js's HOST_PARAM_ALLOWLIST comment for the full
// per-host evidence writeup.

test('the reported bug: reforma.com ?v=3 cache-buster no longer survives (LEMA-11732)', () => {
  const withParam = normalizeUrl(
    'https://www.reforma.com/muestran-las-azules-a-las-mujeres-policias-en-mexico/ar2848897?v=3'
  );
  const bare = normalizeUrl(
    'https://www.reforma.com/muestran-las-azules-a-las-mujeres-policias-en-mexico/ar2848897'
  );
  assert.equal(withParam.key, bare.key);
  assert.equal(withParam.key, 'reforma.com/muestran-las-azules-a-las-mujeres-policias-en-mexico/ar2848897');
});

test('163.com recommendation-widget referrer ?f= is dropped, article id stays in the path', () => {
  const { key } = normalizeUrl('https://www.163.com/dy/article/L6950I8E05561FX4.html?f=post2020_dy_recommends');
  assert.equal(key, '163.com/dy/article/L6950I8E05561FX4.html');
});

test('macprime.ch referrer ?s=rss-artikel is dropped, distinct articles stay distinct by path', () => {
  const a = normalizeUrl('https://www.macprime.ch/a/news/article-one?s=rss-artikel');
  const b = normalizeUrl('https://www.macprime.ch/a/news/article-two?s=rss-artikel');
  assert.notEqual(a.key, b.key);
  assert.equal(a.key, 'macprime.ch/a/news/article-one');
});

test('primevideo.com storefront-referral ?tr= is dropped; same title id under different tr values collapses', () => {
  const mx = normalizeUrl('https://www.primevideo.com/-/es/detail/0JFCKSNHTRBNJA50K5E6QG2HHN?tr=mx');
  const cl = normalizeUrl('https://www.primevideo.com/-/es/detail/0JFCKSNHTRBNJA50K5E6QG2HHN?tr=cl');
  const bare = normalizeUrl('https://www.primevideo.com/-/es/detail/0JFCKSNHTRBNJA50K5E6QG2HHN');
  assert.equal(mx.key, cl.key);
  assert.equal(mx.key, bare.key);
  assert.equal(mx.key, 'primevideo.com/-/es/detail/0JFCKSNHTRBNJA50K5E6QG2HHN');
});

test('primevideo.com locale PATH (not query) stays distinct: /it/ is a different page than /es/', () => {
  const es = normalizeUrl('https://www.primevideo.com/-/es/detail/0JFCKSNHTRBNJA50K5E6QG2HHN');
  const it = normalizeUrl('https://www.primevideo.com/-/it/detail/0JFCKSNHTRBNJA50K5E6QG2HHN');
  assert.notEqual(es.key, it.key);
});

test('issuu.com partner-referral ?fr= is dropped, doc slug is the full identity', () => {
  const { key } = normalizeUrl(
    'https://issuu.com/deadlinehollywood/docs/deadline_hollywood_-_contenders_television_-_docum?fr=sYzhhYTgzOTIxODk'
  );
  assert.equal(key, 'issuu.com/deadlinehollywood/docs/deadline_hollywood_-_contenders_television_-_docum');
});

// Regression guard (explicit deliverable requirement): a bare-path
// identity param (WordPress-style ?p=<id>, no other path segment) must
// NEVER be stripped, even though the pattern superficially looks like a
// single throwaway query param the way the cache-buster hosts above do.

test('diarioimagen.net WordPress ?p= identity param is NOT stripped (bare-path regression guard)', () => {
  const { key } = normalizeUrl('https://www.diarioimagen.net/?p=736623');
  assert.equal(key, 'diarioimagen.net/?p=736623');
});

test('es.hollywoodreporter.com WordPress ?p= identity param is NOT stripped (bare-path regression guard)', () => {
  const { key } = normalizeUrl('https://es.hollywoodreporter.com/?p=9808');
  assert.equal(key, 'es.hollywoodreporter.com/?p=9808');
});

test('webwire.com ?aId= identity param is NOT stripped, still survives after this ticket', () => {
  const { key } = normalizeUrl('https://www.webwire.com/ViewPressRel.asp?aId=358842');
  assert.equal(key, 'webwire.com/ViewPressRel.asp?aId=358842');
});

test('movistarplus.es: ?id= identity param survives, ?tipo= type-classifier flag is dropped', () => {
  const { key } = normalizeUrl('https://www.movistarplus.es/series/las-azules/ficha?tipo=E&id=3958475');
  assert.equal(key, 'movistarplus.es/series/las-azules/ficha?id=3958475');
});

test('filmaffinity.com ?movie-id= identity param is NOT stripped (bare-path regression guard)', () => {
  const { key } = normalizeUrl('https://www.filmaffinity.com/es/movie-awards.php?movie-id=786793');
  assert.equal(key, 'filmaffinity.com/es/movie-awards.php?movie-id=786793');
});

test('thetvdb.com ?page= is identity-bearing on a paginated listing, NOT stripped', () => {
  const p6 = normalizeUrl('https://thetvdb.com/companies/apple-tv-plus?page=6');
  const p7 = normalizeUrl('https://thetvdb.com/companies/apple-tv-plus?page=7');
  assert.notEqual(p6.key, p7.key);
  assert.equal(p6.key, 'thetvdb.com/companies/apple-tv-plus?page=6');
});

test('tv.apple.com: showId/targetId/targetType (constant show-id echoes) are dropped, path id stays the identity', () => {
  const episode = normalizeUrl(
    'https://tv.apple.com/pe/episode/alma/umc.cmc.5g6l2hlovopmmxtypma7v3j3u?showId=umc.cmc.73wmdmkfpta5ul1vbwckmme39'
  );
  assert.equal(episode.key, 'tv.apple.com/pe/episode/alma/umc.cmc.5g6l2hlovopmmxtypma7v3j3u');

  // `l` is also dropped as of LEMA-11736 (was preserved under LEMA-11733) --
  // see the next test.
  const clip = normalizeUrl(
    'https://tv.apple.com/gt/clip/las-mujeres-season-1/umc.cmc.dfqcxumy8pgbu8c3016pkf68?l=en&targetId=umc.cmc.73wmdmkfpta5ul1vbwckmme39&targetType=Show'
  );
  assert.equal(clip.key, 'tv.apple.com/gt/clip/las-mujeres-season-1/umc.cmc.dfqcxumy8pgbu8c3016pkf68');
});

test('tv.apple.com: ?l= locale flag is now dropped -- CEO resolved the LEMA-11733 deferral on LEMA-11736', () => {
  const es = normalizeUrl('https://tv.apple.com/us/show/las-azules/umc.cmc.73wmdmkfpta5ul1vbwckmme39?l=es');
  const en = normalizeUrl('https://tv.apple.com/us/show/las-azules/umc.cmc.73wmdmkfpta5ul1vbwckmme39?l=en');
  const bare = normalizeUrl('https://tv.apple.com/us/show/las-azules/umc.cmc.73wmdmkfpta5ul1vbwckmme39');
  assert.equal(es.key, en.key);
  assert.equal(es.key, bare.key);
  assert.equal(es.key, 'tv.apple.com/us/show/las-azules/umc.cmc.73wmdmkfpta5ul1vbwckmme39');
});

// LEMA-11736: hl/lang/locale added to the global TRACKING_PARAM_NAMES deny
// list (CEO approval, following the LEMA-11733 deliverable's global
// locale-param proposal). facebook.com/instagram.com/tiktok.com/x.com have
// no HOST_PARAM_ALLOWLIST entry of their own -- these params are now
// dropped for them (and every other host) via the generic deny-list path,
// not a per-host entry.

test('facebook.com ?locale=, instagram.com ?hl=, tiktok.com ?lang=, x.com ?lang= are now dropped globally (LEMA-11736)', () => {
  assert.equal(
    normalizeUrl('https://www.facebook.com/SomePage/posts/a-slug/1234?locale=bg_BG').key,
    'facebook.com/SomePage/posts/1234'
  );
  assert.equal(
    normalizeUrl('https://www.instagram.com/someuser/?hl=en').key,
    'instagram.com/someuser'
  );
  assert.equal(
    normalizeUrl('https://www.tiktok.com/@someuser/video/123?lang=es').key,
    'tiktok.com/@someuser/video/123'
  );
  assert.equal(
    normalizeUrl('https://x.com/someuser?lang=en').key,
    'x.com/someuser'
  );
});

test('hl/lang/locale strip is case-insensitive like every other tracking param, and a non-locale param on the same host survives', () => {
  const { key } = normalizeUrl('https://example.com/article?LOCALE=es&keep=1');
  assert.equal(key, 'example.com/article?keep=1');
});

// LEMA-11825 (CEO ruling on LEMA-11824): per-host case-insensitive path
// folding for upi.com (the reported duplicate) and x.com (X handles are
// case-insensitive by X's own product rule). Every other host, including
// the short-ID hosts where case is load-bearing, must keep case-preserving
// behaviour -- the youtube.com/youtu.be pin below is the regression this
// ruling exists to prevent.

test('upi.com: mixed-case and lowercase path variants of the same article collapse to the same key (LEMA-11824)', () => {
  const a = normalizeUrl('https://www.upi.com/Entertainment_News/TV/2026/07/21/las-azules-season-2-trailer/8811784644272/');
  const b = normalizeUrl('https://www.upi.com/entertainment_news/tv/2026/07/21/las-azules-season-2-trailer/8811784644272/');
  assert.equal(a.key, b.key);
  assert.equal(a.key, 'upi.com/entertainment_news/tv/2026/07/21/las-azules-season-2-trailer/8811784644272');
});

test('x.com: case-varied handle forms collapse to the same key', () => {
  const a = normalizeUrl('https://x.com/AppleTV');
  const b = normalizeUrl('https://x.com/appletv');
  assert.equal(a.key, b.key);
  assert.equal(a.key, 'x.com/appletv');

  const c = normalizeUrl('https://x.com/WomenInBlueDoc');
  const d = normalizeUrl('https://x.com/womeninbluedoc');
  assert.equal(c.key, d.key);
});

test('x.com case-fold applies to status-path handles too, not just bare handles', () => {
  const a = normalizeUrl('https://x.com/AppleTV/status/123456789');
  const b = normalizeUrl('https://x.com/appletv/status/123456789');
  assert.equal(a.key, b.key);
});

test('case-insensitive path folding is a per-host opt-in, not global: a case-varied youtube.com/shorts/<ID> and youtu.be/<ID> do NOT collide (regression guard)', () => {
  const shorts = normalizeUrl('https://www.youtube.com/shorts/AbC123xyz');
  const shortsLower = normalizeUrl('https://www.youtube.com/shorts/abc123xyz');
  assert.notEqual(shorts.key, shortsLower.key);

  const youtuBe = normalizeUrl('https://youtu.be/AbC123xyz');
  const youtuBeLower = normalizeUrl('https://youtu.be/abc123xyz');
  assert.notEqual(youtuBe.key, youtuBeLower.key);
});

test('case-insensitive path folding does not affect unlisted hosts at all (instagram/facebook short IDs stay case-preserving)', () => {
  const a = normalizeUrl('https://www.instagram.com/p/AbCdEfGhIjK/');
  const b = normalizeUrl('https://www.instagram.com/p/abcdefghijk/');
  assert.notEqual(a.key, b.key);
});

test('case-fold applies to the comparison key only, never to the display url (a stored/canonical url must keep the real-world handle case)', () => {
  const { url, key } = normalizeUrl('https://x.com/AppleTV');
  assert.equal(url, 'https://x.com/AppleTV');
  assert.equal(key, 'x.com/appletv');
});

// looksLikeUnresolvedIdPermalink (LEMA-11889)

test('looksLikeUnresolvedIdPermalink: true for the reported appleworld.today case (bare root path, single numeric p= param)', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://appleworld.today/?p=129727'), true);
});

test('looksLikeUnresolvedIdPermalink: true regardless of host -- the check is a pure URL shape, not a per-host config entry', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://some-brand-new-outlet.example/?p=42'), true);
});

test('looksLikeUnresolvedIdPermalink: true survives a tracking param riding alongside p= (utm_source is stripped before the shape check)', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://appleworld.today/?p=129727&utm_source=newsletter'), true);
});

test('looksLikeUnresolvedIdPermalink: false when a real path segment is present (not a bare root permalink)', () => {
  assert.equal(
    looksLikeUnresolvedIdPermalink('https://appleworld.today/2026/07/apple-tv-unveils-trailer-for-season-two-of-spanish-language-crime-drama-women-in-blue-las-azules/'),
    false
  );
});

test('looksLikeUnresolvedIdPermalink: false when the p value is not purely numeric', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://example.com/?p=abc123'), false);
});

test('looksLikeUnresolvedIdPermalink: false when another non-tracking param rides alongside p= (ambiguous shape, not the bare WordPress form)', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://example.com/?p=129727&preview=true'), false);
});

test('looksLikeUnresolvedIdPermalink: false with no query string at all', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://example.com/'), false);
});

test('looksLikeUnresolvedIdPermalink: false for diarioimagen.net -- already-decided host where ?p=<id> IS the real identity, not a redirect alias', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://diarioimagen.net/?p=736623'), false);
});

test('looksLikeUnresolvedIdPermalink: false for es.hollywoodreporter.com -- same already-decided-host exclusion as diarioimagen.net', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://es.hollywoodreporter.com/?p=123456'), false);
});

test('looksLikeUnresolvedIdPermalink: www./m. variants of a flagged host still flag true (host is canonicalized before the allow-list check)', () => {
  assert.equal(looksLikeUnresolvedIdPermalink('https://www.appleworld.today/?p=129727'), true);
  assert.equal(looksLikeUnresolvedIdPermalink('https://m.appleworld.today/?p=129727'), true);
});

// ---- AMP second-address fold (LEMA-11953) ----

test('AMP shape 1: trailing /amp/ path segment collapses to the canonical non-AMP key (reviewnation.net live pair)', () => {
  const amp = normalizeUrl('https://reviewnation.net/the-women-in-blue-return-for-season-2-interview/amp/');
  const canonical = normalizeUrl('https://reviewnation.net/the-women-in-blue-return-for-season-2-interview/');
  assert.equal(amp.key, canonical.key);
  assert.equal(amp.url, canonical.url);
});

test('AMP shape 1: bare trailing /amp (no trailing slash) also collapses (senalnews.com ledger case)', () => {
  const amp = normalizeUrl('https://senalnews.com/en/digital/apple-tv-to-launch-spanish-language-women-in-blue-second-season-in-august/amp');
  assert.equal(amp.key, 'senalnews.com/en/digital/apple-tv-to-launch-spanish-language-women-in-blue-second-season-in-august');
});

test('AMP shape 1: www.-stripped host still folds (mactech.com ledger family)', () => {
  const withWww = normalizeUrl('https://www.mactech.com/2026/08/13/season-two-of-women-in-blue-las-azules-is-now-streaming-on-apple-tv/amp/');
  assert.equal(withWww.key, 'mactech.com/2026/08/13/season-two-of-women-in-blue-las-azules-is-now-streaming-on-apple-tv');
});

test('AMP shape 1: a bare "/amp" path by itself is left alone (guard against folding to an empty path)', () => {
  const { key } = normalizeUrl('https://example.com/amp');
  assert.equal(key, 'example.com/amp');
});

test('AMP shape 1: the two pre-S2-window mactech.com orphans fold to their own distinct keys, not to each other or anything live', () => {
  const a = normalizeUrl('https://mactech.com/2025/05/21/apple-tv-renews-spanish-language-crime-series-women-in-blue-for-a-second-season/amp');
  const b = normalizeUrl('https://www.mactech.com/2022/05/24/apple-tv-orders-las-azules-a-new-spanish-language-crime-drama/amp/');
  assert.notEqual(a.key, b.key);
  assert.equal(a.key, 'mactech.com/2025/05/21/apple-tv-renews-spanish-language-crime-series-women-in-blue-for-a-second-season');
  assert.equal(b.key, 'mactech.com/2022/05/24/apple-tv-orders-las-azules-a-new-spanish-language-crime-drama');
});

test('AMP shape 2 (bollywoodshaadis.com only): /amp-articles/<slug> renames to /articles/<slug>, collapsing to the canonical key', () => {
  const amp = normalizeUrl('https://www.bollywoodshaadis.com/amp-articles/women-in-blue-season-2-review-83240');
  const canonical = normalizeUrl('https://www.bollywoodshaadis.com/articles/women-in-blue-season-2-review-83240');
  assert.equal(amp.key, canonical.key);
  assert.equal(amp.url, 'https://bollywoodshaadis.com/articles/women-in-blue-season-2-review-83240');
});

test('AMP shape 2 is host-scoped: an unrelated host with the same /amp-articles/ path shape is NOT renamed', () => {
  const { key } = normalizeUrl('https://some-other-outlet.example/amp-articles/unrelated-story');
  assert.equal(key, 'some-other-outlet.example/amp-articles/unrelated-story');
});

test('AMP shape 3: leading /amp/ path prefix collapses to the canonical non-AMP key (eltiempo.com live pair)', () => {
  const amp = normalizeUrl(
    'https://www.eltiempo.com/amp/cultura/cine-y-tv/vuelven-las-azules-el-increible-grupo-de-mujeres-que-se-abrio-camino-en-la-policia-de-mexico-a-pesar-del-machismo-la-corrupcion-y-las-mentiras-3577681'
  );
  const canonical = normalizeUrl(
    'https://www.eltiempo.com/cultura/cine-y-tv/vuelven-las-azules-el-increible-grupo-de-mujeres-que-se-abrio-camino-en-la-policia-de-mexico-a-pesar-del-machismo-la-corrupcion-y-las-mentiras-3577681'
  );
  assert.equal(amp.key, canonical.key);
  assert.equal(amp.url, canonical.url);
});

test('AMP shape 4: .amp.html extension infix folds to .html, collapsing to the canonical key (theweek.in live pair)', () => {
  const amp = normalizeUrl('https://www.theweek.in/news/entertainment/2026/08/10/women-in-blue-season-2-premiere.amp.html');
  const canonical = normalizeUrl('https://www.theweek.in/news/entertainment/2026/08/10/women-in-blue-season-2-premiere.html');
  assert.equal(amp.key, canonical.key);
  assert.equal(amp.url, canonical.url);
});

test('AMP fold is segment/extension-anchored, not a substring match: "de-campeones" is never touched', () => {
  const { key } = normalizeUrl(
    'https://www.facebook.com/PlanoCinema/videos/cu%C3%A1l-es-el-verdadero-desayuno-de-campeones-de-una-azul-%EF%B8%8Fen-la-alfombra-azul-de-l/2080974666112141/'
  );
  // Facebook's own slug-drop fold (LEMA-10602) removes the slug here, which
  // is what actually accounts for "de-campeones" disappearing from the key
  // -- confirming that, not the AMP fold, is the point of this guard.
  assert.equal(key, 'facebook.com/PlanoCinema/videos/2080974666112141');
});

test('AMP fold is segment/extension-anchored, not a substring match: "camp-rock-3" is never touched', () => {
  const { key } = normalizeUrl(
    'https://streamingbetter.com/what-to-watch-this-weekend-camp-rock-3-lanterns-reacher-and-more-streaming-aug-14-2026/'
  );
  assert.equal(
    key,
    'streamingbetter.com/what-to-watch-this-weekend-camp-rock-3-lanterns-reacher-and-more-streaming-aug-14-2026'
  );
});

test('a path segment that merely contains "amp" mid-word is not folded by the leading-prefix or trailing-segment rules', () => {
  assert.equal(normalizeUrl('https://example.com/campaign-launch/').key, 'example.com/campaign-launch');
  assert.equal(normalizeUrl('https://example.com/amphitheater-tour/').key, 'example.com/amphitheater-tour');
});
