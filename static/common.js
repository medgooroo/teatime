'use strict';

const LANE_COLOURS = ['#4f8a67', '#a2734f', '#5c7cb8', '#b06584', '#7e9a55', '#8f6fb5'];
const laneColour = i => LANE_COLOURS[((i % LANE_COLOURS.length) + LANE_COLOURS.length) % LANE_COLOURS.length];

// "1h 5m", "45s", "5m" — seconds in, human duration out
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  if (s || !parts.length) parts.push(s + 's');
  return parts.join(' ');
}

// ruler labels: "5", "45", "1:15"
function fmtClock(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return String(m);
  return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
}

// running-clock format: "1:05:30", "12:05"
function fmtTimer(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? h + ':' + mm + ':' + ss : m + ':' + ss;
}

// clipboard with a fallback for non-secure contexts
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    ok ? resolve() : reject(new Error('copy not available'));
  });
}

// a small "Copy" button that confirms, then resets its label
function copyBtn(getText, label = 'Copy') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy-btn';
  b.textContent = label;
  b.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await copyText(getText());
      b.textContent = 'Copied ✓';
    } catch {
      b.textContent = 'Copy failed';
    }
    setTimeout(() => { b.textContent = label; }, 1500);
  });
  return b;
}

// accepts "1h 10m", "90m", "45s", "1.5h" or a bare number of minutes
function parseDur(str) {
  str = String(str).trim().toLowerCase();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 60);
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/g;
  let sec = 0, matched = false, m;
  while ((m = re.exec(str))) {
    matched = true;
    const v = parseFloat(m[1]);
    sec += m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : v;
  }
  return matched ? Math.round(sec) : null;
}
