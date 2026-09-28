# sweep-integrity

Deterministic controls from the Media Sweep routine (`b372cbc1-68bc-4322-af74-aa1b013c99b3`),
ported from prose into code, per [LEMA-9933](/LEMA/issues/LEMA-9933).
No dependencies beyond Node's standard library. Requires Node 18+ (uses `node:test`, `node --test`).

Run the tests: `npm test` (equivalent to `node --test 'tools/test/**/*.test.js'`).

## Why this exists

The routine's mechanical controls (URL normalization, fetch-blocklist lookup, the Step 10 /
Step 11 post-write integrity assertions, and the evidence-line counts) are pure functions of
two JSON files plus a candidate list. There is no editorial judgment in any of them. Asking an
LLM agent to re-derive them from prose every 2 hours is what kept failing; a tool that computes
them cannot be skipped for a subset of candidates or misreport a count. See the routine
description and the LEMA-9933 ticket for the full incident history.

The judgment calls (escalating a disagreeing duplicate group, the search-existing-issues dedup
check, story-level dedup tagging, editorial rule classification) stay with the agent. This tool
never does any of that.

## Commands

### `normalize <url>`

Prints the canonical form and comparison key for a single URL.

```
$ node tools/sweep-integrity.js normalize "HTTP://WWW.Example.com/Article/Page/?utm_source=x&id=9"
{
  "input": "HTTP://WWW.Example.com/Article/Page/?utm_source=x&id=9",
  "url": "http://example.com/Article/Page?id=9",
  "key": "example.com/Article/Page?id=9"
}
```

`url` is the canonical display form (real scheme kept, everything else normalized). `key` is
the schemeless comparison key used for lookup, dedup, and both integrity assertions.

### `lookup <candidates.json|url> [--fetch-blocklist path] [--data path] [--json] [--strict]`

The positional argument is either a candidates file or a single bare URL (LEMA-10596):

