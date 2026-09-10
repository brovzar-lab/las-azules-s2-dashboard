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

### `lookup <candidates.json> [--fetch-blocklist path]`

`candidates.json` is either a JSON array of URL strings, or of `{"url": "..."}` objects.
Builds the Pass 0 lookup dict from `fetch-blocklist.json` and prints one line per candidate
with its disposition (`permanentSkip`, `active-cooldown`, `expired-cooldown-retry`, or
`not-found`). Add `--json` for structured output.

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
   `tools/lib/normalize.js`.
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

None of these affect whether the two live artifacts currently pass integrity (both do, see
below); they only matter if a future duplicate group actually exercises one of these paths.

## A factual correction to the LEMA-9933 ticket

The ticket states, for `fetch-blocklist.json` at commit `e87a3c5`: "rows=132, distinct
normalized=132, duplicate groups=0." Directly counting `entries` in that file at that exact
commit (`git show e87a3c5:fetch-blocklist.json`) gives **135**, not 132. `data.json`'s reported
667 is correct. Both files pass integrity either way (0 duplicate groups), so this doesn't
change the finding that motivated this ticket, but the row count itself was off by 3.
