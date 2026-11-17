import { bindCreativeTabs, registerMotion, selectCreativeTab } from './creative-motion';

function motionPlayback(root: HTMLElement, lastStep: number, delay: number, changed?: (step: number, playing: boolean) => void) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const play = root.querySelector<HTMLButtonElement>('[data-motion-play]')!;
  let step = reduced.matches ? lastStep : 0;
  let wantsPlay = !reduced.matches;
  let active = false;
  let timer: number | undefined;

  function render() {
    window.clearTimeout(timer);
    root.dataset.step = String(step);
    const playing = active && wantsPlay && !reduced.matches && step < lastStep;
    root.dataset.playing = String(playing);
    changed?.(step,playing);
    play.textContent = playing ? root.dataset.pauseLabel! : root.dataset.playLabel!;
    play.setAttribute('aria-label', play.textContent);
    root.querySelectorAll<HTMLButtonElement>('[data-motion-step]').forEach((button, index) => {
      if (index === step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    if (playing) timer = window.setTimeout(() => {
      step++;
      if (step === lastStep) wantsPlay = false;
      render();
    }, delay);
  }

  function finish() { wantsPlay = false; step = lastStep; render(); }
  function select(next: number) { wantsPlay = false; step = next; render(); }
  play.addEventListener('click', () => {
    if (reduced.matches) { step = step === lastStep ? 0 : step + 1; render(); return; }
    if (step === lastStep) { step = 0; wantsPlay = true; }
    else wantsPlay = !wantsPlay;
    render();
  });
  root.querySelector('[data-motion-replay]')!.addEventListener('click', () => {
    step = reduced.matches ? lastStep : 0;
    wantsPlay = !reduced.matches;
    render();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-motion-step]').forEach(button => button.addEventListener('click', () => {
    step = Number(button.dataset.motionStep); wantsPlay = false; render();
  }));
  reduced.addEventListener('change', () => { wantsPlay = false; step = lastStep; render(); });
  registerMotion(root, focused => { active = focused; render(); });
  root.dataset.enhanced = 'true';
  render();
  return { finish, select };
}

export function initCreativeExperiences() {
  document.querySelectorAll<HTMLElement>('[data-creative-results]:not([data-initialized])').forEach(root => {
    root.dataset.initialized = 'true';
    const shots = JSON.parse(root.dataset.storyShots!) as {id: string;label: string;caption: string;src: string}[];
    const art = root.querySelector<HTMLImageElement>('.result-art > img')!;
    const figure = root.querySelector<HTMLElement>('.result-art')!;
    const shotButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-result-shot]')];
    let showing = -1;
    let visual: Animation | undefined;
    const playback = motionPlayback(root, shots.length-1, 2400, (step,playing) => {
      if (showing !== step) {
        showing = step;
        root.dataset.shot = String(step);
        shotButtons.forEach((item,i)=>item.setAttribute('aria-pressed',String(i===step)));
        root.querySelector('[data-result-caption]')!.textContent=shots[step].caption;
        root.querySelector('[data-result-frame-count]')!.textContent=`${String(step+1).padStart(2,'0')} / ${String(shots.length).padStart(2,'0')}`;
        const previous = art.currentSrc || art.src;
        const prepared = new Image();
        prepared.src=shots[step].src;
        void prepared.decode().then(()=>{
          if (showing!==step) return;
          figure.style.backgroundImage=`url("${previous}")`;
          art.src=shots[step].src;
          art.alt=shots[step].caption;
          visual?.cancel();
          if(!matchMedia('(prefers-reduced-motion: reduce)').matches) {
            visual=art.animate([{opacity:.2,transform:'scale(1.035)'},{opacity:1,transform:'scale(1)'}],{duration:900,easing:'ease-out',fill:'both'});
            if(root.dataset.playing!=='true') visual.finish();
          }
        }).catch(()=>{ /* 个别图片不可用时继续保留上一幅画面与可读文字。 */ });
      }
      if(visual) { if(playing) visual.play(); else visual.pause(); }
    });
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-result-tab]')];
    const panels = [...root.querySelectorAll<HTMLElement>('[data-result-panel]')];
    bindCreativeTabs(tabs, index => {
      selectCreativeTab(tabs, panels, index);
      root.dataset.kind = tabs[index].dataset.resultTab;
      playback.select(Number(root.dataset.shot??0));
    });
    shotButtons.forEach((button,index) => button.addEventListener('click', () => {
      playback.select(index);
    }));
    root.querySelectorAll<HTMLDetailsElement>('details').forEach(details => details.addEventListener('toggle', () => {
      if (details.open) playback.select(Number(root.dataset.shot??0));
    }));
  });

  document.querySelectorAll<HTMLElement>('[data-revision-demo]:not([data-initialized])').forEach(root => {
    root.dataset.initialized = 'true';
    const playback = motionPlayback(root, 4, 2800);
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-review-tab]')];
    const panels = [...root.querySelectorAll<HTMLElement>('[data-review-panel]')];
    bindCreativeTabs(tabs, index => { selectCreativeTab(tabs, panels, index); playback.finish(); });
    panels.forEach(panel => {
      const variants = JSON.parse(panel.querySelector('[data-revision-variants]')!.textContent!) as { before: string; after: string; note: string; anchor?: string; context?: string; shot?: number }[];
      const buttons = [...panel.querySelectorAll<HTMLButtonElement>('[data-revision-variant]')];
      buttons.forEach((button, index) => button.addEventListener('click', () => {
        buttons.forEach((item, i) => item.setAttribute('aria-pressed', String(i === index)));
        const value = variants[index];
        panel.querySelector('[data-revision-before]')!.textContent = value.before;
        panel.querySelector('[data-revision-after]')!.textContent = value.after;
        panel.querySelector('[data-revision-note]')!.textContent = value.note;
        if(value.anchor) panel.querySelector('[data-revision-anchor]')!.textContent=value.anchor;
        if(value.context) panel.querySelector('[data-revision-context]')!.textContent=value.context;
        panel.querySelectorAll<HTMLElement>('[data-revision-shot]').forEach(shot=>shot.dataset.active=String(Number(shot.dataset.revisionShot)===value.shot));
        playback.finish();
      }));
    });
  });
}

export function initProjectLayers() {
  document.querySelectorAll<HTMLElement>('[data-project-layers]:not([data-initialized])').forEach(root => {
    root.dataset.initialized = 'true';
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-layer-tab]')];
    const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    bindCreativeTabs(tabs, index => { selectCreativeTab(tabs, panels, index); root.dataset.layer = String(index); }, true);
  });
}
