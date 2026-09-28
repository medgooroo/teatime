'use strict';

const $ = s => document.querySelector(s);
const searchBox = $('#search');
const ingBox = $('#ingSearch');
const results = $('#results');
let timer = null;
let meal = [];
let meals = [];
const summaries = new Map();   // id -> summary from the list endpoint

const PAGE = 60;
// a fresh shuffle order per visit; the seed keeps paging consistent within it
const shuffleSeed = Math.floor(Math.random() * 1e9);
let searching = false;    // a text or ingredient search is active
let listParams = '';      // query string of the current list, for paging
let listTotal = 0;        // matches on the server
let listGen = 0;          // stale-response guard
let loadingMore = false;

try {
  meal = JSON.parse(localStorage.getItem('teatime.meal') || '[]');
} catch { meal = []; }

const saveMeal = () => localStorage.setItem('teatime.meal', JSON.stringify(meal));
const inMeal = id => meal.includes(id);

// conversions put the cook's own notes at the end of the description
function splitNotes(desc) {
  const i = (desc || '').indexOf('Notes:');
  if (i < 0) return { text: desc || '', notes: '' };
  return { text: desc.slice(0, i).trim(), notes: desc.slice(i + 6).trim() };
}

/* ---------- cards ---------- */

function card(opts) {
  // a div, not a button — it has to contain the star button
  const el = document.createElement('div');
  el.className = 'card';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onClick(); }
  });

  if (opts.onStar) {
    const star = document.createElement('button');
    star.className = 'card-star' + (opts.starred ? ' on' : '');
    star.type = 'button';
    star.title = opts.starred ? 'Remove from this week' : 'Save for this week';
    star.setAttribute('aria-pressed', String(!!opts.starred));
    star.textContent = opts.starred ? '★' : '☆';
    star.addEventListener('click', e => { e.stopPropagation(); opts.onStar(); });
    el.append(star);
  }

  const h = document.createElement('span');
  h.className = 'card-title';
  h.textContent = opts.title;
  el.append(h);
  if (opts.sub) {
    const s = document.createElement('span');
    s.className = 'card-sub';
    s.textContent = opts.sub;
    el.append(s);
  }
  const foot = document.createElement('span');
  foot.className = 'card-foot';
  const t = document.createElement('span');
  t.textContent = opts.time;
  foot.append(t);
  if (opts.flag) {
    const f = document.createElement('span');
    f.className = 'card-flag';
    f.textContent = opts.flag;
    foot.append(f);
  }
  el.append(foot);
  el.addEventListener('click', opts.onClick);
  return el;
}

function renderRecipes(list, append) {
  if (!append) results.textContent = '';
  if (!append && !list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = searching ? 'No recipes match.' : 'No recipes yet.';
    results.append(p);
    return;
  }
  for (const r of list) {
    const { text, notes } = splitNotes(r.description);
    results.append(card({
      title: r.name,
      sub: text,
      time: fmtDur(r.totalSeconds),
      flag: [notes ? 'notes' : '', inMeal(r.id) ? 'in meal' : ''].filter(Boolean).join(' · '),
      starred: r.starred,
      onStar: () => toggleStar(r.id, !r.starred),
      onClick: () => openRecipe(r.id),
    }));
  }
}

async function toggleStar(id, on) {
  const res = await fetch(`/api/recipes/${encodeURIComponent(id)}/star?on=${on ? 1 : 0}`,
    { method: 'POST' });
  if (!res.ok) return;
  const s = summaries.get(id);
  if (s) s.starred = on;
  refresh();
}

// starred recipes get their own section, tucked away while a search is on
// so results stay above the fold
async function renderStarred() {
  const section = $('#starred');
  const list = $('#starredList');
  const res = await fetch('/api/recipes?starred=1');
  if (!res.ok) return;
  const starred = await res.json();
  for (const r of starred) summaries.set(r.id, r);
  section.hidden = searching || !starred.length;
  list.textContent = '';
  for (const r of starred) {
    const { text } = splitNotes(r.description);
    list.append(card({
      title: r.name,
      sub: text,
      time: fmtDur(r.totalSeconds),
      flag: inMeal(r.id) ? 'in meal' : '',
      starred: true,
      onStar: () => toggleStar(r.id, false),
      onClick: () => openRecipe(r.id),
    }));
  }
}

function renderMeals(q) {
  const section = $('#mealsSaved');
  const list = $('#mealsList');
  const shown = meals.filter(m => !m.hidden)
    .filter(m => !q || m.name.toLowerCase().includes(q.toLowerCase()));
  section.hidden = !shown.length;
  list.textContent = '';
  for (const m of shown) {
    const names = m.recipeIds.map(id => summaries.get(id)?.name || id);
    const longest = Math.max(0, ...m.recipeIds.map(id => summaries.get(id)?.totalSeconds || 0));
    list.append(card({
      title: m.name,
      sub: names.join(', '),
      time: fmtDur(longest),
      flag: m.recipeIds.length + ' recipes',
      onClick: () => openMeal(m),
    }));
  }
}

