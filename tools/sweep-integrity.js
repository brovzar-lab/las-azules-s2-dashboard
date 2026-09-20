#!/usr/bin/env node
'use strict';

// Media Sweep integrity tool (LEMA-9933). Ports the routine's mechanical,
// no-judgment controls out of the ~44KB Media Sweep routine prompt and
// into code: URL normalization, fetch-blocklist lookup, the Step 10 /
// Step 11 post-write integrity assertions, and the evidence-line counts.
//
// Read-only on the repo's JSON artifacts by default. The only exception is
// `assert-integrity --fix`, which auto-merges duplicate-key groups that
// agree on disposition and writes the result back to the artifact file it
// read from, printing exactly what changed. This tool never touches git or
// the GitHub API: committing stays with the sweep routine (steps 8/9).
//
// See tools/README.md for the full command reference and the list of
// ambiguities in the source prose that this port did not resolve on its
// own (flagged instead, per the ticket's instructions).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { normalizeUrl } = require('./lib/normalize');
const { lookupAll } = require('./lib/ledger');
const { assertLedgerIntegrity } = require('./lib/ledger');
const { assertDatasetIntegrity } = require('./lib/dataset');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_LEDGER_PATH = path.join(REPO_ROOT, 'fetch-blocklist.json');
const DEFAULT_DATA_PATH = path.join(REPO_ROOT, 'data.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Same as readJson, but also returns the raw bytes so the caller can
// fingerprint exactly what was on disk (LEMA-10448: readJson alone can't
// tell two runs apart if the underlying file differed between them).
//
// LEMA-10597: a missing or unparseable file here used to escape as an
// uncaught ENOENT/SyntaxError -- a raw stack trace, exit 1, before a
// single line of output. That's not just noisy: it happens before the
// `--strict` check even runs, so the Media Sweep routine's STOP-and-quote
// escalation path (LEMA-10593) demands a `--strict guard failed` block
// that was never printed. `description`/`urlHint` let each call site name
// itself in the resulting message; `urlHint` is for the one call site
// (the candidates argument) where a bare host/path string is plausibly a
// URL missing its scheme.
function readJsonWithRaw(filePath, description, { urlHint = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const hint = urlHint ? ' (if you meant a URL, include the https:// scheme)' : '';
      console.error(`Error: ${description} not found: ${filePath}${hint}`);
      process.exit(2);
    }
    throw err;
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    console.error(`Error: ${description} is not valid JSON: ${filePath}`);
    process.exit(2);
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

// LEMA-10596: `lookup`'s only documented positional form was always a
// candidates-file path. The Media Sweep routine's prose (Rule C, Step 4a)
// also calls `lookup` on a single bare URL with no candidates file in
// hand, which does not exist as a form and used to crash with an uncaught
// ENOENT from readJsonWithRaw before printing anything. This treats a
// positional argument that parses as an http(s) URL as a synthesized
// one-element candidate list instead of a file path.
function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      // LEMA-10595: `--name=value` is parsed as its own form rather than
      // falling through to the space-separated branch below, which used to
      // treat the whole `name=value` string as the flag *name* (so
      // `--strict=true` silently became an unrecognized key nobody read,
      // and `flags.strict` stayed undefined -- disarming the --strict
      // guard without any error).
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const name = arg.slice(2, eq);
        flags[name] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// LEMA-10595: every command gets an explicit allow-list of flag names.
// Anything outside it (a typo like `--stict`, or a genuinely new flag no
// command reads) is rejected loudly instead of being parsed, stored under
// a key nobody reads, and silently dropped -- the same silent-fallback
// shape that let `--strict=true` disarm the LEMA-10592 guard.
const KNOWN_FLAGS = {
  normalize: [],
  lookup: ['fetch-blocklist', 'data', 'json', 'strict'],
  'assert-integrity': ['fetch-blocklist', 'data', 'target', 'fix', 'json'],
  evidence: ['candidates', 'fetch-blocklist', 'data', 'fix'],
};

// Flags that gate an on/off code path rather than carry a path/enum value.
// `--name=value` is supported for these too (e.g. `--strict=true`), so a
// value has to be interpreted as a boolean rather than treated as always
// truthy -- otherwise `--strict=false` would parse to the non-empty string
// "false", which is JS-truthy, and silently re-arm the guard the caller
// just asked to turn off. Only "false"/"0" (case-insensitive) count as off;
// a bare `--strict` (value `true`) and any other value stay on.
const BOOLEAN_FLAGS = new Set(['strict', 'fix', 'json']);

function rejectUnknownFlags(command, flags) {
  const allowed = KNOWN_FLAGS[command];
  if (!allowed) return;
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(flags).filter((name) => !allowedSet.has(name));
  if (unknown.length > 0) {
    console.error(
      `Error: unrecognized flag(s) for '${command}': ${unknown.map((f) => `--${f}`).join(', ')}`
    );
    console.error(
      `Allowed flags for '${command}': ${allowed.length ? allowed.map((f) => `--${f}`).join(', ') : '(none)'}`
    );
    process.exit(2);
  }
}

function coerceBooleanFlags(flags) {
  for (const name of Object.keys(flags)) {
    if (!BOOLEAN_FLAGS.has(name)) continue;
    const value = flags[name];
    if (value === true) continue;
    flags[name] = !/^(false|0)$/i.test(value);
  }
}

function cmdNormalize(positional) {
  const input = positional[0];
  if (!input) {
    console.error('Usage: sweep-integrity.js normalize <url>');
    process.exit(2);
  }
  const { url, key } = normalizeUrl(input);
  console.log(JSON.stringify({ input, url, key }, null, 2));
}

function cmdLookup(positional, flags) {
  const candidatesArg = positional[0];
  if (!candidatesArg) {
    console.error('Usage: sweep-integrity.js lookup <candidates.json|url> [--fetch-blocklist path] [--data path] [--json] [--strict]');
    process.exit(2);
  }
  const ledgerPath = flags['fetch-blocklist'] || DEFAULT_LEDGER_PATH;
  const dataPath = flags.data || DEFAULT_DATA_PATH;

  // A bare http(s) URL is synthesized into a one-element candidate list
  // rather than read as a file path (LEMA-10596). candidatesRaw is
  // synthesized too, so the stderr fingerprint line below still covers it.
  let candidatesPath, candidatesRaw, candidates;
  if (isHttpUrl(candidatesArg)) {
    candidatesPath = candidatesArg;
    candidates = [candidatesArg];
    candidatesRaw = JSON.stringify(candidates);
  } else {
    candidatesPath = candidatesArg;
    ({ raw: candidatesRaw, value: candidates } = readJsonWithRaw(
      candidatesPath,
      'candidates file',
      { urlHint: true }
    ));
  }
  const { raw: ledgerRaw, value: ledger } = readJsonWithRaw(ledgerPath, 'fetch-blocklist ledger');
  const { raw: dataRaw, value: dataset } = readJsonWithRaw(dataPath, 'data.json');

  // LEMA-10448: emit a mechanically-comparable fingerprint of both input
  // files on every run, to stderr only (stdout's one-line-per-candidate
  // contract is unchanged for existing consumers). Two runs claimed to be
  // "against the same unmodified files" can now be diffed on this line
  // instead of taken on faith -- the exact gap that made the original
  // LEMA-10447 report undiagnosable after the fact (its candidates.json
  // input wasn't preserved, so nobody could check).
  const ledgerEntries = Array.isArray(ledger && ledger.entries) ? ledger.entries : null;
  const candidateList = Array.isArray(candidates) ? candidates : null;
  // LEMA-10591: same fingerprint discipline extended to data.json, since a
  // pre-fetch dedup decision made against an un-fingerprinted file is the
  // same un-auditable shape LEMA-10447/LEMA-10448 fixed for the ledger.
  const datasetEntries = Array.isArray(dataset) ? dataset : null;
  console.error(
    `[lookup] ledger path=${ledgerPath} rows=${ledgerEntries ? ledgerEntries.length : 'INVALID'} sha256=${sha256(ledgerRaw)}`
  );
  console.error(
    `[lookup] candidates path=${candidatesPath} count=${candidateList ? candidateList.length : 'INVALID'} sha256=${sha256(candidatesRaw)}`
  );
  console.error(
    `[lookup] data.json path=${dataPath} rows=${datasetEntries ? datasetEntries.length : 'INVALID'} sha256=${sha256(dataRaw)}`
  );
  // LEMA-10595: additive fourth line only -- the three fingerprint lines
  // above are quoted verbatim by the Media Sweep routine and stay
  // byte-identical. On healthy inputs, stdout/stderr used to be identical
  // whether or not --strict was passed, so a transcript couldn't prove the
  // gate was actually armed. This line makes that state explicit on every
  // run, pass or fail.
  console.error(`[lookup] strict=${flags.strict ? 'on' : 'off'}`);

  if (flags.strict) {
    const problems = [];
    if (!ledgerEntries) problems.push('fetch-blocklist ledger has no "entries" array');
    else if (ledgerEntries.length === 0) problems.push('fetch-blocklist ledger "entries" array is empty');
    if (!candidateList) problems.push('candidates file is not a JSON array');
    else if (candidateList.length === 0) problems.push('candidates file is an empty array');
    // LEMA-10592: without this, an unusable data.json silently degrades to
    // `datasetEntries || []` below -- lookupAll then reports inDataJson=false
    // for every candidate, including ones demonstrably present in the real
    // file, and the process still exits 0. --strict exists to hard-fail on
    // unusable inputs instead of proceeding on a wrong answer, same as the
    // ledger/candidates checks above.
    if (!datasetEntries) problems.push('data.json is not a JSON array');
    else if (datasetEntries.length === 0) problems.push('data.json array is empty');
    if (problems.length > 0) {
      console.error(`[lookup] --strict guard failed:\n  - ${problems.join('\n  - ')}`);
      process.exitCode = 3;
      return;
    }
  }

  const results = lookupAll(candidates, ledger, new Date(), datasetEntries || []);

  if (flags.strict && results.length !== candidates.length) {
    // Defense in depth: lookupAll is a straight .map() today so this can't
    // actually happen, but a silent count mismatch is exactly the failure
    // shape this guard exists to catch, so check it explicitly rather than
    // trusting the invariant to hold forever.
    console.error(`[lookup] --strict guard failed: produced ${results.length} results for ${candidates.length} candidates`);
    process.exitCode = 3;
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const r of results) {
    const extra = r.disposition === 'permanentSkip'
      ? ` skipReason=${r.skipReason}`
      : r.disposition === 'active-cooldown' || r.disposition === 'expired-cooldown-retry'
        ? ` cooldownUntil=${r.cooldownUntil || 'null'} failCount=${r.failCount}`
        : '';
    const dataJsonExtra = r.inDataJson
      ? ` inDataJson=true dataJsonTs=${r.dataJsonTs} dataJsonOutlet=${JSON.stringify(r.dataJsonOutlet)}`
      : ' inDataJson=false';
    console.log(`${r.url}\t${r.disposition}${extra}${dataJsonExtra}`);
  }
}

function formatLedgerGroupLine(prefix, group, autoMergedKeys) {
  const merged = autoMergedKeys.has(group.key);
  const status = merged ? 'auto-merged' : 'escalated (unresolved disagreement)';
  const urls = (group.urls || group.rows || []).map((u) => (typeof u === 'string' ? u : u.entry.url)).join(', ');
  return `  - ${prefix} group [${group.key}]: ${urls} -- ${status}`;
}

function runAssertIntegrity(flags) {
  const ledgerPath = flags['fetch-blocklist'] || DEFAULT_LEDGER_PATH;
  const dataPath = flags.data || DEFAULT_DATA_PATH;
  const target = flags.target || 'both';
  const fix = Boolean(flags.fix);

  const result = { target, fix };

  if (target === 'ledger' || target === 'both') {
    const ledger = readJson(ledgerPath);
    const ledgerResult = assertLedgerIntegrity(ledger, { fix });
    result.ledger = ledgerResult;
    if (fix && ledgerResult.autoMerged.length > 0) {
      writeJson(ledgerPath, { ...ledger, entries: ledgerResult.entries });
    }
  }

  if (target === 'data' || target === 'both') {
    const dataset = readJson(dataPath);
    const datasetResult = assertDatasetIntegrity(dataset, { fix });
    result.dataset = datasetResult;
    if (fix && datasetResult.autoMerged.length > 0) {
      writeJson(dataPath, datasetResult.entries);
    }
  }

  return result;
}

function cmdAssertIntegrity(flags) {
  const result = runAssertIntegrity(flags);

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.ledger) {
      const l = result.ledger;
      console.log(`- Ledger integrity: rows=${l.rows}, distinct normalized URLs=${l.distinctNormalizedUrls}, duplicate groups=${l.duplicateGroups}`);
      for (const m of l.autoMerged) {
        console.log(`  - auto-merged group [${m.key}]: ${m.before.join(', ')} -> ${m.after}`);
      }
      for (const p of l.pendingMerge) {
        console.log(`  - pending-merge group [${p.key}]: ${p.urls.join(', ')} -- agrees on disposition, not yet merged (re-run with --fix)`);
      }
      for (const c of l.conflicts) {
        console.log(`  - escalated group [${c.key}]: ${c.urls.join(', ')} -- dispositions differ, agent must resolve (Step 10 escalation path, including the search-existing-issues dedup check)`);
      }
    }
    if (result.dataset) {
      const d = result.dataset;
      console.log(`- data.json integrity: rows=${d.rows}, distinct normalized URLs=${d.distinctNormalizedUrls}, duplicate groups=${d.duplicateGroups}`);
      for (const m of d.autoMerged) {
        console.log(`  - auto-merged group [${m.key}]: ${m.before.join(', ')} -> ${m.after}`);
      }
      for (const p of d.pendingMerge) {
        console.log(`  - pending-merge group [${p.key}]: ${p.urls.join(', ')} -- agrees on date/ts/outlet/lang/market/type, not yet merged (re-run with --fix)`);
      }
      for (const c of d.conflicts) {
        const defect = c.sharedStoryGroupDefect
          ? ` [second defect: shared storyGroup="${c.sharedStoryGroupDefect}" across a field-disagreeing group]`
          : '';
        console.log(`  - escalated group [${c.key}]: ${c.urls.join(', ')} -- fields differ, agent must resolve (Step 11 escalation path)${defect}`);
      }
    }
  }

  const failed = (result.ledger && !result.ledger.passes) || (result.dataset && !result.dataset.passes);
  // LEMA-10448: was process.exit(failed ? 1 : 0) here, which tears the
  // process down as soon as this line runs -- if stdout is a pipe under
  // backpressure (slow consumer, large --json output), Node can still have
  // buffered console.log bytes that haven't reached the reader yet, and
  // process.exit() drops them, truncating the output. Reproduced: piping
  // a large --json run into a slow reader cut output at exactly 65536
  // bytes (the default pipe buffer size) and left invalid JSON on the
  // other end. Setting exitCode and returning lets Node drain stdout
  // before the process actually exits.
  process.exitCode = failed ? 1 : 0;
}

