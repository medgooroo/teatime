'use strict';

const $ = s => document.querySelector(s);

// conversions put the cook's own notes at the end of the description
function stripNotes(desc) {
  const i = (desc || '').indexOf('Notes:');
  return (i < 0 ? desc || '' : desc.slice(0, i)).trim();
}

// a card with action buttons instead of a click-through
function itemCard(title, sub, foot, actions) {
  const el = document.createElement('div');
  el.className = 'card static';
  const h = document.createElement('span');
  h.className = 'card-title';
  h.textContent = title;
  el.append(h);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'card-sub';
    s.textContent = sub;
    el.append(s);
  }
  if (foot) {
    const f = document.createElement('span');
    f.className = 'card-foot';
    f.textContent = foot;
    el.append(f);
  }
  const row = document.createElement('div');
  row.className = 'card-actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = a.cls || '';
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await a.onClick(b); } finally { b.disabled = false; }
    });
    row.append(b);
  }
  el.append(row);
  return el;
}

async function loadAll() {
  const [recRes, mealRes] = await Promise.all([
    fetch('/api/recipes?hidden=1&limit=0'),
    fetch('/api/meals'),
  ]);
  const recipes = recRes.ok ? await recRes.json() : [];
  const meals = (mealRes.ok ? await mealRes.json() : []).filter(m => m.hidden);

  const rl = $('#hRecipesList');
  rl.textContent = '';
  for (const r of recipes) {
    rl.append(itemCard(r.name, stripNotes(r.description), fmtDur(r.totalSeconds), [
      {
        label: 'Bring back', cls: 'primary',
        onClick: async () => {
          await fetch('/api/recipes/' + encodeURIComponent(r.id) + '/hide?on=0', { method: 'POST' });
          loadAll();
        },
      },
    ]));
  }
  $('#hRecipes').hidden = !recipes.length;

  const ml = $('#hMealsList');
  ml.textContent = '';
  for (const m of meals) {
    ml.append(itemCard(m.name, '',
      m.recipeIds.length + (m.recipeIds.length === 1 ? ' recipe' : ' recipes'), [
      {
        label: 'Bring back', cls: 'primary',
        onClick: async () => {
          await fetch('/api/meals/' + encodeURIComponent(m.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...m, hidden: false }),
          });
          loadAll();
        },
      },
    ]));
  }
  $('#hMeals').hidden = !meals.length;

  $('#noneHidden').hidden = !!(recipes.length || meals.length);
}

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
    loadAll();
  } catch (e) {
    backupStatus.textContent = 'Restore failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

loadAll();