/* ---------- detail view ---------- */

// empties the card, keeping a close button in the corner
function resetDetailCard() {
  const card = $('#detailCard');
  card.textContent = '';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'detail-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', closeDetail);
  card.append(close);
  return card;
}

function detailShell(title, subtitle) {
  const card = resetDetailCard();
  const h = document.createElement('h1');
  h.textContent = title;
  card.append(h);
  if (subtitle) {
    const s = document.createElement('p');
    s.className = 'detail-meta';
    s.textContent = subtitle;
    card.append(s);
  }
  $('#detail').hidden = false;
  return card;
}

function closeDetail() { $('#detail').hidden = true; }

$('#detail').addEventListener('click', e => { if (e.target.id === 'detail') closeDetail(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });

function actionRow(buttons) {
  const row = document.createElement('div');
  row.className = 'detail-actions';
  for (const b of buttons) {
    if (b.href) {
      const a = document.createElement('a');
      a.href = b.href;
      const btn = document.createElement('button');
      btn.className = b.cls || '';
      btn.textContent = b.label;
      a.append(btn);
      row.append(a);
    } else {
      const btn = document.createElement('button');
      btn.className = b.cls || '';
      btn.textContent = b.label;
      btn.disabled = !!b.disabled;
      btn.addEventListener('click', b.onClick);
      row.append(btn);
    }
  }
  return row;
}

async function openRecipe(id) {
  const s = summaries.get(id);
  const card = detailShell(s ? s.name : id, 'Loading…');
  const res = await fetch('/api/recipes/' + encodeURIComponent(id));
  if (!res.ok) {
    card.querySelector('.detail-meta').textContent = 'Could not load this recipe.';
    return;
  }
  const r = await res.json();
  const total = r.steps.reduce((m, st) => Math.max(m, st.start + st.duration), 0);
  const alarms = r.steps.filter(st => st.alarm).length;
  const { text, notes } = splitNotes(r.description);

  resetDetailCard();
  const h = document.createElement('h1');
  h.textContent = r.name;
  const meta = document.createElement('p');
  meta.className = 'detail-meta';
  meta.textContent = [
    fmtDur(total),
    r.lanes.length + (r.lanes.length === 1 ? ' lane' : ' lanes'),
    r.steps.length + ' steps',
    alarms ? alarms + ' alarms' : null,
  ].filter(Boolean).join(' · ');
  card.append(h, meta);

  const setHidden = async on => {
    await fetch('/api/recipes/' + encodeURIComponent(r.id) + '/hide?on=' + (on ? 1 : 0),
      { method: 'POST' });
    if (on) {
      meal = meal.filter(m => m !== r.id);
      saveMeal();
      summaries.delete(r.id);
    }
    closeDetail();
    refresh();
  };
  card.append(actionRow(r.hidden ? [
    { label: 'Bring back', cls: 'primary', onClick: () => setHidden(false) },
    { label: 'Edit', href: 'editor.html?id=' + encodeURIComponent(r.id) },
  ] : [
    { label: 'Cook', cls: 'primary', href: 'cook.html?id=' + encodeURIComponent(r.id) },
    {
      label: r.starred ? 'Starred' : 'Star for this week',
      cls: r.starred ? 'starred' : '',
      onClick: async () => {
        await toggleStar(r.id, !r.starred);
        openRecipe(r.id);
      },
    },
    {
      label: inMeal(r.id) ? 'In meal' : 'Add to meal',
      disabled: inMeal(r.id),
      onClick: () => { meal.push(r.id); saveMeal(); closeDetail(); refresh(); },
    },
    { label: 'Edit', href: 'editor.html?id=' + encodeURIComponent(r.id) },
    { label: 'Hide', cls: 'danger', onClick: () => setHidden(true) },
  ]));

  if (text) {
    const p = document.createElement('p');
    p.className = 'detail-desc';
    p.textContent = text;
    card.append(p);
  }
  if (notes) {
    const box = document.createElement('div');
    box.className = 'detail-notes';
    const t = document.createElement('h2');
    t.textContent = 'Notes';
    const b = document.createElement('p');
    b.textContent = notes;
    box.append(t, b);
    card.append(box);
  }
  if (r.ingredients?.length) {
    const t = document.createElement('h2');
    t.textContent = 'Ingredients';
    t.append(copyBtn(() => r.ingredients.join('\n')));
    const ul = document.createElement('ul');
    ul.className = 'detail-list';
    for (const i of r.ingredients) {
      const li = document.createElement('li');
      li.textContent = i;
      ul.append(li);
    }
    card.append(t, ul);
  }
  if (r.lanes.length) {
    const t = document.createElement('h2');
    t.textContent = 'Timeline';
    card.append(t);
    for (const lane of r.lanes) {
      const steps = r.steps.filter(st => st.laneId === lane.id).sort((a, b) => a.start - b.start);
      if (!steps.length) continue;
      const row = document.createElement('p');
      row.className = 'detail-lane';
      const n = document.createElement('strong');
      n.textContent = lane.name + ': ';
      row.append(n, document.createTextNode(steps.map(st => st.name).join(' → ')));
      card.append(row);
    }
  }
}

function openMeal(m) {
  const names = m.recipeIds.map(id => summaries.get(id)?.name || id);
  const longest = Math.max(0, ...m.recipeIds.map(id => summaries.get(id)?.totalSeconds || 0));
  const card = detailShell(m.name, `${m.recipeIds.length} recipes · everything ready in ${fmtDur(longest)}`);

  const setMealHidden = async on => {
    await fetch('/api/meals/' + encodeURIComponent(m.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...m, hidden: on }),
    });
    closeDetail();
    await fetchMeals();
    refresh();
  };
  card.append(actionRow(m.hidden ? [
    { label: 'Bring back', cls: 'primary', onClick: () => setMealHidden(false) },
  ] : [
    { label: 'Cook', cls: 'primary', href: 'cook.html?meal=' + encodeURIComponent(m.id) },
    {
      label: 'Load into builder',
      onClick: () => { meal = [...m.recipeIds]; saveMeal(); closeDetail(); refresh(); },
    },
    { label: 'Hide', cls: 'danger', onClick: () => setMealHidden(true) },
  ]));

  const t = document.createElement('h2');
  t.textContent = 'Recipes';
  const ul = document.createElement('ul');
  ul.className = 'detail-list';
  m.recipeIds.forEach((id, i) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = names[i];
    a.addEventListener('click', ev => { ev.preventDefault(); openRecipe(id); });
    li.append(a);
    ul.append(li);
  });
  card.append(t, ul);
}