- `candidates.json` is a JSON array of URL strings, or of `{"url": "..."}` objects.
- a single `http(s)://...` argument is treated as a synthesized one-element candidate list,
  for callers (the Media Sweep routine's Rule C pre-write check, Step 4a) that have exactly
  one URL in hand and no candidates file to put it in. Detection is by parsing the argument
  as a URL, so a relative or malformed path is never misread as one.

Builds the Pass 0 lookup dict from `fetch-blocklist.json` and prints one line per candidate
with its disposition (`permanentSkip`, `active-cooldown`, `expired-cooldown-retry`, or
`not-found`). Add `--json` for structured output.

**Every run also prints a fingerprint of both input files to stderr** (LEMA-10448):
`rows=<N> sha256=<hash>` for the ledger, `count=<N> sha256=<hash>` for the candidates file.
stdout's line-per-candidate contract is unchanged. This exists so two runs someone claims were
"against the same unmodified files" can be checked mechanically instead of taken on faith --
diff the stderr lines. This was the exact gap that made the LEMA-10447 nondeterminism report
undiagnosable after the fact: its `candidates.json` input wasn't preserved, so nobody could
confirm the two runs actually read byte-identical files. For the single-URL form, this line
fingerprints the synthesized one-element list instead of a file.

Add `--strict` to fail loudly (non-zero exit, no stdout result lines, a clear stderr message)
instead of silently producing output if the ledger or candidates file is present but empty or
malformed (e.g. `{"entries": []}` from a torn/short read). Without `--strict`, those inputs are
still handled the same as before (an empty ledger just means everything looks up as
`not-found`) -- the guard is opt-in so it can't change any existing caller's behavior.

**A missing or unparseable candidates/ledger/`data.json` file is a clean usage error, not a
crash (LEMA-10597).** Before this, a non-URL positional argument that didn't resolve to a real
file (e.g. `normalize`'s schemeless `key` field, a mistyped path, or a URL pasted without its
scheme) went straight into `readFileSync` and escaped as an uncaught ENOENT/`SyntaxError` --
stack trace on stderr, exit **1**, before a single line of output. Now it prints one line
naming the path and exits **2** (this tool's existing usage-error code, distinct from `1`,
which is no longer reachable for these files, and `3`, the `--strict` guard). The candidates
argument's message adds a hint, since it's the one call site where a bare host/path string is
plausibly a URL missing its scheme:

```
$ node tools/sweep-integrity.js lookup "tomsguide.com/entertainment/apple-tv-plus/how-to-watch-women-in-blue-online-and-from-anywhere-now" --strict
Error: candidates file not found: tomsguide.com/entertainment/apple-tv-plus/how-to-watch-women-in-blue-online-and-from-anywhere-now (if you meant a URL, include the https:// scheme)
EXIT=2
```

A malformed (non-JSON) file gets the same clean-exit-2 treatment with a "not valid JSON"
message instead. This matters beyond tidiness: an ENOENT crash never reaches the `--strict`
check, so it can't print the `--strict guard failed` block the Media Sweep routine's
STOP-and-escalate path (LEMA-10593) requires quoting verbatim -- this closes that gap by
converting the crash into a normal, quotable failure.

```
$ node tools/sweep-integrity.js lookup candidates.json
https://www.example.com/news/story  permanentSkip skipReason=editorial_redundant_syndication
https://example.com/news/other      active-cooldown cooldownUntil=2026-10-03T00:15:00Z failCount=3
https://example.com/news/new        not-found
```

### `assert-integrity [--target ledger|data|both] [--fix] [--json]`

Recomputes normalized keys across `fetch-blocklist.json` (Step 10) and/or `data.json`
(Step 11), reports `rows`, `distinct normalized URLs`, and `duplicate groups`, and exits
non-zero if any duplicate group remains after the call (whether that's because `--fix` wasn't
passed, or because a group disagrees and can't be auto-merged).

Read-only by default. With `--fix`, duplicate groups that agree on disposition (ledger) or on
`date`/`ts`/`outlet`/`lang`/`market`/`type` (data.json) are merged per the Step 10 / Step 11
field rules, the result is written back to the file it was read from, and every merge is
printed (`before -> after`). Groups that disagree are **never** merged by this tool; they are
reported so the agent can run the Step 10/11 escalation path (including the
search-existing-issues dedup check), which is a judgment call this tool does not make.

```
$ node tools/sweep-integrity.js assert-integrity --fix
- Ledger integrity: rows=135, distinct normalized URLs=135, duplicate groups=0
- data.json integrity: rows=667, distinct normalized URLs=667, duplicate groups=0
```

If a duplicate group exists, each line below the summary is one of:

- `auto-merged group [...]` (only after `--fix`)
- `pending-merge group [...]` (agrees, but `--fix` wasn't passed, nothing written yet)
- `escalated group [...]` (disagrees, this tool will never merge it)

This tool never commits to git or calls the GitHub API. Committing the result stays with the
sweep routine (its existing steps 8/9).

### `evidence --candidates <candidates.json> [--fetch-blocklist path] [--data path] [--fix]`

Emits the `Ledger check`, `Ledger integrity`, and `data.json integrity` lines in the format the
routine's "Deliverable evidence template" specifies, computed from the actual data (not
self-reported). `hits` on the `Ledger check` line is the count of candidates whose lookup
returned anything other than `not-found`.

```
$ node tools/sweep-integrity.js evidence --candidates candidates.json
- Ledger check: candidates surfaced=6, ledger-checked=6, hits=2 (permanentSkip=1, active cooldown=0, expired cooldown retried=1)
- Ledger integrity: rows=135, distinct normalized URLs=135, duplicate groups=0
- data.json integrity: rows=667, distinct normalized URLs=667, duplicate groups=0
```

When a duplicate group is escalated (disagrees), the printed line includes a
`[FILL IN by agent: ...]` placeholder for the `Step 10/11 escalation: <...>` disposition string,
since which of "opened / re-observed / suppressed" applies depends on searching existing
issues, which this tool deliberately does not do.

### `audit [--fetch-blocklist path] [--data path] [--repo path] [--json]`

Re-checks every **existing** `data.json` row against the ledger's exclusion rules
([LEMA-10625](/LEMA/issues/LEMA-10625)). Every other command in this tool only looks at
candidates about to be fetched; nothing re-examines a row once it has already landed in
`data.json`, and Step 4a2's pre-fetch dedup gate (LEMA-10591/10592) means a URL already in
`data.json` is never re-fetched either, so a row admitted before a rule hardened is
structurally invisible to every subsequent sweep. Two `tv.apple.com` locale show-page rows
survived 18 days and two cleanup waves this way -- see [LEMA-10623](/LEMA/issues/LEMA-10623).

Read-only, report-only: never edits `data.json` or `fetch-blocklist.json`, never makes an
editorial call. Same division of labour as the rest of this kit -- mechanics here, judgment
with the agent. Five checks:

1. **`ledgerOverlap` (assertable).** `data.json` rows whose normalized key matches a
   `permanentSkip` ledger row, **excluding** `skipReason=editorial_redundant_syndication` (see
   `ledgerOverlapAdvisory` below). A row cannot legitimately be both live coverage and a
   permanent exclusion for any other skip reason -- this is the only one of the four checks
   that affects the exit code.
2. **`ledgerOverlapAdvisory` (advisory, never gates).** The `editorial_redundant_syndication`
   rows carved out of check 1 ([LEMA-10634](/LEMA/issues/LEMA-10634)). This is expected overlap,
   not a conflict: `redundant_syndication` means "this is a second address (an AMP page, an `m.`
   mobile subdomain, a `?ref_=`-tagged reprint, etc.) for a document that IS in `data.json`",
   and `normalize` folding that second address onto the same key as its live canonical row is
   the category working as designed. Asserting on it would make `ledgerOverlap` permanently
   red on a clean tree, since a genuine dedup pair like this can never be "fixed" by editing
   data. (A `redundant_syndication` row whose key matches *nothing* live would be the actual
   anomaly -- it would mean a second address was skipped for a document never kept -- but that
   is not currently checked here.)
3. **`surfaceFamilyMatch` (advisory, high signal).** `data.json` rows whose host+path shape
   match a family the ledger has already `permanentSkip`ped (`editorial_listing_or_database`
   only -- see below) at other locales/paths. Families are *derived from the live ledger*, not
   hard-coded, so this stays current as new locales get ledgered. A "family" is a `(host,
   keyword)` pair: a literal path segment (not a locale code, not an opaque id) shared by at
   least 2 `editorial_listing_or_database` rows on the same host. Restricted to that one
   skipReason deliberately: other reasons (`editorial_undateable`,
   `editorial_off_topic_false_positive`, etc.) are per-article judgment calls that can happen to
   share a path keyword with genuine coverage elsewhere on the same host -- e.g. several
   `imdb.com/news/...` ledger rows exist for unrelated individual reasons, while `data.json`
   also carries 12+ legitimate `imdb.com/news/...` rows. Only Rule F
   (`editorial_listing_or_database`, "no written content, pure database/listing page") is a
   structural, shape-based judgment a URL-shape family can legitimately generalize from.
4. **`runDateProxySuspects` (advisory only, never gates a run).** Rows whose `ts` equals the
   UTC date of the git commit that first introduced them in `data.json` -- the Rule A
   `firstSeen`-substitution proxy. Noisy on its own (a daily sweep naturally picks up same-day
   news); intersected with check 2 it is nearly conclusive, and that intersection is reported
   separately as `checks.intersection`. Needs git history: degrades cleanly (`skipped: true`,
   with a `reason`, checks 1/2 still run) when the checkout isn't a git repo, is shallow, or the
   file has no history there -- never crashes, never silently drops the check.
5. **`queryVariantPairs` (advisory, never gates).** [LEMA-11733](/LEMA/issues/LEMA-11733): the
   detection half of the CEO ruling on [LEMA-11732](/LEMA/issues/LEMA-11732) (a `reforma.com
   ?v=3` cache-buster surviving normalization undetected until a human happened to re-fetch the
   bare URL and notice). `normalize()`'s per-host param allow-list (see the `normalize` section
   below) is forward-only and only ever covers a host once a human has looked at real URLs for
   it -- an unlisted host still keeps every unrecognized query param by default, so the same
   defect class can recur on the next host nobody has looked at yet, and neither `lookup` nor
   `assert-integrity` can structurally see it (both only compare against the *current*
   normalization rule). This check groups URLs from `data.json` **and** `fetch-blocklist.json`
   combined (the `reforma.com` case itself was a cross-file pair) by host+path, and flags any
   group -- on a host with **no** `HOST_PARAM_ALLOWLIST` entry -- that produces two or more
   distinct normalized keys because of a query-string difference. Deliberately restricted to
   unlisted hosts: a listed host has already had this exact judgment call made (its allow-list
   entry *is* the record of that decision), so re-flagging it would just re-litigate a closed
   decision and would be noisy on hosts like `diarioimagen.net` where two different query values
   are legitimately two different documents by design.

