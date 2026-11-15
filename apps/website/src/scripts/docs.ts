export {};
type SearchDocument = { title: string; description: string; group: string; href: string; text: string };
const dialog = document.querySelector<HTMLDialogElement>('[data-docs-search]');
const input = document.querySelector<HTMLInputElement>('#docs-search-input');
const results = document.querySelector<HTMLElement>('#docs-search-results');
const status = document.querySelector<HTMLElement>('[data-docs-search-status]');
const index: SearchDocument[] = JSON.parse(document.querySelector('#docs-search-index')?.textContent || '[]');
const en = document.documentElement.lang === 'en';
let returnFocus: HTMLElement | null = null;

function search() {
  if (!input || !results || !status || !dialog) return;
  const query = input.value.trim().toLocaleLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const matches = index.map(doc => {
    const title = doc.title.toLocaleLowerCase(), description = doc.description.toLocaleLowerCase(), text = doc.text.toLocaleLowerCase();
    const score = words.every(word => (title + ' ' + description + ' ' + text).includes(word))
      ? words.reduce((sum, word) => sum + (title.includes(word) ? 5 : description.includes(word) ? 3 : 1), 0) : 0;
    return { doc, score };
  }).filter(item => !query || item.score > 0).sort((a, b) => b.score - a.score);
  results.replaceChildren();
  status.textContent = !query ? dialog.dataset.hint! : matches.length ? (en ? `${matches.length} guides found` : `找到 ${matches.length} 篇指南`) : dialog.dataset.empty!;
  for (const { doc } of matches) {
    const link = document.createElement('a');
    link.href = doc.href;
    const group = document.createElement('small'); group.textContent = doc.group;
    const title = document.createElement('strong'); title.textContent = doc.title;
    const excerpt = document.createElement('span');
    const at = query ? doc.text.toLocaleLowerCase().indexOf(words[0]) : -1;
    excerpt.textContent = at >= 0 ? (at > 30 ? '…' : '') + doc.text.slice(Math.max(0, at - 30), at + 100) + '…' : doc.description;
    link.append(group, title, excerpt); results.append(link);
  }
}
function openSearch() {
  if (!dialog || dialog.open) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.showModal(); search(); input?.focus();
}
document.querySelectorAll('[data-docs-search-open]').forEach(button => button.addEventListener('click', openSearch));
document.querySelector('[data-docs-search-close]')?.addEventListener('click', () => dialog?.close());
dialog?.addEventListener('close', () => returnFocus?.focus());
dialog?.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
input?.addEventListener('input', search);
input?.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); results?.querySelector<HTMLAnchorElement>('a')?.focus(); } if (event.key === 'Enter') { event.preventDefault(); results?.querySelector<HTMLAnchorElement>('a')?.click(); } });
results?.addEventListener('keydown', event => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const links = Array.from(results.querySelectorAll('a'));
  const current = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (event.key === 'ArrowUp' && current <= 0) input?.focus();
  else links[Math.min(links.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
});
document.addEventListener('keydown', event => {
  const editing = event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !editing) { event.preventDefault(); openSearch(); }
  if (event.key === 'Escape') document.querySelectorAll<HTMLDetailsElement>('.doc-mobile-nav[open],.doc-mobile-toc[open]').forEach(details => { details.open = false; details.querySelector('summary')?.focus(); });
});
document.querySelectorAll<HTMLAnchorElement>('.doc-mobile-nav a,.doc-mobile-toc a').forEach(link => link.addEventListener('click', () => { const details = link.closest('details'); if (details) details.open = false; }));

const tocLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.doc-toc a[href^="#"]'));
const headings = tocLinks.map(link => document.getElementById(link.hash.slice(1))).filter((heading): heading is HTMLElement => !!heading);
if (headings.length) {
  let scheduled = false;
  const updateTOC = () => {
    const activationLine = (parseFloat(getComputedStyle(headings[0]).scrollMarginTop) || 0)
      + (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 2;
    const active = [...headings].reverse().find(heading => heading.getBoundingClientRect().top <= activationLine) || headings[0];
    tocLinks.forEach(link => { if (link.hash === '#' + active.id) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
    scheduled = false;
  };
  window.addEventListener('scroll', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(updateTOC); } }, { passive: true });
  window.addEventListener('resize', updateTOC);
  updateTOC();
}
document.querySelector<HTMLButtonElement>('[data-copy-doc]')?.addEventListener('click', async event => {
  const button = event.currentTarget as HTMLButtonElement;
  const output = document.querySelector<HTMLElement>('[data-copy-status]');
  const text = document.querySelector<HTMLElement>('[data-doc-body]')?.innerText;
  if (!text || !output) return;
  try { await navigator.clipboard.writeText(text); output.textContent = en ? 'Page copied' : '已复制正文'; }
  catch { output.textContent = en ? 'Copy unavailable. Select the text to copy.' : '复制不可用，请选择正文复制。'; }
  button.setAttribute('aria-describedby', 'doc-copy-status');
});
