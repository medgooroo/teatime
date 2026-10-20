'use strict';

// signed out (cookie expired or cleared): any API call that comes back 401
// sends the page to the login form, which returns here afterwards
{
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    if (res.status === 401 && location.pathname !== '/login') {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    }
    return res;
  };
}

// Fitting a whole recipe into a phone's width makes short steps a few pixels
// wide. On touch screens the timeline never goes below this scale; it scrolls.
const TOUCH_MIN_PX_PER_MIN = 14;
const isTouch = () => matchMedia('(pointer: coarse)').matches || innerWidth <= 700;
const fitFloor = () => isTouch() ? TOUCH_MIN_PX_PER_MIN : 2;

// House series colours (cat-1 to cat-8): a lane keeps its colour everywhere
const LANE_COLOURS = ['#a7267f', '#4a59bd', '#00a078', '#925600', '#bb6cd9', '#8b9a3c', '#0f7845', '#915ea4'];
const laneColour = i => LANE_COLOURS[((i % LANE_COLOURS.length) + LANE_COLOURS.length) % LANE_COLOURS.length];

// text colour for a lane-coloured fill: whichever of white and ground reads better
function onColour(hex) {
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const n = parseInt(hex.slice(1), 16);
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.058 ? '#ffffff' : '#151613';
}

// a House icon button: one glyph, named by its label
const ICON_PATHS = {
  close: 'M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5',
  'chevron-up': 'M3 10 L8 5 L13 10',
  'chevron-down': 'M3 6 L8 11 L13 6',
};
function iconButton(name, label, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = ('h-iconbtn ' + cls).trim();
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = `<svg class="h-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;
  return b;
}

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
      b.textContent = 'Copied';
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