```
$ node tools/sweep-integrity.js audit
- Ledger overlap (assertable): 1 row(s)
  - https://www.youtube.com/watch?v=wUvSOg3pNmY -- ledger: https://youtube.com/watch?v=wUvSOg3pNmY skipReason=editorial_personal_repost reviewable=false
- Ledger overlap, redundant-syndication (advisory, never gates): 1 row(s)
  - https://www.imdb.com/news/ni64735557/ -- ledger: https://m.imdb.com/news/ni64735557/?ref_=tt_nwr_1 skipReason=editorial_redundant_syndication reviewable=false
- Surface-family match (advisory): 4 row(s) against 27 derived listing-page families
  - https://tv.apple.com/lu/show/las-azules/umc.cmc.73wmdmkfpta5ul1vbwckmme39 -- tv.apple.com/…/show/… (precedent=9)
  ...
- Query-variant pairs (advisory, never gates): 5 group(s)
  - [instagram.com/normantorregrosa] 2 distinct key(s):
      - instagram.com/normantorregrosa?hl=en: https://www.instagram.com/normantorregrosa/?hl=en (fetch-blocklist.json)
      - instagram.com/normantorregrosa: https://www.instagram.com/normantorregrosa/ (fetch-blocklist.json)
  ...
- Run-date proxy suspects (advisory, never gates): 73 row(s)
  ...
- Intersection (surface-family AND run-date proxy -- near-conclusive): 2 row(s)
  - https://tv.apple.com/lu/show/las-azules/umc.cmc.73wmdmkfpta5ul1vbwckmme39
  - https://tv.apple.com/es/show/las-azules/umc.cmc.73wmdmkfpta5ul1vbwckmme39
```

