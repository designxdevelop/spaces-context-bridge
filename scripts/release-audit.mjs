#!/usr/bin/env node
// A bounded release hygiene check, not a substitute for human review or a secret scanner.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:ant-)?[A-Za-z0-9_-]{30,})\b/],
  ['personal-home-path', /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//],
  ['hardcoded-cloudflare-account', /["']?account_id["']?\s*[:=]\s*["'][a-f0-9]{32}["']/i],
  ['hardcoded-d1-database', /["']?database_id["']?\s*[:=]\s*["'](?!00000000-0000-0000-0000-000000000000)[a-f0-9-]{36}["']/i],
  ['personal-worker-origin', /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i],
  ['populated-login-hash', /(?:AGENT|WORKER)_LOGIN_HASH\s*[=:]\s*["']?[A-Za-z0-9_-]{43}(?:["'\s]|$)/],
  ['connection-code', /(?:AGENT|WORKER)_CODE\s*[=:]\s*["']?[A-Za-z0-9_-]{24,}/],
  ['personal-page-reference', /\bpage_(?:space_)?[a-f0-9]{32}\b/i],
];
const privateFile = /(?:^|\/)(?:\.bridge-secrets(?:\/|$)|LOCAL-CONNECTION-CODES\.txt$|connection-codes\.txt$|(?:\.dev\.vars(?:\..+)?|\.env(?:\..+)?|credentials(?:\..+)?|.*\.pem|.*\.key|\.DS_Store)$)/;
const approvedExample = /(?:\.example|\.template|\.tpl)$/;
const failures = [];
let versions = 0;
function inspect(path, data, revision) {
  versions++;
  if (privateFile.test(path) && !approvedExample.test(path)) {
    failures.push({ revision, path, rule: 'private-file' });
  }
  if (data.includes(0)) return;
  const text = data.toString('utf8');
  for (const [rule, pattern] of rules) {
    if (pattern.test(text)) failures.push({ revision, path, rule });
  }
}

try {
  const tracked = git('ls-files', '-z').toString().split('\0').filter(Boolean);
  if (!tracked.length) throw new Error('No tracked files; stage the candidate release first.');
  for (const path of tracked) if (existsSync(path)) inspect(path, readFileSync(path), 'working-tree');
  // The index can differ from the working tree: inspect exactly what a commit would contain.
  const indexEntries = git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean);
  for (const entry of indexEntries) {
    const tab = entry.indexOf('\t');
    const [, oid, stage] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    inspect(path, git('cat-file', 'blob', oid), stage === '0' ? 'index' : 'unmerged-index-' + stage);
  }
  let commits = [];
  try { commits = git('rev-list', '--all').toString().trim().split('\n').filter(Boolean); }
  catch { /* The initial release can be audited before its first commit. */ }
  const seen = new Set();
  for (const commit of commits) {
    const entries = git('ls-tree', '-rz', '--full-tree', commit).toString().split('\0').filter(Boolean);
    for (const entry of entries) {
      const [header, path] = entry.split('\t');
      const [, kind, oid] = header.split(' ');
      if (kind !== 'blob' || seen.has(path + ':' + oid)) continue;
      seen.add(path + ':' + oid);
      inspect(path, git('cat-file', 'blob', oid), commit.slice(0, 12));
    }
    // Commit messages are also public when history is published.
    inspect('(commit-message)', git('show', '-s', '--format=%B', commit), commit.slice(0, 12));
  }
  console.log(JSON.stringify({
    check: 'release-hygiene', trackedFiles: tracked.length, commits: commits.length,
    inspectedVersions: versions, findings: failures,
    limitation: 'Pattern-based scan; review files, history, dependencies and Git author metadata before publication.',
  }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error(JSON.stringify({ check: 'release-hygiene', error: error.message }));
  process.exitCode = 1;
}
