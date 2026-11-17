import type { WorkflowPhase } from '../lib/creation-workflow';
import { registerMotion } from './creative-motion';

function bindTabs(tabs: HTMLButtonElement[], select: (index: number) => void) {
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', event => {
      const destinations: Record<string, number> = {
        ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length,
        Home: 0, End: tabs.length - 1,
      };
      const next = destinations[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(next);
      tabs[next].focus();
    });
  });
}

export function initWorkflowClients() {
  document.querySelectorAll<HTMLElement>('[data-agent-workflow]:not([data-clients-initialized])').forEach(root => {
    const install = root.querySelector<HTMLElement>('[data-install-prompt]');
    if (!install) return;
    root.dataset.clientsInitialized = 'true';
    const clients = JSON.parse(install.dataset.workflowClients!) as { id: string; name: string; icon: string; method: string; prompt: string }[];
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-workflow-client]')];
    const promptText = install.querySelector<HTMLTextAreaElement>('textarea')!;
    const status = install.querySelector<HTMLElement>('[data-install-status]')!;
    function select(id: string) {
      const client = clients.find(item => item.id === id)!;
      root.dataset.client = client.id;
      root.dataset.clientName = client.name;
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.workflowClient === id)));
      root.querySelectorAll<HTMLElement>('[data-selected-agent-name]').forEach(name => { name.textContent = client.name; });
      root.querySelectorAll<HTMLImageElement>('[data-selected-agent-icon]').forEach(icon => { icon.src = client.icon; });
      root.querySelectorAll<HTMLElement>('[data-selected-agent-method]').forEach(method => { method.textContent = client.method; });
      root.querySelectorAll<HTMLElement>('[data-connect-prompt]').forEach(prompt => { prompt.textContent = prompt.dataset.connectPrompt!.replace('Codex', client.name); });
      promptText.value = client.prompt;
      status.textContent = '';
      root.dispatchEvent(new CustomEvent('workflowclientchange'));
    }
    buttons.forEach(button => button.addEventListener('click', () => select(button.dataset.workflowClient!)));
    select(root.dataset.client || clients[0].id);
  });
}

export function initInstallPrompts() {
  document.querySelectorAll<HTMLElement>('[data-install-prompt]:not([data-initialized])').forEach(root => {
    root.dataset.initialized = 'true';
    const button = root.querySelector<HTMLButtonElement>('[data-copy-install]')!;
    const text = root.querySelector<HTMLTextAreaElement>('textarea')!;
    const status = root.querySelector<HTMLElement>('[data-install-status]')!;
    button.addEventListener('click', async () => {
      const prompt = text.value;
      const client = root.closest<HTMLElement>('[data-agent-workflow]')!.dataset.clientName!;
      try {
        await navigator.clipboard.writeText(prompt);
        if (text.value === prompt) status.textContent = root.dataset.copyDone!.replace('{client}', client);
      } catch {
        if (text.value !== prompt) return;
        root.querySelector<HTMLDetailsElement>('details')!.open = true;
        status.textContent = root.dataset.copyFailed!;
        text.focus();
        text.select();
      }
    });
  });
}