/* ---------- meal builder ---------- */

function renderMeal() {
  const section = $('#meal');
  section.hidden = searching || !meal.length;
  if (!meal.length) return;
  const list = $('#mealList');
  list.textContent = '';
  let longest = 0;
  for (const id of meal) {
    const s = summaries.get(id);
    if (s) longest = Math.max(longest, s.totalSeconds);
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = s ? s.name : id;
    const dur = document.createElement('span');
    dur.className = 'total';
    dur.textContent = s ? fmtDur(s.totalSeconds) : '';
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.title = 'Remove from meal';
    rm.addEventListener('click', () => {
      meal = meal.filter(m => m !== id);
      saveMeal();
      refresh();
    });
    li.append(name, dur, rm);
    list.append(li);
  }
  $('#mealTotal').textContent =
    (meal.length > 1 ? 'Everything ready in ' : 'Ready in ') + fmtDur(longest);
  $('#cookMeal').href = 'cook.html?ids=' + meal.map(encodeURIComponent).join(',');
}

$('#clearMeal').addEventListener('click', () => {
  meal = [];
  saveMeal();
  refresh();
});

$('#saveMealBtn').addEventListener('click', async () => {
  const name = prompt('Name this meal');
  if (name === null) return;
  await fetch('/api/meals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, recipeIds: meal }),
  });
  await fetchMeals();
  refresh();
});

async function fetchMeals() {
  const res = await fetch('/api/meals');
  meals = res.ok ? await res.json() : [];
}

/* ---------- load ---------- */

async function refresh() {
  const q = searchBox.value.trim();
  const ings = ingBox.value.split(',').map(s => s.trim()).filter(Boolean);
  searching = !!(q || ings.length);
  const gen = ++listGen;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  for (const i of ings) params.append('ing', i);
  // browsing gets a shuffled order; a search stays alphabetical
  if (!searching) params.set('shuffle', shuffleSeed);
  params.set('limit', PAGE);
  listParams = params.toString();

  const res = await fetch('/api/recipes?' + listParams);
  if (gen !== listGen) return;   // a newer search superseded this one
  if (!res.ok) {
    results.innerHTML = '<p class="empty">Failed to load recipes.</p>';
    return;
  }
  const list = await res.json();
  if (gen !== listGen) return;
  listTotal = parseInt(res.headers.get('X-Total-Count') || list.length, 10);
  for (const r of list) summaries.set(r.id, r);
  if (!searching && listTotal === list.length) {
    // full list: drop meal entries for recipes that no longer exist
    const ids = new Set(list.map(r => r.id));
    const pruned = meal.filter(id => ids.has(id));
    if (pruned.length !== meal.length) {
      meal = pruned;
      saveMeal();
    }
  }
  const bits = [];
  if (q) bits.push(`“${q}”`);
  if (ings.length) bits.push('with ' + ings.join(' + '));
  $('#recipesHeading').textContent = searching
    ? `Recipes matching ${bits.join(', ')} (${listTotal})`
    : `Recipes (${listTotal})`;

  renderRecipes(list);
  renderMeal();
  renderMeals(q);
  renderStarred();
}

