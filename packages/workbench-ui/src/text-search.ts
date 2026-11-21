export interface SearchOptions { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; segmented: boolean; diacriticsInsensitive?: boolean }
export interface TextMatch { from: number; to: number; replacement: string }
export interface TextSearchResult { matches: TextMatch[]; truncated: boolean }

/** 固定算法可放入可终止Worker；正则仍受外部执行期限约束。 */
export function findText(text: string, options: SearchOptions, replacement = "", limit = 10000): TextSearchResult {
  if (!options.query) return {matches: [], truncated: false};
  if (options.query.length > 1000) throw new Error("search.query_limit");
  const starts: number[] = [], ends: number[] = [];
  let searchable = text;
  if (options.diacriticsInsensitive) {
    const pieces: string[] = [];
    for (const part of new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(text)) {
      const folded = part.segment.normalize("NFD").replace(/\p{M}/gu, "");
      pieces.push(folded);
      for (let i = 0; i < folded.length; i++) {starts.push(part.index); ends.push(part.index + part.segment.length);}
    }
    searchable = pieces.join("");
  }
  const query = options.diacriticsInsensitive ? options.query.normalize("NFD").replace(/\p{M}/gu, "") : options.query;
  if (!query) return {matches: [], truncated: false};
  const pattern = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let expression: RegExp;
  try { expression = new RegExp(pattern, "dgu" + (options.caseSensitive ? "" : "i")); } catch { throw new Error("search.invalid_regex"); }
  const matches: TextMatch[] = [], words = options.segmented ? new Map<number, number>() : undefined;
  if (words) for (const part of new Intl.Segmenter("zh-CN", {granularity: "word"}).segment(text)) if (part.isWordLike) words.set(part.index, part.index + part.segment.length);
  const word = (value: string) => /[\p{Script=Latin}\p{N}\p{M}_]/u.test(value);
  const previous = (index: number) => index <= 0 ? "" : String.fromCodePoint(text.codePointAt(index > 1 && /[\uDC00-\uDFFF]/.test(text[index - 1]) ? index - 2 : index - 1)!);
  let replacementSize = 0, zeroWidth = false;
  for (const match of searchable.matchAll(expression)) {
    const start = match.index!, end = start + match[0].length;
    if (start === end) {zeroWidth = true; continue;}
    const from = options.diacriticsInsensitive ? starts[start]! : start, to = options.diacriticsInsensitive ? ends[end - 1]! : end;
    if (matches.at(-1)?.from === from && matches.at(-1)?.to === to) continue;
    if (options.wholeWord && (word(previous(from)) || word(to < text.length ? String.fromCodePoint(text.codePointAt(to)!) : ""))) continue;
    if (words && words.get(from) !== to) continue;
    if (matches.length >= limit) return {matches, truncated: true};
    const capture = (range?: [number, number]) => !range || range[0] === range[1] ? "" : text.slice(options.diacriticsInsensitive ? starts[range[0]] : range[0], options.diacriticsInsensitive ? ends[range[1] - 1] : range[1]);
    const expanded = options.regex ? replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token, key: string) => {
      if (key === "$") return "$"; if (key === "&") return text.slice(from, to); if (key === "`") return text.slice(0, from); if (key === "'") return text.slice(to);
      if (key.startsWith("<")) return match.groups ? capture(match.indices?.groups?.[key.slice(1, -1)]) : token;
      const index = Number(key);
      if (index > 0 && index < match.length) return capture(match.indices?.[index]);
      if (key.length === 2 && Number(key[0]) > 0 && Number(key[0]) < match.length) return capture(match.indices?.[Number(key[0])]) + key[1];
      return token;
    }) : replacement;
    replacementSize += expanded.length;
    if (replacementSize > 4 * 1024 * 1024) throw new Error("search.replacement_limit");
    matches.push({from, to, replacement: expanded});
  }
  if (zeroWidth && !matches.length) throw new Error("search.zero_width");
  return {matches, truncated: false};
}

export interface SearchJob { result: Promise<TextSearchResult>; cancel: () => void }
export function searchText(text: string, options: SearchOptions, replacement = ""): SearchJob {
  let worker: Worker | undefined, url: string | undefined, finished = false, rejectJob: (error: Error) => void = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const cleanup = () => { worker?.terminate(); if (url) URL.revokeObjectURL(url); clearTimeout(timer); finished = true; };
  const result = new Promise<TextSearchResult>((resolve, reject) => {
    rejectJob = reject;
    if (!options.query) { finished = true; resolve({matches: [], truncated: false}); return; }
    try {
      url = URL.createObjectURL(new Blob(["onmessage = event => {try {postMessage({value:(" + findText.toString() + ")(...event.data)});} catch(error) {postMessage({error:error.message});}}"], {type: "text/javascript"}));
      worker = new Worker(url);
      worker.onmessage = event => { cleanup(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.value); };
      worker.onerror = event => { event.preventDefault(); cleanup(); reject(new Error("search.worker_unavailable")); };
      timer = setTimeout(() => { cleanup(); reject(new Error("search.timeout")); }, 1200);
      worker.postMessage([text, options, replacement]);
    } catch { cleanup(); reject(new Error("search.worker_unavailable")); }
  });
  return {result, cancel: () => { if (!finished) {cleanup(); rejectJob(new Error("search.cancelled"));} }};
}
