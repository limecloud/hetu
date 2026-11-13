type Chapter = { title: string; body: string; saved: string; revision: number; finalRevision?: number };
type Book = {
  title: string; author: string; status: string; cover: string; synopsis: string; chapters: Chapter[];
  locked: boolean; decision: string; comment: string; snapshots: number[];
};
type View = 'library' | 'book' | 'novel' | 'bible' | 'drama' | 'reviews' | 'git' | 'media' | 'plot' | 'validation';
const escape = (value: string | number) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const covers = ['cover-river-jade', 'cover-cloud-rose', 'cover-stars-ink'];

// 演示状态只保留在当前组件内，作品正文与界面语言分别管理。
export function initializeWorkbench(root: HTMLElement) {
  const app = root.querySelector<HTMLElement>('.demo-app')!;
  let english = root.dataset.locale === 'en';
  const t = (zh: string, en: string) => english ? en : zh;
  const initialEnglish = english;
  const chapter = (title: string, body: string): Chapter => ({ title, body, saved: body, revision: 12 });
  const books: Book[] = [
    {
      title: t('雾川纪', 'Chronicles of Wuchuan'), author: t('南山', 'Nan Shan'), status: 'writing', cover: covers[0],
      synopsis: t('一枚旧玉扣，把远行的少年带回一座雨中的城。', 'An old jade clasp brings a young traveler to a city in the rain.'),
      chapters: [
        chapter(t('第一章 雨夜入城', 'Chapter 1 · A rainy arrival'), t('雨下了整整三日。\n\n林舟沿着青石街走进雾川，衣角滴下的水在门槛前积成细线。他摸了摸怀里的旧玉扣，推开客栈的木门。\n\n掌柜抬起头，目光在玉扣上停了一瞬。\n\n“借一间房。”林舟说。\n\n窗外，河上的灯火在雨中摇曳。', 'Rain had been falling for three days.\n\nLin Zhou walked into Wuchuan along the stone street. Water dripped from his coat. He touched the old jade clasp inside his pocket and opened the inn door.\n\nThe innkeeper looked up. His eyes paused on the clasp.\n\n“A room, please,” Lin Zhou said.\n\nOutside, lights swayed above the river.')),
        chapter(t('第二章 河上来信', 'Chapter 2 · A letter from the river'), t('翌日清晨，沈慈送来一封未署名的信。\n\n林舟拆开信封，只见纸上画着一条通往旧渡口的小路。', 'The next morning, Shen Ci brought an unsigned letter.\n\nLin Zhou opened it. A path to the old ferry crossing was drawn on the paper.')),
      ], locked: true, decision: 'pending', comment: '', snapshots: [],
    },
    { title: t('云间来信', 'Letters above the clouds'), author: t('南山', 'Nan Shan'), status: 'planning', cover: covers[1], synopsis: t('在云与山之间，寻找一封没有收件人的信。', 'Between clouds and mountains, a letter waits for its recipient.'), chapters: [chapter(t('故事筹备', 'Story notes'), t('从一封信开始。', 'Begin with a letter.'))], locked: false, decision: 'pending', comment: '', snapshots: [] },
    { title: t('星河旧事', 'Tales of the starlit river'), author: t('南山', 'Nan Shan'), status: 'completed', cover: covers[2], synopsis: t('一段关于星空、河流与归途的旧事。', 'A story of stars, rivers and the way home.'), chapters: [chapter(t('尾声 归途', 'Epilogue · Homeward'), t('抬头时，星河依旧。', 'Above them, the stars remained.'))], locked: true, decision: 'pending', comment: '', snapshots: [] },
  ];
  let view: View = 'library', bookIndex = 0, chapterIndex = 0, filter = 'all', search = '', list = false;
  let theme = 'light', evidence = false, feedback = '', sourceVisible = false;
  let dialog: '' | 'new-book' | 'new-chapter' | 'adopt' | 'finalize' | 'snapshot' = '';
  let previewRevision = 0;
  const book = () => books[bookIndex];
  const current = () => book().chapters[chapterIndex];
  const dirty = () => current().body !== current().saved;
  const status = (value: string) => ({ all: t('全部作品', 'All books'), planning: t('筹备中', 'Planning'), writing: t('创作中', 'Writing'), completed: t('已完结', 'Completed'), archived: t('已归档', 'Archived') })[value] ?? value;
  const decision = () => ({ pending: t('待审核', 'Awaiting review'), changes: t('要求修改', 'Changes requested'), approved: t('审核通过', 'Review approved') })[book().decision];
  const button = (action: string, label: string, primary = false, extra = '') => `<button type="button" data-action="${action}" class="${primary ? 'demo-primary' : ''}" ${extra}>${escape(label)}</button>`;
  const badge = (label: string) => `<span class="demo-badge">${escape(label)}</span>`;
  const artwork = (name: string, className = '') => `<img class="${className}" src="/images/library/${name}.jpg" alt="" loading="lazy"/>`;
  const navItems: [View, string, string][] = [
    ['book', '作品资料', 'Book details'], ['novel', '小说正文', 'Manuscript'], ['bible', '设定集', 'Story bible'],
    ['drama', '短剧骨架', 'Drama outline'], ['reviews', '审核工作台', 'Draft review'], ['git', '版本管理', 'Version history'],
    ['media', '线索与素材', 'Media & cues'], ['plot', '剧情整理', 'Plot beats'], ['validation', '一致性诊断', 'Consistency checks'],
  ];
  function heading(title: string, subtitle: string, art?: string) {
    return `<header class="demo-heading"><div><h3 tabindex="-1">${escape(title)}</h3><p>${escape(subtitle)}</p></div>${art ? artwork(art, 'demo-spot') : ''}</header>`;
  }
  function libraryCards() {
    const matches = books.map((b, index) => ({ b, index })).filter(({ b }) => (filter === 'all' || b.status === filter) && `${b.title} ${b.author}`.toLowerCase().includes(search.toLowerCase()));
    return `<div class="demo-books ${list ? 'demo-list' : ''}">${matches.map(({ b, index }) => `<button type="button" class="demo-book-card" data-action="open-book" data-book="${index}" aria-label="${escape(b.title)}">${artwork(b.cover, 'demo-cover')}<span class="demo-book-info"><strong>${escape(b.title)}</strong><small>${escape(b.author || t('未填写作者', 'No author specified'))}</small><span>${badge(status(b.status))}<small>${b.chapters.length} ${t('章', 'chapters')}</small></span></span></button>`).join('') || `<p class="demo-empty">${t('没有匹配的作品。试试其他书名或状态。', 'No matching books. Try another title or status.')}</p>`}</div>`;
  }
  function library() {
    return `<div class="demo-library"><aside class="demo-sidebar" aria-label="${t('书库筛选', 'Library filters')}"><small>${t('我的收藏', 'MY COLLECTION')}</small>${['all', 'planning', 'writing', 'completed', 'archived'].map(value => `<button type="button" data-action="filter" data-filter="${value}" aria-pressed="${filter === value}">${escape(status(value))}<small>${books.filter(b => value === 'all' || b.status === value).length}</small></button>`).join('')}<p>${t('作品独立保存于本机。\n当前为演示书库。', 'Books live in separate local workspaces.\nThis is a sample library.')}</p></aside><div class="demo-library-content"><div class="demo-library-banner">${artwork('library-garden-' + theme)}<div><h3 tabindex="-1">${t('我的书库', 'My library')}</h3><p>${books.length} ${t('部作品，每一个世界都有自己的位置。', 'books. A place for every story world.')}</p></div></div><div class="demo-library-controls"><strong>${escape(status(filter))}</strong><label class="demo-search"><span class="demo-sr">${t('搜索书名或作者', 'Search title or author')}</span><input name="search" type="search" placeholder="${t('搜索书名或作者', 'Search title or author')}" value="${escape(search)}"/></label>${button('layout', list ? t('封面视图', 'Cover view') : t('列表视图', 'List view'), false, `aria-pressed="${list}"`)}</div><div data-book-results>${libraryCards()}</div></div></div>`;
  }
  function editor() {
    const c = current();
    return `<div class="demo-writing"><aside class="demo-chapters"><strong>${escape(book().title)}</strong>${button('new-chapter', t('＋ 新建章节', '+ New chapter'))}<details open><summary>${t('第一卷 启程', 'Volume I · Departure')}</summary>${book().chapters.map((item, i) => `<button type="button" data-action="chapter" data-chapter="${i}" aria-pressed="${i === chapterIndex}">${escape(item.title)}</button>`).join('')}</details><small>${book().chapters.length} ${t('章 · 独立正文修订', 'chapters · Independent revisions')}</small></aside><div class="demo-editor"><div class="demo-document-head"><h3 tabindex="-1">${escape(c.title)}</h3><div>${badge(t('当前写作稿', 'Working manuscript'))}<span data-final-state>${c.finalRevision ? escape(c.finalRevision === c.revision && !dirty() ? t('当前修订已定稿', 'Current revision finalized') : t('旧定稿仍保留', 'Earlier final retained')) : t('尚未定稿', 'Not finalized')}</span></div></div><label class="demo-sr" for="demo-manuscript">${t('章节正文', 'Chapter text')}</label><textarea id="demo-manuscript" name="manuscript" spellcheck="false">${escape(c.body)}</textarea><div class="demo-editor-footer"><span data-word-count>${count(c.body)}</span><span>${t('修订', 'Revision')} ${c.revision}</span>${button('finalize', t('作者定稿', 'Finalize revision'))}</div></div></div>`;
  }
  function count(text: string) {
    return `${Array.from(text.replace(/\s/g, '')).length} ${t('字符', 'characters')}`;
  }
  function details() {
    return `${heading(t('作品资料', 'Book details'), t('每部作品有独立的资料、封面、卷章与设定。', 'Each book has its own details, cover, chapters and story bible.'))}<form data-form="details" class="demo-details-form"><div>${artwork(book().cover, 'demo-detail-cover')}<label>${t('演示封面', 'Sample cover')}<select name="cover">${covers.map((value, i) => `<option value="${value}" ${book().cover === value ? 'selected' : ''}>${t('封面', 'Cover')} ${i + 1}</option>`).join('')}</select></label></div><div class="demo-fields"><label>${t('书名', 'Title')}<input name="title" required maxlength="120" value="${escape(book().title)}"/></label><label>${t('作者', 'Author')}<input name="author" maxlength="80" value="${escape(book().author)}"/></label><label>${t('创作状态', 'Writing status')}<select name="status">${['planning', 'writing', 'completed', 'archived'].map(value => `<option value="${value}" ${book().status === value ? 'selected' : ''}>${escape(status(value))}</option>`).join('')}</select></label><label>${t('作品简介', 'Synopsis')}<textarea name="synopsis" rows="3">${escape(book().synopsis)}</textarea></label><button class="demo-primary" type="submit">${t('保存作品资料', 'Save book details')}</button></div></form>`;
  }
  function bible() {
    return `${heading(t('设定集', 'Story bible'), t('作者确认的事实，供小说与改编共同引用。', 'Author-confirmed facts shared by the novel and adaptations.'), 'story-world' + (theme === 'dark' ? '-dark' : ''))}<div class="demo-inline-actions">${badge(book().locked ? t('已锁定', 'Locked') : t('已解锁', 'Unlocked'))}${button('lock', book().locked ? t('解锁设定', 'Unlock story bible') : t('锁定设定', 'Lock story bible'))}</div>${[t('林舟 · 主角', 'Lin Zhou · Protagonist'), t('沈慈 · 伙伴', 'Shen Ci · Companion'), t('雾川 · 河城', 'Wuchuan · River town')].map((name, i) => `<div class="demo-entity"><span class="demo-entity-icon">${['◇', '◇', '⌂'][i]}</span><div><strong>${name}</strong><p>${[t('携带一枚旧玉扣，来历待作者补充。', 'Carries an old jade clasp; its origin awaits author input.'), t('熟悉城中旧事，身份尚待展开。', 'Knows the city’s past; more remains to be revealed.'), t('山谷之间的河城，常年多雨。', 'A rainy river town in a mountain valley.')][i]}</p></div>${badge(t('已确认', 'Confirmed'))}</div>`).join('')}<p class="demo-help">${t('此处演示查看与锁定。解锁只改变作者编辑状态，不授予 Agent 设定集写权限。', 'This demo shows viewing and locking. Unlocking never grants agents permission to edit canon.')}</p>`;
  }
  function plot() {
    return `${heading(t('剧情整理', 'Plot beats'), t('固定正文修订上的结构候选；覆盖不足和待确认内容单独保留。', 'Structural candidates from a fixed text revision, with partial coverage shown.'))}${badge(t('固定演示结果 · 不实时抽取', 'Fixed sample · No live extraction'))}<div class="demo-timeline">${[t('抵达雾川', 'Arrival in Wuchuan'), t('走进客栈', 'Entering the inn'), t('掌柜注意到玉扣', 'The innkeeper notices the clasp')].map((s, i) => `<article><small>0${i + 1} · ${t('场景候选', 'Scene candidate')}</small><h4>${s}</h4><p>${t('来源：第一章，固定修订 12。当前正文修改后需重新整理。', 'Source: Chapter 1, fixed revision 12. Edited sources require a new extraction.')}</p></article>`).join('')}</div>${button('source', t('核对原文', 'Inspect source'))}`;
  }
  function validation() {
    return `${heading(t('一致性诊断', 'Consistency checks'), t('区分确定命中、启发式提示和缺失前提；作者核对证据后处置。', 'Separate definite conflicts, heuristic advisories and missing premises.'))}<div class="demo-warning"><strong>${t('时间线待确认 · 启发式提示', 'Timeline needs review · Heuristic advisory')}</strong><p>${t('玉扣首次出现的时间依据不足。提示不能证明情节错误。', 'The clasp’s first appearance needs a time reference. This advisory does not prove a plot error.')}</p></div>${badge(t('覆盖：当前演示片段；不是全书检查', 'Coverage: sample excerpt, not the whole book'))}<div class="demo-inline-actions">${button('source', t('定位原文', 'Locate source'))}${button('go-review', t('前往审核', 'Open draft review'))}</div><p class="demo-help">${t('这里展示固定报告，不分析输入文本。真实客户端会保留报告修订与处置理由。', 'This is a fixed report, not a live analysis. The native client retains report revisions and disposition reasons.')}</p>`;
  }
  function drama() {
    return `${heading(t('短剧骨架', 'Drama outline'), t('先整理分集场次，再建立独立 Fountain 剧本；不自动编写对白。', 'Organize episode scenes before creating a separate Fountain script; no generated dialogue.'), 'drama-stage' + (theme === 'dark' ? '-dark' : ''))}<div class="demo-inline-actions">${badge(t('第一集 · 结构候选', 'Episode 1 · Structure candidate'))}${button('source', t('查看原著映射', 'Inspect source mapping'))}</div>${[t('1-1 外景 · 雾川城门 · 夜', '1-1 EXT. WUCHUAN GATE · NIGHT'), t('1-2 内景 · 客栈 · 夜', '1-2 INT. INN · NIGHT')].map((title, i) => `<article class="demo-scene"><small>${t('场次', 'SCENE')} ${i + 1}</small><h4>${title}</h4><p>${i === 0 ? t('林舟抵达雾川。', 'Lin Zhou arrives in Wuchuan.') : t('掌柜注意到林舟携带的旧玉扣。', 'The innkeeper notices Lin Zhou’s jade clasp.')}</p><small>${t('原著来源：第一章 · 修订 12', 'Original source: Chapter 1 · Revision 12')}</small></article>`).join('')}<p class="demo-help">${t('原生客户端支持拆分、相邻合并、重排及创建可编辑剧本；本演示展示结构与来源核对。', 'The native client supports splitting, adjacent merges, reordering and editable scripts. This demo shows structure and provenance.')}</p>`;
  }
  const sourceQuote = () => initialEnglish ? 'old jade clasp' : '旧玉扣';
  const replacement = () => initialEnglish ? 'weathered jade clasp' : '纹路斑驳的旧玉扣';
  function reviews() {
    return `${heading(t('审核工作台', 'Draft review'), t('参考稿、当前写作稿和作者定稿分别保存。', 'Reference drafts, working text and author finals remain separate.'), 'review-desk' + (theme === 'dark' ? '-dark' : ''))}<div class="demo-inline-actions">${badge(t('参考稿 · 固定候选', 'Reference draft · Fixed candidate'))}<span id="demo-review-state">${decision()}</span></div><div class="demo-review-grid"><div><div class="demo-reference"><small>${t('建议替换片段', 'Suggested replacement')}</small><p>${escape(replacement())}</p><p>${t('保留原场景，只补充玉扣的外观。新增描述仍需作者判断。', 'Keep the scene and add texture to the clasp. The author must assess the added detail.')}</p></div><div class="demo-warning">${t('审核通过只记录决定，不覆盖正文，也不创建定稿。', 'Review approval records a decision. It neither overwrites the manuscript nor creates a final.')}</div></div><form data-form="review" class="demo-fields"><label>${t('审核批注', 'Review comment')}<textarea name="comment" rows="3" placeholder="${t('记录具体修改意见…', 'Describe the requested changes…')}">${escape(book().comment)}</textarea></label><label class="demo-checkbox"><input type="checkbox" name="evidence" ${evidence ? 'checked' : ''}/><span>${t('已核对原文与提示的处理方式', 'I checked the source and the advisory')}</span></label><div class="demo-inline-actions">${button('changes', t('要求修改', 'Request changes'))}${button('approve', t('通过审核', 'Approve review'), true)}</div>${button('adopt', t('局部采纳到写作稿', 'Adopt an excerpt'))}</form></div>`;
  }
  function versions() {
    return `${heading(t('版本管理', 'Version history'), t('准备固定文件与差异，作者确认后再提交；正文保存与 Git 快照分开。', 'Prepare fixed files and changes, then confirm the snapshot separately from saving.'))}<div class="demo-warning">${t('仅演示快照准备与确认，不执行 Git，不连接 GitHub 或 Gitee。', 'Sample snapshot preparation and confirmation only. No Git, GitHub or Gitee connection.')}</div>${button('snapshot', t('准备版本快照', 'Prepare a snapshot'), true)}<div class="demo-history">${book().snapshots.length ? book().snapshots.map((revision, i) => `<article><strong>${t('作者确认的演示快照', 'Author-confirmed demo snapshot')} ${book().snapshots.length - i}</strong><p>${escape(book().title)} · ${t('正文修订', 'Text revision')} ${revision}</p></article>`).join('') : `<p class="demo-help">${t('尚无快照。先保存正文，再准备版本。', 'No snapshots yet. Save your text before preparing one.')}</p>`}</div>`;
  }
  function media() {
    return `${heading(t('线索与素材', 'Media & cues'), t('固定原文选区、素材来源与权利说明分别记录。', 'Keep source selections, media provenance and rights statements distinct.'), 'media-collection' + (theme === 'dark' ? '-dark' : ''))}<div class="demo-media">${artwork(book().cover, 'demo-detail-cover')}<div><h4>${t('作品封面', 'Book cover')}</h4><p>${t('随客户端提供的演示插画。原图按比例显示，封面窗口为 2:3。', 'Sample client artwork. The original aspect ratio is preserved within a 2:3 cover window.')}</p>${badge(t('页面演示素材', 'Demo asset'))}<p class="demo-help">${t('真实素材导入、摘要校验及权利声明在本机客户端完成，此处不上传文件。', 'Real imports, checksum verification and rights records belong to the local client. No files are uploaded here.')}</p></div></div>`;
  }
  function dialogMarkup() {
    if (!dialog) return '';
    let title = '', body = '', action = '', label = '';
    if (dialog === 'new-book') {
      title = t('新建作品', 'New book'); action = 'create-book'; label = t('保存筹备', 'Save planning book');
      body = `<label>${t('书名（可留空）', 'Title (optional)')}<input name="new-title" maxlength="120" placeholder="${t('还没有书名也可以开始', 'Start without a title')}"/></label><label>${t('作者', 'Author')}<input name="new-author" maxlength="80"/></label><p>${t('手工填写即可建书，不需要模型或 Agent。这里只创建页面内演示作品。', 'Create a book manually without a model or agent. This creates an in-page sample only.')}</p>`;
    } else if (dialog === 'new-chapter') {
      title = t('新建章节', 'New chapter'); action = 'create-chapter'; label = t('建立章节', 'Create chapter');
      body = `<label>${t('章节标题', 'Chapter title')}<input name="new-title" required maxlength="120"/></label>`;
    } else if (dialog === 'adopt') {
      title = t('预览局部采纳', 'Preview excerpt adoption'); action = 'confirm-adopt'; label = t('确认采纳到写作稿', 'Confirm adoption');
      body = `<p>${t('只替换第一章中选定的片段，其余正文保留。', 'Replace only the selected excerpt in Chapter 1. Keep the rest of the text.')}</p><div class="demo-diff"><div><small>${t('当前写作稿', 'Current manuscript')}</small><p>${escape(sourceQuote())}</p></div><div><small>${t('参考稿选区', 'Reference excerpt')}</small><p>${escape(replacement())}</p></div></div><p>${t('采纳会保存新的写作稿修订。作者定稿是下一次独立决定。', 'Adoption saves a new working revision. Finalization is a separate author decision.')}</p>`;
    } else if (dialog === 'finalize') {
      title = t('确认作者定稿', 'Confirm final revision'); action = 'confirm-finalize'; label = t('确认此修订定稿', 'Finalize this revision');
      body = `<p>${escape(current().title)} · ${t('修订', 'Revision')} ${current().revision}</p><p>${t('定稿绑定当前已保存修订。以后继续修改时，旧定稿保留，新写作稿需要重新确认。', 'Finalization binds this saved revision. Later edits retain the earlier final and require a new decision.')}</p><label class="demo-checkbox"><input type="checkbox" name="final-evidence" required/><span>${t('我已核对正文、设定与来源，确认此版本。', 'I checked the text, canon and sources and confirm this revision.')}</span></label>`;
    } else {
      title = t('核对版本快照', 'Review snapshot'); action = 'confirm-snapshot'; label = t('确认演示快照', 'Confirm demo snapshot');
      body = `<p>${escape(book().title)} · ${escape(current().title)} · ${t('修订', 'Revision')} ${current().revision}</p><pre>${escape(current().saved.slice(0, 260))}</pre><p>${t('此确认只更新演示历史，不创建真实 Git 提交。', 'This confirmation only updates demo history. It creates no real Git commit.')}</p>`;
    }
    return `<dialog class="demo-dialog" aria-labelledby="demo-dialog-title"><form data-form="${action}"><h3 id="demo-dialog-title">${title}</h3><div class="demo-fields">${body}</div><div class="demo-dialog-actions">${button('cancel', t('取消', 'Cancel'))}<button type="submit" class="demo-primary">${label}</button></div></form></dialog>`;
  }
  function render(focusHeading = false) {
    root.dataset.theme = theme;
    root.lang = english ? 'en' : 'zh-CN';
    const nav = `<aside class="demo-sidebar" aria-label="${t('作品导航', 'Book navigation')}">${button('library', t('‹ 返回书库', '‹ Back to library'))}<nav>${navItems.map(([id, zh, en]) => `<button type="button" data-action="view" data-view="${id}" aria-pressed="${view === id}">${t(zh, en)}</button>`).join('')}</nav><div class="demo-current-book">${artwork(book().cover)}<strong>${escape(book().title)}</strong></div></aside>`;
    const contents = { book: details, novel: editor, bible, drama, reviews, git: versions, media, plot, validation };
    app.innerHTML = `<div class="demo-toolbar"><div class="demo-app-brand"><img src="/brand/icon-64.png" alt="" width="28" height="28"/><strong>${t('河图', 'Hetu')}</strong></div><span class="demo-context">${view === 'library' ? t('作者书库', 'Author library') : escape(book().title)}</span><div class="demo-toolbar-actions">${view !== 'library' ? `<span class="demo-save-state" data-save-state>${dirty() ? t('未保存', 'Unsaved changes') : t('已保存', 'Saved')}</span>` : ''}${button('language', english ? '中文' : 'EN', false, `aria-label="${t('切换原型界面语言', 'Switch demo interface language')}"`)}${button('theme', theme === 'light' ? t('深色', 'Dark') : t('浅色', 'Light'), false, `aria-label="${t('切换原型主题', 'Switch demo theme')}"`)}${view === 'library' ? button('new-book', t('新建作品', 'New book'), true) : button('save', t('保存正文', 'Save text'), true, dirty() ? '' : 'disabled')}</div></div>${view === 'library' ? library() : `<div class="demo-workspace">${nav}<div class="demo-content ${view === 'novel' ? 'demo-content-writing' : ''}">${bookIndex !== 0 && ['bible', 'drama', 'reviews', 'plot', 'validation'].includes(view) ? heading(t('当前作品尚无相关记录', 'No records for this book yet'), t('每部作品独立保存。回到《雾川纪》可体验已准备的设定、剧情与参考稿。', 'Books keep independent records. Open Chronicles of Wuchuan to explore prepared canon, plot and reference samples.')) : contents[view]()}${sourceVisible ? `<div class="demo-source"><h4>${t('固定原文 · 修订 12', 'Fixed source · Revision 12')}</h4><p>${escape(initialEnglish ? 'He touched the old jade clasp inside his pocket and opened the inn door.' : '他摸了摸怀里的旧玉扣，推开客栈的木门。')}</p>${button('locate', t('在写作稿中定位', 'Locate in working text'))}</div>` : ''}</div></div>`}<div class="demo-feedback" role="status" aria-live="polite">${escape(feedback || t('点击作品封面进入写作台；所有操作都在本页完成。', 'Open a book to explore its workspace. Every demo action stays on this page.'))}</div>${dialogMarkup()}`;
    if (dialog) {
      const element = app.querySelector<HTMLDialogElement>('dialog')!;
      element.showModal();
      element.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    } else if (focusHeading) {
      app.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
      app.querySelector<HTMLElement>('.demo-sidebar [aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  let dialogOpener = '';
  function closeDialog() {
    dialog = ''; render();
    app.querySelector<HTMLElement>(`[data-action="${dialogOpener}"]`)?.focus({ preventScroll: true });
  }
  function openDialog(value: typeof dialog, opener: string) {
    dialogOpener = opener; dialog = value; previewRevision = current().revision; render();
  }
  function notify(message: string) {
    feedback = message;
    app.querySelector<HTMLElement>('.demo-feedback')!.textContent = message;
  }
  function save() {
    if (!dirty()) return;
    current().saved = current().body; current().revision++;
    feedback = t('已保存页面内修订。旧定稿与参考稿审核记录分别保留。', 'In-page revision saved. Earlier finals and reference-review decisions are retained separately.');
  }
  app.addEventListener('input', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    if (target.name === 'manuscript') {
      current().body = target.value;
      app.querySelector<HTMLElement>('[data-word-count]')!.textContent = count(target.value);
      app.querySelector<HTMLElement>('[data-save-state]')!.textContent = dirty() ? t('未保存', 'Unsaved changes') : t('已保存', 'Saved');
      app.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled = !dirty();
      const final = app.querySelector<HTMLElement>('[data-final-state]')!;
      if (current().finalRevision) final.textContent = dirty() || current().finalRevision !== current().revision ? t('旧定稿仍保留', 'Earlier final retained') : t('当前修订已定稿', 'Current revision finalized');
    }
    if (target.name === 'search') { search = target.value; app.querySelector('[data-book-results]')!.innerHTML = libraryCards(); }
    if (target.name === 'comment') book().comment = target.value;
    if (target.name === 'evidence' && target instanceof HTMLInputElement) evidence = target.checked;
  });
  app.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>('[data-action]');
    if (!control) return;
    const action = control.dataset.action;
    feedback = ''; sourceVisible = false;
    if (action === 'open-book') { bookIndex = Number(control.dataset.book); chapterIndex = 0; view = 'novel'; evidence = false; }
    else if (action === 'library') view = 'library';
    else if (action === 'view') { view = control.dataset.view as View; }
    else if (action === 'filter') filter = control.dataset.filter!;
    else if (action === 'layout') list = !list;
    else if (action === 'language') english = !english;
    else if (action === 'theme') theme = theme === 'light' ? 'dark' : 'light';
    else if (action === 'chapter') chapterIndex = Number(control.dataset.chapter);
    else if (action === 'save') save();
    else if (action === 'lock') book().locked = !book().locked;
    else if (action === 'source') sourceVisible = true;
    else if (action === 'go-review') view = 'reviews';
    else if (action === 'locate') {
      chapterIndex = 0; view = 'novel'; render();
      const textarea = app.querySelector<HTMLTextAreaElement>('[name="manuscript"]')!;
      const index = textarea.value.indexOf(sourceQuote());
      if (index < 0) { notify(t('原文片段已变化，请核对固定修订；不会默认定位到错误位置。', 'The excerpt has changed. Inspect the fixed revision; no substitute location was chosen.')); return; }
      textarea.focus({ preventScroll: true }); textarea.setSelectionRange(index, index + sourceQuote().length); return;
    } else if (action === 'new-book' || action === 'new-chapter') { openDialog(action, action); return; }
    else if (action === 'cancel') { closeDialog(); return; }
    else if (action === 'changes') {
      if (!book().comment.trim()) { notify(t('请先填写具体修改意见。', 'Enter a specific review comment first.')); return; }
      book().decision = 'changes'; feedback = t('返工意见已记录；未覆盖正文。', 'Change request recorded. The manuscript is unchanged.');
    } else if (action === 'approve') {
      if (!evidence) { notify(t('请先核对原文并勾选确认。', 'Check the source and confirm the checkbox first.')); return; }
      book().decision = 'approved'; feedback = t('参考稿审核通过。可另行采纳；写作稿尚未定稿。', 'Reference review approved. Adoption and manuscript finalization are separate actions.');
    } else if (action === 'adopt') {
      chapterIndex = 0;
      if (dirty()) { notify(t('请先到小说正文保存修改，再预览采纳。', 'Save your manuscript edits before previewing adoption.')); return; }
      if (current().body.includes(replacement())) { notify(t('此参考片段已采纳，请继续编辑写作稿或独立定稿。', 'This excerpt is already adopted. Continue editing or finalize separately.')); return; }
      if (!current().body.includes(sourceQuote())) { notify(t('选定原文已变化，请重新核对选区。', 'The selected source has changed. Recheck the excerpt.')); return; }
      openDialog('adopt', action); return;
    } else if (action === 'finalize' || action === 'snapshot') {
      if (dirty()) { notify(t('请先保存正文，再确认固定修订。', 'Save the text before confirming a fixed revision.')); return; }
      openDialog(action, action); return;
    }
    render(['view', 'open-book', 'library'].includes(action ?? ''));
  });
  app.addEventListener('submit', event => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    const data = new FormData(event.target), action = event.target.dataset.form;
    if (action === 'details') {
      const title = String(data.get('title')).trim();
      if (!title) { notify(t('请填写书名。', 'Enter a title.')); return; }
      Object.assign(book(), { title, author: String(data.get('author')).trim(), status: String(data.get('status')), cover: String(data.get('cover')), synopsis: String(data.get('synopsis')) });
      feedback = t('演示作品资料已保存。', 'Sample book details saved.');
    } else if (action === 'create-book') {
      books.push({ title: String(data.get('new-title')).trim() || t('未命名作品', 'Untitled book'), author: String(data.get('new-author')).trim(), status: 'planning', cover: covers[0], synopsis: '', chapters: [chapter(t('创作笔记', 'Writing notes'), '')], locked: false, decision: 'pending', comment: '', snapshots: [] });
      bookIndex = books.length - 1; chapterIndex = 0; evidence = false; view = 'book';
      feedback = t('筹备作品已建立。可以补充资料，再开始第一章。', 'Planning book created. Add details and begin your first chapter.');
    } else if (action === 'create-chapter') {
      const title = String(data.get('new-title')).trim();
      if (!title) return;
      book().chapters.push(chapter(title, '')); chapterIndex = book().chapters.length - 1; view = 'novel';
    } else if (action === 'confirm-adopt') {
      if (current().revision !== previewRevision || dirty()) { notify(t('正文已改变，请重新预览。', 'The manuscript changed. Preview again.')); return; }
      current().body = current().body.replace(sourceQuote(), replacement()); save(); view = 'novel';
      feedback = t('选定片段已采纳到新的写作稿修订，尚未定稿。', 'Excerpt adopted into a new working revision. It is not finalized.');
    } else if (action === 'confirm-finalize') {
      if (current().revision !== previewRevision || dirty()) { notify(t('修订已变化，请重新确认。', 'The revision changed. Review it again.')); return; }
      current().finalRevision = current().revision;
      feedback = t('当前保存修订已由作者定稿；后续编辑不改写此决定。', 'This saved revision is finalized. Later edits retain this decision.');
    } else if (action === 'confirm-snapshot') {
      if (current().revision !== previewRevision || dirty()) return;
      book().snapshots.unshift(current().revision);
      feedback = t('演示快照已确认。没有执行真实 Git 操作。', 'Demo snapshot confirmed. No real Git operation ran.');
    }
    dialog = ''; render();
  });
  render();
}