export function initWorkflowDemos() {
  document.querySelectorAll<HTMLElement>('[data-workflow-demo]:not([data-initialized])').forEach(root => {
    root.dataset.initialized = 'true';
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-workflow-tab]')];
    const panels = [...root.querySelectorAll<HTMLElement>('[data-workflow-scene]')];
    const phases = panels.map(panel => JSON.parse(panel.dataset.phases!) as WorkflowPhase[]);
    const playButton = root.querySelector<HTMLButtonElement>('[data-workflow-play]')!;
    const detail = root.querySelector<HTMLAnchorElement>('[data-workflow-detail]')!;
    const announcement = root.querySelector<HTMLElement>('[data-workflow-announcement]')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let scene = 0;
    let phase = 0;
    let inViewport = false;
    let wantsPlay = !reduced.matches;
    let timer: number | undefined;
    let previewTimer: number | undefined;

    function drawConnections() {
      const panel = panels[scene];
      const body = panel.querySelector<HTMLElement>('.wf-demo-body')!;
      const svg = body.querySelector<SVGSVGElement>('.wf-wires')!;
      if (getComputedStyle(svg).display === 'none') return;
      const area = body.getBoundingClientRect();
      const agent = body.querySelector<HTMLElement>('[data-wf-node="agent"]')!.getBoundingClientRect();
      const core = body.querySelector<HTMLElement>('[data-wf-node="core"]')!.getBoundingClientRect();
      svg.setAttribute('viewBox', `0 0 ${area.width} ${area.height}`);
      const curve = (x1: number, y1: number, x2: number, y2: number) => {
        const bend = Math.max(20, (x2 - x1) / 2);
        return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
      };
      panel.querySelector('[data-wire="agent"]')!.setAttribute('d', curve(agent.right - area.left, agent.top + agent.height / 2 - area.top, core.left - area.left, core.top + core.height / 2 - area.top));
      const results = [...panel.querySelectorAll<HTMLElement>('[data-wf-artifact]')];
      results.forEach((result, index) => {
        const bounds = result.getBoundingClientRect();
        panel.querySelector(`[data-wire-artifact="${index}"]`)!.setAttribute('d', curve(core.right - area.left, core.top + core.height / 2 - area.top, bounds.left - area.left, bounds.top + bounds.height / 2 - area.top));
      });
      const bottom = area.height - 6;
      panel.querySelector('[data-wire="feedback"]')!.setAttribute('d', `M${core.left + core.width / 2 - area.left},${core.bottom - area.top} V${bottom} H${agent.left + agent.width / 2 - area.left} V${agent.bottom - area.top}`);
      panel.querySelector('[data-wire="feedback"]')!.classList.toggle('is-feedback', scene === 4 && phase < 4);
    }

    function syncPlayback() {
      window.clearTimeout(timer);
      window.clearInterval(previewTimer);
      panels.forEach(panel => panel.querySelectorAll('[data-wf-frame]').forEach(frame => frame.classList.remove('is-current')));
      const playing = wantsPlay && inViewport && !document.hidden && !reduced.matches && phase < phases[scene].length - 1;
      root.dataset.playing = String(playing);
      const label = playing ? root.dataset.pauseLabel! : root.dataset.playLabel!;
      playButton.setAttribute('aria-label', label);
      root.querySelector<HTMLElement>('[data-play-text]')!.textContent = label;
      root.querySelector('[data-play-icon]')!.setAttribute('d', playing ? 'M8 5v14 M16 5v14' : 'm9 5 11 7-11 7z');
      if (!playing) return;
      timer = window.setTimeout(() => setPhase(phase + 1), 3400);
      if (panels[scene].dataset.workflowScene === 'video' && phase >= 3) {
        let frame = 0;
        const frames = [...panels[scene].querySelectorAll<HTMLElement>('[data-wf-frame]')];
        const showFrame = () => frames.forEach((item, index) => item.classList.toggle('is-current', index === frame));
        showFrame();
        previewTimer = window.setInterval(() => { frame = (frame + 1) % frames.length; showFrame(); }, 1100);
      }
    }

    function setPhase(next: number, announce = false) {
      phase = Math.max(0, Math.min(next, phases[scene].length - 1));
      const panel = panels[scene];
      const current = phases[scene][phase];
      panel.dataset.phase = String(phase);
      panel.querySelector<HTMLElement>('[data-wf-agent]')!.textContent = current.agent;
      panel.querySelector<HTMLElement>('[data-wf-core]')!.textContent = current.hetu;
      panel.querySelector<HTMLElement>('[data-wf-phase-title]')!.textContent = current.title;
      panel.querySelector<HTMLElement>('[data-wf-phase-count]')!.textContent = `${phase + 1} / ${phases[scene].length}`;
      panel.querySelectorAll<HTMLElement>('[data-wf-preview-line]').forEach((line, index) => {
        const value = current.preview[index] ?? '';
        line.textContent = panel.dataset.workflowScene === 'connect' ? value.replace('Codex', root.closest<HTMLElement>('[data-agent-workflow]')!.dataset.clientName || 'Codex') : value;
      });
      panel.querySelectorAll<HTMLElement>('[data-wf-artifact]').forEach((item, index) => {
        item.classList.toggle('is-current', index === current.artifact);
        item.classList.toggle('is-complete', index < current.artifact);
        item.querySelector('[data-wf-artifact-state]')!.textContent = index < current.artifact ? '✓' : index === current.artifact ? '←' : '';
      });
      panel.querySelectorAll('[data-wire-artifact]').forEach((wire, index) => wire.classList.toggle('is-active', index === current.artifact));
      panel.querySelectorAll<HTMLButtonElement>('[data-workflow-step]').forEach((button, index) => {
        if (index === phase) button.setAttribute('aria-current', 'step');
        else button.removeAttribute('aria-current');
      });
      if (announce) announcement.textContent = `${tabs[scene].textContent}: ${current.title}. ${current.hetu}`;
      if (phase === phases[scene].length - 1) wantsPlay = false;
      syncPlayback();
      requestAnimationFrame(drawConnections);
    }

    function selectScene(index: number) {
      scene = index;
      tabs.forEach((tab, tabIndex) => {
        tab.setAttribute('aria-selected', String(tabIndex === index));
        tab.tabIndex = tabIndex === index ? 0 : -1;
        panels[tabIndex].hidden = tabIndex !== index;
      });
      const id = panels[index].dataset.workflowScene!;
      const target = id === 'revision' ? 'revise' : id;
      detail.hash = target;
      wantsPlay = !reduced.matches;
      setPhase(0, true);
    }

    bindTabs(tabs, selectScene);
    panels.forEach(panel => panel.querySelectorAll<HTMLButtonElement>('[data-workflow-step]').forEach(button => button.addEventListener('click', () => {
      wantsPlay = false;
      setPhase(Number(button.dataset.workflowStep), true);
    })));
    playButton.addEventListener('click', () => {
      // 减少动态效果下保留逐步操作，显式播放也不覆盖系统偏好。
      if (reduced.matches) { setPhase(phase === phases[scene].length - 1 ? 0 : phase + 1, true); return; }
      wantsPlay = root.dataset.playing !== 'true';
      if (wantsPlay && phase === phases[scene].length - 1) setPhase(0);
      else syncPlayback();
    });
    root.querySelector('[data-workflow-replay]')!.addEventListener('click', () => { wantsPlay = !reduced.matches; setPhase(0, true); });
    registerMotion(root, active => { inViewport = active; syncPlayback(); });
    new ResizeObserver(() => requestAnimationFrame(drawConnections)).observe(root);
    root.closest('[data-agent-workflow]')!.addEventListener('workflowclientchange', () => setPhase(phase));
    reduced.addEventListener('change', () => { wantsPlay = false; syncPlayback(); });
    setPhase(0);
  });
}

export function initWorkflowMaps() {
  document.querySelectorAll<HTMLElement>('[data-workflow-map]:not([data-initialized])').forEach(root => {
    root.dataset.initialized = 'true';
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-map-tab]')];
    const panels = [...root.querySelectorAll<HTMLElement>('[data-map-panel]')];
    function select(index: number, updateURL = true) {
      tabs.forEach((tab, tabIndex) => {
        tab.setAttribute('aria-selected', String(tabIndex === index));
        tab.tabIndex = tabIndex === index ? 0 : -1;
        panels[tabIndex].hidden = tabIndex !== index;
      });
      if (updateURL) history.replaceState(null, '', `#${tabs[index].dataset.mapTab}`);
      const languageLink = document.querySelector<HTMLAnchorElement>('.header-actions .lang');
      if (languageLink) languageLink.hash = tabs[index].dataset.mapTab!;
    }
    const fromHash = () => { const index = tabs.findIndex(tab => `#${tab.dataset.mapTab}` === location.hash); if (index >= 0) select(index, false); };
    bindTabs(tabs, select);
    fromHash();
    window.addEventListener('hashchange', fromHash);
  });
}
