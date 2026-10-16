#!/usr/bin/env node
// CKA practice webapp — zero-dependency local server.
// Serves the UI and runs kubectl (and helm, if installed) against one pinned context.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const PORT = Number(process.env.PORT || 8377);
// Listens on all interfaces so other devices on the LAN can use it. Anyone who can reach this
// port can run kubectl against the cluster — set HOST=127.0.0.1 on networks you don't trust.
const HOST = process.env.HOST || '0.0.0.0';
const KUBE_CONTEXT = process.env.KUBE_CONTEXT || 'minikube';
// Hostname this is published under behind an https proxy or tunnel, e.g. cka.example.com.
const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACE = path.join(__dirname, 'workspace');
const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 400_000;
const EDIT_HELPER = path.join(__dirname, 'edit-helper.js');
const EDIT_MARK = /\u0001cka-edit (.*)\n/;
const EDIT_IDLE_MS = 30 * 60_000;

const { tasks, domains, examInfo, cheatsheet, helpers } = require('./tasks');
const { scenarios, scenarioSource } = require('./scenarios');
// The quiz bank is optional: without quiz.js the server still starts and the Quiz tab is empty.
let quiz = [];
try {
  ({ quiz } = require('./quiz'));
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND' || !err.message.includes("'./quiz'")) console.warn(`quiz.js not loaded: ${err.message}`);
}
if (!Array.isArray(quiz)) quiz = [];
const taskById = new Map([...tasks, ...scenarios].map((t) => [t.id, t]));

fs.mkdirSync(WORKSPACE, { recursive: true });
const HAS_HELM = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;
const HAS_MINIKUBE = spawnSync('minikube', ['version', '--short'], { stdio: 'ignore' }).status === 0;
const PROFILE = helpers.PROFILE;
// Used when the Cluster page starts the profile; for an existing profile minikube keeps its own settings.
const MINIKUBE_START_ARGS = (process.env.MINIKUBE_START_ARGS || '--driver=docker --container-runtime=containerd --nodes=3 --cpus=2 --memory=2200 --addons=metrics-server').split(/\s+/).filter(Boolean);

// ---------- process helpers ----------