function cmdEvidence(flags) {
  const candidatesPath = flags.candidates;
  if (!candidatesPath) {
    console.error('Usage: sweep-integrity.js evidence --candidates <candidates.json> [--fetch-blocklist path] [--data path] [--fix]');
    process.exit(2);
  }
  const ledgerPath = flags['fetch-blocklist'] || DEFAULT_LEDGER_PATH;
  const dataPath = flags.data || DEFAULT_DATA_PATH;

  const candidates = readJson(candidatesPath);
  const ledger = readJson(ledgerPath);
  const dataset = readJson(dataPath);
  const lookups = lookupAll(candidates, ledger, new Date(), dataset);

  // LEMA-10591: alreadyInDataJson is deliberately not folded into `hits` --
  // it's a separate axis from ledger disposition (a candidate can be
  // not-found in the ledger and still already be in data.json), so mixing
  // it into the ledger hit-rate count would misstate both numbers.
  const counts = { permanentSkip: 0, activeCooldown: 0, expiredCooldownRetry: 0, notFound: 0, alreadyInDataJson: 0 };
  for (const r of lookups) {
    if (r.disposition === 'permanentSkip') counts.permanentSkip++;
    else if (r.disposition === 'active-cooldown') counts.activeCooldown++;
    else if (r.disposition === 'expired-cooldown-retry') counts.expiredCooldownRetry++;
    else counts.notFound++;
    if (r.inDataJson) counts.alreadyInDataJson++;
  }
  const hits = counts.permanentSkip + counts.activeCooldown + counts.expiredCooldownRetry;

  console.log(`- Ledger check: candidates surfaced=${candidates.length}, ledger-checked=${lookups.length}, hits=${hits} (permanentSkip=${counts.permanentSkip}, active cooldown=${counts.activeCooldown}, expired cooldown retried=${counts.expiredCooldownRetry}), already in data.json=${counts.alreadyInDataJson}`);

  const assertResult = runAssertIntegrity(flags);
  const l = assertResult.ledger;
  console.log(`- Ledger integrity: rows=${l.rows}, distinct normalized URLs=${l.distinctNormalizedUrls}, duplicate groups=${l.duplicateGroups}`);
  for (const m of l.autoMerged) {
    console.log(`  - auto-merged group [${m.key}]: ${m.before.join(', ')} -> ${m.after}`);
  }
  for (const p of l.pendingMerge) {
    console.log(`  - pending-merge group [${p.key}]: ${p.urls.join(', ')} -- agrees on disposition, not yet merged (re-run with --fix)`);
  }
  for (const c of l.conflicts) {
    console.log(`  - group [${c.key}]: ${c.urls.join(', ')} -- Step 10 escalation: [FILL IN by agent: opened LEMA-xxxx | re-observed on LEMA-xxxx | suppressed, same-day re-observation already posted]`);
  }

  const d = assertResult.dataset;
  console.log(`- data.json integrity: rows=${d.rows}, distinct normalized URLs=${d.distinctNormalizedUrls}, duplicate groups=${d.duplicateGroups}`);
  for (const m of d.autoMerged) {
    console.log(`  - auto-merged group [${m.key}]: ${m.before.join(', ')} -> ${m.after}`);
  }
  for (const p of d.pendingMerge) {
    console.log(`  - pending-merge group [${p.key}]: ${p.urls.join(', ')} -- agrees on date/ts/outlet/lang/market/type, not yet merged (re-run with --fix)`);
  }
  for (const c of d.conflicts) {
    const defect = c.sharedStoryGroupDefect
      ? ` [second defect: shared storyGroup="${c.sharedStoryGroupDefect}" across a field-disagreeing group]`
      : '';
    console.log(`  - group [${c.key}]: ${c.urls.join(', ')} -- Step 11 escalation: [FILL IN by agent: opened LEMA-xxxx | re-observed on LEMA-xxxx | suppressed, same-day re-observation already posted]${defect}`);
  }
}

function main() {
  const [, , command, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);

  rejectUnknownFlags(command, flags);
  coerceBooleanFlags(flags);

  switch (command) {
    case 'normalize':
      return cmdNormalize(positional, flags);
    case 'lookup':
      return cmdLookup(positional, flags);
    case 'assert-integrity':
      return cmdAssertIntegrity(flags);
    case 'evidence':
      return cmdEvidence(flags);
    default:
      console.error('Usage: sweep-integrity.js <normalize|lookup|assert-integrity|evidence> ...');
      process.exit(2);
  }
}

main();
