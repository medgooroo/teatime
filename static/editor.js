'use strict';

const SNAP = 30;     // drag snap, seconds
const RULER_H = 28;  // must match --ruler-h in style.css

let rowH = 56;       // recomputed to fill the window, mirrored into --row-h

let recipe = { id: null, name: 'New recipe', description: '', lanes: [], steps: [] };
let pxPerMin = 8;
let selectedId = null;
let dirty = false;
let blockEls = new Map();

const $ = s => document.querySelector(s);
const rows = $('#rows');
const ruler = $('#ruler');
const timeline = document.querySelector('.timeline');

const uid = p => p + crypto.randomUUID().slice(0, 8);
const snap = s => Math.round(s / SNAP) * SNAP;
const secToPx = s => s / 60 * pxPerMin;
const pxToSec = x => x / pxPerMin * 60;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const stepById = id => recipe.steps.find(s => s.id === id);
const laneIndex = id => recipe.lanes.findIndex(l => l.id === id);
const totalSeconds = () => recipe.steps.reduce((m, s) => Math.max(m, s.start + s.duration), 0);

// timeline extends past the last step so there is room to drag into
const contentSeconds = () => Math.max(3600, Math.ceil((totalSeconds() + 900) / 300) * 300);

function markDirty() {
  dirty = true;
  setStatus('Unsaved changes');
}

// lanes stretch to fill the window height, the recipe to fill the width
function fitRows() {
  const avail = timeline.clientHeight - RULER_H;
  rowH = clamp(Math.floor(avail / Math.max(1, recipe.lanes.length)), 56, 140);
  document.documentElement.style.setProperty('--row-h', rowH + 'px');
}

function fitWidth() {
  pxPerMin = clamp((timeline.clientWidth - 20) / (contentSeconds() / 60), 2, 60);
}

function fit() {
  fitRows();
  fitWidth();
  render();
}

function setStatus(msg) {
  $('#status').textContent = msg;
}

/* ---------- rendering ---------- */

function render() {
  renderLaneNames();
  renderRuler();
  renderRows();
  $('#total').textContent = 'Total ' + fmtDur(totalSeconds());
  document.title = (recipe.name || 'Recipe') + ' — teatime';
}

function renderLaneNames() {
  const col = $('#laneNames');
  col.textContent = '';
  recipe.lanes.forEach((lane, i) => {
    const div = document.createElement('div');
    div.className = 'lane-name';
    const input = document.createElement('input');
    input.value = lane.name;
    input.addEventListener('change', () => {
      lane.name = input.value.trim() || lane.name;
      input.value = lane.name;
      markDirty();
    });
    const up = laneMoveBtn('↑', 'Move lane up', i, -1);
    const down = laneMoveBtn('↓', 'Move lane down', i, 1);
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Delete lane';
    del.addEventListener('click', () => deleteLane(lane));
    div.append(input, up, down, del);
    col.append(div);
  });
}

function laneMoveBtn(label, title, i, delta) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.title = title;
  const j = i + delta;
  btn.disabled = j < 0 || j >= recipe.lanes.length;
  btn.addEventListener('click', () => {
    [recipe.lanes[i], recipe.lanes[j]] = [recipe.lanes[j], recipe.lanes[i]];
    markDirty();
    render();
  });
  return btn;
}

function renderRuler() {
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
}

function renderRows() {
  rows.textContent = '';
  const width = secToPx(contentSeconds());
  rows.style.width = width + 'px';
  rows.style.height = Math.max(1, recipe.lanes.length) * rowH + 'px';

  // vertical gridlines: strong every 5 min, light every minute when zoomed in
  const five = pxPerMin * 5;
  let bg = `repeating-linear-gradient(to right, var(--grid-strong) 0 1px, transparent 1px ${five}px)`;
  if (pxPerMin >= 6) {
    bg += `, repeating-linear-gradient(to right, var(--grid) 0 1px, transparent 1px ${pxPerMin}px)`;
  }
  rows.style.backgroundImage = bg;

  recipe.lanes.forEach((lane, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.top = i * rowH + 'px';
    rows.append(row);
  });

  blockEls = new Map();
  for (const step of recipe.steps) {
    const el = stepBlock(step);
    rows.append(el);
    blockEls.set(step.id, el);
  }
}