function run(bin, args, { stdin, timeout = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(bin, args, { cwd: WORKSPACE, env: process.env });
    } catch (err) {
      return resolve({ code: 127, stdout: '', stderr: String(err.message), ms: 0 });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM'); // lets kubectl clean up (e.g. run --rm) before the hard kill
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeout);
    const cap = (buf, chunk) => (buf.length < MAX_OUTPUT ? buf + chunk : buf);
    child.stdout.on('data', (d) => (stdout = cap(stdout, d)));
    child.stderr.on('data', (d) => (stderr = cap(stderr, d)));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${bin}: ${err.message}`, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        stderr += `\n[stopped after ${timeout / 1000}s — streaming/interactive commands are cut off here]`;
      }
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

const kubectl = (args, opts) => run('kubectl', ['--context', KUBE_CONTEXT, ...args], opts);

// ---------- minikube profile control ----------
// One start/stop/delete at a time. It runs in the background (start takes minutes, longer than a
// proxy or tunnel holds a request open) and the Cluster page polls its log.

let clusterJob = null; // { action, running, log, code, startedAt, endedAt }
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function clusterArgs(action) {
  // --keep-context: never move the user's current kubectl context onto this profile
  if (action === 'start') return ['start', '-p', PROFILE, '--keep-context', ...MINIKUBE_START_ARGS];
  return [action, '-p', PROFILE];
}

// minikube start (even with --keep-context when restarting a stopped profile) and delete rewrite
// the kubeconfig's current-context. Put the user's own context back afterwards.
async function restoreContext(before) {
  if (!before) return;
  const now = (await run('kubectl', ['config', 'current-context'])).stdout.trim();
  if (now !== before) await run('kubectl', ['config', 'use-context', before]);
}

async function startClusterJob(action) {
  const args = clusterArgs(action);
  const job = { action, running: true, log: `$ minikube ${args.join(' ')}\n`, code: null, startedAt: Date.now(), endedAt: null };
  clusterJob = job; // claim the slot before the first await
  const before = (await run('kubectl', ['config', 'current-context'])).stdout.trim();
  const child = spawn('minikube', args, { cwd: WORKSPACE, env: { ...process.env, MINIKUBE_IN_STYLE: 'false' } });
  const add = (d) => {
    if (job.log.length < MAX_OUTPUT) job.log += String(d).replace(ANSI, '');
  };
  const done = async (code) => {
    if (job.code !== null) return;
    job.code = code;
    await restoreContext(before);
    job.running = false;
    job.endedAt = Date.now();
  };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (err) => {
    add(`minikube: ${err.message}\n`);
    done(127);
  });
  child.on('close', (code) => done(code ?? 1));
  child.stdin.end();
}

// Per-node state from "minikube status": an array for multi-node profiles, an object for one node.
async function clusterState() {
  if (!HAS_MINIKUBE) return { exists: false, nodes: [], error: 'minikube is not installed on this machine' };
  const r = await run('minikube', ['status', '-p', PROFILE, '-o', 'json'], { timeout: 20_000 });
  if (r.code === 85) return { exists: false, nodes: [] };
  try {
    const nodes = [].concat(JSON.parse(r.stdout)).map((n) => ({ name: n.Name, host: n.Host, kubelet: n.Kubelet, apiserver: n.APIServer, worker: !!n.Worker }));
    return { exists: true, nodes };
  } catch {
    return { exists: true, nodes: [], error: (r.stderr || r.stdout).replace(ANSI, '').trim().split('\n').pop() };
  }
}

// ---------- kubectl edit sessions ----------
// kubectl edit (and friends) run with edit-helper.js as their editor: kubectl does the fetching,
// validating and patching exactly as in a real terminal, and the browser plays the part of vi.

const edits = new Map();
let editSeq = 0;

function startEdit(bin, args) {
  const id = `${Date.now().toString(36)}-${++editSeq}`;
  const s = { id, stdout: '', stderr: '', file: null, waiter: null, queued: null, started: Date.now() };
  const shq = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
  s.child = spawn(bin, args, { cwd: WORKSPACE, env: { ...process.env, KUBE_EDITOR: `${shq(process.execPath)} ${shq(EDIT_HELPER)}` } });
  const settle = (res) => {
    clearTimeout(s.timer);
    if (s.waiter) s.waiter(res);
    else s.queued = res;
    s.waiter = null;
  };
  const finish = (code, extra = '') => {
    if (!edits.delete(id)) return;
    s.child.stdin.end(); // never leave a helper waiting on a dead session
    settle({ code, stdout: s.stdout, stderr: s.stderr + extra, ms: Date.now() - s.started });
  };
  s.child.stdout.on('data', (d) => {
    s.stdout += d;
    const m = s.stdout.match(EDIT_MARK);
    if (!m) return;
    s.stdout = s.stdout.replace(EDIT_MARK, '');
    // only ever touch the temp file kubectl itself created for this edit
    if (path.dirname(m[1]) !== os.tmpdir() || !path.basename(m[1]).startsWith('kubectl-edit-')) return s.child.kill('SIGKILL');
    s.file = m[1];
    let content;
    try {
      content = fs.readFileSync(s.file, 'utf8');
    } catch (err) {
      s.stderr += `could not read ${s.file}: ${err.message}\n`;
      return s.child.kill('SIGKILL');
    }
    const note = s.stderr.trim();
    s.stderr = '';
    settle({ edit: { id, content, note } });
    // closing stdin releases the helper, and kubectl then sees an unchanged file: a cancelled edit
    s.timer = setTimeout(() => s.child.stdin.end(), EDIT_IDLE_MS);
  });
  s.child.stderr.on('data', (d) => (s.stderr += d));
  s.child.on('error', (err) => finish(127, `${bin}: ${err.message}`));
  s.child.on('close', (code) => finish(code ?? 1));
  s.child.stdin.on('error', () => {});
  edits.set(id, s);
  return nextEditEvent(s);
}

// Resolves with the next thing kubectl does: asks for another edit ({ edit }) or exits ({ code, … }).
function nextEditEvent(s) {
  if (s.queued) {
    const res = s.queued;
    s.queued = null;
    return Promise.resolve(res);
  }
  return new Promise((resolve) => (s.waiter = resolve));
}

// Leaving the file untouched is how kubectl recognises a cancelled edit.
function resumeEdit(id, content) {
  const s = edits.get(id);
  if (!s || !s.file) return { code: 1, stdout: '', stderr: `This edit is no longer open (edits left for ${EDIT_IDLE_MS / 60_000} min are abandoned) — run the command again.`, ms: 0 };
  clearTimeout(s.timer);
  if (typeof content === 'string') fs.writeFileSync(s.file, content);
  s.file = null;
  s.child.stdin.write('\n');
  return nextEditEvent(s);
}

// ---------- command line parsing (no shell is ever involved) ----------

function tokenize(line) {
  const tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (c === '#' && !cur && !has) {
      break; // trailing comment
    } else if (/\s/.test(c)) {
      if (has || cur) tokens.push({ v: cur, raw: false });
      cur = '';
      has = false;
    } else if ((c === '|' || c === '>' || c === '<' || c === ';' || c === '&') && !cur && !has) {
      let op = c;
      while (line[i + 1] === c) op += line[++i];
      tokens.push({ v: op, raw: true });
    } else if (c === '>' || c === '|' || c === ';' || c === '<') {
      tokens.push({ v: cur, raw: false });
      cur = '';
      has = false;
      i--; // re-read the operator as its own token
    } else {
      cur += c;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} quote`);
  if (has || cur) tokens.push({ v: cur, raw: false });
  return tokens;
}

