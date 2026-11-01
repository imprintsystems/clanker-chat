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

// the two nuts: messages arrive one by one, the sender's nut gives a small turn, then it starts over
const duo = document.querySelector('.duo');
if (duo && !reduce) {
  duo.setAttribute('data-play', '');
  const msgs = [...duo.querySelectorAll('li')];
  const [mine, theirs] = duo.querySelectorAll('.duo__nut');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tick = async (nut) => {
    const flip = nut === theirs ? 'scaleX(-1) ' : '';
    nut.style.transform = `${flip}rotate(-14deg)`;
    await wait(220);
    nut.style.transform = '';
  };
  (async () => {
    for (;;) {
      await wait(700);
      for (const m of msgs) {
        tick(m.classList.contains('them') ? theirs : mine);
        m.classList.add('on');
        await wait(1600);
      }
      await wait(2400);
      msgs.forEach((m) => m.classList.remove('on'));
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
