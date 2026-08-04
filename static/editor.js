'use strict';

const SNAP = 30;   // drag snap, seconds
const ROW_H = 56;  // must match --row-h in style.css

let recipe = { id: null, name: 'New recipe', description: '', lanes: [], steps: [] };
let pxPerMin = 8;
let selectedId = null;
let dirty = false;
let blockEls = new Map();

const $ = s => document.querySelector(s);
const rows = $('#rows');
const ruler = $('#ruler');

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
  rows.style.height = Math.max(1, recipe.lanes.length) * ROW_H + 'px';

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
    row.style.top = i * ROW_H + 'px';
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
  el.style.top = li * ROW_H + 5 + 'px';
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
  dur.textContent = fmtDur(step.duration);
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
  $('#stepInstr').value = step.instructions;
}

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
    step.start = Math.max(0, sec);
    resolveLane(step);
    markDirty();
    render();
  }
  updatePanel();
});

$('#stepDur').addEventListener('change', () => {
  const step = stepById(selectedId);
  const sec = parseDur($('#stepDur').value);
  if (step && sec !== null && sec > 0) {
    step.duration = sec;
    resolveLane(step);
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
function resolveLane(active) {
  const others = recipe.steps
    .filter(s => s.laneId === active.laneId && s.id !== active.id)
    .sort((a, b) => a.start - b.start);
  const centre = active.start + active.duration / 2;
  const before = others.filter(s => s.start + s.duration / 2 < centre);
  const after = others.filter(s => s.start + s.duration / 2 >= centre);
  const orig = others.map(s => s.start);

  for (let pass = 0; pass < 2; pass++) {
    let limit = active.start;
    for (let i = before.length - 1; i >= 0; i--) {
      const s = before[i];
      if (s.start + s.duration > limit) s.start = limit - s.duration;
      limit = s.start;
    }
    if (!before.length || before[0].start >= 0) break;
    // no room left of t=0: the active step gives way instead
    active.start -= before[0].start;
    others.forEach((s, i) => { s.start = orig[i]; });
  }

  let limit = active.start + active.duration;
  for (const s of after) {
    if (s.start < limit) s.start = limit;
    limit = s.start + s.duration;
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
  let moved = false;
  block.setPointerCapture(e.pointerId);

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
      let ds = snap(orig.start + dSec);
      if (ds < 0) {
        // dragged past the front: push everything else later instead
        for (const s of recipe.steps) {
          if (s.id !== step.id) s.start -= ds;
        }
        ds = 0;
      }
      step.start = ds;
      const li = clamp(orig.lane + Math.round((ev.clientY - startY) / ROW_H), 0, recipe.lanes.length - 1);
      step.laneId = recipe.lanes[li].id;
    } else {
      step.duration = Math.max(SNAP, snap(orig.duration + dSec));
      block.querySelector('.dur').textContent = fmtDur(step.duration);
    }
    resolveLane(step);
    for (const s of recipe.steps) positionBlock(blockEls.get(s.id), s);
    $('#stepStart').value = fmtDur(step.start);
    $('#stepDur').value = fmtDur(step.duration);
  }

  function onUp() {
    block.removeEventListener('pointermove', onMove);
    block.removeEventListener('pointerup', onUp);
    block.removeEventListener('pointercancel', onUp);
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
  const li = Math.floor((e.clientY - rect.top) / ROW_H);
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
  render();
});

function deleteLane(lane) {
  const count = recipe.steps.filter(s => s.laneId === lane.id).length;
  if (count && !confirm(`Delete lane "${lane.name}" and its ${count} step${count > 1 ? 's' : ''}?`)) return;
  recipe.steps = recipe.steps.filter(s => s.laneId !== lane.id);
  recipe.lanes = recipe.lanes.filter(l => l.id !== lane.id);
  if (selectedId && !stepById(selectedId)) select(null);
  markDirty();
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
});

$('#ingredientsText').addEventListener('input', markDirty);

/* ---------- zoom ---------- */

function setZoom(v) {
  pxPerMin = clamp(v, 3, 24);
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
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    recipe.lanes = [{ id: uid('l-'), name: 'Prep' }, { id: uid('l-'), name: 'Cook' }];
    render();
    return;
  }
  const res = await fetch('/api/recipes/' + encodeURIComponent(id));
  if (!res.ok) {
    setStatus('Failed to load recipe');
    render();
    return;
  }
  recipe = await res.json();
  recipe.lanes = recipe.lanes || [];
  recipe.steps = recipe.steps || [];
  $('#recipeName').value = recipe.name;
  $('#ingredientsText').value = (recipe.ingredients || []).join('\n');
  setCookLink();
  render();
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