function safeWorkspacePath(rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('Missing file path');
  const abs = path.resolve(WORKSPACE, rel.replace(/^~\//, '').replace(/^\/+/, ''));
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) throw new Error('Path escapes the workspace folder');
  return abs;
}

// Global flags that take a separate value, so "kubectl -n dev edit …" is recognised as "edit".
const VALUE_FLAGS = new Set(['-n', '--namespace', '-v', '--v', '--as', '--as-group', '--as-uid', '--user', '--request-timeout', '--cache-dir', '--certificate-authority', '--client-certificate', '--client-key', '--tls-server-name', '--username', '--password', '--profile', '--profile-output', '--log-flush-frequency', '--vmodule']);

function subcommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') return undefined;
    if (!argv[i].startsWith('-')) return argv[i];
    if (VALUE_FLAGS.has(argv[i])) i++;
  }
  return undefined;
}

function parseCommand(line) {
  const tokens = tokenize(line.trim());
  if (!tokens.length) throw new Error('Empty command');

  let redirect = null;
  const ops = tokens.filter((t) => t.raw);
  if (ops.length) {
    const i = tokens.findIndex((t) => t.raw);
    const op = tokens[i].v;
    if ((op === '>' || op === '>>') && i === tokens.length - 2 && ops.length === 1) {
      redirect = { file: tokens[i + 1].v, append: op === '>>' };
      tokens.splice(i);
    } else {
      throw new Error(
        `"${op}" is not supported — this console runs one kubectl command at a time, without a shell.\n` +
          'Supported: "> file" / ">> file" to save output into the workspace. ' +
          'Instead of pipes use -o jsonpath, --sort-by, -l selectors or --field-selector (good exam habits anyway).'
      );
    }
  }

  const argv = tokens.map((t) => t.v);
  let interactive = false;
  let bin = argv.shift();
  if (bin === 'k') bin = 'kubectl';
  if (bin !== 'kubectl' && bin !== 'helm') {
    throw new Error(`Only kubectl (alias k)${HAS_HELM ? ' and helm' : ''} can be run here — got "${bin}".`);
  }
  if (bin === 'helm' && !HAS_HELM) throw new Error('helm is not installed on this machine. Install it and restart the server to use it here.');

  for (const a of argv) {
    if (/^--(context|kubeconfig|kube-context|cluster|server|token)(=|$)/.test(a) || a === '-s') {
      throw new Error(`"${a}" is blocked: this console is pinned to the "${KUBE_CONTEXT}" context.`);
    }
  }
  if (bin === 'kubectl') {
    const sub = subcommand(argv);
    // these open $KUBE_EDITOR: kubectl edit, apply edit-last-applied, create --edit
    interactive = sub === 'edit' || (sub === 'apply' && argv.includes('edit-last-applied')) || argv.some((a) => a === '--edit' || a === '--edit=true');
    if (interactive && redirect) throw new Error('Output redirection is not supported together with an editor session.');
    const beforeDashDash = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
    if (beforeDashDash.some((a) => a === '--tty' || a === '-t' || /^-[a-su-zA-Z]*t[a-zA-Z]*$/.test(a))) {
      throw new Error('No TTY here, so drop -t / -it. Non-interactive forms work, e.g.\n  kubectl exec mypod -- cat /etc/hosts\n  kubectl run tmp --rm -i --restart=Never --image=busybox:1.36 -- nslookup kubernetes');
    }
    if (['proxy', 'port-forward', 'attach'].includes(sub)) {
      throw new Error(`kubectl ${sub} is long-running and is not supported in this console.`);
    }
  }
  const args = bin === 'kubectl' ? ['--context', KUBE_CONTEXT, ...argv] : ['--kube-context', KUBE_CONTEXT, ...argv];
  return { bin, args, redirect, interactive };
}

