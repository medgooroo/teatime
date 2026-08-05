'use strict';

const RULER_H = 28;  // must match --ruler-h in style.css

let recipes = [];
let lanes = [];   // combined across recipes: {key, label, sub, colour}
let steps = [];   // combined, offsets applied: {key, laneKey, name, instructions, start, duration}
let mealKey = '';
let pxPerMin = 10;
let rowH = 56;
let startTs = null;   // ms epoch, persisted so a refresh resumes the cook
let doneSet = new Set();  // step keys ticked off by the cook, persisted
let expandedId = null;
let blocks = new Map();
let nowline = null, nowbubble = null;

const $ = s => document.querySelector(s);
const timeline = $('.timeline');
const rows = $('#rows');
const ruler = $('#ruler');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const secToPx = s => s / 60 * pxPerMin;
const laneIdx = key => lanes.findIndex(l => l.key === key);
const total = () => steps.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
const contentSeconds = () => Math.max(600, Math.ceil((total() + 60) / 300) * 300);
const storageKey = () => 'teatime.start.' + mealKey;
const doneKey = () => 'teatime.done.' + mealKey;
const elapsed = () => startTs ? (Date.now() - startTs) / 1000 : 0;

const recipeTotal = r => (r.steps || []).reduce((m, s) => Math.max(m, s.start + s.duration), 0);

// merge recipes onto one timeline, each offset so they all finish together
function combine() {
  lanes = [];
  steps = [];
  const overall = Math.max(...recipes.map(recipeTotal));
  let n = 0;
  for (const r of recipes) {
    const offset = overall - recipeTotal(r);
    for (const lane of (r.lanes || [])) {
      lanes.push({
        key: r.id + '/' + lane.id,
        label: lane.name,
        sub: recipes.length > 1 ? r.name : '',
        colour: laneColour(n++),
      });
    }
    for (const s of (r.steps || [])) {
      steps.push({
        key: r.id + '/' + s.id,
        laneKey: r.id + '/' + s.laneId,
        name: s.name,
        instructions: s.instructions,
        start: s.start + offset,
        duration: s.duration,
        alarm: s.alarm || '',
      });
    }
  }
}

// lanes stretch to fill the window height
function fitRows() {
  const avail = timeline.clientHeight - RULER_H;
  rowH = clamp(Math.floor(avail / Math.max(1, lanes.length)), 56, 220);
  document.documentElement.style.setProperty('--row-h', rowH + 'px');
}

// and the timeline stretches to fill the window width
function fitWidth() {
  pxPerMin = clamp((timeline.clientWidth - 20) / (contentSeconds() / 60), 2, 80);
}

/* ---------- alarms ---------- */

let audioCtx = null;
let lastEl = null;   // elapsed at previous tick; alarms fire on crossing

// must be called from a user gesture or iOS keeps the context suspended
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio available */ }
}

function beep(times) {
  if (!audioCtx) return;
  for (let i = 0; i < times; i++) {
    const t = audioCtx.currentTime + i * 0.45;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.35);
  }
}

function alarmTimes(step) {
  const out = [];
  if (step.alarm === 'start' || step.alarm === 'both') out.push([step.start, 'start']);
  if (step.alarm === 'end' || step.alarm === 'both') out.push([step.start + step.duration, 'end']);
  return out;
}

function checkAlarms(el) {
  if (lastEl === null) { lastEl = el; return; }   // first tick: no history, fire nothing
  const due = [];
  for (const step of steps) {
    if (!step.alarm || doneSet.has(step.key)) continue;
    for (const [at, kind] of alarmTimes(step)) {
      if (at > lastEl && at <= el) due.push({ step, kind });
    }
  }
  lastEl = el;
  if (!due.length) return;
  beep(due.some(d => d.kind === 'end') ? 3 : 2);
  showAlarm(due);
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function showAlarm(due) {
  const bar = $('#alarmbar');
  bar.textContent = '';
  for (const { step, kind } of due) {
    const row = document.createElement('div');
    row.className = 'alarm-row';
    const what = document.createElement('strong');
    what.textContent = step.name;
    const when = document.createElement('span');
    when.textContent = kind === 'start' ? ' — start now' : ' — finished';
    row.append(what, when);
    bar.append(row);
  }
  const dismiss = document.createElement('button');
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => { bar.hidden = true; });
  bar.append(dismiss);
  bar.hidden = false;
}

/* ---------- views: ingredients before the cook, timeline during ---------- */

let view = '';
const hasIngredients = () => recipes.some(r => (r.ingredients || []).length);

function setView(v) {
  if (view === v) return;
  view = v;
  $('#ingredients').hidden = v !== 'ingredients';
  document.querySelector('.board').hidden = v !== 'board';
  $('#zoomIn').hidden = $('#zoomOut').hidden = v !== 'board';
  if (v === 'board') {
    // the board only has real dimensions once visible
    fitWidth();
    fitRows();
    render();
  }
}

