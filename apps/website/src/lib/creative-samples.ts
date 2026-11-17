import type { Locale } from './site';

export type SampleKind = 'novel' | 'screenplay' | 'video';
export interface CreativeSample {
  id: SampleKind;
  label: string;
  title: string;
  location: string;
  excerpt: string[];
  continuation: string;
  goal: string;
  guide: string;
  feedback: { label: string; note: string; before: string; after: string; anchor?: string; context?: string; shot?: number }[];
}

export function storyShots(locale: Locale) {
  const en = locale === 'en';
  const shots = [
    ['arrival','渡口','Arrive','最后一班渡船还没走。','The last ferry was still waiting.'],
    ['rope','解绳','Untie','“天黑不渡人。”他却解开了缆绳。','“No one crosses after dark.” He unties the rope.'],
    ['letter','藏信','Conceal','指腹停在旧折痕，信没入袖口。','Her thumb finds the old crease. The letter disappears.'],
    ['listen','倾听','Listen','一声船铃。她停住了。','A bell. She holds still.'],
    ['empty','空岸','Silence','对岸空无一人。','The far bank is empty.'],
    ['wait','停步','Wait','她没有上船。','She does not board.'],
  ];
  return shots.map(([id,zh,name,line,text],i)=>({id,label:en?name:zh,caption:en?text:line,image:`/images/ferry-${id}.webp`,time:`00:${String(i*2).padStart(2,'0')}`}));
}

