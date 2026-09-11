'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUrl } = require('../lib/normalize');

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
  const { key, url } = normalizeUrl('https://m.youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(key, 'm.youtube.com/watch?v=Z9n3TkdcGLY');
  assert.equal(url, 'https://m.youtube.com/watch?v=Z9n3TkdcGLY');
});

test('youtu.be host also applies the YouTube whitelist', () => {
  const { key } = normalizeUrl('https://youtu.be/Z9n3TkdcGLY?si=shareToken123');
  assert.equal(key, 'youtu.be/Z9n3TkdcGLY');
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

test('ref_ (IMDb nav referrer) is stripped, the news id survives', () => {
  const { key } = normalizeUrl('https://m.imdb.com/news/ni64735557/?ref_=tt_nwr_1');
  assert.equal(key, 'm.imdb.com/news/ni64735557');
});

// Regression guard: these params are identity-bearing on non-YouTube hosts
// and must survive the generic strip list untouched.

test('non-YouTube identity params survive: aId, s (macprime.ch), p, f, v (reforma.com)', () => {
  assert.equal(
    normalizeUrl('https://www.webwire.com/ViewPressRel.asp?aId=358842').key,
    'webwire.com/ViewPressRel.asp?aId=358842'
  );
  assert.equal(
    normalizeUrl('https://www.macprime.ch/a/news/some-article?s=rss-artikel').key,
    'macprime.ch/a/news/some-article?s=rss-artikel'
  );
  assert.equal(
    normalizeUrl('https://example.com/article?p=1').key,
    'example.com/article?p=1'
  );
  assert.equal(
    normalizeUrl('https://example.com/article?f=1').key,
    'example.com/article?f=1'
  );
  assert.equal(
    normalizeUrl('https://www.reforma.com/muestran-las-azules-a-las-mujeres-policias-en-mexico/ar2848897?v=3').key,
    'reforma.com/muestran-las-azules-a-las-mujeres-policias-en-mexico/ar2848897?v=3'
  );
});
