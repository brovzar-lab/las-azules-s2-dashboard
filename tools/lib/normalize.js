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
 * strip a leading www. from the host, strip a trailing slash from the
 * path, drop tracking query params, and exclude the scheme from the
 * comparison key (http/https treated as equivalent).
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
 */
function normalizeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const scheme = parsed.protocol.toLowerCase(); // e.g. "https:"
  const host = stripLeadingWww(parsed.host.toLowerCase()); // host includes port, if any
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
