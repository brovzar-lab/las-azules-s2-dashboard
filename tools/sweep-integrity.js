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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
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
  const candidatesPath = positional[0];
  if (!candidatesPath) {
    console.error('Usage: sweep-integrity.js lookup <candidates.json> [--fetch-blocklist path] [--json]');
    process.exit(2);
  }
  const ledgerPath = flags['fetch-blocklist'] || DEFAULT_LEDGER_PATH;
  const candidates = readJson(candidatesPath);
  const ledger = readJson(ledgerPath);
  const results = lookupAll(candidates, ledger);

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
    console.log(`${r.url}\t${r.disposition}${extra}`);
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
  process.exit(failed ? 1 : 0);
}

function cmdEvidence(flags) {
  const candidatesPath = flags.candidates;
  if (!candidatesPath) {
    console.error('Usage: sweep-integrity.js evidence --candidates <candidates.json> [--fetch-blocklist path] [--data path] [--fix]');
    process.exit(2);
  }
  const ledgerPath = flags['fetch-blocklist'] || DEFAULT_LEDGER_PATH;

  const candidates = readJson(candidatesPath);
  const ledger = readJson(ledgerPath);
  const lookups = lookupAll(candidates, ledger);

  const counts = { permanentSkip: 0, activeCooldown: 0, expiredCooldownRetry: 0, notFound: 0 };
  for (const r of lookups) {
    if (r.disposition === 'permanentSkip') counts.permanentSkip++;
    else if (r.disposition === 'active-cooldown') counts.activeCooldown++;
    else if (r.disposition === 'expired-cooldown-retry') counts.expiredCooldownRetry++;
    else counts.notFound++;
  }
  const hits = counts.permanentSkip + counts.activeCooldown + counts.expiredCooldownRetry;

  console.log(`- Ledger check: candidates surfaced=${candidates.length}, ledger-checked=${lookups.length}, hits=${hits} (permanentSkip=${counts.permanentSkip}, active cooldown=${counts.activeCooldown}, expired cooldown retried=${counts.expiredCooldownRetry})`);

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