async function execLine(line, stdin) {
  const { bin, args, redirect, interactive } = parseCommand(line);
  if (interactive) return startEdit(bin, args);
  const target = redirect ? safeWorkspacePath(redirect.file) : null;
  // rollout status / wait legitimately block while pods start
  const slow = bin === 'helm' || args.includes('wait') || (args.includes('rollout') && args.includes('status'));
  const res = await run(bin, args, { stdin, timeout: slow ? 120_000 : EXEC_TIMEOUT_MS });
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (redirect.append) fs.appendFileSync(target, res.stdout);
    else fs.writeFileSync(target, res.stdout);
    res.stdout = '';
    res.note = `${res.code === 0 ? 'output' : 'stdout'} written to workspace/${path.relative(WORKSPACE, target)}`;
  }
  return res;
}

// ---------- task setup / checks / cleanup ----------

async function runSteps(cmds, log, opts) {
  let ok = true;
  for (const args of cmds || []) {
    const r = await kubectl(args, opts);
    log.push({ cmd: 'kubectl ' + args.join(' '), code: r.code, out: (r.stdout + r.stderr).trim() });
    if (r.code !== 0) ok = false;
  }
  return ok;
}

async function setupTask(task) {
  const log = [];
  const s = task.setup || {};
  let ok = true;
  for (const [rel, content] of Object.entries(s.files || {})) {
    const abs = safeWorkspacePath(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    log.push({ cmd: `write workspace/${rel}`, code: 0, out: '' });
  }
  ok = (await runSteps(s.pre, log, { timeout: 120_000 })) && ok;
  if (s.yaml) {
    const r = await kubectl(['apply', '-f', '-'], { stdin: s.yaml, timeout: 60_000 });
    log.push({ cmd: 'kubectl apply -f - (task resources)', code: r.code, out: (r.stdout + r.stderr).trim() });
    if (r.code !== 0) ok = false;
  }
  ok = (await runSteps(s.post, log, { timeout: 120_000 })) && ok;
  return { ok, log };
}

// wait=false returns immediately and lets namespaces terminate in the background
async function cleanupTask(task, wait = true) {
  const log = [];
  const cmds = (task.cleanup || []).map((args) => (!wait && args[0] === 'delete' ? [...args, '--wait=false'] : args));
  await runSteps(cmds, log, { timeout: 120_000 });
  for (const rel of task.cleanupFiles || []) {
    fs.rmSync(safeWorkspacePath(rel), { recursive: true, force: true });
    log.push({ cmd: `remove workspace/${rel}`, code: 0, out: '' });
  }
  return { ok: true, log };
}

function evaluate(expect, value, code) {
  const v = value.trim();
  if (expect.exit !== undefined) return code === expect.exit;
  if (code !== 0 && !expect.allowFail) return false;
  if (expect.eq !== undefined) return v === String(expect.eq);
  if (expect.contains !== undefined) return [].concat(expect.contains).every((s) => v.includes(s));
  if (expect.match !== undefined) return new RegExp(expect.match, expect.flags || '').test(v);
  if (expect.notMatch !== undefined) return !new RegExp(expect.notMatch, expect.flags || '').test(v);
  if (expect.gte !== undefined) return Number(v) >= expect.gte;
  if (expect.nonEmpty) return v.length > 0;
  return code === 0;
}

async function checkTask(task) {
  const results = await Promise.all(
    (task.checks || []).map(async (c) => {
      let value = '';
      let code = 0;
      if (c.file) {
        try {
          value = fs.readFileSync(safeWorkspacePath(c.file), 'utf8');
        } catch {
          code = 1;
          value = '(file not found in workspace)';
        }
      } else {
        const r = await kubectl(c.args);
        code = r.code;
        // prefer stdout so warnings on stderr (e.g. from "auth can-i") don't pollute the value
        value = r.stdout.trim() ? r.stdout : r.stderr;
      }
      const pass = evaluate(c.expect, value, code);
      return { desc: c.desc, pass, got: value.trim().slice(0, 300) };
    })
  );
  return { ok: results.length > 0 && results.every((r) => r.pass), results };
}

// ---------- workspace files ----------

function listFiles(dir = WORKSPACE, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(abs, out);
    else if (e.isFile()) out.push(path.relative(WORKSPACE, abs));
  }
  return out.sort();
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 2_000_000) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Requests must come from this page itself: blocks other websites (CSRF) and DNS rebinding
// from reaching the kubectl runner.
function allowedHosts() {
  const names = ['localhost', os.hostname(), `${os.hostname()}.local`];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) names.push(a.family === 'IPv6' ? `[${a.address}]` : a.address);
  }
  return names.map((n) => `${n.toLowerCase()}:${PORT}`);
}

