'use strict';

const searchBox = document.querySelector('#search');
const results = document.querySelector('#results');
let timer = null;
let meal = [];
const summaries = new Map();  // id -> summary from fetches

try {
  meal = JSON.parse(localStorage.getItem('teatime.meal') || '[]');
} catch { meal = []; }

function saveMeal() {
  localStorage.setItem('teatime.meal', JSON.stringify(meal));
}

function renderMeal() {
  const section = document.querySelector('#meal');
  section.hidden = !meal.length;
  if (!meal.length) return;
  const list = document.querySelector('#mealList');
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
  document.querySelector('#mealTotal').textContent =
    meal.length > 1 ? 'Everything ready in ' + fmtDur(longest) : 'Ready in ' + fmtDur(longest);
  document.querySelector('#cookMeal').href = 'cook.html?ids=' + meal.map(encodeURIComponent).join(',');
}

document.querySelector('#clearMeal').addEventListener('click', () => {
  meal = [];
  saveMeal();
  refresh();
});

/* ---------- saved meals ---------- */

let meals = [];

async function fetchMeals() {
  const res = await fetch('/api/meals');
  meals = res.ok ? await res.json() : [];
}

document.querySelector('#saveMealBtn').addEventListener('click', async () => {
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

function renderMeals(q) {
  const section = document.querySelector('#mealsSaved');
  const list = document.querySelector('#mealsList');
  const shown = meals.filter(m => !q || m.name.toLowerCase().includes(q.toLowerCase()));
  section.hidden = !shown.length;
  list.textContent = '';
  for (const m of shown) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = 'cook.html?meal=' + encodeURIComponent(m.id);
    a.textContent = m.name;
    const names = m.recipeIds.map(id => summaries.has(id) ? summaries.get(id).name : id);
    const d = document.createElement('span');
    d.className = 'desc';
    d.textContent = names.join(', ');
    a.append(d);
    const total = document.createElement('span');
    total.className = 'total';
    const longest = Math.max(0, ...m.recipeIds.map(id => summaries.get(id)?.totalSeconds || 0));
    total.textContent = fmtDur(longest);
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    loadBtn.title = 'Load into the meal builder';
    loadBtn.addEventListener('click', () => {
      meal = [...m.recipeIds];
      saveMeal();
      refresh();
    });
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete meal "${m.name}"?`)) return;
      await fetch('/api/meals/' + encodeURIComponent(m.id), { method: 'DELETE' });
      await fetchMeals();
      refresh();
    });
    li.append(a, total, loadBtn, del);
    list.append(li);
  }
}

async function refresh() {
  const q = searchBox.value.trim();
  const res = await fetch('/api/recipes' + (q ? '?q=' + encodeURIComponent(q) : ''));
  if (!res.ok) {
    results.innerHTML = '<li class="empty">Failed to load recipes.</li>';
    return;
  }
  const list = await res.json();
  for (const r of list) summaries.set(r.id, r);
  if (!q) {
    // full list: drop meal entries for recipes that no longer exist
    const ids = new Set(list.map(r => r.id));
    const pruned = meal.filter(id => ids.has(id));
    if (pruned.length !== meal.length) {
      meal = pruned;
      saveMeal();
    }
  }

  results.textContent = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q ? 'No recipes match.' : 'No recipes yet.';
    results.append(li);
  }
  for (const r of list) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = 'cook.html?id=' + encodeURIComponent(r.id);
    a.textContent = r.name;
    if (r.description) {
      const d = document.createElement('span');
      d.className = 'desc';
      d.textContent = r.description;
      a.append(d);
    }
    const total = document.createElement('span');
    total.className = 'total';
    total.textContent = fmtDur(r.totalSeconds);
    const add = document.createElement('button');
    add.textContent = meal.includes(r.id) ? 'Added' : 'Add';
    add.disabled = meal.includes(r.id);
    add.addEventListener('click', () => {
      meal.push(r.id);
      saveMeal();
      refresh();
    });
    const edit = document.createElement('a');
    edit.href = 'editor.html?id=' + encodeURIComponent(r.id);
    edit.innerHTML = '<button>Edit</button>';
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${r.name}"?`)) return;
      await fetch('/api/recipes/' + encodeURIComponent(r.id), { method: 'DELETE' });
      meal = meal.filter(m => m !== r.id);
      saveMeal();
      refresh();
    });
    li.append(a, total, add, edit, del);
    results.append(li);
  }
  renderMeal();
  renderMeals(q);
}

searchBox.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(refresh, 200);
});

fetchMeals().then(refresh);
