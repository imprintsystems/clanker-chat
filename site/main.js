// Clanker Chat site: install tabs, copy buttons, the two-nuts chat, entrances.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// install tabs
const tabs = [...document.querySelectorAll('.install__tab')];
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    selectTab(next);
    next.focus();
  });
}

// copy
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = Object.assign(document.createElement('textarea'), { value: text });
  area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}
for (const button of document.querySelectorAll('[data-copy]')) {
  const label = button.textContent;
  button.addEventListener('click', async () => {
    const source = document.querySelector(`[data-copy-source="${button.dataset.copy}"]`);
    button.textContent = (await copyText(source.textContent.trim())) ? 'Copied' : 'Select and copy';
    clearTimeout(button._t);
    button._t = setTimeout(() => { button.textContent = label; }, 2000);
  });
}

// the two nuts keep chatting: four messages stay on screen, a new one arrives at the bottom,
// the oldest leaves at the top, and the sender's nut gives a small turn. The chat is never empty.
const duo = document.querySelector('.duo');
if (duo && !reduce) {
  const lane = duo.querySelector('.duo__lane');
  const msgs = [...lane.children];
  const WINDOW = 4;
  const [mine, theirs] = duo.querySelectorAll('.duo__nut');
  const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const windowAt = (start) => Array.from({ length: WINDOW }, (_, k) => msgs[(start + k) % msgs.length]);
  let shown = [];
  const setShown = (list) => { shown = list; msgs.forEach((m) => m.classList.toggle('on', list.includes(m))); };
  // Hold the lane at the tallest four-message stretch, so nothing below it moves.
  const lockHeight = () => {
    const keep = shown;
    lane.style.minHeight = '';
    let tallest = 0;
    for (let i = 0; i < msgs.length; i++) { setShown(windowAt(i)); tallest = Math.max(tallest, lane.offsetHeight); }
    lane.style.minHeight = `${tallest}px`;
    setShown(keep);
  };
  msgs.forEach((m) => { m.hidden = false; });
  duo.setAttribute('data-play', '');
  setShown(windowAt(0));
  lockHeight();
  let width = duo.offsetWidth;
  new ResizeObserver(() => { if (duo.offsetWidth !== width) { width = duo.offsetWidth; lockHeight(); } }).observe(duo);

  const tick = async (nut) => {
    const flip = nut === theirs ? 'scaleX(-1) ' : '';
    nut.style.transform = `${flip}rotate(-14deg)`;
    await wait(220);
    nut.style.transform = '';
  };
  const next = async (m) => {
    const [oldest, ...rest] = shown;
    await oldest.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out' }).finished;
    const before = rest.map((el) => el.getBoundingClientRect().top);
    lane.append(m); // keep the DOM in conversation order as the script wraps around
    setShown([...rest, m]);
    rest.forEach((el, i) => {
      const dy = before[i] - el.getBoundingClientRect().top;
      if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 480, easing: ease });
    });
    const dx = m.classList.contains('them') ? 24 : -24;
    m.animate([{ opacity: 0, transform: `translate(${dx}px, 12px)` }, { opacity: 1, transform: 'none' }], { duration: 480, easing: ease });
    tick(m.classList.contains('them') ? theirs : mine);
  };
  (async () => {
    for (let i = WINDOW; ; i = (i + 1) % msgs.length) {
      await wait(2200);
      await next(msgs[i]);
    }
  })();
}

// entrances for the plain sections below
if (!reduce && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -10% 0px' });
  for (const part of document.querySelectorAll('.part')) {
    part.querySelectorAll('h2, li').forEach((el, n) => {
      el.setAttribute('data-in', '');
      el.style.setProperty('--i', n);
      io.observe(el);
    });
  }
}