`--repo path` overrides where check 4 runs its `git log`/`git show` calls (defaults to the
directory containing `--data`); only useful for pointing the check at a different checkout,
e.g. in tests. Prints the same `[audit] ... rows=<N> sha256=<hash>` stderr fingerprints as
`lookup` (LEMA-10448) for both input files. Exit is **1** only when `ledgerOverlap` (the
assertable bucket, excluding `editorial_redundant_syndication`) is non-empty -- the
`ledgerOverlapAdvisory` bucket, the two other advisory checks, and their intersection never
affect the exit code, per the ticket's explicit requirement.

## Flag parsing (LEMA-10595)

Every command has an explicit allow-list of flag names. A flag outside it -- a typo
(`--stict`) or a name no command reads -- is rejected with a non-zero exit and a stderr
message naming the offending flag, instead of being parsed, stored under a key nobody
reads, and silently dropped. This closes the exact shape of bug that let `--strict=true`
disarm the `lookup --strict` guard (LEMA-10592) without any error: before this fix,
`--strict=true` parsed as a flag literally named `strict=true`, so `flags.strict` stayed
`undefined` and the guard never ran.

Both `--name value` and `--name=value` are accepted for every flag. For the boolean gate
flags (`--strict`, `--fix`, `--json`), a value of `false` or `0` (case-insensitive) is
treated as off; a bare flag or any other value is on -- so `--strict=false` actually
disarms the guard rather than being coerced to "on" by JS string truthiness.

`lookup` also prints a fourth stderr line, `[lookup] strict=on` or `[lookup] strict=off`,
on every run. The three fingerprint lines above it are unchanged (the Media Sweep routine
quotes them verbatim); this line exists because a passing run used to look byte-identical
whether or not `--strict` was actually passed, so a transcript alone couldn't prove the
guard was armed.

## Ambiguities in the source prose, flagged rather than resolved

Per the ticket's "behaviour-preserving" constraint, none of these were resolved by inventing new
rules. Each is implemented with a documented, reasonable default and called out here for CEO
confirmation.

