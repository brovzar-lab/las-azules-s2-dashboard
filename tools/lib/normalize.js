'use strict';

// Canonical implementation of the Media Sweep routine's "URL normalization
// rule" (Pass 0 of routine b372cbc1-68bc-4322-af74-aa1b013c99b3). Every
// call site that used to re-implement this from memory (ledger lookup,
// ledger write, data.json dedup, both integrity assertions) should call
// normalizeUrl() instead. See LEMA-9933.

// Tracking query parameters to drop when building the comparison key. The
// routine prose says "drop tracking query parameters" without enumerating
// which ones count. This list is an implementation decision, not specified
// in the source prose. Flagged as an ambiguity in the LEMA-9933 deliverable.
const TRACKING_PARAM_NAMES = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src', 'ref_url', 'ref_',
  'spm', 'si', 'cmpid', 'icid', 'srsltid', 'sessionid',
]);
const TRACKING_PARAM_PREFIX = /^utm_/i;

function isTrackingParam(name) {
  const lower = name.toLowerCase();
  return TRACKING_PARAM_PREFIX.test(lower) || TRACKING_PARAM_NAMES.has(lower);
}

// Per-host whitelist for the YouTube family (youtube.com, m.youtube.com,
// youtu.be -- checked after the existing www. strip). Approved on
// LEMA-9904 Item 5, shipped on LEMA-9942: `v` (video id) and `list`
// (playlist id) are the only identity-bearing params on these hosts, so
// everything else (locale flags like `vl`, session/share params, etc.) is
// dropped instead of running through the generic tracking-param strip.
// Video/playlist IDs are case-sensitive and must never be lowercased.
const YOUTUBE_FAMILY_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtu.be']);
const YOUTUBE_KEPT_PARAMS = new Set(['v', 'list']);

