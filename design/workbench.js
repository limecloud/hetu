const $=id=>document.getElementById(id);let locale='zh',revision=12,locked=true,review='pending',activeChapter=1,timer;
const chapters={1:{title:'第一章 雨夜来客',content:'雾川的雨，从黄昏开始便没有停过。\n\n山谷被一层乳白的雾气笼住，远处的河声隐约，像是从更深的年代传来。林舟推开客栈的木门时，衣摆已被雨水浸透。\n\n他抖了抖肩上的水珠，径直走向柜台。掌柜抬起头，打量了他片刻。\n\n“借一间房。”林舟简短地说，将一枚旧玉扣放在桌上。玉扣表面已有磨痕，仍依稀可看出上面的河纹。\n\n掌柜的神色微微一变，似乎认出了什么，却没有多问，只点头应下。\n\n林舟接过房钥，沿着木梯上楼。推开房门的那一刻，雨声忽然更加清晰。'},2:{title:'第二章 雾川旧事',content:'【演示章节】\n\n这一页展示章节切换。你的正文不会因界面语言改变而被翻译。'},3:{title:'第三章 河图之约',content:'【演示章节】\n\n人物设定与来源引用通过稳定身份关联，章节顺序可以独立调整。'},4:{title:'第四章 山门试炼',content:'【演示章节】\n\n草稿与定稿分别保存，修改正文不会覆盖旧的审核证据。'}};
const isEnglishDemo=new URLSearchParams(location.search).get('lang')==='en';
if(isEnglishDemo){
 const samples=[
  ['Chapter 1: A Rainy Arrival','Rain had been falling over Wuchuan since dusk.\n\nA pale mist filled the valley, and the distant river sounded like an echo from another age. Lin Zhou pushed open the inn door, his coat soaked through.\n\nHe crossed the room and placed an old jade clasp on the counter. The innkeeper looked up, then fell silent. A faded river pattern still marked the stone.\n\n“One room,” Lin Zhou said.\n\nThe innkeeper recognized something in the clasp but asked no questions. He handed Lin Zhou a key. Outside, the rain grew louder.\n\nLin Zhou climbed the wooden stairs. When he opened the door to his room, a faint light moved through the mist beyond the window. The story of Wuchuan was only beginning.'],
  ['Chapter 2: Old Stories','[Demo chapter]\n\nSwitch chapters to explore the editor. Changing the interface language never translates your manuscript.'],
  ['Chapter 3: The River Pact','[Demo chapter]\n\nCharacters and source references keep stable identities even when chapter order changes.'],
  ['Chapter 4: Mountain Trials','[Demo chapter]\n\nDrafts and approved revisions remain separate. Editing never replaces earlier review evidence.']
 ];
 samples.forEach(([title,content],index)=>{chapters[index+1]={title,content};document.querySelector(`[data-chapter="${index+1}"]`).textContent=title;});
 document.querySelector('.chapter-list h3').textContent='The Wuchuan Chronicles';
 $('chapterTitle').textContent=chapters[1].title;
 document.querySelector('.workspace-name').firstChild.textContent='The Wuchuan Chronicles ';
 document.querySelector('.brand span').textContent='Hetu Luoshu';
 document.querySelector('.brand img').alt='Hetu Luoshu';
 document.querySelector('.app-sidebar').setAttribute('aria-label','Workspace navigation');
 document.querySelector('.review-body').innerHTML='1-2　INT. INN · NIGHT<br><br>Lin Zhou places the old jade clasp on the counter.<br>The innkeeper glances down, then pauses.<br><br>LIN ZHOU<br>“One room.”<br><br><span style="background:#fff1cf">Confirm when the jade clasp first appeared.</span>';
 const names=new Map([['林舟','Lin Zhou'],['沈慈','Shen Ci'],['雾川','Wuchuan'],['林','L'],['沈','S'],['雾','W']]);
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){const text=node.textContent.trim();if(names.has(text))node.textContent=names.get(text);}
}
const message=(zh,en)=>locale==='zh'?zh:en;
function toast(zh,en){$('toast').textContent=message(zh,en);$('toast').hidden=false;clearTimeout(timer);timer=setTimeout(()=>$('toast').hidden=true,3500)}
function updateCount(){const text=$('manuscript').value;const count=isEnglishDemo?(text.match(/\p{L}+(?:['’-]\p{L}+)*/gu)||[]).length:[...text].filter(c=>/\p{Script=Han}/u.test(c)).length;$('wordCount').textContent=isEnglishDemo?message(`英文词 ${count}`,`${count} words`):message(`汉字 ${count}`,`${count} Han characters`)}
function updateState(){
 $('saveState').textContent=message(`本地演示 · 修订 ${revision}`,`Local demo · Revision ${revision}`);
 $('lockState').textContent=message(locked?'设定已锁定':'设定已解锁',locked?'Story Bible locked':'Story Bible unlocked');
 $('bibleStatus').textContent=message(`${locked?'设定已锁定':'设定已解锁'} · 版本 7`,`${locked?'Locked':'Unlocked'} · Revision 7`);
 $('toggleLock').textContent=message(locked?'解锁设定':'锁定设定',locked?'Unlock Story Bible':'Lock Story Bible');
 $('reviewStatus').textContent=message({pending:'待审核',approved:'已定稿',changes:'要求修改'}[review],{pending:'Awaiting review',approved:'Approved',changes:'Changes requested'}[review]);
 if(review!=='pending'){$('reviewResult').textContent=message(review==='approved'?'演示：已记录通过决定。':'演示：已记录修改要求和批注。',review==='approved'?'Demo: approval recorded.':'Demo: changes and comment recorded.');}
 updateCount();
}
function changeLanguage(){locale=locale==='zh'?'en':'zh';document.documentElement.lang=locale==='zh'?'zh-CN':'en';document.querySelectorAll('[data-zh]').forEach(e=>e.innerHTML=e.dataset[locale]);document.querySelectorAll('[data-placeholder-zh]').forEach(e=>e.placeholder=e.dataset[locale==='zh'?'placeholderZh':'placeholderEn']);$('language').textContent=locale==='zh'?'EN':'中文';$('language').setAttribute('aria-label',message('切换为英文','Switch to Chinese'));$('manuscript').setAttribute('aria-label',message('章节正文','Chapter manuscript'));document.title=message('河图洛书 · 交互原型','Hetu Luoshu · Interactive Prototype');updateState();}
$('language').onclick=changeLanguage;
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===b.dataset.view));});
document.querySelectorAll('[data-chapter]').forEach(b=>b.onclick=()=>{chapters[activeChapter].content=$('manuscript').value;activeChapter=+b.dataset.chapter;$('chapterTitle').textContent=chapters[activeChapter].title;$('manuscript').value=chapters[activeChapter].content;document.querySelectorAll('[data-chapter]').forEach(x=>x.classList.toggle('selected',x===b));updateCount();});
$('manuscript').value=chapters[1].content;$('manuscript').addEventListener('input',updateCount);
$('save').onclick=()=>{chapters[activeChapter].content=$('manuscript').value;revision++;updateState();toast('演示：已保存当前修订，未写入磁盘。','Demo: revision saved in this page. No files written.');};
$('toggleLock').onclick=()=>{locked=!locked;updateState();toast(locked?'演示：设定已锁定。':'演示：作者已解锁，Agent 权限不变。',locked?'Demo: Story Bible locked.':'Demo: unlocked by author; agent permissions unchanged.');};
$('locate').onclick=()=>{const text=$('manuscript').value,target=isEnglishDemo?'old jade clasp':'旧玉扣';let start=text.indexOf(target);if(start<0){toast('当前章节没有对应引用，请打开第一章。','Open Chapter 1 to inspect this source.');return;}$('manuscript').focus();$('manuscript').setSelectionRange(start,start+target.length);toast('已定位原文引用。','Source passage selected.');};
$('compare').onclick=()=>{document.querySelector('[data-view="novel"]').click();document.querySelector('[data-chapter="1"]').click();$('locate').click();};
$('changes').onclick=()=>{if(!$('comment').value.trim()){toast('请先写下修改意见。','Add a review comment first.');$('comment').focus();return;}review='changes';$('reviewResult').hidden=false;updateState();};
$('approve').onclick=()=>{if(!$('evidence').checked){toast('请先审阅并确认时间线提示。','Review and resolve the timeline advisory first.');$('evidence').focus();return;}$('approvalDialog').showModal();};
$('cancelApproval').onclick=()=>$('approvalDialog').close();$('confirmApproval').onclick=()=>{review='approved';$('reviewResult').hidden=false;$('approvalDialog').close();updateState();};
$('export').onclick=()=>{const n=document.querySelectorAll('.export-list input:checked').length;$('exportResult').hidden=false;$('exportResult').textContent=n?message(`演示清单：已选择 ${n} 类材料；正式导出仍需校验版本、定稿与权利。`,`Demo selection: ${n} content groups. A real export must verify revisions, approval and rights.`):message('请至少选择一类交付内容。','Select at least one content group.');};updateState();
if(isEnglishDemo)changeLanguage();