1. **Locale-path variants (`/es-es/` etc.) do not actually collapse under the literal
   normalization rule.** The routine's Pass 0 text claims "this same normalization rule" makes
   locale-path variants resolve to the same ledger entry as their non-locale counterpart, but
   the rule it defines (lowercase scheme/host, strip `www.`, strip trailing slash, drop tracking
   query params) contains no transformation that touches path segments other than a trailing
   slash. `tools/lib/normalize.js` implements only the literal steps; a `/es-es/` variant
   produces a different key than its non-locale counterpart. See the `normalize.test.js` test
   documenting this. Inventing a locale-stripping rule would be a new normalization behavior,
   not a port of an existing one (and a real risk: an `/es-es/` page could be a genuinely
   distinct translated article with its own publish date, which a blind fold-together would
   silently lose).
2. **Which query parameters count as "tracking."** Not enumerated in the prose. Implemented as
   `utm_*` plus a fixed list (`fbclid`, `gclid`, `gclsrc`, `dclid`, `msclkid`, `mc_cid`,
   `mc_eid`, `igshid`, `ref`, `ref_src`, `ref_url`, `spm`, `si`, `cmpid`, `icid`) in
   `tools/lib/normalize.js`. This is a deny-list default (keep unless recognized as tracking);
   see the `HOST_PARAM_ALLOWLIST` section below for the per-host allow-list mechanism that
   overrides this default on specific, evidenced hosts.
3. **Ordering of surviving (non-tracking) query params in the comparison key.** Not specified.
   Sorted alphabetically so param order in the source URL never affects the key.
4. **URL fragments (`#...`).** Not mentioned by the rule at all. Dropped entirely from both the
   canonical `url` and the comparison `key`.
5. **Step 10 merge, `url: the normalized form`.** The Pass 0 rule elsewhere says to "store the
   full URL with its real scheme in the row itself; only the comparison key is schemeless,"
   which is in tension with "the normalized form" for a merged row's `url` field. Implemented as
   `normalizeUrl(...).url`: full normalization applied, but the scheme is kept (taken from the
   row with the most recent `lastAttempt`, consistent with how every other tied field in the
   same merge is chosen).
6. **Step 10 merge, `skipNote`'s `<issue-id>` for a "Prior note" prefix.** A ledger row has no
   top-level issue id field of its own (only each `history` entry has one). Implemented as the
   `issue` field of that row's own most recent `history` entry.
7. **Step 11 merge, "more complete text."** Not defined beyond "from the entry with the more
   complete text." Implemented as trimmed character length (the longer string wins).

As of this section's original writing, none of these affected whether the two live artifacts
passed integrity. That is no longer true for `fetch-blocklist.json` -- see the m. fold section
below.

## m. mobile-subdomain fold (LEMA-10275)

`normalize.js` now folds a leading `m.` mobile subdomain into its parent host (`m.imdb.com` ->
`imdb.com`), the same way it already folded `www.`. Exception: hosts in the YouTube family
(`YOUTUBE_FAMILY_HOSTS`) are left alone -- `m.youtube.com` keeps its own key, unchanged from
before this ticket, because that per-host identity was a deliberate LEMA-9942 decision, not an
unhandled normalization gap.

Running this against the live artifacts surfaced **3 duplicate groups in `fetch-blocklist.json`**
(0 new in `data.json`), all `www.imdb.com` vs `m.imdb.com` pairs that already agree on
`skipReason`/`permanentSkip` and, in two cases, whose own `skipNote` already describes the other
row as "the same pattern." This is a real pre-existing ledger redundancy this normalizer change
makes visible, not a new duplicate created by the change. Per the code/data split established on
LEMA-9923 and LEMA-9942, remediation is Research Specialist's, tracked on
[LEMA-10275](/LEMA/issues/LEMA-10275)'s follow-up. This tool does not write to
`fetch-blocklist.json`.

**Redirect/canonical aliases (e.g. a page whose live URL differs from its `og:url` /
`<link rel="canonical">`) are explicitly out of scope for this fold and are not solved by it.**
Folding those would require a network fetch per URL, changing this module's contract from
deterministic/offline to network-dependent. See the `KNOWN GAP` comment on `normalizeUrl` in
`tools/lib/normalize.js` and the recommendation on LEMA-10275.