function stripTrailingSlash(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function stripLeadingWww(host) {
  return host.startsWith('www.') ? host.slice(4) : host;
}

// Folds a leading "m." mobile subdomain into its parent host (e.g.
// m.imdb.com -> imdb.com), same rationale and style as the www. strip
// above: a mobile-site duplicate of an already-tracked page, not a
// distinct one. LEMA-10275.
//
// Exception: hosts already in YOUTUBE_FAMILY_HOSTS are left alone.
// m.youtube.com is a deliberate, pre-existing member of that set (LEMA-9942)
// with its own key identity -- folding it here would collapse it into
// youtube.com and change the comparison key, breaking that shipped
// behavior. Checked against the pre-fold host so this only ever exempts
// the literal 'm.youtube.com' entry, not every "m." host.
function stripLeadingMobile(host) {
  if (YOUTUBE_FAMILY_HOSTS.has(host)) return host;
  return host.startsWith('m.') ? host.slice(2) : host;
}

// Host aliases: hosts that are the exact same live entity under a
// different domain name, folded to one canonical host before the
// comparison key is built. Checked after stripLeadingWww/stripLeadingMobile
// above, so entries here are written in already-www/m.-stripped form.
//
// twitter.com -> x.com: X (formerly Twitter) redirects twitter.com to
// x.com in the live product, so a twitter.com URL and its x.com
// equivalent are the same tracked source. LEMA-10553, dedup gap found
// during LEMA-10552. www.twitter.com does not need its own entry: it is
// already folded to twitter.com by stripLeadingWww before this map is
// consulted.
//
// mobile.twitter.com -> x.com: included explicitly rather than relying on
// stripLeadingMobile above, because that fold only strips a literal
// leading "m." -- "mobile." is a distinct, real legacy Twitter subdomain
// it does not match. Same same-entity rationale as the twitter.com entry.
// No occurrence of this host was found in data.json/fetch-blocklist.json
// as of LEMA-10553; folding it anyway costs nothing and closes the gap
// pre-emptively rather than waiting for a real occurrence (contrast with
// the youtu.be gap below, which is deliberately left open pending one).
//
// This is a distinct, static, host-level alias and is NOT the same as the
// open canonical/redirect gap (LEMA-10275) documented below on
// normalizeUrl: that gap is about per-page redirects/canonical tags that
// require a network call to discover. twitter.com -> x.com is a
// universally-known, permanent product-level rename that can be hardcoded
// with no network dependency, so it is fixed here rather than left to
// editorial judgment.
const HOST_ALIASES = new Map([
  ['twitter.com', 'x.com'],
  ['mobile.twitter.com', 'x.com'],
]);

function applyHostAlias(host) {
  return HOST_ALIASES.get(host) || host;
}

// The routine prose does not specify an order for surviving query params.
// Sorted here so two URLs whose params differ only in order produce the
// same key. Implementation decision, flagged as an ambiguity.
function buildQueryString(searchParams, host) {
  const isYoutubeFamily = YOUTUBE_FAMILY_HOSTS.has(host);
  const kept = [];
  for (const [key, value] of searchParams.entries()) {
    if (isYoutubeFamily) {
      if (YOUTUBE_KEPT_PARAMS.has(key)) kept.push([key, value]);
    } else if (!isTrackingParam(key)) {
      kept.push([key, value]);
    }
  }
  kept.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  if (kept.length === 0) return '';
  return '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/**
 * Applies the Pass 0 URL normalization rule: lowercase scheme and host,
 * strip a leading www. from the host, fold a leading m. mobile subdomain
 * into its parent host (except for the YouTube family, see
 * stripLeadingMobile above), fold known same-entity host aliases (e.g.
 * twitter.com/mobile.twitter.com -> x.com, see HOST_ALIASES above), strip
 * a trailing slash from the path, drop tracking query params, and exclude
 * the scheme from the comparison key (http/https treated as equivalent).
 *
 * Returns:
 *   url - canonical display form, real scheme kept, everything else
 *         normalized. This is what the spec calls "the normalized form"
 *         when a row's url field is rewritten (e.g. Step 10/11 merges).
 *   key - schemeless comparison key (host + path + query only), used for
 *         lookup, dedup, and the integrity assertions.
 *
 * KNOWN SPEC GAP (not resolved here, flagged in the LEMA-9933 deliverable):
 * the routine prose claims this rule collapses "locale-path variants (e.g.
 * an /es-es/ segment)" into the same entry as their non-locale counterpart,
 * but defines no transformation that would strip or fold a locale path
 * segment. This implementation follows only the literal steps above,
 * so a /es-es/ variant of a URL does NOT produce the same key as its
 * non-locale counterpart. Inventing a locale-stripping rule here would be
 * a new editorial/technical rule (what if the /es-es/ page is a genuinely
 * distinct translated article with its own publish date?), which is out
 * of scope for a "behaviour-preserving port" per the ticket's constraints.
 *
 * Fragments (#...) are dropped entirely from both url and key. The routine
 * prose does not mention fragments; this is also an implementation
 * decision, flagged in the deliverable.
 *
 * KNOWN GAP (not resolved here, flagged on LEMA-9942): `youtu.be/<id>` and
 * `youtube.com/shorts/<id>` are not folded into `watch?v=<id>` even though
 * they carry the same video identity. Zero occurrences of either form in
 * data.json or fetch-blocklist.json as of LEMA-9942, so this was not
 * invented speculatively. Pre-approved by the CEO on LEMA-9942 to implement
 * video-ID-based path folding for these forms the first time one actually
 * appears in a candidate stream or artifact -- ship it with a test and a
 * note on that ticket, no new escalation needed.
 *
 * KNOWN GAP (not resolved here, flagged on LEMA-10275): canonical/redirect
 * aliases are not folded. A URL that 302-redirects to (or declares via
 * og:url / <link rel="canonical">) a different URL already in data.json is
 * a duplicate this function cannot see -- e.g. a Senal News piece whose
 * live URL differs from its canonical one. Following redirects or fetching
 * canonical tags would require a network call per URL, which would change
 * this module's contract from deterministic/offline to network-dependent
 * and add fetch-failure/timeout handling this tool doesn't otherwise need.
 * Recommendation (not yet decided, see LEMA-10275 comment thread): leave
 * this class of duplicate to editorial judgment
 * (`editorial_redundant_syndication`) rather than the normalizer, the same
 * way the routine already handles it today.
 */
function normalizeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const scheme = parsed.protocol.toLowerCase(); // e.g. "https:"
  const host = applyHostAlias(stripLeadingMobile(stripLeadingWww(parsed.host.toLowerCase()))); // host includes port, if any
  const path = stripTrailingSlash(parsed.pathname);
  const query = buildQueryString(parsed.searchParams, host);

  const url = `${scheme}//${host}${path}${query}`;
  const key = `${host}${path}${query}`;
  return { url, key };
}

function normalizedKey(rawUrl) {
  return normalizeUrl(rawUrl).key;
}

module.exports = { normalizeUrl, normalizedKey, isTrackingParam };
