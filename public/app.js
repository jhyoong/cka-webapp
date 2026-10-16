'use strict';

// ───────────── helpers ─────────────
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const codeText = (s) => esc(String(s ?? '')).replace(/`([^`]+)`/g, '<code>$1</code>'); // quiz texts: `code` only
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

// Tiny markdown subset used by task texts: paragraphs, "- " lists, "1. " lists, `code`, **bold**.
function md(text) {
  const out = [];
  let list = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*- (.*)/);
    const ol = line.match(/^\s*\d+\. (.*)/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (!line.trim()) {
      close();
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('');
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CKA-Lab': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// ───────────── state ─────────────
let META = null;
let progress = store.get('cka.progress', {}); // { taskId: timestamp }
let exam = store.get('cka.exam', null); // { ids, startedAt, minutes, finishedAt, results }
const lastChecks = {}; // taskId -> last verify result (session only)
let quizHist = store.get('cka.quiz', {}); // { questionId: { seen, correct, last, at } }
let quizRun = null; // current deck (session only): { ids, i, answers: { id: { order, picked } }, finished }
let quizKeys = null; // { pick, next } while a quiz card is on screen
const EXAM_MINUTES = 120;
const EXAM_MIX = { trbl: 4, arch: 3, net: 3, work: 3, stor: 2 };
const PASS_MARK = 66;

const taskById = (id) => META.tasks.find((t) => t.id === id) || META.scenarios.find((t) => t.id === id);
const isScenario = (t) => META.scenarios.includes(t);
const domainById = (id) => META.domains.find((d) => d.id === id);
const examRunning = () => exam && exam.startedAt && !exam.finishedAt;

function setDone(id, done) {
  if (done) progress[id] = Date.now();
  else delete progress[id];
  store.set('cka.progress', progress);
}

// ───────────── cluster status ─────────────
async function refreshStatus() {
  const btn = $('#cluster');
  $('#cluster-text').textContent = 'checking…';
  try {
    const s = await api('/api/status');
    btn.className = 'cluster ' + (s.up ? 'up' : 'down');
    const ready = s.nodes.filter((n) => n.ready).length;
    $('#cluster-text').textContent = s.up ? `${s.context} · ${s.server} · ${ready}/${s.nodes.length} nodes` : `${s.context} · unreachable`;
    btn.title = s.up ? 'Cluster reachable — click to refresh' : `${s.error || 'Cluster unreachable'}\nStart it with: minikube start`;
  } catch {
    btn.className = 'cluster down';
    $('#cluster-text').textContent = 'server offline';
  }
}

// ───────────── terminal ─────────────
const termOut = $('#term-out');
const termInput = $('#term-input');
const cmdHistory = store.get('cka.history', []);
let histPos = cmdHistory.length;
let busy = false;

// Split pasted text into runnable commands: joins "\" continuations and multi-line quotes,
// captures heredoc bodies as stdin, and skips comment lines.
function parseScript(text) {
  const lines = text.split('\n');
  const cmds = [];
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let quote = quoteState(line);
    while ((quote || /\\\s*$/.test(line)) && i + 1 < lines.length) {
      line = quote ? line + '\n' + lines[++i] : line.replace(/\\\s*$/, '') + lines[++i].trimStart();
      quote = quoteState(line);
    }
    if (quote || /\\\s*$/.test(line)) open = true;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(.*?)\s*<<-?\s*(['"]?)(\w+)\2\s*$/);
    if (m) {
      const body = [];
      i++;
      while (i < lines.length && lines[i].trim() !== m[3]) body.push(lines[i++]);
      if (i >= lines.length) open = true;
      cmds.push({ command: m[1], stdin: body.join('\n') + '\n' });
    } else {
      cmds.push({ command: t });
    }
  }
  return { cmds, open };
}

function quoteState(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '\\') i++;
    else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) break;
  }
  return q;
}

function termEntry(cmd) {
  const el = h('div', { class: 'entry running' }, h('div', { class: 'cmd' }, cmd));
  $('.term-welcome', termOut)?.remove();
  termOut.append(el);
  termOut.scrollTop = termOut.scrollHeight;
  return el;
}

function fillEntry(el, r) {
  el.classList.remove('running');
  if (r.stdout) el.append(h('pre', {}, r.stdout.replace(/\n$/, '')));
  if (r.stderr) el.append(h('pre', { class: r.code === 0 ? '' : 'err' }, r.stderr.replace(/\n$/, '')));
  const meta = h('div', { class: 'meta' }, r.code === 0 ? `ok · ${r.ms} ms` : `exit ${r.code} · ${r.ms} ms`);
  if (r.note) meta.append(h('span', {}, r.note));
  if (r.stdout && /^(apiVersion|kind):/m.test(r.stdout)) {
    meta.append(h('button', { onclick: () => openInEditor(r.stdout) }, '→ editor'));
  }
  el.append(meta);
  termOut.scrollTop = termOut.scrollHeight;
}

// kubectl edit: the server holds kubectl open with the temp file it wants edited, and this plays
// the editor. Resolves with whatever kubectl does next — its final result, or the file again
// (with the failure in its header comments) if the save was rejected.
function editInTerminal(el, { id, content, note }) {
  return new Promise((resolve) => {
    const area = h('textarea', { class: 'edit-text', spellcheck: 'false' });
    area.value = content;
    area.rows = Math.min(Math.max(content.split('\n').length + 1, 8), 26);
    const done = async (body) => {
      box.remove();
      try {
        resolve(await api('/api/edit', 'POST', { id, ...body }));
      } catch (err) {
        resolve({ code: 1, stdout: '', stderr: 'Could not reach the lab server: ' + err.message, ms: 0 });
      }
    };
    const save = () => done({ content: area.value });
    const cancel = () => done({ cancel: true });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    const box = h(
      'div',
      { class: 'edit-box' },
      note && h('pre', { class: 'err' }, note),
      area,
      h('div', { class: 'edit-bar' }, h('button', { class: 'primary', onclick: save }, 'Save & quit'), h('button', { onclick: cancel }, 'Cancel'), h('span', {}, 'Ctrl+Enter saves (like :wq) · Esc cancels (like :q!)'))
    );
    el.append(box);
    box.scrollIntoView({ block: 'nearest' });
    area.focus();
    area.setSelectionRange(0, 0);
    area.scrollTop = 0;
  });
}

async function runCommands(cmds) {
  if (busy || !cmds.length) return;
  busy = true;
  $('#term-run').disabled = true;
  try {
    for (const c of cmds) {
      const el = termEntry(c.command + (c.stdin ? '  <<EOF …' : ''));
      let r;
      try {
        r = await api('/api/exec', 'POST', c);
      } catch (err) {
        r = { code: 1, stdout: '', stderr: 'Could not reach the lab server: ' + err.message, ms: 0 };
      }
      while (r.edit) r = await editInTerminal(el, r.edit);
      fillEntry(el, r);
      if (/>\s*\S+\s*$/.test(c.command)) refreshFiles();
    }
  } finally {
    busy = false;
    $('#term-run').disabled = false;
    termInput.focus();
  }
}

function submitTerminal() {
  const text = termInput.value;
  const { cmds } = parseScript(text);
  if (!cmds.length) return;
  if (cmdHistory[cmdHistory.length - 1] !== text) cmdHistory.push(text);
  store.set('cka.history', cmdHistory.slice(-200));
  histPos = cmdHistory.length;
  termInput.value = '';
  autoGrow();
  runCommands(cmds);
}

function autoGrow() {
  termInput.style.height = 'auto';
  termInput.style.height = Math.min(termInput.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
}

function toTerminal(text, run = false) {
  showConsole('term');
  termInput.value = text;
  autoGrow();
  termInput.focus();
  if (run) submitTerminal();
}

termInput.addEventListener('input', autoGrow);
termInput.addEventListener('keydown', (e) => {
  const single = !termInput.value.includes('\n');
  if (e.key === 'Enter' && !e.shiftKey) {
    // keep typing if a heredoc / quote / line continuation is still open
    if (parseScript(termInput.value).open) return;
    e.preventDefault();
    submitTerminal();
  } else if (e.key === 'ArrowUp' && single && histPos > 0) {
    e.preventDefault();
    termInput.value = cmdHistory[--histPos];
    autoGrow();
  } else if (e.key === 'ArrowDown' && single && histPos < cmdHistory.length) {
    e.preventDefault();
    histPos++;
    termInput.value = cmdHistory[histPos] ?? '';
    autoGrow();
  } else if (e.key === 'l' && e.ctrlKey) {
    e.preventDefault();
    termOut.replaceChildren();
  }
});
$('#term-run').addEventListener('click', submitTerminal);
$('#term-clear').addEventListener('click', () => termOut.replaceChildren());

// ───────────── editor ─────────────
const edText = $('#ed-text');
const edOut = $('#ed-out');

function showConsole(tab) {
  $('#layout').classList.remove('no-console');
  store.set('cka.console', true);
  if (!tab) return;
  $$('.console-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + tab));
}

function openInEditor(text, name) {
  showConsole('editor');
  edText.value = text;
  if (name !== undefined) $('#ed-name').value = name;
  edOut.textContent = '';
  edText.focus();
}

function edReport(r, label) {
  const text = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  edOut.className = 'ed-out' + (r.code === 0 ? '' : ' err');
  edOut.textContent = text || (r.code === 0 ? `${label}: ok` : `${label}: failed`);
}

async function edAction(action) {
  if (!edText.value.trim()) return;
  if (action === 'delete' && !confirm('Delete every object described in the editor from the cluster?')) return;
  edOut.className = 'ed-out';
  edOut.textContent = 'working…';
  edReport(await api('/api/apply', 'POST', { yaml: edText.value, action }), action);
}

async function refreshFiles() {
  const { files } = await api('/api/files');
  const sel = $('#ed-files');
  sel.replaceChildren(h('option', { value: '' }, files.length ? 'Open file…' : 'No files yet'), ...files.map((f) => h('option', { value: f }, f)));
}

edText.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    edText.setRangeText('  ', edText.selectionStart, edText.selectionEnd, 'end');
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    edAction('apply');
  }
});
$('#ed-apply').addEventListener('click', () => edAction('apply'));
$('#ed-dry').addEventListener('click', () => edAction('dry-run'));
$('#ed-delete').addEventListener('click', () => edAction('delete'));
$('#ed-save').addEventListener('click', async () => {
  const name = $('#ed-name').value.trim();
  if (!name) return $('#ed-name').focus();
  const r = await api('/api/file', 'PUT', { path: name, content: edText.value });
  edOut.className = 'ed-out' + (r.error ? ' err' : '');
  edOut.textContent = r.error || `saved workspace/${r.path}`;
  refreshFiles();
});
$('#ed-files').addEventListener('change', async (e) => {
  const name = e.target.value;
  if (!name) return;
  const r = await api('/api/file?path=' + encodeURIComponent(name));
  if (r.error) return void (edOut.textContent = r.error);
  openInEditor(r.content, name);
  e.target.value = '';
});
async function loadFromCluster() {
  const ref = $('#ed-load').value.trim();
  if (!ref) return $('#ed-load').focus();
  edOut.className = 'ed-out';
  edOut.textContent = 'loading…';
  const r = await api('/api/exec', 'POST', { command: `kubectl get ${ref} -o yaml` });
  if (r.code === 0) {
    edText.value = r.stdout;
    edOut.textContent = `loaded ${ref} — edit, then Apply (immutable fields need kubectl replace --force)`;
  } else edReport(r, 'load');
}
$('#ed-load-btn').addEventListener('click', loadFromCluster);
$('#ed-load').addEventListener('keydown', (e) => e.key === 'Enter' && loadFromCluster());

$$('.console-tabs button').forEach((b) => b.addEventListener('click', () => showConsole(b.dataset.tab)));
$('#toggle-console').addEventListener('click', () => {
  const hidden = $('#layout').classList.toggle('no-console');
  store.set('cka.console', !hidden);
});
$('#cluster').addEventListener('click', refreshStatus);

// ───────────── views ─────────────
const view = $('#view');
const show = (...nodes) => view.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));

function domainStats(d) {
  const ts = META.tasks.filter((t) => t.domain === d.id);
  return { total: ts.length, done: ts.filter((t) => progress[t.id]).length };
}

function renderOverview() {
  const total = META.tasks.length;
  const done = META.tasks.filter((t) => progress[t.id]).length;
  const next = META.domains.flatMap((d) => META.tasks.filter((t) => t.domain === d.id)).find((t) => !progress[t.id] && t.lab);
  show(
    h('h1', {}, 'Certified Kubernetes Administrator'),
    h('p', { class: 'lede' }, `${done} of ${total} tasks completed. Tasks follow the official curriculum domains and the topics candidates report from the current exam; lab tasks are set up and graded on your local cluster.`),
    next && h('p', {}, h('a', { href: '#/task/' + next.id }, `Continue with: ${next.title} →`)),
    h('p', {}, h('a', { href: '#/scenarios' }, `Exam scenarios: ${META.scenarios.filter((t) => progress[t.id]).length} of ${META.scenarios.length} done →`)),
    quizBank().length > 0 && h('p', {}, h('a', { href: '#/quiz' }, `Quiz: ${quizStats(quizBank()).right} of ${quizBank().length} questions answered correctly on the latest try →`)),

    h('h2', {}, 'Exam domains'),
    ...META.domains.map((d) => {
      const s = domainStats(d);
      return h(
        'div',
        { class: 'domain' },
        h('div', { class: 'domain-head' }, h('span', { class: `w d-${d.id}` }, d.weight + '%'), h('a', { class: 'n', href: '#/tasks/' + d.id }, d.name), h('span', { class: 'p' }, `${s.done}/${s.total} tasks`)),
        h('div', { class: 'bar', title: `${s.done} of ${s.total} done` }, h('i', { class: 'b-' + d.id, style: `width:${s.total ? (100 * s.done) / s.total : 0}%` })),
        h('ul', {}, d.competencies.map((c) => h('li', {}, c)))
      );
    }),

    h('h2', {}, 'The exam'),
    h('dl', { class: 'facts' }, META.examInfo.facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),

    h('h2', {}, 'Exam-day habits'),
    h('ul', { class: 'tips' }, META.examInfo.tips.map((t) => h('li', { html: inline(t) }))),

    h('h2', {}, 'Sources'),
    h('ul', { class: 'tips' }, META.examInfo.sources.map(([t, u]) => h('li', {}, h('a', { href: u, target: '_blank', rel: 'noopener' }, t)))),
    h('p', { class: 'muted' }, 'Exam details change — confirm version, duration and pass mark on the Linux Foundation page before booking.')
  );
}

function taskRow(t, extra) {
  return h(
    'li',
    { class: progress[t.id] ? 'done' : '' },
    h(
      'a',
      { href: '#/task/' + t.id },
      h('span', { class: 'check' }, '✓'),
      h('span', {}, t.title),
      h('span', { class: 'tmeta' }, extra, h('span', { class: 'tag ' + (t.lab ? 'lab' : 'walk') }, t.lab ? 'lab' : 'walkthrough'), `${t.difficulty} · ${t.minutes} min`)
    )
  );
}

function renderTasks(filter = 'all') {
  const chip = (id, label) => h('button', { class: 'chip' + (filter === id ? ' on' : ''), onclick: () => (location.hash = '#/tasks/' + id) }, label);
  const doms = META.domains.filter((d) => filter === 'all' || filter === d.id);
  show(
    h('h1', {}, 'Practice tasks'),
    h('p', { class: 'lede' }, 'Lab tasks create their own namespaces on the cluster, check your work, and clean up after themselves. Walkthroughs cover node-level work (kubeadm, etcd, kubelet) that a minikube cluster cannot grade.'),
    h('div', { class: 'filters' }, chip('all', 'All'), ...META.domains.map((d) => chip(d.id, `${d.name.split(',')[0].split(' &')[0]} ${d.weight}%`))),
    ...doms.flatMap((d) => [
      h('h3', { class: 'd-' + d.id }, `${d.name} · ${d.weight}%`),
      h('ul', { class: 'tlist' }, META.tasks.filter((t) => t.domain === d.id).map((t) => taskRow(t))),
    ])
  );
}

// "Title ↗" links to the videos a scenario was adapted from
const videoLinks = (t) => t.videos.flatMap(([title, url], i) => [i > 0 && ' · ', h('a', { href: url, target: '_blank', rel: 'noopener' }, title + ' ↗')]);

function renderScenarios() {
  const src = META.scenarioSource;
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  show(
    h('h1', {}, 'Exam scenarios'),
    h('p', { class: 'lede' }, 'Questions candidates report from the current exam, worded the way the exam words them. Most are labs set up and graded on your cluster; node-level ones are walkthroughs. They are separate from the Practice bank and the mock exam, and some cover the same ground with the exam\'s own names.'),
    h('ul', { class: 'tlist' }, META.scenarios.map((t) => taskRow(t, h('span', { class: 'd-' + t.domain }, t.num)))),
    h('p', { class: 'credit' }, 'Scenarios adapted from the YouTube playlist ', link(src.url, `“${src.title}” ↗`), ' by ', link(src.authorUrl, src.author), '. Each scenario links to the video it follows — watch it for the full walkthrough.')
  );
}

function renderResults(res) {
  if (!res) return null;
  return h(
    'div',
    {},
    h('p', { class: 'verdict ' + (res.ok ? 'pass' : 'fail') }, res.ok ? '✓ All checks passed' : `${res.results.filter((r) => r.pass).length} of ${res.results.length} checks passed`),
    h(
      'ul',
      { class: 'results' },
      res.results.map((r) => h('li', {}, h('span', { class: r.pass ? 'pass' : 'fail' }, r.pass ? '✓' : '✗'), h('span', {}, r.desc), !r.pass && h('span', { class: 'got' }, 'got: ' + (r.got || '(empty)'))))
    )
  );
}

function renderTask(id) {
  const t = taskById(id);
  if (!t) return renderTasks();
  const d = domainById(t.domain);
  const inExam = examRunning() && exam.ids.includes(id);
  const sc = isScenario(t);
  const order = inExam ? exam.ids.map(taskById) : sc ? META.scenarios : META.domains.flatMap((dd) => META.tasks.filter((x) => x.domain === dd.id));
  const pos = order.indexOf(t);
  const prev = order[pos - 1];
  const next = order[pos + 1];

  const status = h('span', { class: 'status-line' });
  const resultsBox = h('div', {}, renderResults(lastChecks[id]));
  const logBox = h('div', {});
  const buttons = [];

  const act = async (verb, label) => {
    buttons.forEach((b) => (b.disabled = true));
    status.textContent = label + '…';
    try {
      const r = await api(`/api/tasks/${id}/${verb}`, 'POST', {});
      if (verb === 'check') {
        lastChecks[id] = r;
        resultsBox.replaceChildren(renderResults(r));
        if (r.ok && !inExam) setDone(id, true);
        status.textContent = '';
      } else {
        const failed = r.log.filter((l) => l.code !== 0);
        status.textContent = verb === 'cleanup' ? 'Cleaned up.' : r.ok ? 'Environment ready — solve the task in the console.' : 'Setup had errors, see the log below.';
        logBox.replaceChildren(
          h('details', { open: failed.length > 0 && verb !== 'cleanup' }, h('summary', {}, `${label} log`), h('div', { class: 'setup-log' }, r.log.map((l) => `${l.code === 0 ? '✓' : '✗'} ${l.cmd}\n${l.out ? l.out.replace(/^/gm, '    ') + '\n' : ''}`).join('')))
        );
        delete lastChecks[id];
        resultsBox.replaceChildren();
        refreshFiles();
      }
    } catch (err) {
      status.textContent = 'Request failed: ' + err.message;
    }
    buttons.forEach((b) => (b.disabled = false));
  };

  if (t.lab) {
    buttons.push(
      h('button', { class: 'primary', title: 'Creates the scenario from scratch — any previous attempt is removed first', onclick: () => act('reset', 'Setting up') }, 'Set up / reset'),
      h('button', { onclick: () => act('check', 'Verifying') }, 'Verify'),
      h('button', { class: 'danger', onclick: () => act('cleanup', 'Cleaning up') }, 'Clean up')
    );
  } else {
    const b = h('button', { class: progress[id] ? '' : 'primary' }, progress[id] ? '✓ Studied — undo' : 'Mark as studied');
    b.addEventListener('click', () => {
      setDone(id, !progress[id]);
      renderTask(id);
    });
    buttons.push(b);
  }

  let shown = 0;
  const hintList = h('ol', { class: 'hint' });
  const hintBtn = h('button', {}, 'Show a hint');
  hintBtn.addEventListener('click', () => {
    hintList.append(h('li', { html: inline(t.hints[shown++]) }));
    if (shown >= t.hints.length) hintBtn.remove();
    else hintBtn.textContent = `Next hint (${shown}/${t.hints.length})`;
  });

  show(
    h(
      'div',
      { class: 'crumbs' },
      h('a', { href: inExam ? '#/exam' : sc ? '#/scenarios' : '#/tasks/' + t.domain }, inExam ? '← Mock exam' : sc ? '← Exam scenarios' : `← ${d.name}`),
      h('span', {}, prev && h('a', { href: '#/task/' + prev.id }, '‹ prev'), prev && next && ' · ', next && h('a', { href: '#/task/' + next.id }, 'next ›'))
    ),
    h('h1', {}, t.title),
    h(
      'div',
      { class: 'badges' },
      sc && h('span', {}, `Scenario ${t.num}`),
      h('span', { class: `tag d-${d.id}` }, `${d.name.split(',')[0]} · ${d.weight}%`),
      h('span', { class: 'tag ' + (t.lab ? 'lab' : 'walk') }, t.lab ? 'lab — graded on your cluster' : 'walkthrough'),
      h('span', {}, `${t.difficulty} · about ${t.minutes} min`),
      progress[id] && h('span', { class: 'd-net' }, '✓ completed')
    ),
    h('div', { class: 'scenario', html: md(t.scenario) }),
    h('div', { class: 'actions' }, buttons, status),
    resultsBox,
    logBox,
    inExam
      ? h('p', { class: 'note' }, 'Mock exam in progress: hints and solutions are hidden. Use the documentation link like you would in the exam.')
      : [
          t.hints?.length ? h('details', {}, h('summary', {}, `Hints (${t.hints.length})`), hintList, hintBtn) : null,
          h(
            'details',
            {},
            h('summary', {}, t.lab ? 'Solution' : 'Reference solution'),
            h('pre', { class: 'code' }, t.solution),
            t.lab && h('p', {}, h('button', { onclick: () => toTerminal(t.solution) }, 'Copy into terminal'), ' ', h('span', { class: 'muted' }, 'Comment lines are skipped; file edits described in comments are still yours to do.'))
          ),
        ],
    h('p', {}, h('a', { href: t.docs, target: '_blank', rel: 'noopener' }, 'Relevant documentation ↗')),
    sc && h('p', { class: 'credit' }, `Adapted from ${META.scenarioSource.author} on YouTube: `, videoLinks(t))
  );
}

function pickExamTasks() {
  const ids = [];
  for (const [dom, n] of Object.entries(EXAM_MIX)) {
    const pool = META.tasks.filter((t) => t.domain === dom && t.lab && t.id !== 'trbl-top');
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    ids.push(...pool.slice(0, n).map((t) => t.id));
  }
  return ids.sort(() => Math.random() - 0.5);
}

function saveExam() {
  store.set('cka.exam', exam);
  tickTimer();
}

function tickTimer() {
  const el = $('#exam-timer');
  if (!examRunning()) return void (el.hidden = true);
  const left = exam.startedAt + exam.minutes * 60000 - Date.now();
  const abs = Math.abs(left);
  const mm = String(Math.floor(abs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((abs % 60000) / 1000)).padStart(2, '0');
  el.hidden = false;
  el.textContent = (left < 0 ? '+' : '') + `${mm}:${ss}`;
  el.classList.toggle('over', left < 0);
  el.title = left < 0 ? 'Time is up — finish and grade the exam' : 'Mock exam time remaining';
}
setInterval(tickTimer, 1000);

async function forEachExamTask(verb, status, label) {
  const out = {};
  const queue = [...exam.ids];
  let finished = 0;
  status.textContent = `${label} 0/${exam.ids.length}…`;
  const worker = async () => {
    for (let id; (id = queue.shift()); ) {
      out[id] = await api(`/api/tasks/${id}/${verb}`, 'POST', {});
      status.textContent = `${label} ${++finished}/${exam.ids.length}…`;
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  status.textContent = '';
  return out;
}

function renderExam() {
  const status = h('span', { class: 'status-line' });

  if (!exam) {
    const start = h('button', { class: 'primary' }, 'Start mock exam');
    start.addEventListener('click', async () => {
      start.disabled = true;
      exam = { ids: pickExamTasks(), minutes: EXAM_MINUTES, startedAt: null };
      const res = await forEachExamTask('reset', status, 'Preparing tasks');
      exam.setupFailed = Object.entries(res).filter(([, r]) => !r.ok).map(([id]) => id);
      exam.startedAt = Date.now();
      saveExam();
      refreshFiles();
      renderExam();
    });
    const total = Object.values(EXAM_MIX).reduce((a, b) => a + b, 0);
    show(
      h('h1', {}, 'Mock exam'),
      h('p', { class: 'lede' }, `${total} randomly chosen lab tasks, weighted like the real exam, with a ${EXAM_MINUTES}-minute timer. Hints and solutions stay hidden until you finish. Pass mark: ${PASS_MARK}%.`),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Domain'), h('th', {}, 'Exam weight'), h('th', {}, 'Tasks'))), h('tbody', {}, META.domains.map((d) => h('tr', {}, h('td', {}, d.name), h('td', {}, d.weight + '%'), h('td', {}, EXAM_MIX[d.id]))))),
      h('p', { class: 'note' }, 'Starting sets up every selected task on the cluster at once (this takes a minute). Node-level topics — kubeadm upgrade, etcd, kubelet and control-plane repair — are a large part of the real exam but cannot be graded here; study them as walkthroughs.'),
      h('div', { class: 'actions' }, start, status)
    );
    return;
  }

  const rows = (withResult) =>
    exam.ids.map((id, i) => {
      const t = taskById(id);
      const r = exam.results?.[id];
      return h(
        'tr',
        {},
        h('td', { class: 'num' }, i + 1),
        h('td', {}, h('a', { href: '#/task/' + id }, t.title), exam.setupFailed?.includes(id) && h('span', { class: 'muted' }, ' (setup had errors)')),
        h('td', { class: 'd-' + t.domain }, domainById(t.domain).name.split(',')[0]),
        h('td', {}, `${t.minutes} min`),
        withResult && h('td', { class: r?.ok ? 'd-net' : 'd-trbl' }, r ? (r.ok ? '✓ passed' : `✗ ${r.results.filter((x) => x.pass).length}/${r.results.length} checks`) : '—')
      );
    });
  const head = (withResult) => h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Task'), h('th', {}, 'Domain'), h('th', {}, 'Est.'), withResult && h('th', {}, 'Result')));

  if (examRunning()) {
    const finish = h('button', { class: 'primary' }, 'Finish & grade');
    finish.addEventListener('click', async () => {
      if (!confirm('Finish the exam and grade all tasks now?')) return;
      finish.disabled = true;
      exam.results = await forEachExamTask('check', status, 'Grading tasks');
      exam.finishedAt = Date.now();
      for (const [id, r] of Object.entries(exam.results)) {
        lastChecks[id] = r;
        if (r.ok) setDone(id, true);
      }
      saveExam();
      renderExam();
    });
    const abort = h('button', { class: 'danger' }, 'Abort & clean up');
    abort.addEventListener('click', async () => {
      if (!confirm('Abort the exam and remove all its resources from the cluster?')) return;
      abort.disabled = finish.disabled = true;
      await forEachExamTask('cleanup', status, 'Cleaning up tasks');
      exam = null;
      saveExam();
      refreshFiles();
      renderExam();
    });
    show(
      h('h1', {}, 'Mock exam in progress'),
      h('p', { class: 'lede' }, 'Work through the tasks in any order. Skip what takes too long and come back — exactly as in the real exam.'),
      h('table', {}, head(false), h('tbody', {}, rows(false))),
      h('div', { class: 'actions' }, finish, abort, status)
    );
    return;
  }

  const passed = exam.ids.filter((id) => exam.results[id]?.ok).length;
  const pct = Math.round((100 * passed) / exam.ids.length);
  const used = Math.round((exam.finishedAt - exam.startedAt) / 60000);
  const done = h('button', { class: 'primary' }, 'Clean up & close');
  done.addEventListener('click', async () => {
    done.disabled = true;
    await forEachExamTask('cleanup', status, 'Cleaning up tasks');
    exam = null;
    saveExam();
    refreshFiles();
    renderExam();
  });
  show(
    h('h1', {}, 'Mock exam result'),
    h('div', { class: 'score ' + (pct >= PASS_MARK ? 'pass' : 'fail') }, pct + '%'),
    h('p', {}, `${passed} of ${exam.ids.length} tasks fully correct in ${used} minutes — ${pct >= PASS_MARK ? 'above' : 'below'} the ${PASS_MARK}% pass mark. `, h('span', { class: 'muted' }, 'The real exam gives partial credit; this score counts a task only when every check passes.')),
    h('table', {}, head(true), h('tbody', {}, rows(true))),
    h('p', { class: 'muted' }, 'Resources are still on the cluster so you can open failed tasks, read the solution and fix them.'),
    h('div', { class: 'actions' }, done, status)
  );
}

// ───────────── quiz ─────────────
const QUIZ_SIZES = [10, 20, 50, 0]; // 0 = all
const KEYS = 'ABCD';
const quizBank = () => META.quiz || [];
const quizById = (id) => quizBank().find((q) => q.id === id);
const shortDomain = (d) => (d ? d.name.split(',')[0] : 'Other');

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// right / missed count the latest attempt at each question
function quizStats(qs) {
  const seen = qs.filter((q) => quizHist[q.id]);
  return { total: qs.length, seen: seen.length, right: seen.filter((q) => quizHist[q.id].last).length, missed: seen.filter((q) => !quizHist[q.id].last).length };
}

function recordQuiz(id, ok) {
  const r = quizHist[id] || { seen: 0, correct: 0 };
  quizHist[id] = { seen: r.seen + 1, correct: r.correct + (ok ? 1 : 0), last: ok, at: Date.now() };
  store.set('cka.quiz', quizHist);
}

function startQuiz(ids, shuffle = true) {
  const order = shuffle ? shuffled(ids) : ids;
  quizRun = { ids: order, i: 0, finished: false, answers: Object.fromEntries(order.map((id) => [id, { order: shuffled(quizById(id).options.map((_, i) => i)), picked: null }])) };
  renderQuiz();
  view.scrollTop = 0;
}

const quizCorrect = (q) => {
  const a = quizRun.answers[q.id];
  return a.picked != null && a.order[a.picked] === q.answer;
};

function renderQuiz() {
  quizKeys = null;
  if (!quizRun) renderQuizSetup();
  else if (quizRun.finished) renderQuizEnd();
  else renderQuizCard();
}

function renderQuizSetup() {
  const bank = quizBank();
  if (!bank.length) {
    show(h('h1', {}, 'Quiz'), h('p', { class: 'lede' }, 'No quiz questions are loaded. Add quiz.js at the repository root and restart the server.'));
    return;
  }
  const prefs = store.get('cka.quiz.prefs', {});
  const sel = new Set(Array.isArray(prefs.domains) ? prefs.domains : META.domains.map((d) => d.id));
  let size = QUIZ_SIZES.includes(prefs.size) ? prefs.size : 20;
  let shuffle = prefs.shuffle !== false;
  let missedOnly = !!prefs.missed;
  const pool = () => bank.filter((q) => sel.has(q.domain) && (!missedOnly || quizHist[q.id]?.last === false));

  const count = h('span', { class: 'status-line' });
  const start = h('button', { class: 'primary' }, 'Start');
  start.addEventListener('click', () => {
    const ids = pool().map((q) => q.id);
    startQuiz((shuffle ? shuffled(ids) : ids).slice(0, size || ids.length), false);
  });
  const update = () => {
    const n = pool().length;
    const deck = size ? Math.min(size, n) : n;
    count.textContent = n ? `${deck} card${deck === 1 ? '' : 's'} from ${n} matching question${n === 1 ? '' : 's'}` : missedOnly ? 'No missed questions in the chosen domains.' : 'Choose at least one domain.';
    start.disabled = !n;
    store.set('cka.quiz.prefs', { domains: [...sel], size, shuffle, missed: missedOnly });
  };

  const all = quizStats(bank);
  const reset = h('button', { class: 'link' }, 'reset history');
  reset.addEventListener('click', () => {
    if (!confirm('Forget every quiz answer you have given so far?')) return;
    quizHist = {};
    store.set('cka.quiz', quizHist);
    renderQuizSetup();
  });

  show(
    h('h1', {}, 'Quiz'),
    h('p', { class: 'lede' }, `Flashcard questions on the CKA curriculum — one at a time, with the reasoning and a docs link after each answer. ${bank.length} questions; you have seen ${all.seen} and got ${all.right} right on your latest try.`),
    h('h3', {}, 'Domains'),
    h(
      'ul',
      { class: 'quiz-domains' },
      META.domains.map((d) => {
        const qs = bank.filter((q) => q.domain === d.id);
        const s = quizStats(qs);
        const cb = h('input', { type: 'checkbox', checked: qs.length > 0 && sel.has(d.id), disabled: !qs.length });
        cb.addEventListener('change', () => {
          if (cb.checked) sel.add(d.id);
          else sel.delete(d.id);
          update();
        });
        return h(
          'li',
          {},
          h(
            'label',
            {},
            cb,
            h('span', { class: 'n d-' + d.id }, shortDomain(d)),
            h('span', { class: 'c' }, `${qs.length} question${qs.length === 1 ? '' : 's'}`),
            h('span', { class: 'm' }, s.seen ? `${s.right}/${s.total} mastered${s.missed ? ` · ${s.missed} missed` : ''}` : 'not started')
          ),
          h('div', { class: 'bar', title: `${s.right} of ${s.total} answered correctly on the latest try` }, h('i', { class: 'b-' + d.id, style: `width:${s.total ? (100 * s.right) / s.total : 0}%` }))
        );
      })
    ),
    h('h3', {}, 'Deck'),
    h(
      'div',
      { class: 'quiz-opts-row' },
      h('div', { class: 'filters' }, QUIZ_SIZES.map((n) => {
        const b = h('button', { class: 'chip' + (size === n ? ' on' : '') }, n ? `${n} cards` : 'All');
        b.addEventListener('click', () => {
          size = n;
          b.parentNode.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
          update();
        });
        return b;
      })),
      h('label', {}, h('input', { type: 'checkbox', checked: shuffle, onchange: (e) => ((shuffle = e.target.checked), update()) }), ' Shuffle'),
      h('label', {}, h('input', { type: 'checkbox', checked: missedOnly, disabled: !all.missed && !missedOnly, onchange: (e) => ((missedOnly = e.target.checked), update()) }), ` Review missed only (${all.missed})`)
    ),
    h('div', { class: 'actions' }, start, count),
    h('p', { class: 'muted' }, 'Answer with 1–4 or A–D, go on with Enter or →. Your answers are kept in this browser. ', all.seen > 0 && reset)
  );
  update();
}

function renderQuizCard() {
  const run = quizRun;
  const id = run.ids[run.i];
  const q = quizById(id);
  const a = run.answers[id];
  const d = domainById(q.domain);
  const answered = a.picked != null;
  const correctPos = a.order.indexOf(q.answer);
  const ok = a.picked === correctPos;
  const last = run.i === run.ids.length - 1;
  const hist = quizHist[id];

  const pick = (pos) => {
    if (a.picked != null || pos < 0 || pos >= a.order.length) return;
    a.picked = pos;
    recordQuiz(id, pos === correctPos);
    renderQuizCard();
    $('#quiz-next')?.focus({ preventScroll: true });
  };
  const next = () => {
    if (a.picked == null) return;
    if (++run.i >= run.ids.length) run.finished = true;
    renderQuiz();
    view.scrollTop = 0;
  };
  const quit = () => {
    const done = run.ids.filter((x) => run.answers[x].picked != null);
    if (done.length < run.ids.length && done.length && !confirm('End this deck now? Unanswered cards are dropped.')) return;
    if (done.length) Object.assign(run, { ids: done, finished: true });
    else quizRun = null;
    renderQuiz();
  };
  quizKeys = { pick, next };

  const right = run.ids.slice(0, run.i + 1).filter((x) => quizCorrect(quizById(x))).length;
  show(
    h('div', { class: 'crumbs' }, h('button', { class: 'link', onclick: quit }, '← End deck'), h('span', { class: 'quiz-count' }, `${run.i + 1} / ${run.ids.length}`, h('span', { class: 'muted' }, ` · ${right} correct`))),
    h('div', { class: 'bar' }, h('i', { class: 'b-' + q.domain, style: `width:${(100 * (run.i + (answered ? 1 : 0))) / run.ids.length}%` })),
    h(
      'div',
      { class: 'quiz-card' + (answered ? ' answered' : '') },
      h('div', { class: 'badges' }, h('span', { class: 'tag d-' + q.domain }, `${shortDomain(d)} · ${q.topic}`), hist && h('span', {}, `seen ${hist.seen}× · ${hist.correct} right`)),
      h('p', { class: 'quiz-q', html: codeText(q.question) }),
      h(
        'ol',
        { class: 'quiz-options' },
        a.order.map((orig, pos) => {
          const state = !answered ? '' : pos === correctPos ? ' right' : pos === a.picked ? ' wrong' : ' dim';
          return h(
            'li',
            {},
            h(
              'button',
              { class: 'quiz-opt' + state, disabled: answered, 'aria-keyshortcuts': `${pos + 1} ${KEYS[pos]}`, onclick: () => pick(pos) },
              h('span', { class: 'k' }, KEYS[pos] || pos + 1),
              h('span', { class: 't', html: codeText(q.options[orig]) }),
              answered && (pos === correctPos || pos === a.picked) && h('span', { class: 'mark' }, pos === correctPos ? '✓' : '✗')
            )
          );
        })
      ),
      answered &&
        h(
          'div',
          { class: 'quiz-reveal', role: 'status' },
          h('p', { class: 'verdict ' + (ok ? 'pass' : 'fail') }, ok ? '✓ Correct' : `✗ Not quite — the answer is ${KEYS[correctPos]}`),
          h('p', { class: 'quiz-expl', html: codeText(q.explanation) }),
          /^https?:\/\//.test(q.ref || '') && h('p', {}, h('a', { href: q.ref, target: '_blank', rel: 'noopener' }, 'Documentation ↗'))
        )
    ),
    h('div', { class: 'actions' }, h('button', { id: 'quiz-next', class: 'primary', disabled: !answered, onclick: next }, last ? 'See results' : 'Next →'), h('span', { class: 'status-line' }, answered ? 'Enter or → for the next card' : '1–4 or A–D to answer'))
  );
}

function renderQuizEnd() {
  const qs = quizRun.ids.map(quizById);
  const right = qs.filter(quizCorrect).length;
  const pct = Math.round((100 * right) / qs.length);
  const missed = qs.filter((q) => !quizCorrect(q));
  const optHtml = (q, orig) => codeText(q.options[orig]);
  show(
    h('h1', {}, 'Quiz result'),
    h('div', { class: 'score ' + (pct >= PASS_MARK ? 'pass' : 'fail') }, pct + '%'),
    h('p', {}, `${right} of ${qs.length} correct.`),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Domain'), h('th', {}, 'Correct'), h('th', {}, ''))),
      h(
        'tbody',
        {},
        META.domains
          .map((d) => [d, qs.filter((q) => q.domain === d.id)])
          .filter(([, dq]) => dq.length)
          .map(([d, dq]) => {
            const r = dq.filter(quizCorrect).length;
            return h('tr', {}, h('td', { class: 'd-' + d.id }, shortDomain(d)), h('td', { class: 'num' }, `${r} / ${dq.length}`), h('td', {}, h('div', { class: 'bar' }, h('i', { class: 'b-' + d.id, style: `width:${(100 * r) / dq.length}%` }))));
          })
      )
    ),
    missed.length > 0 && [
      h('h2', {}, `Missed (${missed.length})`),
      h(
        'ol',
        { class: 'quiz-missed' },
        missed.map((q) => {
          const a = quizRun.answers[q.id];
          return h(
            'li',
            {},
            h('p', { class: 'quiz-q', html: codeText(q.question) }),
            h('p', { class: 'ans right' }, '✓ ', h('span', { html: optHtml(q, q.answer) })),
            a.picked != null && h('p', { class: 'ans wrong' }, '✗ ', h('span', { html: optHtml(q, a.order[a.picked]) })),
            h('p', { class: 'muted quiz-expl', html: codeText(q.explanation) }),
            /^https?:\/\//.test(q.ref || '') && h('p', {}, h('a', { href: q.ref, target: '_blank', rel: 'noopener' }, 'Documentation ↗'))
          );
        })
      ),
    ],
    h(
      'div',
      { class: 'actions' },
      missed.length > 0 && h('button', { class: 'primary', onclick: () => startQuiz(missed.map((q) => q.id)) }, `Retry missed (${missed.length})`),
      h('button', { class: missed.length ? '' : 'primary', onclick: () => ((quizRun = null), renderQuiz()) }, 'New deck')
    )
  );
}

// Quiz shortcuts — never while typing in the console, an input or an editor.
document.addEventListener('keydown', (e) => {
  if (!quizKeys || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), #console')) return;
  const k = e.key.toLowerCase();
  if (/^[1-4]$/.test(k)) quizKeys.pick(Number(k) - 1);
  else if (/^[a-d]$/.test(k)) quizKeys.pick(k.charCodeAt(0) - 97);
  else if (k === 'arrowright' || (k === 'enter' && !(t instanceof Element && t.closest('button, a')))) quizKeys.next();
  else return;
  e.preventDefault();
});

function renderCheats() {
  show(
    h('h1', {}, 'Cheat sheet'),
    h('p', { class: 'lede' }, 'Click a command to put it into the terminal for editing. Node-level commands (systemctl, crictl, kubeadm, etcdctl) are for reference; run them inside minikube ssh.'),
    ...META.cheatsheet.flatMap((sec) => [
      h('h3', {}, sec.title),
      ...sec.items.map(([k, c]) => h('div', { class: 'cheat' }, h('span', { class: 'k' }, k), h('button', { title: 'Put into terminal', onclick: () => toTerminal(c) }, c))),
    ])
  );
}

function route() {
  const [, name = 'overview', arg] = location.hash.split('/');
  const nav = name !== 'task' ? name : META.scenarios.some((t) => t.id === arg) ? 'scenarios' : 'tasks';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === nav));
  quizKeys = null;
  if (name === 'tasks') renderTasks(arg || 'all');
  else if (name === 'task') renderTask(arg);
  else if (name === 'scenarios') renderScenarios();
  else if (name === 'exam') renderExam();
  else if (name === 'quiz') renderQuiz();
  else if (name === 'cheats') renderCheats();
  else renderOverview();
  view.scrollTop = 0;
}

// ───────────── boot ─────────────
(async function boot() {
  META = await api('/api/meta');
  $('#console-ctx').textContent = 'context: ' + META.context;
  if (store.get('cka.console', true) === false) $('#layout').classList.add('no-console');
  termOut.append(
    h(
      'div',
      { class: 'term-welcome' },
      `kubectl console — pinned to context "${META.context}".\n\n` +
        '  k get nodes -o wide\n  kubectl run web --image=nginx:1.27-alpine --dry-run=client -o yaml\n  kubectl get pods -A > pods.txt        (saved to the workspace folder)\n\n' +
        'No shell: pipes, && and exec -it are not available.\nkubectl edit opens an editor right here; the YAML editor tab is for writing and applying manifests.' +
        (META.helm ? '\nhelm is available too.' : '')
    )
  );
  window.addEventListener('hashchange', route);
  route();
  tickTimer();
  refreshStatus();
  refreshFiles();
  setInterval(refreshStatus, 60000);
})();