/* ---------- continuous scroll ---------- */

async function loadMore() {
  const rendered = results.querySelectorAll('.card').length;
  if (loadingMore || rendered >= listTotal) return;
  loadingMore = true;
  $('#moreNote').hidden = false;
  const gen = listGen;
  try {
    const params = new URLSearchParams(listParams);
    params.set('offset', rendered);
    const res = await fetch('/api/recipes?' + params);
    if (!res.ok || gen !== listGen) return;
    const list = await res.json();
    if (gen !== listGen) return;
    if (!list.length) { listTotal = rendered; return; }   // server ran dry early
    for (const r of list) summaries.set(r.id, r);
    renderRecipes(list, true);
  } finally {
    loadingMore = false;
    $('#moreNote').hidden = true;
  }
}

new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) loadMore();
}, { rootMargin: '600px' }).observe($('#sentinel'));


for (const el of [searchBox, ingBox]) {
  el.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  });
}

/* ---------- pull new recipes from the Guardian ---------- */

const syncPanel = $('#syncPanel');

function renderSync(s) {
  syncPanel.hidden = false;
  syncPanel.textContent = '';

  const head = document.createElement('div');
  head.className = 'sync-head';
  const stage = document.createElement('strong');
  stage.textContent = s.error ? s.stage || 'Something went wrong' : s.stage;
  head.append(stage);

  if (!s.running) {
    const close = document.createElement('button');
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => { syncPanel.hidden = true; });
    head.append(close);
  }
  syncPanel.append(head);

  if (s.error) {
    const err = document.createElement('p');
    err.className = 'sync-error';
    err.textContent = s.error;
    syncPanel.append(err);
    return;
  }

  // counts, only once the index has been read
  if (s.indexed) {
    const line = document.createElement('p');
    line.className = 'sync-counts';
    const parts = [`${s.indexed.toLocaleString()} recipes published`];
    if (s.already) parts.push(`${s.already.toLocaleString()} already yours`);
    if (s.toFetch) parts.push(`${s.toFetch.toLocaleString()} new`);
    if (s.failed) parts.push(`${s.failed} could not be read`);
    if (s.unavailable) parts.push(`${s.unavailable} unavailable, skipped`);
    if (s.restored) parts.push(`${s.restored} once deleted, brought back hidden`);
    line.textContent = parts.join(' · ');
    syncPanel.append(line);
  }

  if (s.toFetch > 0) {
    const bar = document.createElement('div');
    bar.className = 'sync-bar';
    const fill = document.createElement('div');
    const pct = Math.round(((s.added + s.failed) / s.toFetch) * 100);
    fill.style.width = pct + '%';
    bar.append(fill);
    const count = document.createElement('p');
    count.className = 'sync-counts';
    count.textContent = s.running
      ? `Importing ${s.added + s.failed} of ${s.toFetch}${s.current ? ' — ' + s.current : ''}`
      : `Imported ${s.added} of ${s.toFetch}${s.partial ? ', more waiting — press again' : ''} in ${s.took}`;
    syncPanel.append(bar, count);
  } else if (s.done) {
    const p = document.createElement('p');
    p.className = 'sync-counts';
    p.textContent = 'Nothing new to import.';
    syncPanel.append(p);
  }

  if (s.names && s.names.length) {
    const list = document.createElement('ul');
    list.className = 'sync-names';
    for (const n of s.names.slice(-8).reverse()) {
      const li = document.createElement('li');
      li.textContent = n;
      list.append(li);
    }
    syncPanel.append(list);
  }
}

async function runSync(query = '') {
  const btn = $('#syncBtn');
  btn.disabled = true;
  renderSync({ running: true, stage: 'Contacting the Guardian…' });
  try {
    let s = await (await fetch('/api/guardian/sync' + query, { method: 'POST' })).json();
    renderSync(s);
    while (s.running) {
      await new Promise(r => setTimeout(r, 400));
      s = await (await fetch('/api/guardian/sync')).json();
      renderSync(s);
    }
    if (s.added > 0) await refresh();
  } catch (e) {
    renderSync({ running: false, done: true, stage: 'Check failed', error: e.message });
  } finally {
    btn.disabled = false;
  }
}

$('#syncBtn').addEventListener('click', () => runSync());

fetchMeals().then(refresh);