// 静态原创示例，不调用模型，不读写作者作品。
export function creativeSamples(locale: Locale): CreativeSample[] {
  return locale === 'en' ? [
    {
      id: 'novel', label: 'Novel', title: 'The Last Ferry', location: 'Chapter 1 / The letter',
      excerpt: ['The last ferry was still waiting. Qing stopped where the lantern light ended, the letter folded inside her sleeve.', '“No one crosses after dark,” the boatkeeper said. He had already untied the rope.'],
      continuation: 'Qing looked at his hands. The knot had left a pale mark, as though he had been waiting there for a very long time.',
      goal: 'Open at a river crossing. Keep the letter’s sender a mystery.', guide: 'writing',
      feedback: [
        { label: 'Keep the mystery', note: 'Let the action hint that she recognizes the letter. Keep the sender unnamed.', before: 'She knew the handwriting. Her brother had finally written after three years.', after: 'Her thumb stopped on the last stroke. She folded the letter along its old crease and hid it in her sleeve.' },
        { label: 'A quieter voice', note: 'Keep the hesitation, but make it less explicit.', before: 'She was frightened. Crossing the river would mean giving up the life she knew.', after: 'She put one foot on the boat, then lifted it back onto the landing. “How long to the other side?”' },
      ],
    },
    {
      id: 'screenplay', label: 'Script', title: 'The Last Ferry', location: 'Scene 03 / EXT. RIVER LANDING — DUSK',
      excerpt: ['Qing steps into the lantern light. A folded letter disappears into her sleeve.', 'BOATKEEPER: No one crosses after dark.', 'He unties the rope. Qing stays on the landing.'],
      continuation: 'QING: Then why are you still here?\nThe boatkeeper looks past her. A bell sounds from the empty bank.',
      goal: 'Write the encounter through action and restrained dialogue.', guide: 'screenplays',
      feedback: [
        { label: 'Subtler dialogue', note: 'Remove the explanation. Let his action contradict what he says.', before: 'BOATKEEPER: I was told to wait for you, but crossing now is dangerous.', after: 'BOATKEEPER: Last boat’s gone.\nHe pulls the ferry closer to the landing.' },
        { label: 'Leave it open', note: 'End on the bell. Do not explain who is on the other bank.', before: 'Qing sees her brother on the far bank and calls his name.', after: 'A bell sounds from the far bank.\nQing turns. The river is empty.' },
      ],
    },
    {
      id: 'video', label: 'Short video', title: 'The Last Ferry', location: 'Six-shot storyboard / 12 seconds',
      excerpt: ['01–02 / 00:00–00:04 / Arrive. The boatkeeper unties the rope.', '03–04 / 00:04–00:08 / Hide the letter. Hear a bell.', '05–06 / 00:08–00:12 / An empty bank. A step held back.'],
      continuation: 'An illustrated storyboard for pacing and shot order. It is not a generated final film.',
      goal: 'Plan a short mystery in six shots. Stop before the crossing.', guide: 'video',
      feedback: [
        { label: 'Sound before action', note: 'On shot 04, hear the bell before her gaze shifts. Add a one-second pause.', before: '00:06 Qing looks away → 00:07 the bell sounds.', after: '00:06 the bell sounds → hold 1 second → 00:07 her gaze shifts.', anchor:'00:06–00:08', context:'Shot 04 / The bell and her gaze', shot:3 },
        { label: 'Stay with the detail', note: 'Hold on the letter in shot 03. Keep the other shots.', before: 'Shot 03 / 2 seconds. The hand immediately leaves the frame.', after: 'Shot 03 / 3 seconds. Her thumb pauses on the crease before the letter disappears.', anchor:'00:04–00:06', context:'Shot 03 / The letter', shot:2 },
      ],
    },
  ] : [
    {
      id: 'novel', label: '小说', title: '渡口来信', location: '第一章 / 最后一班渡船',
      excerpt: ['最后一班渡船还没走。沈青停在灯照不到的地方，把信折进袖里。', '“天黑不渡人。”船夫说。他手里的缆绳，却已经解开了。'],
      continuation: '沈青看着他的手。那道绳结在掌心留下一圈白印，像是已经等了很久。',
      goal: '从渡口写一个开篇，保留来信人身份的悬念。', guide: 'writing',
      feedback: [
        { label: '保留悬念', note: '用动作暗示她认得这封信，先不揭开来信人的身份。', before: '她认得这笔迹。失踪三年的兄长，终于给她写信了。', after: '指腹停在最后一笔。她沿旧折痕把信叠好，收进了袖中。' },
        { label: '表达更克制', note: '保留犹豫，删去对情绪的直接解释。', before: '她很害怕。渡过这条河，就再也回不到从前的生活。', after: '她一只脚踏上船，又退回石阶。“到对岸，要多久？”' },
      ],
    },
    {
      id: 'screenplay', label: '剧本', title: '渡口来信', location: '第 03 场 / 外景 渡口 傍晚',
      excerpt: ['沈青走进灯下。折好的信没入袖口。', '船夫：天黑不渡人。', '他解开缆绳。沈青留在石阶上。'],
      continuation: '沈青：那你在等谁？\n船夫看向她身后。空荡的河岸，响起一声船铃。',
      goal: '写一场渡口相遇，用行动和简短对白表现试探。', guide: 'screenplays',
      feedback: [
        { label: '对白更克制', note: '删去解释，让动作和说出口的话形成反差。', before: '船夫：有人托我等你，但现在过河很危险。', after: '船夫：末班船走了。\n他把船又拉近了些。' },
        { label: '留下疑问', note: '停在铃声响起，不解释对岸是谁。', before: '沈青看见对岸的兄长，喊出了他的名字。', after: '对岸，一声船铃。\n沈青回头。江上空无一人。' },
      ],
    },
    {
      id: 'video', label: '短视频', title: '渡口来信', location: '六镜分镜 / 12 秒',
      excerpt: ['01–02 / 00:00–00:04 / 来到渡口，船夫解绳', '03–04 / 00:04–00:08 / 藏起来信，听见船铃', '05–06 / 00:08–00:12 / 对岸无人，登船前停步'],
      continuation: '插画分镜用于说明镜头顺序与节奏，不是生成成片。',
      goal: '用六个镜头呈现渡口的悬念，停在过河之前。', guide: 'video',
      feedback: [
        { label: '声音先于动作', note: '第四镜先听见船铃，多停一秒，再让人物移开视线。', before: '00:06 沈青移开视线 → 00:07 船铃响起。', after: '00:06 船铃响起 → 停顿 1 秒 → 00:07 沈青移开视线。', anchor:'00:06–00:08', context:'第四镜 / 船铃与视线', shot:3 },
        { label: '留住细节', note: '第三镜在信的折痕上多停一秒，其他镜头保持。', before: '第三镜 / 2 秒。手直接离开画面。', after: '第三镜 / 3 秒。指腹停在旧折痕，随后将信收好。', anchor:'00:04–00:06', context:'第三镜 / 来信', shot:2 },
      ],
    },
  ];
}
