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
// hl/lang/locale added under LEMA-11736 (CEO approval, following the
// LEMA-11733 deliverable's global locale-param proposal): live-data
// measurement against commit 99e463d found 9 ledger rows across
// instagram.com/tiktok.com/x.com carrying exactly one of these three
// params with no other observed extra query param, each a locale/language
// flag with no bearing on document identity. Blast radius re-verified at
// ship time (LEMA-11736 deliverable): 0 data.json collisions, 6
// fetch-blocklist.json same-key groups (4 auto-merged on agreeing
// disposition, 2 escalated as pre-existing disposition conflicts -- see
// that ticket for the conflict detail and remediation routing).
const TRACKING_PARAM_NAMES = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src', 'ref_url', 'ref_',
  'spm', 'si', 'cmpid', 'icid', 'srsltid', 'sessionid',
  'hl', 'lang', 'locale',
]);
const TRACKING_PARAM_PREFIX = /^utm_/i;

function isTrackingParam(name) {
  const lower = name.toLowerCase();
  return TRACKING_PARAM_PREFIX.test(lower) || TRACKING_PARAM_NAMES.has(lower);
}

// Per-host query-param ALLOW-list, checked after the existing
// www./m. strip and host-alias fold (so entries are written in
// already-canonicalized host form). A host in this table gets an
// allow-list policy: keep only the named params, drop everything else,
// including any param not yet seen for that host. A host NOT in this
// table keeps the generic deny-list default below (keep-unless-known-
// tracking-param), so an unlisted host can never silently merge two
// distinct documents -- only hosts with an explicit, evidenced entry here
// switch away from that safe default. See LEMA-11733 for the full
// per-host justification writeup and the live-data measurement each entry
// below is seeded from.
//
// YouTube (LEMA-9942, approved LEMA-9904 Item 5): `v` (video id) and `list`
// (playlist id) are the only identity-bearing params; everything else
// (locale flags like `vl`, session/share params, etc.) is dropped.
// Video/playlist IDs are case-sensitive -- this table only ever gates
// *which* params survive, never lowercases a value (see buildQueryString
// below), so that guarantee holds here. One entry only, keyed on
// 'youtube.com': m.youtube.com and youtu.be no longer reach this table
// under their own host name as of LEMA-11959 -- both are folded to
// 'youtube.com' upstream (stripLeadingMobile and HOST_ALIASES
// respectively) before buildQueryString ever looks the host up here. See
// foldYoutubeVideoPath and normalizeUrl's KNOWN GAP comment (now closed)
// below for the full fold.
//
// The following seven entries were added under LEMA-11733, generalizing
// this mechanism per the CEO ruling on LEMA-11732 (a bare `?v=3` cache-
// buster on reforma.com surviving normalization because the generic
// deny-list's default is keep, not drop). Each was verified against the
// live URLs in data.json/fetch-blocklist.json as of 2026-09-28, not
// assumed from the param name alone:
//
// - 163.com: [] -- `?f=post2020_dy_recommends` is a static recommendation-
//   widget referrer tag (single observed value); the article id is
//   already the path's last segment.
// - macprime.ch: [] -- `?s=rss-artikel` is a static referrer tag
//   (identical value on both observed rows, which have distinct path
//   slugs); the slug already carries the article's identity.
// - reforma.com: [] -- `?v=3` is a cache-buster/version param (the
//   reported case on LEMA-11732); the article id (`ar2848897`-style) is
//   already the path's last segment.
// - primevideo.com: [] -- `?tr=<territory>` is a storefront-referral tag,
//   not a content selector: the live ledger has the *same* title id
//   (`0JFCKSNHTRBNJA50K5E6QG2HHN`) under `?tr=mx`, `?tr=cl`, `?tr=pr`, and
//   with no `tr` at all, all four already independently classified
//   `editorial_listing_or_database` -- proof the param never gated
//   distinct content. (`/it/detail/...`, a different locale *path*, is
//   unaffected -- this entry only touches the query string.)
// - issuu.com: [] -- `?fr=<hash>` is an opaque partner-referral token; the
//   document slug is already the full path.
// - diarioimagen.net: ['p'] -- WordPress `?p=<id>` is the *only* identity
//   the URL carries (bare `/?p=736623`, no other path segment), so unlike
//   the entries above this is a param that must survive.
// - es.hollywoodreporter.com: ['p'] -- same WordPress `?p=<id>` shape and
//   same reasoning as diarioimagen.net above.
// - webwire.com: ['aId'] -- `ViewPressRel.asp?aId=<id>` carries the only
//   identity in the query string; the path alone is shared by every
//   WebWire release.
// - movistarplus.es: ['id'] -- `?tipo=E&id=<id>` on a bare `/ficha` path;
//   `id` is the catalog identity (kept), `tipo` is a type-classifier flag
//   that duplicates no distinguishing information Movistar's own catalog
//   ids don't already carry (dropped).
// - filmaffinity.com: ['movie-id'] -- `?movie-id=<id>` on bare
//   `/movie-awards.php` / `/pro-reviews.php` paths with no id elsewhere in
//   the URL.
// - thetvdb.com: ['page'] -- `?page=<n>` on a paginated company-listing
//   page (`/companies/apple-tv-plus`); unlike the referral tags above,
//   different page numbers genuinely show different content, so this is
//   an identity param, not a tracking one.
// - tv.apple.com: [] (LEMA-11736; was ['l'] under LEMA-11733) -- drops
//   `showId`/`targetId`/`targetType` for the reason already established
//   under LEMA-11733 (every occurrence carries this dataset's own fixed
//   show id, `umc.cmc.73wmdmkfpta5ul1vbwckmme39`, echoed back on episode/
//   clip pages whose own path already has a distinct id, so they never
//   disambiguate two different documents), and now also drops `l`. The
//   CEO resolved the `l` deferral on LEMA-11736 rather than extending it:
//   scoped to this host specifically (not the global proposal below,
//   which was evidence-gathered separately and excluded `l` for being too
//   generic to trust globally), because the `umc.cmc.*` id in the path is
//   already the identity, `/us/`, `/gt/`, `/fi/` etc. already carry locale
//   in the *path*, and every observed `l` value (`es`, `en`, `es-MX`) is a
//   language tag -- proven by a same-path, same-show-id, two-row merge
//   group (`.../us/show/las-azules/umc.cmc.73wmdmkfpta5ul1vbwckmme39` bare
//   + `?l=es`) that existed only because `l` was still being kept.
//
// The following three hosts had their locale/language param dropped
// globally instead of per-host (LEMA-11736, see the TRACKING_PARAM_NAMES
// comment above for the evidence and blast-radius summary), so they do
// NOT get their own HOST_PARAM_ALLOWLIST entry: facebook.com (`?locale=`),
// instagram.com (`?hl=`), tiktok.com (`?lang=`), twitter.com/x.com
// (`?lang=`, alias-folded to x.com by HOST_ALIASES above). Each host's
// only observed extra param was exactly one of hl/lang/locale with no
// other extra query param -- the case the global rule was written for.
//
// PROVISIONAL ENTRIES (LEMA-11736): an entry may be marked
// `provisional: true` when it keeps a param whose identity-vs-tracking
// status is a known, explicitly-not-yet-resolved judgment call (what
// tv.apple.com's `l` was between LEMA-11733 and LEMA-11736) rather than a
// closed decision. queryVariantPairs (tools/lib/audit.js) excludes a host
// from its advisory scan specifically because "a listed host has already
// had the judgment call made" -- a rationale that only applies to
// non-provisional entries. isDecidedAllowlistHost() below is the single
// place that distinction lives, so the advisory only ever loses visibility
// into a host once its allow-list entry stops being provisional. No entry
// currently in this table is provisional (tv.apple.com's only prior
// provisional param, `l`, was resolved above); the mechanism exists so the
// next deferred-param host doesn't disappear from the advisory the same
// way tv.apple.com did.
const HOST_PARAM_ALLOWLIST = new Map([
  ['youtube.com', { keep: ['v', 'list'] }],
  ['163.com', { keep: [] }],
  ['macprime.ch', { keep: [] }],
  ['reforma.com', { keep: [] }],
  ['primevideo.com', { keep: [] }],
  ['issuu.com', { keep: [] }],
  ['diarioimagen.net', { keep: ['p'] }],
  ['es.hollywoodreporter.com', { keep: ['p'] }],
  ['webwire.com', { keep: ['aId'] }],
  ['movistarplus.es', { keep: ['id'] }],
  ['filmaffinity.com', { keep: ['movie-id'] }],
  ['thetvdb.com', { keep: ['page'] }],
  ['tv.apple.com', { keep: [] }],
]);