function positionBlock(el, step) {
  const li = laneIndex(step.laneId);
  el.style.left = secToPx(step.start) + 'px';
  el.style.top = li * rowH + 5 + 'px';
  el.style.width = Math.max(secToPx(step.duration), 24) + 'px';
  el.style.setProperty('--step-bg', laneColour(li));
}

function stepBlock(step) {
  const el = document.createElement('div');
  el.className = 'step' + (step.id === selectedId ? ' selected' : '');
  el.dataset.id = step.id;
  positionBlock(el, step);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = step.name;
  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.textContent = fmtDur(step.duration) + (step.alarm ? ' · alarm' : '');
  const handle = document.createElement('div');
  handle.className = 'handle';
  el.append(name, dur, handle);
  return el;
}

/* ---------- selection and panel ---------- */

function select(id) {
  selectedId = id;
  const prev = rows.querySelector('.step.selected');
  if (prev) prev.classList.remove('selected');
  if (id) {
    const el = rows.querySelector(`.step[data-id="${id}"]`);
    if (el) el.classList.add('selected');
  }
  updatePanel();
}

function updatePanel() {
  const step = selectedId && stepById(selectedId);
  $('#panel').hidden = !step;
  if (!step) return;
  $('#stepName').value = step.name;
  $('#stepStart').value = fmtDur(step.start);
  $('#stepDur').value = fmtDur(step.duration);
  $('#stepAlarm').value = step.alarm || '';
  $('#stepInstr').value = step.instructions;
}

$('#stepAlarm').addEventListener('change', () => {
  const step = stepById(selectedId);
  if (!step) return;
  step.alarm = $('#stepAlarm').value;
  markDirty();
  render();
});

$('#stepName').addEventListener('input', () => {
  const step = stepById(selectedId);
  if (!step) return;
  step.name = $('#stepName').value;
  const el = rows.querySelector(`.step[data-id="${step.id}"] .name`);
  if (el) el.textContent = step.name;
  markDirty();
});

$('#stepStart').addEventListener('change', () => {
  const step = stepById(selectedId);
  const sec = parseDur($('#stepStart').value);
  if (step && sec !== null) {
    const cut = laneCut(step);   // its place in the lane before the edit
    step.start = Math.max(0, sec);
    resolveLane(step, cut);
    markDirty();
    render();
  }
  updatePanel();
});

$('#stepDur').addEventListener('change', () => {
  const step = stepById(selectedId);
  const sec = parseDur($('#stepDur').value);
  if (step && sec !== null && sec > 0) {
    const cut = laneCut(step);
    step.duration = sec;
    resolveLane(step, cut);
    markDirty();
    render();
  }
  updatePanel();
});

$('#stepInstr').addEventListener('input', () => {
  const step = stepById(selectedId);
  if (!step) return;
  step.instructions = $('#stepInstr').value;
  markDirty();
});

function deleteSelected() {
  const i = recipe.steps.findIndex(s => s.id === selectedId);
  if (i < 0) return;
  recipe.steps.splice(i, 1);
  selectedId = null;
  markDirty();
  render();
  updatePanel();
}

$('#stepDelete').addEventListener('click', deleteSelected);

/* ---------- overlap resolution ---------- */

// push other steps in the active step's lane so nothing overlaps it;
// earlier steps shift left (floored at 0), later steps shift right
// Steps in a lane, excluding one, in time order.
function laneSteps(active) {
  return recipe.steps
    .filter(s => s.laneId === active.laneId && s.id !== active.id)
    .sort((a, b) => a.start - b.start);
}

// How many of them sit before this step — its place in the lane's order.
function laneCut(active, others) {
  others = others || laneSteps(active);
  const i = others.findIndex(s => s.start >= active.start);
  return i < 0 ? others.length : i;
}

