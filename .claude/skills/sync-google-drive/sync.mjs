#!/usr/bin/env node
// sync-google-drive helper: the deterministic half of the skill.
// The Google Drive connector (create_file / search_files / download_file_content)
// does the transfer; this script scans, hashes, plans, verifies and writes.
//
// Commands (all print JSON on stdout):
//   scan        [--project DIR] --out PLAN.json [--stage-dir SCRATCH] what to upload + what changed since last upload
//               (--stage-dir is required only when this script runs from ~/.claude/skills/)
//   finalize    [--project DIR] --plan PLAN.json --ids IDS.json --snapshot NAME --folder-id ID --out MANIFEST.json
//   plan-download [--project DIR] --manifest FILE          compare a Drive snapshot manifest with local files
//   apply-download [--project DIR] --manifest FILE --staging DIR --files rel1,rel2,...
//   status      [--project DIR]                            last upload/download recorded locally
//
// download_file_content saves the raw file locally and prints its path; pass that path as --manifest,
// and map each downloaded rel to its saved path in --staged MAP.json ({ "<rel>": "<saved path>" }).
// Fallbacks: --manifest *.b64 and --staging DIR (<DIR>/<rel>.b64) for base64 text.
// Every write is sha256-verified against the manifest.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, extname, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// User Layer (DATA_CONTRACT.md) that git does not carry. Paths are relative to the data root.
const SCOPE = [
  // Profile: what career-ops needs before it can evaluate anything
  { file: 'cv.md' },
  { file: 'cv-original.md' },
  { file: 'config/profile.yml' },
  { file: 'config/cv-facts.json' },
  { file: 'config/benchmarks.yml' },
  { file: 'modes/_profile.md' },
  { file: 'modes/_custom.md' },
  { file: 'modes/_brief.md' },
  { file: 'portals.yml' },
  { file: 'voice-dna.md' },
  { file: 'article-digest.md' },
  { dir: 'data/templates', recursive: true },
  { dir: 'writing-samples', recursive: true },
  { dir: 'interview-prep', recursive: true },
  { dir: 'documents', recursive: true },
  // Tracker and pipeline
  { file: 'data/applications.md' },
  { file: 'data/status-log.tsv' },
  { file: 'data/pipeline.md' },
  { file: 'data/scan-history.tsv' },
  { file: 'data/scan-runs.tsv' },
  { file: 'data/follow-ups.md' },
  { file: 'data/active-interviews.md' },
  { file: 'data/agent-inbox.md' },
  { file: 'data/blacklist.md' },
  { file: 'data/contacts.tsv' },
  { file: 'data/salary-observations.tsv' },
  { file: 'data/assessments.tsv' },
  { file: 'data/pdf-index.tsv' },
  { file: 'data/career-profile.yml' },
  { dir: 'data/offers', recursive: true },
  { dir: 'data/outcomes', recursive: true },
  { dir: 'data/upskill', recursive: true },
  // Evaluation output
  { dir: 'reports', ext: ['.md'], recursive: false },
  { dir: 'output', recursive: true },
  { dir: 'jds', recursive: true },
  // Batch
  { file: 'batch/batch-state.tsv' },
  { file: 'batch/batch-input.tsv' },
  { dir: 'batch/logs', recursive: true },
  { dir: 'batch/tracker-additions', ext: ['.tsv'], recursive: false },
  { dir: 'batch/tracker-additions/merged', ext: ['.tsv'], recursive: false },
];
const SKIP_NAMES = new Set(['.gitkeep', '.DS_Store']);
// System-owned scaffold files inside user directories: shipped by career-ops, never synced.
const SKIP_RELS = new Set(['documents/README.md', 'writing-samples/README.md', 'interview-prep/sessions/README.md']);
// This skill travels in every snapshot under _skill/, so a new machine can restore it from Drive.
// Upload-only: apply-download never writes these.
const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_FILES = ['SKILL.md', 'sync.mjs'];
const SKILL_PREFIX = '_skill/sync-google-drive/';
const MIME = {
  '.md': 'text/markdown', '.tsv': 'text/tab-separated-values', '.csv': 'text/csv',
  '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json',
  '.html': 'text/html', '.pdf': 'application/pdf', '.tex': 'text/x-tex',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};
