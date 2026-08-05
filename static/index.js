'use strict';

const $ = s => document.querySelector(s);
const searchBox = $('#search');
const ingBox = $('#ingSearch');
const results = $('#results');
let timer = null;
let meal = [];
let meals = [];
const summaries = new Map();   // id -> summary from the list endpoint

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

function renderRecipes(list) {
  results.textContent = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = searchBox.value.trim() ? 'No recipes match.' : 'No recipes yet.';
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

// starred recipes get their own section, independent of the current search
async function renderStarred() {
  const section = $('#starred');
  const list = $('#starredList');
  const res = await fetch('/api/recipes?starred=1');
  if (!res.ok) return;
  const starred = await res.json();
  for (const r of starred) summaries.set(r.id, r);
  section.hidden = !starred.length;
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
  const shown = meals.filter(m => !q || m.name.toLowerCase().includes(q.toLowerCase()));
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

function detailShell(title, subtitle) {
  const card = $('#detailCard');
  card.textContent = '';
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

  card.textContent = '';
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

  card.append(actionRow([
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
    {
      label: 'Delete', cls: 'danger',
      onClick: async () => {
        if (!confirm(`Delete "${r.name}"?`)) return;
        await fetch('/api/recipes/' + encodeURIComponent(r.id), { method: 'DELETE' });
        meal = meal.filter(m => m !== r.id);
        saveMeal();
        closeDetail();
        refresh();
      },
    },
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

  card.append(actionRow([
    { label: 'Cook', cls: 'primary', href: 'cook.html?meal=' + encodeURIComponent(m.id) },
    {
      label: 'Load into builder',
      onClick: () => { meal = [...m.recipeIds]; saveMeal(); closeDetail(); refresh(); },
    },
    {
      label: 'Delete', cls: 'danger',
      onClick: async () => {
        if (!confirm(`Delete meal "${m.name}"?`)) return;
        await fetch('/api/meals/' + encodeURIComponent(m.id), { method: 'DELETE' });
        closeDetail();
        await fetchMeals();
        refresh();
      },
    },
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
  section.hidden = !meal.length;
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
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  for (const i of ings) params.append('ing', i);
  const res = await fetch('/api/recipes' + (params.toString() ? '?' + params : ''));
  if (!res.ok) {
    results.innerHTML = '<p class="empty">Failed to load recipes.</p>';
    return;
  }
  const list = await res.json();
  const total = parseInt(res.headers.get('X-Total-Count') || list.length, 10);
  for (const r of list) summaries.set(r.id, r);
  if (!q && !ings.length && total === list.length) {
    // full list: drop meal entries for recipes that no longer exist
    const ids = new Set(list.map(r => r.id));
    const pruned = meal.filter(id => ids.has(id));
    if (pruned.length !== meal.length) {
      meal = pruned;
      saveMeal();
    }
  }
  const what = ings.length ? `Recipes with ${ings.join(' + ')}` : 'Recipes';
  $('#recipesHeading').textContent = total > list.length
    ? `${what} (showing ${list.length} of ${total} — narrow the search)`
    : `${what} (${total})`;
  renderRecipes(list);
  renderMeal();
  renderMeals(q);
  renderStarred();
}

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
    if (s.removed) {
      const undo = document.createElement('button');
      undo.textContent = `Bring back ${s.removed} deleted`;
      undo.addEventListener('click', () => runSync('?forget=1'));
      head.append(undo);
    }
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
    if (s.removed) parts.push(`${s.removed} you deleted, left out`);
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

/* ---------- backup and restore ---------- */

const backupStatus = $('#backupStatus');

$('#backupBtn').addEventListener('click', async () => {
  const btn = $('#backupBtn');
  btn.disabled = true;
  backupStatus.textContent = 'Building the archive…';
  try {
    const res = await fetch('/api/backup');
    if (!res.ok) throw new Error(await res.text());
    const count = res.headers.get('X-Recipe-Count');
    const blob = await res.blob();
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name ? name[1] : 'teatime-backup.tar.gz';
    a.click();
    URL.revokeObjectURL(a.href);
    const mb = (blob.size / 1048576).toFixed(1);
    backupStatus.textContent = `Saved ${count} files, ${mb} MB.`;
  } catch (e) {
    backupStatus.textContent = 'Backup failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

$('#restoreFile').addEventListener('change', () => {
  $('#restoreBtn').disabled = !$('#restoreFile').files.length;
  backupStatus.textContent = '';
});

$('#restoreBtn').addEventListener('click', async () => {
  const file = $('#restoreFile').files[0];
  if (!file) return;
  const replace = $('#restoreReplace').checked;

  const warning = replace
    ? `Restore from "${file.name}", DELETING every recipe not in it?`
    : `Restore from "${file.name}"? Recipes in the backup will overwrite what is here; anything else is left alone.`;
  if (!confirm(warning)) return;

  const btn = $('#restoreBtn');
  btn.disabled = true;
  backupStatus.textContent = 'Restoring…';
  try {
    const res = await fetch('/api/restore?mode=' + (replace ? 'replace' : 'merge'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file,
    });
    if (!res.ok) throw new Error(await res.text());
    const r = await res.json();
    const bits = [`${r.restored} restored`];
    if (r.removed) bits.push(`${r.removed} removed`);
    if (r.skipped) bits.push(`${r.skipped} skipped`);
    backupStatus.textContent = bits.join(', ') + '.';
    await refresh();
  } catch (e) {
    backupStatus.textContent = 'Restore failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

fetchMeals().then(refresh);