// Push the other steps in the active step's lane out of its way. `cut` fixes the
// active step's place in the lane order: everything before it stays before and
// everything after stays after, so dragging only ever nudges neighbours along.
// Reordering within a lane is not a drag gesture — delete the step and add it
// where you want it.
function resolveLane(active, cut) {
  const others = laneSteps(active);
  if (!others.length) return;
  if (cut === undefined) cut = laneCut(active, others);
  cut = clamp(cut, 0, others.length);
  const before = others.slice(0, cut);
  const after = others.slice(cut);

  const layout = () => {
    let limit = active.start;
    for (let j = before.length - 1; j >= 0; j--) {
      const s = before[j];
      if (s.start + s.duration > limit) s.start = limit - s.duration;
      limit = s.start;
    }
    limit = active.start + active.duration;
    for (const s of after) {
      if (s.start < limit) s.start = limit;
      limit = s.start + s.duration;
    }
  };

  const orig = others.map(s => s.start);
  layout();
  // nothing may start before t=0: the active step gives way instead
  if (before.length && before[0].start < 0) {
    const shift = -before[0].start;
    others.forEach((s, j) => { s.start = orig[j]; });
    active.start += shift;
    layout();
  }
}

/* ---------- dragging ---------- */

rows.addEventListener('pointerdown', e => {
  const block = e.target.closest('.step');
  if (!block) return;
  e.preventDefault();
  const step = stepById(block.dataset.id);
  select(step.id);
  const mode = e.target.classList.contains('handle') ? 'resize' : 'move';
  const startX = e.clientX, startY = e.clientY;
  const orig = { start: step.start, duration: step.duration, lane: laneIndex(step.laneId) };
  const origAll = new Map(recipe.steps.map(s => [s.id, { start: s.start, laneId: s.laneId }]));
  // the step's place in its lane order, held for the whole drag so neighbours
  // are pushed rather than swapped past
  let cut = laneCut(step);
  let cutLane = step.laneId;
  let moved = false;
  block.setPointerCapture(e.pointerId);
  timeline.classList.add('dragging');
  block.classList.add('dragged');

  function onMove(ev) {
    if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) moved = true;
    if (!moved) return;
    // recompute from the pre-drag layout each frame so pushed steps spring back
    for (const s of recipe.steps) {
      if (s.id === step.id) continue;
      const o = origAll.get(s.id);
      s.start = o.start;
      s.laneId = o.laneId;
    }
    const dSec = pxToSec(ev.clientX - startX);
    if (mode === 'move') {
      const li = clamp(orig.lane + Math.round((ev.clientY - startY) / rowH), 0, recipe.lanes.length - 1);
      step.laneId = recipe.lanes[li].id;
      const ds = snap(orig.start + dSec);
      step.start = Math.max(0, ds);
      // entering a different lane needs a fresh insertion point; within a lane
      // the original one is kept, so the order never changes under the drag
      if (step.laneId !== cutLane) {
        cutLane = step.laneId;
        cut = laneCut(step);
      }
      // only a lane's first step can be dragged past the front; doing so inserts
      // time at the start of the whole recipe rather than jumping the queue
      if (ds < 0 && cut === 0) {
        for (const s of recipe.steps) {
          if (s.id !== step.id) s.start -= ds;
        }
      }
    } else {
      step.duration = Math.max(SNAP, snap(orig.duration + dSec));
      block.querySelector('.dur').textContent = fmtDur(step.duration);
    }
    resolveLane(step, cut);
    for (const s of recipe.steps) positionBlock(blockEls.get(s.id), s);
    $('#stepStart').value = fmtDur(step.start);
    $('#stepDur').value = fmtDur(step.duration);
  }

  function onUp() {
    block.removeEventListener('pointermove', onMove);
    block.removeEventListener('pointerup', onUp);
    block.removeEventListener('pointercancel', onUp);
    timeline.classList.remove('dragging');
    block.classList.remove('dragged');
    if (moved) {
      markDirty();
      render();
    }
  }

  block.addEventListener('pointermove', onMove);
  block.addEventListener('pointerup', onUp);
  block.addEventListener('pointercancel', onUp);
});

