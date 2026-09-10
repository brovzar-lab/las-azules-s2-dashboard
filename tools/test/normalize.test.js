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