const LARGE_BYTES = 256 * 1024; // downloads above this are flagged: base64 goes through the model's context

function args() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    opts[key] = val;
  }
  return { cmd, opts };
}

function die(msg, code = 1) {
  console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  process.exit(code);
}

function findProject(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, 'AGENTS.md')) && existsSync(join(dir, 'modes'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

async function roots(opts) {
  // Default: the checkout this skill ships in (<repo>/.claude/skills/sync-google-drive/), else the cwd.
  const project = findProject(opts.project || process.env.CAREER_OPS_PROJECT || process.cwd())
    || (!opts.project && findProject(SKILL_DIR));
  if (!project) die('career-ops checkout not found (no AGENTS.md + modes/). Pass --project DIR.');
  const resolver = await import(pathToFileURL(join(project, 'path-resolver.mjs')).href);
  const dataRoot = resolver.getCareerOpsRoot();
  return { project, dataRoot, stateDir: join(dataRoot, 'data', '.gdrive-sync') };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(sep).join('/');

function walk(dir, recursive) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { if (recursive) out.push(...walk(p, true)); }
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function inScope(rel) {
  if (!rel || isAbsolute(rel) || rel.split('/').some((s) => s === '..' || s === '')) return false;
  const name = rel.split('/').pop();
  if (SKIP_NAMES.has(name) || SKIP_RELS.has(rel)) return false;
  return SCOPE.some((s) => {
    if (s.file) return rel === s.file;
    if (!rel.startsWith(s.dir + '/')) return false;
    const rest = rel.slice(s.dir.length + 1);
    if (!s.recursive && rest.includes('/')) return false;
    return !s.ext || s.ext.includes(extname(rel).toLowerCase());
  });
}

function scanFiles(dataRoot, { includeSkill = false } = {}) {
  const found = new Map(); // rel -> abs (Map dedupes overlapping scope entries)
  for (const s of SCOPE) {
    const paths = s.file
      ? [join(dataRoot, s.file)].filter((p) => existsSync(p) && statSync(p).isFile())
      : walk(join(dataRoot, s.dir), s.recursive);
    for (const p of paths) {
      const rel = toPosix(relative(dataRoot, p));
      if (inScope(rel)) found.set(rel, p);
    }
  }
  if (includeSkill) {
    for (const f of SKILL_FILES) {
      const p = join(SKILL_DIR, f);
      if (existsSync(p)) found.set(SKILL_PREFIX + f, p);
    }
  }
  return [...found].map(([rel, p]) => {
    const buf = readFileSync(p);
    const hash = sha256(buf);
    return {
      rel, abs: p, size: buf.length, sha256: hash,
      mime: MIME[extname(p).toLowerCase()] || 'application/octet-stream',
      fileRef: `sha256:${hash}:${toPosix(p)}`,
    };
  }).sort((a, b) => a.rel.localeCompare(b.rel));
}

function folderList(files) {
  const set = new Set();
  for (const f of files) {
    const parts = f.rel.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function loadState(stateDir) {
  const p = join(stateDir, 'state.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { baseline: {}, lastUpload: null, lastDownload: null };
}
function saveState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

function readJson(path) {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.b64')) return JSON.parse(Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8'));
  return JSON.parse(raw);
}

function snapshotName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const { cmd, opts } = args();
  if (!cmd || cmd === 'help' || opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
    return;
  }
  const { project, dataRoot, stateDir } = await roots(opts);
  const state = loadState(stateDir);

  if (cmd === 'status') {
    console.log(JSON.stringify({ ok: true, project, dataRoot, lastUpload: state.lastUpload, lastDownload: state.lastDownload, baselineFiles: Object.keys(state.baseline).length }, null, 2));
    return;
  }

  if (cmd === 'scan') {
    if (!opts.out) die('scan needs --out PLAN.json');
    const files = scanFiles(dataRoot, { includeSkill: true });
    // The connector cannot send files from ~/.claude by reference. When the skill runs from there
    // (a user-level install), its own files are copied into --stage-dir (the session scratchpad) and
    // referenced from there: same bytes, same sha. From the repo's .claude/skills/ no staging is needed.
    const inUserClaude = toPosix(SKILL_DIR).startsWith(toPosix(join(homedir(), '.claude')) + '/');
    const stageDir = opts['stage-dir'] ? resolve(opts['stage-dir'], 'skill-stage') : null;
    for (const f of files.filter((x) => x.rel.startsWith(SKILL_PREFIX) && inUserClaude)) {
      if (!stageDir) die('scan needs --stage-dir DIR (the session scratchpad): skill files must be staged outside ~/.claude');
      const copy = join(stageDir, f.rel.slice(SKILL_PREFIX.length));
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(f.abs, copy);
      f.abs = copy;
      f.fileRef = `sha256:${f.sha256}:${toPosix(copy)}`;
    }
    const prev = state.lastUpload?.files || {};
    const now = Object.fromEntries(files.map((f) => [f.rel, f.sha256]));
    const added = files.filter((f) => !(f.rel in prev)).map((f) => f.rel);
    const modified = files.filter((f) => f.rel in prev && prev[f.rel] !== f.sha256).map((f) => f.rel);
    const removed = Object.keys(prev).filter((r) => !(r in now));
    const large = files.filter((f) => f.size > LARGE_BYTES).map((f) => ({ rel: f.rel, size: f.size }));
    const plan = {
      project, dataRoot, snapshot: snapshotName(), driveRoot: 'career-ops',
      folders: folderList(files), files,
      changedSinceLastUpload: { added, modified, removed, any: !state.lastUpload || added.length + modified.length + removed.length > 0 },
      lastUpload: state.lastUpload ? { snapshot: state.lastUpload.snapshot, at: state.lastUpload.at } : null,
      large,
    };
    writeFileSync(opts.out, JSON.stringify(plan, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, plan: resolve(opts.out), snapshot: plan.snapshot, fileCount: files.length, totalBytes: files.reduce((s, f) => s + f.size, 0), folders: plan.folders, changedSinceLastUpload: plan.changedSinceLastUpload, lastUpload: plan.lastUpload, large }, null, 2));
    return;
  }

  if (cmd === 'finalize') {
    for (const k of ['plan', 'ids', 'snapshot', 'folder-id', 'out']) if (!opts[k]) die(`finalize needs --${k}`);
    const plan = readJson(opts.plan);
    const ids = readJson(opts.ids); // { "<rel>": "<driveFileId>" }
    const missing = plan.files.filter((f) => !ids[f.rel]).map((f) => f.rel);
    if (missing.length) die(`no Drive file id recorded for: ${missing.join(', ')} (upload them, or the snapshot is incomplete)`);
    const manifest = {
      tool: 'career-ops sync-google-drive', version: 1, snapshot: opts.snapshot, snapshotFolderId: opts['folder-id'],
      createdAt: new Date().toISOString(),
      files: plan.files.map((f) => ({ rel: f.rel, sha256: f.sha256, size: f.size, mime: f.mime, fileId: ids[f.rel] })),
    };
    writeFileSync(opts.out, JSON.stringify(manifest, null, 2) + '\n');
    const files = Object.fromEntries(plan.files.map((f) => [f.rel, f.sha256]));
    state.lastUpload = { snapshot: opts.snapshot, folderId: opts['folder-id'], at: manifest.createdAt, files };
    const dataFiles = Object.fromEntries(Object.entries(files).filter(([rel]) => !rel.startsWith(SKILL_PREFIX)));
    state.baseline = { ...state.baseline, ...dataFiles };
    saveState(stateDir, state);
    const buf = readFileSync(opts.out);
    console.log(JSON.stringify({ ok: true, manifest: resolve(opts.out), fileRef: `sha256:${sha256(buf)}:${toPosix(resolve(opts.out))}`, files: manifest.files.length }, null, 2));
    return;
  }

  if (cmd === 'plan-download' || cmd === 'apply-download') {
    if (!opts.manifest) die(`${cmd} needs --manifest FILE`);
    const manifest = readJson(opts.manifest);
    if (manifest.tool !== 'career-ops sync-google-drive' || !Array.isArray(manifest.files)) die('not a sync-google-drive manifest');
    const isSkill = (rel) => rel.startsWith(SKILL_PREFIX);
    const rejected = manifest.files.filter((f) => !inScope(f.rel) && !isSkill(f.rel)).map((f) => f.rel);
    // The bundled skill is never written by apply-download; it is reported so a new machine can restore it by hand.
    const skillFiles = manifest.files.filter((f) => isSkill(f.rel)).map((f) => {
      const installed = join(SKILL_DIR, f.rel.slice(SKILL_PREFIX.length));
      const sameAsInstalled = existsSync(installed) && sha256(readFileSync(installed)) === f.sha256;
      return { rel: f.rel, fileId: f.fileId, sha256: f.sha256, sameAsInstalled };
    });

    const rows = manifest.files.filter((f) => inScope(f.rel)).map((f) => {
      const local = join(dataRoot, f.rel);
      const localSha = existsSync(local) ? sha256(readFileSync(local)) : null;
      const base = state.baseline[f.rel] || null;
      let status;
      if (!localSha) status = 'new';
      else if (localSha === f.sha256) status = 'same';
      else if (base && localSha === base) status = 'remote-changed'; // local untouched since last sync: safe to take
      else status = 'conflict'; // local edited since last sync (or never synced) and differs from Drive
      return { ...f, status, localSha, large: f.size > LARGE_BYTES };
    });

    if (cmd === 'plan-download') {
      const remoteRels = new Set(manifest.files.map((f) => f.rel));
      const localOnly = scanFiles(dataRoot).filter((f) => !remoteRels.has(f.rel)).map((f) => f.rel);
      const by = (s) => rows.filter((r) => r.status === s).map((r) => ({ rel: r.rel, fileId: r.fileId, size: r.size, large: r.large }));
      console.log(JSON.stringify({ ok: true, snapshot: manifest.snapshot, createdAt: manifest.createdAt, new: by('new'), remoteChanged: by('remote-changed'), conflict: by('conflict'), same: by('same').length, localOnly, skillFiles, rejectedOutOfScope: rejected }, null, 2));
      return;
    }

    if ((!opts.staged && !opts.staging) || !opts.files) die('apply-download needs --staged MAP.json (or --staging DIR) and --files rel1,rel2,...');
    const stagedMap = opts.staged ? readJson(opts.staged) : null;
    const wanted = String(opts.files).split(',').map((s) => s.trim()).filter(Boolean);
    const byRel = Object.fromEntries(rows.map((r) => [r.rel, r]));
    const backupDir = join(stateDir, 'backup', snapshotName());
    const written = [], failed = [];
    for (const rel of wanted) {
      const row = byRel[rel];
      if (!row) { failed.push({ rel, error: 'not in manifest or out of scope' }); continue; }
      // --staged MAP.json: { "<rel>": "<raw file the connector saved>" } (preferred);
      // --staging DIR: fallback, <DIR>/<rel>.b64 holding base64 text.
      let buf;
      if (stagedMap) {
        const p = stagedMap[rel];
        if (!p || !existsSync(p)) { failed.push({ rel, error: `staged file missing: ${p || '(not in --staged map)'}` }); continue; }
        buf = readFileSync(p);
      } else {
        const staged = join(opts.staging, rel + '.b64');
        if (!existsSync(staged)) { failed.push({ rel, error: `staged file missing: ${staged}` }); continue; }
        buf = Buffer.from(readFileSync(staged, 'utf8').replace(/\s+/g, ''), 'base64');
      }
      const got = sha256(buf);
      if (got !== row.sha256) { failed.push({ rel, error: `sha256 mismatch (got ${got.slice(0, 12)}, manifest ${row.sha256.slice(0, 12)}); not written` }); continue; }
      const dest = join(dataRoot, rel);
      let backup = null;
      if (existsSync(dest)) {
        backup = join(backupDir, rel);
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(dest, backup);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
      state.baseline[rel] = row.sha256;
      written.push({ rel, backup });
    }
    state.lastDownload = { snapshot: manifest.snapshot, at: new Date().toISOString(), files: written.map((w) => w.rel) };
    saveState(stateDir, state);
    console.log(JSON.stringify({ ok: failed.length === 0, written, failed }, null, 2));
    process.exit(failed.length ? 2 : 0);
  }

  die(`unknown command: ${cmd}`);
}

main().catch((e) => die(e.stack || String(e)));