rows.addEventListener('dblclick', e => {
  if (e.target.closest('.step') || !recipe.lanes.length) return;
  const rect = rows.getBoundingClientRect();
  const li = Math.floor((e.clientY - rect.top) / rowH);
  if (li < 0 || li >= recipe.lanes.length) return;
  const step = {
    id: uid('s-'),
    laneId: recipe.lanes[li].id,
    name: 'New step',
    instructions: '',
    start: Math.max(0, snap(pxToSec(e.clientX - rect.left))),
    duration: 300,
  };
  recipe.steps.push(step);
  resolveLane(step);
  selectedId = step.id;
  markDirty();
  render();
  updatePanel();
  $('#stepName').focus();
  $('#stepName').select();
});

/* ---------- lanes ---------- */

$('#addLane').addEventListener('click', () => {
  recipe.lanes.push({ id: uid('l-'), name: 'Lane ' + (recipe.lanes.length + 1) });
  markDirty();
  fitRows();
  render();
});

function deleteLane(lane) {
  const count = recipe.steps.filter(s => s.laneId === lane.id).length;
  if (count && !confirm(`Delete lane "${lane.name}" and its ${count} step${count > 1 ? 's' : ''}?`)) return;
  recipe.steps = recipe.steps.filter(s => s.laneId !== lane.id);
  recipe.lanes = recipe.lanes.filter(l => l.id !== lane.id);
  if (selectedId && !stepById(selectedId)) select(null);
  markDirty();
  fitRows();
  render();
}

/* ---------- ingredients mode ---------- */

let mode = 'timeline';
$('#modeBtn').addEventListener('click', () => {
  mode = mode === 'timeline' ? 'ingredients' : 'timeline';
  $('#modeBtn').textContent = mode === 'timeline' ? 'Ingredients' : 'Timeline';
  document.querySelector('.board').hidden = mode !== 'timeline';
  document.querySelector('.hint').hidden = mode !== 'timeline';
  $('#ingredientsEd').hidden = mode !== 'ingredients';
  $('#zoomIn').hidden = $('#zoomOut').hidden = mode !== 'timeline';
  // the board has no dimensions while hidden, so refit on the way back
  if (mode === 'timeline') fit();
});

$('#ingredientsText').addEventListener('input', markDirty);

/* ---------- the recipe as originally published ---------- */

let sourceLoaded = null;

function setSourceButton() {
  $('#sourceBtn').hidden = !(recipe.source && recipe.source.uid);
}

$('#sourceBtn').addEventListener('click', async () => {
  const panel = $('#sourcePanel');
  if (!panel.hidden) {
    panel.hidden = true;
    if (mode === 'timeline') fit();
    return;
  }
  panel.hidden = false;
  if (mode === 'timeline') fit();
  if (sourceLoaded) return;

  panel.textContent = 'Loading the original…';
  const res = await fetch('/api/recipes/' + encodeURIComponent(recipe.id) + '/source');
  if (!res.ok) {
    panel.textContent = 'No original held for this recipe.';
    return;
  }
  sourceLoaded = await res.json();
  renderSource(sourceLoaded);
});

