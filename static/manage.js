'use strict';

const $ = s => document.querySelector(s);

// one compact row: a name, a short note, and action buttons
function itemRow(title, foot, actions) {
  const el = document.createElement('div');
  el.className = 'hid-row';
  const h = document.createElement('span');
  h.className = 'hid-name';
  h.textContent = title;
  const f = document.createElement('span');
  f.className = 'hid-foot';
  f.textContent = foot || '';
  el.append(h, f);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = a.cls || '';
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await a.onClick(b); } finally { b.disabled = false; }
    });
    el.append(b);
  }
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
    rl.append(itemRow(r.name, fmtDur(r.totalSeconds), [
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
    ml.append(itemRow(m.name,
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

/* ---------- account and users ---------- */

async function apiError(res) {
  return (await res.text()).trim() || res.statusText;
}

const userStatus = $('#userStatus');

async function loadUsers() {
  const res = await fetch('/api/users');
  if (!res.ok) return;
  const list = $('#userList');
  list.textContent = '';
  for (const u of await res.json()) {
    const row = document.createElement('div');
    row.className = 'backup-row user-row';
    const name = document.createElement('strong');
    name.textContent = u.name;
    name.className = 'user-name';
    const role = document.createElement('select');
    for (const r of ['user', 'admin']) {
      const o = document.createElement('option');
      o.value = o.textContent = r;
      o.selected = r === u.role;
      role.append(o);
    }
    role.addEventListener('change', async () => {
      const res = await fetch('/api/users/' + encodeURIComponent(u.name), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: role.value }),
      });
      userStatus.textContent = res.ok ? `${u.name} is now ${role.value}.` : await apiError(res);
      if (!res.ok) loadUsers();
    });
    const reset = document.createElement('button');
    reset.textContent = 'Reset';
    reset.title = 'Set a new password';
    reset.addEventListener('click', async () => {
      const pw = prompt(`New password for ${u.name} (8+ characters)`);
      if (!pw) return;
      const res = await fetch('/api/users/' + encodeURIComponent(u.name), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      userStatus.textContent = res.ok ? `Password reset; ${u.name} is signed out elsewhere.` : await apiError(res);
    });
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove ${u.name}? Their stars, cook counts and saved meals go with them.`)) return;
      const res = await fetch('/api/users/' + encodeURIComponent(u.name), { method: 'DELETE' });
      userStatus.textContent = res.ok ? `Removed ${u.name}.` : await apiError(res);
      loadUsers();
    });
    row.append(name, role, reset, del);
    list.append(row);
  }
}

$('#userForm').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await fetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: $('#newName').value, password: $('#newPass').value, role: $('#newRole').value,
    }),
  });
  if (res.ok) {
    userStatus.textContent = `Added ${$('#newName').value.trim().toLowerCase()}.`;
    e.target.reset();
    loadUsers();
  } else {
    userStatus.textContent = await apiError(res);
  }
});

$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await fetch('/api/me/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: $('#pwCurrent').value, new: $('#pwNew').value }),
  });
  $('#pwStatus').textContent = res.ok ? 'Password changed; other devices are signed out.' : await apiError(res);
  if (res.ok) e.target.reset();
});

async function initAccount() {
  const res = await fetch('/api/me');
  if (!res.ok) return;
  const me = await res.json();
  const admin = me.role === 'admin';
  $('#meName').textContent = me.name;
  $('#meRole').textContent = admin ? ' (admin)' : '';
  $('#account').querySelector('#pwForm').hidden = me.open;
  if (me.open) {
    $('#pwStatus').textContent = 'No accounts yet: set TEATIME_PASSWORD and restart to turn on sign-in and users.';
  }
  $('#backup').hidden = !admin;
  $('#users').hidden = !(admin && !me.open);
  if (admin && !me.open) loadUsers();
}

initAccount();
loadAll();