function buildIngredients() {
  const sec = $('#ingredients');
  sec.textContent = '';
  const inner = document.createElement('div');
  inner.className = 'ing-inner';
  const h = document.createElement('h1');
  h.textContent = 'Ingredients';
  inner.append(h);
  for (const r of recipes) {
    const ings = r.ingredients || [];
    if (!ings.length) continue;
    if (recipes.length > 1) {
      const h2 = document.createElement('h2');
      h2.textContent = r.name;
      inner.append(h2);
    }
    for (const text of ings) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const span = document.createElement('span');
      span.textContent = text;
      label.append(cb, span);
      inner.append(label);
    }
  }
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.id = 'startBtn2';
  btn.textContent = 'Start cooking';
  btn.addEventListener('click', start);
  inner.append(btn);
  sec.append(inner);
}

/* ---------- rendering ---------- */

function render() {
  const col = $('#laneNames');
  col.textContent = '';
  for (const lane of lanes) {
    const div = document.createElement('div');
    div.className = 'lane-name';
    const text = document.createElement('div');
    text.className = 'lane-text';
    if (lane.sub) {
      const sub = document.createElement('span');
      sub.className = 'lane-sub';
      sub.textContent = lane.sub;
      text.append(sub);
    }
    const label = document.createElement('span');
    label.className = 'lane-label';
    label.textContent = lane.label;
    text.append(label);
    div.append(text);
    col.append(div);
  }

  ruler.textContent = '';
  const width = secToPx(contentSeconds());
  ruler.style.width = width + 'px';
  const tickEvery = pxPerMin >= 6 ? 60 : 300;
  const labelEvery = pxPerMin >= 10 ? 300 : 600;
  for (let s = 0; s <= contentSeconds(); s += tickEvery) {
    const tick = document.createElement('div');
    tick.className = 'tick' + (s % labelEvery === 0 ? ' major' : '');
    tick.style.left = secToPx(s) + 'px';
    ruler.append(tick);
    if (s % labelEvery === 0 && s > 0) {
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = fmtClock(s);
      lbl.style.left = secToPx(s) + 'px';
      ruler.append(lbl);
    }
  }
  nowbubble = document.createElement('div');
  nowbubble.id = 'nowbubble';
  nowbubble.hidden = true;
  ruler.append(nowbubble);

  rows.textContent = '';
  rows.style.width = width + 'px';
  rows.style.height = Math.max(1, lanes.length) * rowH + 'px';
  const five = pxPerMin * 5;
  let bg = `repeating-linear-gradient(to right, var(--grid-strong) 0 1px, transparent 1px ${five}px)`;
  if (pxPerMin >= 6) {
    bg += `, repeating-linear-gradient(to right, var(--grid) 0 1px, transparent 1px ${pxPerMin}px)`;
  }
  rows.style.backgroundImage = bg;

  lanes.forEach((lane, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.top = i * rowH + 'px';
    rows.append(row);
  });

  blocks = new Map();
  for (const step of steps) {
    const el = document.createElement('div');
    el.className = 'step clickable' + (step.alarm ? ' has-alarm' : '');
    el.dataset.id = step.key;
    const li = laneIdx(step.laneKey);
    el.style.left = secToPx(step.start) + 'px';
    el.style.top = li * rowH + 5 + 'px';
    el.style.width = Math.max(secToPx(step.duration), 24) + 'px';
    el.style.setProperty('--step-bg', lanes[li].colour);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = step.name;
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = fmtDur(step.duration);
    const progress = document.createElement('div');
    progress.className = 'progress';
    el.append(name, dur, progress);
    rows.append(el);
    blocks.set(step.key, el);
  }

  nowline = document.createElement('div');
  nowline.id = 'nowline';
  nowline.hidden = true;
  rows.append(nowline);
}

/* ---------- ticking ---------- */