function renderSource(s) {
  const panel = $('#sourcePanel');
  panel.textContent = '';

  const h = document.createElement('h2');
  h.textContent = s.title || 'Original';
  panel.append(h);

  const meta = [];
  if (s.contributors?.length) meta.push(s.contributors.map(c => c.replace(/^profile\//, '')).join(', '));
  if (s.serves?.length) meta.push(s.serves[0].text);
  for (const t of s.timings || []) meta.push(t.text);
  if (meta.length) {
    const m = document.createElement('p');
    m.className = 'src-meta';
    m.textContent = meta.join(' · ');
    panel.append(m);
  }
  if (s.url) {
    const a = document.createElement('a');
    a.className = 'src-link';
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = 'Read on theguardian.com';
    panel.append(a);
  }
  if (s.description) {
    const d = document.createElement('p');
    d.className = 'src-desc';
    d.textContent = s.description;
    panel.append(d);
  }

  if (s.ingredients?.length) {
    const t = document.createElement('h3');
    t.textContent = 'Ingredients';
    panel.append(t);
    for (const g of s.ingredients) {
      if (g.recipeSection) {
        const sec = document.createElement('p');
        sec.className = 'src-section';
        sec.textContent = g.recipeSection;
        panel.append(sec);
      }
      const ul = document.createElement('ul');
      ul.className = 'src-list';
      for (const i of g.ingredientsList || []) {
        const li = document.createElement('li');
        li.textContent = i.text;
        ul.append(li);
      }
      panel.append(ul);
    }
  }

  if (s.instructions?.length) {
    const t = document.createElement('h3');
    t.textContent = 'Method';
    panel.append(t);
    const ol = document.createElement('ol');
    ol.className = 'src-method';
    for (const i of s.instructions) {
      const li = document.createElement('li');
      li.textContent = i.description;
      // click to drop the original wording into the selected step
      li.title = 'Click to copy into the selected step';
      li.addEventListener('click', () => {
        const step = stepById(selectedId);
        if (!step) return;
        step.instructions = i.description;
        $('#stepInstr').value = i.description;
        markDirty();
      });
      ol.append(li);
    }
    panel.append(ol);
  }
}

/* ---------- zoom ---------- */

function setZoom(v) {
  pxPerMin = clamp(v, 2, 60);
  render();
}
$('#zoomIn').addEventListener('click', () => setZoom(pxPerMin * 1.5));
$('#zoomOut').addEventListener('click', () => setZoom(pxPerMin / 1.5));

/* ---------- load and save ---------- */

function setCookLink() {
  const a = $('#cookLink');
  a.hidden = !recipe.id;
  if (recipe.id) a.href = 'cook.html?id=' + encodeURIComponent(recipe.id);
}

async function load() {
  window.addEventListener('resize', () => { if (mode === 'timeline') fit(); });

  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    recipe.lanes = [{ id: uid('l-'), name: 'Prep' }, { id: uid('l-'), name: 'Cook' }];
    fit();
    return;
  }
  const res = await fetch('/api/recipes/' + encodeURIComponent(id));
  if (!res.ok) {
    setStatus('Failed to load recipe');
    fit();
    return;
  }
  recipe = await res.json();
  recipe.lanes = recipe.lanes || [];
  recipe.steps = recipe.steps || [];
  $('#recipeName').value = recipe.name;
  $('#ingredientsText').value = (recipe.ingredients || []).join('\n');
  setCookLink();
  setSourceButton();
  fit();
}

async function save() {
  recipe.name = $('#recipeName').value.trim() || 'Untitled recipe';
  recipe.ingredients = $('#ingredientsText').value.split('\n').map(s => s.trim()).filter(Boolean);
  // drop any blank time at the front of the recipe
  if (recipe.steps.length) {
    const min = Math.min(...recipe.steps.map(s => s.start));
    if (min > 0) {
      recipe.steps.forEach(s => { s.start -= min; });
      render();
    }
  }
  const isNew = !recipe.id;
  setStatus('Saving…');
  const res = await fetch(isNew ? '/api/recipes' : '/api/recipes/' + encodeURIComponent(recipe.id), {
    method: isNew ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(recipe),
  });
  if (!res.ok) {
    setStatus('Save failed');
    return;
  }
  const saved = await res.json();
  recipe.id = saved.id;
  history.replaceState(null, '', 'editor.html?id=' + encodeURIComponent(recipe.id));
  setCookLink();
  dirty = false;
  setStatus('Saved');
}

$('#saveBtn').addEventListener('click', save);
$('#recipeName').addEventListener('input', markDirty);

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
    return;
  }
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) deleteSelected();
});

window.addEventListener('beforeunload', e => {
  if (dirty) e.preventDefault();
});

load();
