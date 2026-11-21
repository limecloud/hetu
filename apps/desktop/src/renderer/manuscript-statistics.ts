import {useEffect, useRef, useState} from "react";

export interface ManuscriptStatistics { count: number; words: number; characters: number }

/** 分批计数也用于无Worker的宿主；取消旧请求，不让长文统计占住输入线程。 */
export async function calculateStatistics(text: string, active = () => true): Promise<ManuscriptStatistics | undefined> {
  const result: ManuscriptStatistics = {count: 0, words: 0, characters: 0};
  const phases: [keyof ManuscriptStatistics, Iterable<unknown>][] = [
    ["characters", new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(text)],
    ["count", text.matchAll(/\p{Script=Han}/gu)],
    ["words", text.matchAll(/\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:[’'-]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*/gu)],
  ];
  let batch = 0, deadline = performance.now() + 4;
  for (const [key, values] of phases) {
    for (const _ of values) {
      result[key]++;
      if (++batch % 256 === 0 && performance.now() >= deadline) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!active()) return;
        deadline = performance.now() + 4;
      }
    }
    if (!active()) return;
  }
  return result;
}

export function useManuscriptStatistics(text: string) {
  const [result, setResult] = useState<{text: string; value: ManuscriptStatistics}>();
  const request = useRef(0), worker = useRef<Worker>(), current = useRef(text);
  const sent = useRef<{id: number; text: string}>();
  current.current = text;
  useEffect(() => {
    let url: string | undefined, active = true;
    try {
      const code = "let latest = 0; onmessage = async event => { const id = event.data.id; latest = id; const value = await (" + calculateStatistics.toString() + ")(event.data.text, () => id === latest); if (value && id === latest) postMessage({id, value}); };";
      url = URL.createObjectURL(new Blob([code], {type: "text/javascript"}));
      const instance = new Worker(url); worker.current = instance;
      instance.onmessage = event => { const source = sent.current; if (source && active && event.data.id === request.current && source.id === event.data.id) setResult({text: source.text, value: event.data.value}); };
      instance.onerror = event => {
        event.preventDefault(); instance.terminate(); worker.current = undefined;
        const id = request.current, source = current.current;
        void calculateStatistics(source, () => active && id === request.current).then(value => { if (value && active && id === request.current) setResult({text: source, value}); });
      };
    } catch { /* 受限宿主使用下面同一分批算法，不依赖Worker权限。 */ }
    return () => { active = false; request.current++; worker.current?.terminate(); worker.current = undefined; if (url) URL.revokeObjectURL(url); };
  }, []);
  useEffect(() => {
    const id = ++request.current;
    const timer = setTimeout(() => {
      if (worker.current) { sent.current = {id, text}; worker.current.postMessage({id, text}); }
      else void calculateStatistics(text, () => id === request.current).then(value => { if (value && id === request.current) setResult({text, value}); });
    }, 160);
    return () => { clearTimeout(timer); if (id === request.current) request.current++; };
  }, [text]);
  return result?.text === text ? result.value : undefined;
}