// The Host header must be one of this machine's own names/addresses (an attacker's domain
// rebinding to us fails this), and writes must come from the page served by that same host.
// PUBLIC_HOST is the one extra name accepted, for a reverse proxy or tunnel that serves it over https.
function isTrusted(req) {
  const host = (req.headers.host || '').toLowerCase();
  const isPublic = PUBLIC_HOST !== '' && host === PUBLIC_HOST;
  if (!isPublic && !allowedHosts().includes(host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && origin.toLowerCase() !== `${isPublic ? 'https' : 'http'}://${host}`) return false;
  return req.headers['x-cka-lab'] === '1' && /^application\/json/.test(req.headers['content-type'] || '');
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/api/meta') {
    return send(res, 200, { tasks, scenarios, scenarioSource, quiz, domains, examInfo, cheatsheet, context: KUBE_CONTEXT, helm: HAS_HELM, profile: PROFILE, minikube: HAS_MINIKUBE });
  }
  if (m === 'GET' && p === '/api/status') {
    const [ver, nodes] = await Promise.all([
      kubectl(['version', '-o', 'json'], { timeout: 8000 }),
      kubectl(['get', 'nodes', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"="}{.status.conditions[?(@.type=="Ready")].status}{" "}{end}'], { timeout: 8000 }),
    ]);
    let server = null;
    try {
      server = JSON.parse(ver.stdout).serverVersion?.gitVersion || null;
    } catch {}
    const nodeList = nodes.code === 0 ? nodes.stdout.trim().split(/\s+/).filter(Boolean).map((s) => ({ name: s.split('=')[0], ready: s.split('=')[1] === 'True' })) : [];
    return send(res, 200, { context: KUBE_CONTEXT, up: nodes.code === 0, server, nodes: nodeList, error: nodes.code === 0 ? null : (nodes.stderr || ver.stderr).trim().split('\n').pop() });
  }
  if (m === 'GET' && p === '/api/cluster') {
    return send(res, 200, { profile: PROFILE, context: KUBE_CONTEXT, startArgs: clusterArgs('start'), ...(await clusterState()), job: clusterJob });
  }
  const cm = p.match(/^\/api\/cluster\/(start|stop|delete)$/);
  if (m === 'POST' && cm) {
    if (!HAS_MINIKUBE) return send(res, 400, { error: 'minikube is not installed on this machine.' });
    if (clusterJob?.running) return send(res, 409, { error: `minikube ${clusterJob.action} is still running.` });
    // deleting is irreversible: the request has to name the profile it means
    if (cm[1] === 'delete' && (await readJson(req)).profile !== PROFILE) return send(res, 400, { error: `Type the profile name "${PROFILE}" to confirm.` });
    await startClusterJob(cm[1]);
    return send(res, 202, { job: clusterJob });
  }
  if (m === 'POST' && p === '/api/exec') {
    const { command, stdin } = await readJson(req);
    try {
      return send(res, 200, await execLine(String(command || ''), typeof stdin === 'string' ? stdin : undefined));
    } catch (err) {
      return send(res, 200, { code: 2, stdout: '', stderr: err.message, ms: 0 });
    }
  }
  if (m === 'POST' && p === '/api/edit') {
    const { id, content, cancel } = await readJson(req);
    return send(res, 200, await resumeEdit(String(id), cancel ? undefined : content));
  }
  if (m === 'POST' && p === '/api/apply') {
    const { yaml, action } = await readJson(req);
    const verb = action === 'delete' ? ['delete', '-f', '-'] : action === 'dry-run' ? ['apply', '--dry-run=server', '-f', '-'] : ['apply', '-f', '-'];
    return send(res, 200, await kubectl(verb, { stdin: String(yaml || '') }));
  }
  if (m === 'GET' && p === '/api/files') return send(res, 200, { files: listFiles() });
  if (p === '/api/file') {
    try {
      if (m === 'GET') return send(res, 200, { content: fs.readFileSync(safeWorkspacePath(url.searchParams.get('path')), 'utf8') });
      const body = await readJson(req);
      const abs = safeWorkspacePath(body.path);
      if (m === 'PUT') {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(body.content ?? ''));
        return send(res, 200, { ok: true, path: path.relative(WORKSPACE, abs) });
      }
      if (m === 'DELETE') {
        fs.rmSync(abs, { force: true });
        return send(res, 200, { ok: true });
      }
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }
  const tm = p.match(/^\/api\/tasks\/([\w-]+)\/(setup|check|cleanup|reset)$/);
  if (m === 'POST' && tm) {
    const task = taskById.get(tm[1]);
    if (!task) return send(res, 404, { error: 'Unknown task' });
    if (tm[2] === 'setup') return send(res, 200, await setupTask(task));
    if (tm[2] === 'check') return send(res, 200, await checkTask(task));
    if (tm[2] === 'cleanup') return send(res, 200, await cleanupTask(task, false));
    const c = await cleanupTask(task);
    const s = await setupTask(task);
    return send(res, 200, { ok: s.ok, log: [...c.log, ...s.log] });
  }
  send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isTrusted(req)) return send(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const abs = path.resolve(PUBLIC_DIR, rel);
    if (!abs.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs)] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CKA practice lab → http://localhost:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`                   http://${a.address}:${PORT}`);
    }
  }
  if (PUBLIC_HOST) console.log(`                   https://${PUBLIC_HOST} (via your proxy or tunnel)`);
  console.log(`kubectl context: ${KUBE_CONTEXT}${HAS_HELM ? '  (helm available)' : ''}`);
  console.log(`minikube:        ${HAS_MINIKUBE ? `profile ${PROFILE}` : 'not installed (Cluster page disabled)'}`);
  console.log(`workspace:       ${WORKSPACE}`);
});