// True only for a host with an allow-list entry that is NOT provisional --
// i.e. the judgment call this table records has actually been made. Used
// by tools/lib/audit.js's queryVariantPairs check to decide which hosts to
// skip; see the PROVISIONAL ENTRIES comment above for why a provisional
// entry must not be skipped.
function isDecidedAllowlistHost(host) {
  const entry = HOST_PARAM_ALLOWLIST.get(host);
  return Boolean(entry) && entry.provisional !== true;
}

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
// m.youtube.com was exempted from this fold between LEMA-9942 and
// LEMA-11959 (kept its own distinct key identity, deliberately). That
// exemption is now removed: LEMA-11959 found a live m.youtube.com candidate
// that the exemption prevented the Pass 0 dedup gate from matching against
// an existing youtube.com row, and the CEO ruling on that ticket folded
// m.youtube.com into the generic m. strip as part of shipping the
// LEMA-9942 video-ID fold (foldYoutubeVideoPath below), rather than
// special-casing the host. See normalizeUrl's updated KNOWN GAP comment.
function stripLeadingMobile(host) {
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
// pre-emptively rather than waiting for a real occurrence.
//
// This is a distinct, static, host-level alias and is NOT the same as the
// open canonical/redirect gap (LEMA-10275) documented below on
// normalizeUrl: that gap is about per-page redirects/canonical tags that
// require a network call to discover. twitter.com -> x.com is a
// universally-known, permanent product-level rename that can be hardcoded
// with no network dependency, so it is fixed here rather than left to
// editorial judgment.
//
// youtu.be -> youtube.com: youtu.be exists solely to redirect to
// youtube.com/watch?v=<id> -- there is no other page type on that host --
// so this is the same static, product-level, no-network-call rename as
// twitter.com -> x.com. Checked against the pre-alias host inside
// foldYoutubeVideoPath (below) to pull the video id out of the path before
// this alias is applied; by the time applyHostAlias runs here, that id has
// already been captured. LEMA-9942/LEMA-11959.
const HOST_ALIASES = new Map([
  ['twitter.com', 'x.com'],
  ['mobile.twitter.com', 'x.com'],
  ['youtu.be', 'youtube.com'],
]);

function applyHostAlias(host) {
  return HOST_ALIASES.get(host) || host;
}

// Per-host case-insensitive PATH folding. Checked after host alias
// resolution (so entries are keyed on the canonicalized host) and applied
// to the path only -- never the host (already lowercased unconditionally
// above) and never query-param values (case-sensitive IDs, e.g. YouTube/
// Instagram/Facebook/Threads, must never collide -- see the measurement
// below). This is an explicit per-host opt-in, not a global path
// case-fold: LEMA-11825 measured all 1514 URLs in data.json +
// fetch-blocklist.json (0 unparseable) and found case-significant
// characters in the normalized key on 39 hosts, led by youtube.com (166
// keys), instagram.com (35), facebook.com (28), en.wikipedia.org (28),
// x.com (22), broadwayworld.com (13), threads.com (9) -- almost entirely
// short IDs where case is load-bearing. Folding globally would silently
// merge genuinely distinct documents, a worse failure than the duplicate-
// row cost this table exists to prevent. Only a host with an explicit,
// evidence-backed entry here switches away from the safe (case-preserving)
// default, same posture as HOST_PARAM_ALLOWLIST/HOST_ALIASES above.
//
// - upi.com: UPI's own CMS serves the identical article at both
//   `/entertainment_news/tv/...` and `/Entertainment_News/TV/...` -- same
//   numeric post id (8811784644272), same outlet, same Jul 21 2026 trailer
//   story, both forms confirmed live (LEMA-11824/LEMA-11823). 1 key in the
//   live corpus carries uppercase in this path as of LEMA-11825.
// - x.com: X handles are case-insensitive by X's own product rule
//   (x.com/AppleTV and x.com/appletv resolve to the same account) --
//   case never carries document identity on this host's handle/status
//   paths. The LEMA-11824 ruling cited two live merge groups
//   (x.com/AppleTV||x.com/appletv, x.com/WomenInBlueDoc||
//   x.com/womeninbluedoc) as evidence; re-measured live at ship time
//   (LEMA-11825) and **neither group exists in the current corpus** --
//   `x.com/appletv` (bare handle, from an already-stripped `?lang=en`) and
//   `x.com/WomenInBlueDoc` each appear exactly once, with no case-variant
//   sibling. Shipped anyway per the ruling's own stated authority (a
//   mechanical, product-level fact about how X resolves handles, not
//   conditioned on a collision existing today) but the discrepancy from
//   the ruling-time measurement is reported on LEMA-11825 rather than
//   silently reconciled, per that ticket's explicit instruction.
const HOST_CASE_INSENSITIVE_PATH = new Set(['upi.com', 'x.com']);

function foldPathCase(host, path) {
  return HOST_CASE_INSENSITIVE_PATH.has(host) ? path.toLowerCase() : path;
}

// Facebook /<page>/<type>/<slug>/<id> -> /<page>/<type>/<id> path fold.
// LEMA-10602: Facebook generates the <slug> segment from the post's own
// body text -- it carries no identity of its own, so a slug-form URL and
// its short-ID-only equivalent are the same tracked post. Checked against
// the already-alias-resolved host (so www./m. variants of facebook.com
// are covered too, since those fold to plain "facebook.com" upstream of
// this call) and against the already-trailing-slash-stripped path.
//
// <type> must be exactly "videos", "posts", or "reel" -- this is what
// keeps the fold from misfiring on /groups/<gid>/posts/<id>, where the
// segment in the <type> position is a numeric group id, not one of these
// literal words. A bare /<page>/<type>/<id> (no slug present) matches the
// same pattern with an empty slug capture and reconstructs to an
// identical path, so it is a no-op for URLs already in the folded form.
//
// Deliberately keeps <page>: folding page identity too (numeric page-ID
// vs. vanity page-name, or /groups/<gid>/... itself) is an out-of-scope
// residual gap, see the KNOWN GAP comment on normalizeUrl below.
const FACEBOOK_SLUG_ID_PATH = /^\/([^/]+)\/(videos|posts|reel)\/(?:[^/]+\/)?(\d+)$/;

function foldFacebookPath(host, path) {
  if (host !== 'facebook.com') return path;
  const match = FACEBOOK_SLUG_ID_PATH.exec(path);
  if (!match) return path;
  const [, page, type, id] = match;
  return `/${page}/${type}/${id}`;
}

// YouTube video-ID path fold (LEMA-9942 pre-approval, exercised on
// LEMA-11959). `youtu.be/<id>` and `youtube.com/shorts/<id>` carry the same
// video identity as `youtube.com/watch?v=<id>` -- same "same document,
// different address" principle as foldFacebookPath/foldAmpPath, and the
// canonical form is mechanically reconstructable from the given path alone
// (no network call needed), so this folds the real path AND injects the
// extracted id as the `v` query param, rather than only flagging the shape.
//
// Checked against the PRE-alias host (i.e. before youtu.be -> youtube.com
// in HOST_ALIASES runs), because the two source hosts need different path
// handling:
//
// - youtu.be: every non-root path on this host IS a video id -- the host
//   exists solely to redirect to youtube.com/watch?v=<id>, there is no
//   other page type -- so a single-segment path is unconditionally treated
//   as the id. This must NOT be generalized to youtube.com itself: a bare
//   youtube.com/<single-segment> path is frequently a channel vanity name
//   (youtube.com/@channel, youtube.com/c/Name), not a video id.
// - youtube.com: only the literal /shorts/<id> path shape is folded.
//   youtube.com/watch?v=<id> is already the canonical form and passes
//   through unchanged (no match), and every other youtube.com path
//   (channel pages, /playlist, etc.) is deliberately left alone.
//
// This also subsumes the m.youtube.com gap reported on LEMA-11959: now
// that m.youtube.com is no longer exempted from the generic m. strip (see
// stripLeadingMobile above), m.youtube.com/watch?v=<id> already folds to
// host 'youtube.com' with path '/watch' before this function is even
// reached, for free -- and if an m.youtube.com/shorts/<id> URL ever
// appears, the generic m. strip resolves the host to 'youtube.com' first,
// so it hits the youtube.com branch below with no extra code.
//
// Returns the (possibly folded) path and the extracted video id, or `null`
// for `videoId` when no fold applies (path returned unchanged).
function foldYoutubeVideoPath(preAliasHost, path) {
  if (preAliasHost === 'youtu.be') {
    const id = path.slice(1);
    if (id && !id.includes('/')) return { path: '/watch', videoId: id };
    return { path, videoId: null };
  }
  if (preAliasHost === 'youtube.com') {
    const match = /^\/shorts\/([^/]+)$/.exec(path);
    if (match) return { path: '/watch', videoId: match[1] };
  }
  return { path, videoId: null };
}

// AMP second-address fold (LEMA-11953). An AMP-served copy of a page is a
// second address for a document already tracked under its non-AMP URL, the
// same "same document, different address" principle as the www./m. strip
// and foldFacebookPath above -- not the `?p=<id>` gap (LEMA-10275/
// LEMA-11889), where the canonical address is genuinely unknown without a
// network call. Here the canonical path IS mechanically reconstructable
// from the AMP path alone, so this folds the real path (both the display
// url and the comparison key), rather than only flagging the shape.
//
// Three of the four shapes found in this corpus are generic, standards-
// driven AMP URL conventions (Google's AMP markup popularized all three
// across the web, not any one outlet's CMS quirk), so they're folded for
// every host:
//   1. trailing /amp or /amp/ path segment (e.g. reviewnation.net/<slug>/amp/)
//   3. leading /amp/ path prefix right after the host (e.g. eltiempo.com/amp/cultura/...)
//   4. .amp.html extension infix (e.g. theweek.in/<path>/<slug>.amp.html)
// Every pattern below is anchored to the specific marker position (end of
// path / start of path / file extension), never a bare substring match --
// `de-campeones` (contains "amp" mid-segment) and `camp-rock-3` (same) do
// NOT match any of these and must not be touched; both are pinned by a
// regression test.
//
// Shape 2 -- bollywoodshaadis.com's /amp-articles/<slug> vs /articles/<slug>
// -- is different in kind: it's a path-segment RENAME, not a strip, and is
// this one outlet's own CMS routing choice rather than a web-wide AMP
// convention (unlike shapes 1/3/4, no second outlet in this corpus or prior
// tickets uses "amp-articles" as a URL marker). Generalizing "strip any
// amp-prefixed segment" would misfire the day a host's real, non-AMP
// section is itself named starting with "amp-". The canonical form IS
// known for this specific, evidenced host though (the live sibling row
// proves it), so this still gets a real fold rather than an advisory flag
// -- just scoped to the one evidenced host, same posture as
// HOST_PARAM_ALLOWLIST/FACEBOOK_SLUG_ID_PATH being host-scoped tables
// rather than global rules.
const AMP_PATH_SEGMENT_RENAME_HOSTS = new Map([
  ['bollywoodshaadis.com', { from: /^\/amp-articles\//, to: '/articles/' }],
]);

function foldAmpPath(host, path) {
  // Shape 3: leading /amp/ path prefix.
  let next = path.replace(/^\/amp(\/.+)$/, '$1');
  // Shape 1: trailing /amp or /amp/ path segment (trailing slash is already
  // gone by the time this runs -- see stripTrailingSlash above -- so only
  // the bare-/amp suffix needs matching here). Requires at least one path
  // segment survives, so a bare "/amp" path itself is left alone rather
  // than folded to an empty path.
  next = next.replace(/^(\/.+)\/amp$/, '$1');
  // Shape 4: .amp.html extension infix.
  next = next.replace(/\.amp\.html$/, '.html');
  // Shape 2: host-scoped path-segment rename.
  const rename = AMP_PATH_SEGMENT_RENAME_HOSTS.get(host);
  if (rename) next = next.replace(rename.from, rename.to);
  return next;
}

// The routine prose does not specify an order for surviving query params.
// Sorted here so two URLs whose params differ only in order produce the
// same key. Implementation decision, flagged as an ambiguity.
function buildQueryString(searchParams, host) {
  const allowEntry = HOST_PARAM_ALLOWLIST.get(host);
  const kept = [];
  for (const [key, value] of searchParams.entries()) {
    if (allowEntry) {
      if (allowEntry.keep.includes(key)) kept.push([key, value]);
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
 * into its parent host (see stripLeadingMobile above -- no host is exempt,
 * including m.youtube.com as of LEMA-11959), fold known same-entity host
 * aliases (e.g. twitter.com/mobile.twitter.com -> x.com, youtu.be ->
 * youtube.com, see HOST_ALIASES above), strip a trailing slash from the
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
 * This is a DIFFERENT class of gap than the path case-sensitivity question
 * below -- that one is a mechanical same-document fact with no editorial
 * component, this one is blocked on an unresolved editorial question. CEO
 * ruling on LEMA-11824/LEMA-11825 declined to bundle the two.
 *
 * PATH CASE-SENSITIVITY (LEMA-11825, CEO ruling on LEMA-11824): path
 * segments are case-PRESERVING by default (see "host and scheme are
 * lowercased, path case is preserved" above) -- this is deliberate, not an
 * oversight. A per-host opt-in, HOST_CASE_INSENSITIVE_PATH above, folds the
 * path to lowercase for two evidence-backed hosts (upi.com, x.com) whose
 * servers are demonstrably case-insensitive. Every other host, including
 * the short-ID hosts (youtube.com/instagram.com/facebook.com/
 * en.wikipedia.org/threads.com/broadwayworld.com and 33 more) where case is
 * load-bearing, keeps today's case-preserving behaviour and is NOT folded
 * by this change. See HOST_CASE_INSENSITIVE_PATH's own comment for the
 * full per-host evidence and the live-measurement methodology.
 *
 * Fragments (#...) are dropped entirely from both url and key. The routine
 * prose does not mention fragments; this is also an implementation
 * decision, flagged in the deliverable.
 *
 * YOUTUBE VIDEO-ID FOLD (LEMA-9942 pre-approval, shipped on LEMA-11959):
 * `youtu.be/<id>` and `youtube.com/shorts/<id>` fold into `watch?v=<id>`,
 * since they carry the same video identity. This was left unimplemented
 * between LEMA-9942 and LEMA-11959 (zero occurrences of either form in
 * data.json/fetch-blocklist.json as of LEMA-9942, so it was not invented
 * speculatively) under a standing CEO pre-approval to ship it, with a test,
 * the first time one of these forms actually appeared in a candidate stream
 * or artifact. LEMA-11959 found both triggers at once: a live
 * `youtube.com/shorts/<id>` fetch-blocklist.json row (added under
 * LEMA-11250, predating this ticket) and a `m.youtube.com` candidate
 * surfaced by the Media Sweep routine. The m.youtube.com case is folded by
 * removing its stripLeadingMobile exemption (see that function's comment)
 * rather than by a separate carve-out here, per the CEO ruling on
 * LEMA-11959: a video-ID fold is a single host-family policy that covers
 * watch?v=, youtu.be/, shorts/, and m. forms for every past and future URL,
 * where a one-host exemption tweak would not. See foldYoutubeVideoPath
 * above for the implementation.
 *
 * AMP PATH FOLD (LEMA-11953): a trailing /amp or /amp/ path segment, a
 * leading /amp/ path prefix, and a .amp.html extension infix are folded to
 * their non-AMP canonical path for every host; bollywoodshaadis.com's own
 * /amp-articles/ -> /articles/ CMS rename additionally folds, scoped to
 * that one evidenced host. See foldAmpPath above for the implementation,
 * the anchoring that keeps `de-campeones`/`camp-rock-3` untouched, and the
 * reasoning for why shape 2 is host-scoped while the other three are not.
 *
 * FACEBOOK PATH FOLD (LEMA-10602): facebook.com URLs of the form
 * /<page>/<type>/<slug>/<id> (type is videos, posts, or reel) fold to
 * /<page>/<type>/<id>, dropping the body-text slug segment. See
 * foldFacebookPath above for the implementation and rationale.
 *
 * KNOWN GAP (not resolved here, flagged on LEMA-10602): the fold above
 * keeps the <page> segment, so a numeric Facebook page ID
 * (facebook.com/100064912081062/posts/<id>) and the same page's vanity
 * name (facebook.com/<vanity>/posts/<id>) still produce different keys.
 * No occurrence of the *same* post under both page-identity forms has
 * been found, so folding page identity too was not invented speculatively
 * -- same "wait for a real occurrence" posture the YouTube video-ID fold
 * above was under before LEMA-11959 closed it.
 * facebook.com/groups/<gid>/posts/<id> is also explicitly NOT folded by
 * this rule (the <type> position there is a numeric group id, not one of
 * videos/posts/reel), and is pinned by a test.
 *
 * KNOWN GAP (not resolved here, flagged on LEMA-10275): canonical/redirect
 * aliases are not folded. A URL that 302-redirects to (or declares via
 * og:url / <link rel="canonical">) a different URL already in data.json is
 * a duplicate this function cannot see -- e.g. a Senal News piece whose
 * live URL differs from its canonical one, or a WordPress `?p=<id>` legacy
 * permalink that 301-redirects to the same post's slug URL (LEMA-11825,
 * LEMA-11827, LEMA-11862, LEMA-11889 -- four different outlets, same gap,
 * re-confirmed on LEMA-11889 as the identical class rather than a new one).
 * Following redirects or fetching canonical tags would require a network
 * call per URL, which would change this module's contract from
 * deterministic/offline to network-dependent and add fetch-failure/timeout
 * handling this tool doesn't otherwise need. Recommendation (not yet
 * decided, see LEMA-10275 comment thread): leave this class of duplicate to
 * editorial judgment (`editorial_redundant_syndication`) rather than the
 * normalizer, the same way the routine already handles it today.
 * `looksLikeUnresolvedIdPermalink` below gives the WordPress `?p=<id>`
 * instance of this gap a cheap, offline, host-agnostic early-warning flag
 * (verify before including), but does not close the gap itself.
 */
function normalizeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const scheme = parsed.protocol.toLowerCase(); // e.g. "https:"
  // host includes port, if any. Captured pre-alias (and pre-video-path-fold)
  // because foldYoutubeVideoPath needs to distinguish youtu.be from
  // youtube.com, which HOST_ALIASES would otherwise already have merged.
  const preAliasHost = stripLeadingMobile(stripLeadingWww(parsed.host.toLowerCase()));
  const { path: videoFoldedPath, videoId } = foldYoutubeVideoPath(
    preAliasHost,
    stripTrailingSlash(parsed.pathname)
  );
  const host = applyHostAlias(preAliasHost);
  const path = foldAmpPath(host, foldFacebookPath(host, videoFoldedPath));
  // A youtu.be/shorts fold extracts the video id from the PATH, not the
  // query string, so it has to be injected into the query here rather than
  // simply surviving buildQueryString's existing param filter below. Never
  // overwrites a real `v` (youtu.be/youtube.com/shorts paths never carry
  // one of their own).
  const searchParams = videoId === null
    ? parsed.searchParams
    : new URLSearchParams(parsed.searchParams);
  if (videoId !== null) searchParams.set('v', videoId);
  const query = buildQueryString(searchParams, host);

  // Path case-folding (LEMA-11825, HOST_CASE_INSENSITIVE_PATH above) is
  // applied to the COMPARISON key only, never to the display url -- same
  // posture as query-param values never being lowercased (see
  // buildQueryString/HOST_PARAM_ALLOWLIST comment): case is a real part of
  // how the document is actually addressed on the web, even on a host
  // whose server happens to treat two cases as the same document, so a
  // merge that rewrites a stored url (mergeLedgerGroup/mergeDatasetGroup)
  // must not silently lowercase someone's real display handle.
  const keyPath = foldPathCase(host, path);

  const url = `${scheme}//${host}${path}${query}`;
  const key = `${host}${keyPath}${query}`;
  return { url, key };
}

function normalizedKey(rawUrl) {
  return normalizeUrl(rawUrl).key;
}

// Offline, host-agnostic SHAPE heuristic for a WordPress-style bare "ID
// permalink" (root path, a single `p=<digits>` query param, e.g.
// `https://appleworld.today/?p=129727`). WordPress's default permalink
// structure serves every post at `/?p=<id>` before a site switches to
// pretty (slug) permalinks, and 301-redirects the old `?p=<id>` form to
// the slug URL forever after -- so this shape is frequently a *second*
// address for a document already tracked under its slug URL. Four
// different outlets have surfaced this exact shape as a sweep candidate
// so far (LEMA-11825, LEMA-11827, LEMA-11862, LEMA-11889/appleworld.today),
// each one caught only because a human happened to run `curl -L` by hand.
//
// This is NOT redirect resolution (see the KNOWN GAP comment on
// normalizeUrl above re: canonical/redirect aliases, LEMA-10275 -- putting
// a network call in this module was already evaluated and declined there
// for the Senal News case, and the appleworld.today occurrence is the same
// gap class, not a new one). It is also NOT a per-URL alias map -- a map
// from a specific numeric id to its slug would need a fresh, manually-
// discovered entry for every single article on every outlet that uses
// this permalink form, which is the same recurring manual-discovery labor
// as ledgering it by hand, just moved to a different file (LEMA-11889
// evaluated and rejected this option explicitly: it does not generalize
// the way a host-level policy does).
//
// What this DOES do: flag the URL *shape* itself, which generalizes
// across every host and every future id with zero new config -- a true
// structural fix for "don't let anyone forget to check," even though the
// actual canonical target still has to be resolved by a human (or a
// future network-aware tool) before the candidate can be safely included
// or excluded. A true result never changes `disposition` and is never by
// itself grounds to exclude a URL -- it is a prompt to manually verify
// (`curl -L`) before treating the candidate as new, nothing more.
//
// Hosts with an explicit HOST_PARAM_ALLOWLIST entry that KEEPS `p`
// (diarioimagen.net, es.hollywoodreporter.com) are excluded on purpose:
// those two were specifically verified (see the allow-list comment above)
// to have no slug URL at all, so `?p=<id>` IS their real, permanent
// identity. Flagging them here would be a false positive on a host whose
// shape has already been investigated and settled.
function looksLikeUnresolvedIdPermalink(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = applyHostAlias(stripLeadingMobile(stripLeadingWww(parsed.host.toLowerCase())));
  const allowEntry = HOST_PARAM_ALLOWLIST.get(host);
  if (allowEntry && allowEntry.keep.includes('p')) return false;

  const path = stripTrailingSlash(parsed.pathname);
  if (path !== '' && path !== '/') return false;

  const survivors = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (isTrackingParam(key)) continue;
    survivors.push([key, value]);
  }
  if (survivors.length !== 1) return false;
  const [key, value] = survivors[0];
  return key === 'p' && /^\d+$/.test(value);
}

module.exports = {
  normalizeUrl,
  normalizedKey,
  isTrackingParam,
  HOST_PARAM_ALLOWLIST,
  isDecidedAllowlistHost,
  looksLikeUnresolvedIdPermalink,
};