function update() {
  const tot = total();
  const el = elapsed();
  const state = !startTs ? 'idle' : el >= tot ? 'done' : 'running';

  setView(state === 'idle' && hasIngredients() ? 'ingredients' : 'board');

  $('#resetBtn').hidden = !startTs;
  $('#startBtn').hidden = state === 'running';
  $('#startBtn').textContent = state === 'done' ? 'Start again' : 'Start cooking';
  $('#wallClock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#clock').textContent = startTs ? fmtTimer(Math.min(el, tot)) + ' / ' + fmtTimer(tot) : '';

  if (view !== 'board') return;

  const x = secToPx(Math.min(el, contentSeconds()));
  nowline.hidden = nowbubble.hidden = !startTs;
  if (startTs) {
    nowline.style.left = x + 'px';
    nowbubble.style.left = x + 'px';
    nowbubble.textContent = fmtTimer(el);
  }

  for (const step of steps) {
    const end = step.start + step.duration;
    const ticked = doneSet.has(step.key);
    const block = blocks.get(step.key);
    block.classList.toggle('done', startTs && el >= end);
    block.classList.toggle('ticked', ticked);
    block.classList.toggle('active', state === 'running' && !ticked && el >= step.start && el < end);
    const pct = !startTs ? 0 : clamp((el - step.start) / step.duration * 100, 0, 100);
    block.querySelector('.progress').style.width = pct + '%';
  }

  if (state === 'running') {
    checkAlarms(el);
    const vis = timeline.scrollLeft, w = timeline.clientWidth;
    if (x < vis + 20 || x > vis + w - 80) timeline.scrollLeft = Math.max(0, x - w * 0.25);
  }

  if (expandedId) {
    const step = steps.find(s => s.key === expandedId);
    if (step) $('#bigTiming').textContent = timingText(step);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- tap a step: full-screen reader card ---------- */

rows.addEventListener('click', e => {
  const block = e.target.closest('.step');
  if (!block) return;
  openStep(block.dataset.id);
});

function timingText(step) {
  const state = !startTs ? 'idle' : elapsed() >= total() ? 'done' : 'running';
  if (state !== 'running') return 'starts at ' + fmtTimer(step.start);
  const el = elapsed();
  const end = step.start + step.duration;
  if (el >= end) return 'finished';
  if (el >= step.start) return fmtDur(end - el) + ' left';
  return 'in ' + fmtDur(step.start - el);
}

function openStep(key) {
  const step = steps.find(s => s.key === key);
  if (!step) return;
  expandedId = key;
  const lane = lanes[laneIdx(step.laneKey)];
  const big = $('#bigstep');
  big.textContent = '';
  big.style.setProperty('--step-bg', lane.colour);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = step.name;
  const laneText = lane.sub ? lane.sub + ' · ' + lane.label : lane.label;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = escapeHtml(laneText) + ' · ' + fmtDur(step.duration)
    + ' · <span id="bigTiming"></span>';
  const instr = document.createElement('div');
  instr.className = 'instr';
  instr.textContent = step.instructions || 'No instructions for this step.';
  const btn = document.createElement('button');
  btn.className = 'done-btn';
  btn.textContent = doneSet.has(key) ? 'Undo' : 'Done!';
  btn.addEventListener('click', () => toggleDone(key));
  big.append(name, meta, instr, btn);

  $('#bigTiming').textContent = timingText(step);
  $('#overlay').hidden = false;
}

function closeOverlay() {
  expandedId = null;
  $('#overlay').hidden = true;
}

$('#overlay').addEventListener('click', e => {
  if (!e.target.closest('.done-btn')) closeOverlay();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeOverlay();
});

function toggleDone(key) {
  if (doneSet.has(key)) doneSet.delete(key);
  else doneSet.add(key);
  localStorage.setItem(doneKey(), JSON.stringify([...doneSet]));
  closeOverlay();
  update();
}

/* ---------- controls ---------- */

function start() {
  unlockAudio();
  startTs = Date.now();
  localStorage.setItem(storageKey(), String(startTs));
  doneSet.clear();
  localStorage.removeItem(doneKey());
  lastEl = 0;
  $('#alarmbar').hidden = true;
  update();
}

$('#startBtn').addEventListener('click', start);

$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Reset the cooking timer?')) return;
  localStorage.removeItem(storageKey());
  localStorage.removeItem(doneKey());
  startTs = null;
  doneSet.clear();
  update();
});

function setZoom(v) {
  pxPerMin = clamp(v, 2, 80);
  render();
  update();
}
$('#zoomIn').addEventListener('click', () => setZoom(pxPerMin * 1.5));
$('#zoomOut').addEventListener('click', () => setZoom(pxPerMin / 1.5));

/* ---------- load ---------- */

async function load() {
  const params = new URLSearchParams(location.search);
  let ids = [];
  let mealName = '';
  const mealParam = params.get('meal');
  if (mealParam) {
    const res = await fetch('/api/meals/' + encodeURIComponent(mealParam));
    if (!res.ok) {
      $('#recipeTitle').textContent = 'Meal not found';
      return;
    }
    const m = await res.json();
    mealName = m.name;
    ids = m.recipeIds || [];
  } else {
    const idsParam = params.get('ids') || params.get('id');
    if (!idsParam) {
      location.href = '/';
      return;
    }
    ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
  }
  const fetched = await Promise.all(ids.map(async id => {
    const res = await fetch('/api/recipes/' + encodeURIComponent(id));
    return res.ok ? res.json() : null;
  }));
  recipes = fetched.filter(Boolean);
  if (!recipes.length) {
    $('#recipeTitle').textContent = 'Recipe not found';
    return;
  }
  combine();
  mealKey = recipes.map(r => r.id).sort().join('+');

  const title = mealName || recipes.map(r => r.name).join(' + ');
  document.title = title + ' — teatime';
  $('#recipeTitle').textContent = title;
  $('#total').textContent = 'Total ' + fmtDur(total());
  $('#editLink').hidden = recipes.length !== 1;
  if (recipes.length === 1) {
    $('#editLink').href = 'editor.html?id=' + encodeURIComponent(recipes[0].id);
  }

  const ts = parseInt(localStorage.getItem(storageKey()), 10);
  if (ts && ts <= Date.now()) startTs = ts;
  try {
    doneSet = new Set(JSON.parse(localStorage.getItem(doneKey()) || '[]'));
  } catch { doneSet = new Set(); }

  buildIngredients();
  update();
  setInterval(update, 1000);

  window.addEventListener('resize', () => {
    if (view !== 'board') return;
    fitWidth();
    fitRows();
    render();
    update();
  });
}

load();