## A factual correction to the LEMA-9933 ticket

The ticket states, for `fetch-blocklist.json` at commit `e87a3c5`: "rows=132, distinct
normalized=132, duplicate groups=0." Directly counting `entries` in that file at that exact
commit (`git show e87a3c5:fetch-blocklist.json`) gives **135**, not 132. `data.json`'s reported
667 is correct. Both files pass integrity either way (0 duplicate groups), so this doesn't
change the finding that motivated this ticket, but the row count itself was off by 3.

## `HOST_PARAM_ALLOWLIST`: generalized per-host query-param table (LEMA-11733)

CEO ruling on [LEMA-11732](/LEMA/issues/LEMA-11732): a `reforma.com` URL's `?v=3`
cache-buster survived normalization because the generic tracking-param deny-list's default is
*keep*, not drop, and the reported case (a version/cache-buster param) isn't on the fixed
tracking-param list above. Rejected fixes: adding `v` to the *global* deny-list (a landmine --
`v` is YouTube's own identity param, safe today only by evaluation order) and inverting to a
global default-*drop* (refuted by live data: several hosts, e.g. `diarioimagen.net`'s bare
`/?p=<id>`, carry their *only* identity in the query string -- a blind global strip would
silently merge distinct articles into one row).

Adopted fix: generalize the YouTube-only allow-list (LEMA-9942: keep only `v`/`list` on
`youtube.com`/`m.youtube.com`/`youtu.be`, drop everything else) into `HOST_PARAM_ALLOWLIST`, a
`host -> [kept param names]` table in `tools/lib/normalize.js`. A host with an entry switches
from the generic deny-list (keep-unless-known-tracking) to an allow-list (drop-unless-listed);
a host with no entry keeps the old, safe default. Seeded from a live measurement of every
surviving query param in `data.json`/`fetch-blocklist.json` as of 2026-09-28:

| Host | Kept params | Why |
|---|---|---|
| `youtube.com` / `m.youtube.com` / `youtu.be` | `v`, `list` | Pre-existing (LEMA-9942) |
| `163.com` | *(none)* | `?f=` is a static recommendation-widget referrer tag; article id is in the path |
| `macprime.ch` | *(none)* | `?s=rss-artikel` is a static referrer tag; slug is in the path |
| `reforma.com` | *(none)* | `?v=` is a cache-buster (the reported LEMA-11732 case); article id is in the path |
| `primevideo.com` | *(none)* | `?tr=<territory>` is a storefront-referral tag: the same title id was seen under `?tr=mx`/`?tr=cl`/`?tr=pr` and with no `tr` at all, all four already independently classified identically -- proof it never gated distinct content |
| `issuu.com` | *(none)* | `?fr=<hash>` is an opaque partner-referral token; the doc slug is the full path identity |
| `diarioimagen.net` | `p` | Bare `/?p=<id>`, no other path segment -- `p` is the only identity the URL carries |
| `es.hollywoodreporter.com` | `p` | Same WordPress `?p=<id>` shape as diarioimagen.net |
| `webwire.com` | `aId` | `ViewPressRel.asp?aId=<id>` -- the path alone is shared by every WebWire release |
| `movistarplus.es` | `id` | Bare `/ficha` path; `id` is the catalog identity, `tipo` (dropped) is a type-classifier flag |
| `filmaffinity.com` | `movie-id` | Bare `/movie-awards.php` / `/pro-reviews.php` paths, no id elsewhere |
| `thetvdb.com` | `page` | Paginated company-listing page -- unlike the referral tags above, different page numbers genuinely show different content |
| `tv.apple.com` | `l` | `showId`/`targetId`/`targetType` are dropped: every occurrence carries the *same* fixed show-id value this whole dataset already tracks, echoed onto episode/clip pages whose own path already has a distinct id, so they never disambiguate two documents. `l` (locale, e.g. `es-MX`) is kept -- see below, deliberately unresolved |

**Deliberately not added:** `facebook.com` (`?locale=`), `instagram.com` (`?hl=`),
`tiktok.com` (`?lang=`), `twitter.com`/`x.com` (`?lang=`). Each host's only observed extra
param is a locale/language flag -- exactly the family proposed for a *separate*, global rule
below, not decided host-by-host here.

**Locale-param proposal (not shipped, needs CEO approval before it ships globally).** The
ledger also carries `lang`/`hl`/`locale`/`l` on the four hosts just listed (9 rows as of the
2026-09-28 measurement) -- the query-string twin of the already-documented `/es-es/`
locale-*path* gap (ambiguity #1 above). All four look like genuine display-language selectors
with no bearing on document identity, which would make them safe to add to the *global*
deny-list (`TRACKING_PARAM_NAMES`) the same way `srsltid`/`SESSIONID`/`ref_` were added on
LEMA-9942. Per the CEO ruling, this is **not** shipped here: "do not ship it on judgment alone."
`l` on `tv.apple.com` is the one param the ruling explicitly flagged as the least certain
("least sure is always a locale") -- kept in the per-host table above rather than folded into
this proposal, since an incorrect per-host call only affects one host, while an incorrect
global call would affect every host that ever gets one of these four param names. If approved,
this proposal would let `tv.apple.com`'s `l` and the four now-`HOST_PARAM_ALLOWLIST`-absent
hosts above all be handled by one global rule instead of a growing set of one-off host entries.

**Re-key migration performed on ship.** Verified against the live tree (2026-09-28) by diffing
every row's `normalizeUrl(...).key` under the pre-ticket normalize.js against this ticket's
version: **13 rows change key** (5 in `data.json`, 8 in `fetch-blocklist.json`). A changed key
does not by itself mean a file edit is needed -- see LEMA-10553's precedent ("key-affecting is
not necessarily file-affecting"), which held for 9 of these 13:

- `data.json` (5 keys changed, 0 file edits): `163.com` `?f=`, `macprime.ch` `?s=` (x2),
  `tv.apple.com` `pe/episode/.../umc.cmc.5g6l2...?showId=`, and the reported
  `reforma.com/...ar2848897?v=3` row. None collides with another row *within* `data.json`
  (`assertDatasetIntegrity`: 0 duplicate groups before and after), so no merge, no file write.
- `fetch-blocklist.json` (8 keys changed, 4 rows -> 1 via one real merge): `movistarplus.es`
  `?tipo=E&id=...` (param-order/drop only, no collision), `issuu.com` `?fr=`,
  `tv.apple.com` `gt/clip/.../umc.cmc.dfqcx...` and `fi/episode/.../umc.cmc.4p8rfi4...`
  (no collision each) -- and the one genuine collision, the `primevideo.com` `tr=mx`/`tr=cl`/
  `tr=pr` triple, which already had a fourth, already-bare sibling row in the same file. All
  four agreed on `permanentSkip=true`/`skipReason=editorial_listing_or_database`, so
  `assert-integrity --target ledger --fix` cleanly auto-merged them (not an escalation) into
  `https://primevideo.com/-/es/detail/0JFCKSNHTRBNJA50K5E6QG2HHN` (687 rows, was 690;
  `failCount` on the merged row is `0`, the same value all four inputs already had -- not reset
  for tidiness; full history from all four preserved on the merged row).

**The reforma.com pair named in the ruling is the 13th row's cross-file counterpart, not a
14th row.** `data.json`'s `...ar2848897?v=3` row (one of the 5 above) and
`fetch-blocklist.json`'s already-`permanentSkip`/`editorial_redundant_syndication` bare-path
row (added same-day on [LEMA-11731](/LEMA/issues/LEMA-11731) when the routine self-caught this
exact defect) now normalize to the same key across both files. `assertDatasetIntegrity`/
`assertLedgerIntegrity` each only look *within* their own file, so this cross-file coincidence
triggers no merge in either -- it is exactly what `audit`'s `ledgerOverlapCheck` exists to
catch, and it correctly reports it under `ledgerOverlapAdvisory` (expected Rule I overlap), not
the assertable `ledgerOverlap` bucket: confirmed via `node tools/sweep-integrity.js audit`,
exit 0. One live document, one correctly-classified ledger row for its second address: "one row
at the correct key," as required.

Full suite: 86 (pre-LEMA-10625 baseline noted elsewhere in this file) is long since stale;
as of this ticket the suite is **140** (`npm test`), all green, including the two
`real-fixtures.test.js` checks against the live, post-merge artifacts.
