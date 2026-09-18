#!/usr/bin/env node
/**
 * Runs every suite wired into package.json as a `test:*` script and reports one
 * pass/fail table with a single exit code.
 *
 * Why this exists: verification in this repo previously required running up to 17
 * separate `npm run test:x` commands by hand, so "all suites pass" was never a
 * reproducible claim and a newly added suite could sit unwired indefinitely
 * (poly-paper and paper-mc were both added without ever being run). This script
 * derives the suite list from package.json, so wiring a suite in package.json is
 * the ONLY step needed to have it verified.
 *
 * Usage:  npm test            (all suites)
 *         node scripts/tests/run-all.cjs --list
 *
 * Every suite sets a non-zero exit code on failure (verified 2026-09-18), so the
 * exit code here is meaningful rather than decorative.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const suites = Object.keys(pkg.scripts || {})
  .filter((k) => k.startsWith('test:') && k !== 'test')
  .sort()
  .map((k) => ({ key: k, cmd: pkg.scripts[k] }));

if (process.argv.includes('--list')) {
  for (const s of suites) console.log(`${s.key}\t${s.cmd}`);
  console.log(`\n${suites.length} suites`);
  process.exit(0);
}

if (!suites.length) {
  console.error('run-all: no test:* scripts found in package.json');
  process.exit(2);
}

/** Last non-empty line of output, trimmed - the suite's own summary. */
function lastLine(text, max = 110) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const l = lines.length ? lines[lines.length - 1] : '';
  return l.length > max ? l.slice(0, max - 1) + '\u2026' : l;
}

const results = [];
const t0 = Date.now();

for (const s of suites) {
  const started = Date.now();
  const r = spawnSync(s.cmd, { shell: true, cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ok = r.status === 0;
  results.push({
    key: s.key,
    ok,
    status: r.status,
    ms: Date.now() - started,
    summary: lastLine(ok ? r.stdout : r.stderr || r.stdout),
  });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.key.padEnd(30)} ${String(Date.now() - started).padStart(6)}ms  ${ok ? '' : lastLine(r.stderr || r.stdout)}`);
}

const failed = results.filter((r) => !r.ok);
const width = 30;

console.log('\n' + '='.repeat(78));
console.log(`run-all: ${results.length - failed.length}/${results.length} suites passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) {
    console.log(`  ${f.key.padEnd(width)} exit=${f.status}  ${f.summary}`);
  }
}
console.log('='.repeat(78));

process.exit(failed.length ? 1 : 0);
