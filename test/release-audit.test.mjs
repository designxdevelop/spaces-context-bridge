import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const audit = fileURLToPath(new URL('../scripts/release-audit.mjs', import.meta.url));
test('release audit inspects the index before the first commit and all committed history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-audit-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  const run = () => {
    const result = spawnSync(process.execPath, [audit], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Release audit fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.hooksPath', '/dev/null');
    const file = resolve(dir, 'candidate.txt');
    // A synthetic signature for the scanner, never an actual usable credential.
    writeFileSync(file, 'ghp_' + 'a'.repeat(36));
    git('add', 'candidate.txt');
    writeFileSync(file, 'sanitized working tree');
    let result = run();
    assert.equal(result.status, 1);
    assert.ok(result.report.findings.some(f => f.revision === 'index' && f.rule === 'provider-token'));
    assert.ok(!result.report.findings.some(f => f.revision === 'working-tree'));
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic scanner fixture');
    git('add', 'candidate.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Sanitize current content');
    result = run();
    assert.equal(result.status, 1);
    assert.ok(result.report.findings.some(f => f.revision !== 'index' && f.revision !== 'working-tree' && f.rule === 'provider-token'));
    assert.ok(!result.report.findings.some(f => f.revision === 'index' || f.revision === 'working-tree'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
