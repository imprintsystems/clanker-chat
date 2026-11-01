// Clanker Chat site: install tabs, copy buttons, the hero reel, the live round trip, entrances.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- install tabs ----------
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
    const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(next);
    next.focus();
  });
}

// ---------- copy ----------
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
    const ok = await copyText(source.textContent.trim());
    button.textContent = ok ? (button.dataset.copiedLabel || 'Copied') : 'Select and copy';
    clearTimeout(button._t);
    button._t = setTimeout(() => { button.textContent = label; }, 2200);
  });
}

// ---------- hero reel: three steps, driven by scroll on wide screens ----------
const hero = document.querySelector('[data-hero]');
const frames = [...document.querySelectorAll('.frame')];
const captions = [...document.querySelectorAll('[data-caption]')];
let step = -1;
function show(n) {
  if (n === step) return;
  step = n;
  frames.forEach((f, i) => {
    const d = i - n;
    f.style.transform = d === 0 ? 'none' : `translateY(calc(${d * 100}% + ${d * 24}px))`;
    f.style.opacity = d === 0 ? '1' : '0.35';
  });
  captions.forEach((c, i) => c.classList.toggle('is-on', i === n));
}
show(0);

const wide = matchMedia('(min-width: 900px)');
let timer;
function onScroll() {
  const r = hero.getBoundingClientRect();
  const run = hero.offsetHeight - innerHeight;
  const p = run > 0 ? Math.min(Math.max(-r.top / run, 0), 0.999) : 0;
  show(Math.floor(p * frames.length));
}
function setupReel() {
  removeEventListener('scroll', onScroll);
  clearInterval(timer);
  if (wide.matches) {
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  } else if (!reduce) {
    timer = setInterval(() => { if (!document.hidden) show((step + 1) % frames.length); }, 3600);
  }
}
wide.addEventListener('change', setupReel);
setupReel();

// the invite countdown in the first frame
const countdown = document.querySelector('[data-countdown]');
if (countdown) {
  let left = 600;
  setInterval(() => {
    left = left > 0 ? left - 1 : 600;
    countdown.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }, 1000);
}

// ---------- the live round trip ----------
const demo = document.querySelector('[data-demo]');
if (demo) {
  const form = demo.querySelector('[data-demo-form]');
  const input = demo.querySelector('#demo-text');
  const awake = demo.querySelector('[data-demo-awake]');
  const outList = demo.querySelector('[data-demo-out]');
  const inList = demo.querySelector('[data-demo-in]');
  const badge = demo.querySelector('[data-demo-badge]');
  const status = demo.querySelector('[data-demo-status]');
  const queued = [];
  let unread = 0;

  const empty = (list, text) => { if (!list.querySelector('.msg')) list.innerHTML = `<li class="box__empty">${text}</li>`; };
  const item = (text, state, cls = '') => {
    const li = document.createElement('li');
    li.className = `msg ${cls}`;
    li.append(text);
    const s = document.createElement('span');
    s.className = 'msg__state';
    s.textContent = state;
    li.append(s);
    return li;
  };
  const clearEmpty = (list) => list.querySelector('.box__empty')?.remove();

  function deliver(text) {
    clearEmpty(inList);
    inList.prepend(item(text, 'From Erik · unread'));
    unread += 1;
    badge.hidden = false;
    badge.textContent = `${unread} unread`;
  }

  function flush() {
    if (!awake.checked || !queued.length) return;
    const pending = queued.splice(0);
    status.textContent = 'David is back. Retrying now…';
    setTimeout(() => {
      for (const { text, li } of pending) { li.remove(); deliver(text); }
      empty(outList, 'Nothing waiting.');
      status.textContent = pending.length === 1
        ? "Delivered. It's saved in David's inbox and his agent got a notice. Nobody has read it yet."
        : `Delivered all ${pending.length}. They're saved in David's inbox and his agent got a notice. Nobody has read them yet.`;
    }, reduce ? 0 : 900);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { status.textContent = 'Write a message first.'; input.focus(); return; }
    clearEmpty(outList);
    const li = item(text, 'Saved to outbox', 'msg--queued');
    outList.prepend(li);
    if (awake.checked) {
      status.textContent = 'Saved to your outbox. Sending…';
      setTimeout(() => {
        li.remove();
        empty(outList, 'Nothing waiting.');
        deliver(text);
        status.textContent = "Delivered. It's saved in David's inbox and his agent got a notice. Nobody has read it yet.";
      }, reduce ? 0 : 900);
    } else {
      li.querySelector('.msg__state').textContent = 'Queued · retrying until David is online';
      queued.push({ text, li });
      status.textContent = "David's computer is asleep, so the message waits in your outbox. Switch it back on.";
    }
  });
  awake.addEventListener('change', flush);
}

// ---------- the statement that lights one phrase at a time ----------
const cycle = document.querySelector('[data-cycle]');
if (cycle && !reduce) {
  const parts = [...cycle.querySelectorAll('span')];
  let i = 0;
  setInterval(() => {
    if (document.hidden) return;
    parts[i].classList.remove('lit');
    i = (i + 1) % parts.length;
    parts[i].classList.add('lit');
  }, 2000);
}

// ---------- the teleprinter loop rests under reduced motion ----------
if (reduce) document.querySelectorAll('[data-loop]').forEach((v) => { v.removeAttribute('autoplay'); v.pause(); });

// ---------- entrances: heading, then text, then picture ----------
if (!reduce && 'IntersectionObserver' in window) {
  const groups = [
    ['.how', '.how__title, .stage, .stage__note'],
    ['.try', '.try__text > *, .demo'],
    ['.send__intro', 'h2'],
    ['.row', '.row__title, .row__text p, .row__pic'],
    ['.apps', '.apps__title, .apps__table, .apps__pic'],
    ['.none', 'h2, .none__statement'],
    ['.faq', '.faq__title, details'],
    ['.close', '.close__title span, .close__choices, .close__note'],
  ];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  for (const [scope, sel] of groups) {
    for (const root of document.querySelectorAll(scope)) {
      root.querySelectorAll(sel).forEach((el, n) => {
        el.setAttribute('data-in', '');
        el.style.setProperty('--i', n % 6);
        io.observe(el);
      });
    }
  }
}
