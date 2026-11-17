import { bindCreativeTabs, selectCreativeTab } from './creative-motion';

export function initWorkbenchPreviews() {
  document.querySelectorAll<HTMLElement>('[data-workbench-preview]:not([data-initialized])').forEach(root=>{
    root.dataset.initialized='true';
    const tabs=[...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const panels=[...root.querySelectorAll<HTMLElement>('[data-workbench-panel]')];
    bindCreativeTabs(tabs,index=>selectCreativeTab(tabs,panels,index));
    const dialog=root.querySelector<HTMLDialogElement>('dialog')!;
    const full=dialog.querySelector<HTMLImageElement>('[data-preview-full]')!;
    let trigger: HTMLAnchorElement | undefined;
    root.querySelectorAll<HTMLAnchorElement>('[data-preview-zoom]').forEach(link=>link.addEventListener('click',event=>{
      event.preventDefault();
      trigger=link;
      const image=link.querySelector('img')!;
      full.src=image.src;
      full.alt=image.alt;
      dialog.querySelector('[data-preview-title]')!.textContent=tabs.find(tab=>tab.getAttribute('aria-selected')==='true')!.textContent;
      dialog.showModal();
      dialog.querySelector('.workbench-zoom-canvas')!.scrollTo(0,0);
    }));
    dialog.querySelector('[data-preview-close]')!.addEventListener('click',()=>dialog.close());
    dialog.addEventListener('click',event=>{if(event.target===dialog) dialog.close();});
    dialog.addEventListener('close',()=>trigger?.focus({preventScroll:true}));
  });
}
