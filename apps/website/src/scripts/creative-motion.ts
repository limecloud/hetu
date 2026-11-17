type MotionTarget = { root: HTMLElement; visible: boolean; sync: (active: boolean) => void };
const targets: MotionTarget[] = [];
let current: MotionTarget | undefined;
let preferred: MotionTarget | undefined;
let scheduled = false;

// 所有首页演示共用一个播放焦点，避免同屏动画争抢注意力。
function updateFocus() {
  scheduled = false;
  const visible = targets.filter(target => target.visible);
  const next = document.hidden ? undefined : preferred?.visible ? preferred : visible.sort((a, b) => {
    const distance = (target: MotionTarget) => {
      const rect = target.root.getBoundingClientRect();
      return Math.abs((Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2 - innerHeight / 2);
    };
    return distance(a) - distance(b);
  })[0];
  if (next === current) return;
  const previous = current;
  current = next;
  previous?.sync(false);
  next?.sync(true);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(updateFocus);
}

const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
  entries.forEach(entry => {
    const target = targets.find(item => item.root === entry.target);
    if (target) target.visible = entry.isIntersecting && entry.intersectionRatio >= .15;
  });
  if (!preferred?.visible) preferred = undefined;
  schedule();
}, { threshold: [0, .15, .5, 1] });

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', updateFocus);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
}

export function registerMotion(root: HTMLElement, sync: (active: boolean) => void) {
  const target: MotionTarget = { root, sync, visible: false };
  targets.push(target);
  const prefer = () => { preferred = target; updateFocus(); };
  root.addEventListener('pointerdown', prefer);
  root.addEventListener('focusin', prefer);
  observer?.observe(root);
  sync(false);
}

export function bindCreativeTabs(tabs: HTMLButtonElement[], select: (index: number) => void, vertical = false) {
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      const next = event.key === (vertical ? 'ArrowDown' : 'ArrowRight') ? (index + 1) % tabs.length
        : event.key === (vertical ? 'ArrowUp' : 'ArrowLeft') ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
      if (next === undefined) return;
      event.preventDefault(); select(next); tabs[next].focus();
    });
  });
}

export function selectCreativeTab(tabs: HTMLButtonElement[], panels: HTMLElement[], index: number) {
  tabs.forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
    panels[i].hidden = i !== index;
  });
}
