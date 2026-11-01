// Clanker Chat site: install tabs, copy buttons, the hero window, entrances.
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

// the hero window steps through pairing, sending and arriving
const frames = [...document.querySelectorAll('.frame')];
if (!reduce && frames.length > 1) {
  let i = 0;
  setInterval(() => {
    if (document.hidden) return;
    frames[i].classList.remove('is-on');
    i = (i + 1) % frames.length;
    frames[i].classList.add('is-on');
  }, 3200);
}

// entrances for the sections below the hero
if (!reduce && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -10% 0px' });
  for (const block of document.querySelectorAll('.block')) {
    block.querySelectorAll('h2, dl > div, .block__body > p, details').forEach((el, n) => {
      el.setAttribute('data-in', '');
      el.style.setProperty('--i', n);
      io.observe(el);
    });
  }
}
