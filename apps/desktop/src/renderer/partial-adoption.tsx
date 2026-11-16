import React, { useRef, useState } from "react";
import { desktop } from "./bridge.ts";
import { selectedSource } from "./editor.tsx";

type Span = NonNullable<ReturnType<typeof selectedSource>>;

/** 在完整固定原文中选择片段；字节坐标只用于提交，不进入作者表单。 */
export function PartialAdoption({
  task_ref,
  candidate_id,
  busy,
  notify,
  preview,
}: {
  task_ref: any;
  candidate_id: string;
  busy: boolean;
  notify: (text: string) => void;
  preview: (value: any) => void;
}) {
  const [context, setContext] = useState<any>(),
    [source, setSource] = useState<Span>(),
    [target, setTarget] = useState<Span>(),
    [loading, setLoading] = useState(false);
  const sourceNode = useRef<HTMLPreElement>(null),
    targetNode = useRef<HTMLPreElement>(null);
  async function run(action: () => Promise<void>) {
    setLoading(true);
    try {
      await action();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  function select(kind: "source" | "target") {
    if (loading || busy) return;
    const element = kind === "source" ? sourceNode.current : targetNode.current;
    if (!element) return;
    const span = selectedSource(
      element,
      kind === "source" ? context.source : context.before,
    );
    if (span) {
      (kind === "source" ? setSource : setTarget)(span);
      preview(undefined);
    }
  }
  return (
    <details className="partial-adoption">
      <summary>只采纳部分内容</summary>
      <p className="muted">
        在参考稿和当前正文中分别选中一段文字，预览替换后的完整正文，再决定采纳。
      </p>
      <button
        disabled={busy || loading}
        onClick={() =>
          void run(async () => {
            const fixed = await desktop.author("adoption_context", {
              task_ref,
              candidate_id,
            });
            setContext(fixed);
            setSource(undefined);
            setTarget(
              fixed.before === ""
                ? { byte_start: 0, byte_end: 0, quote: "" }
                : undefined,
            );
            preview(undefined);
          })
        }
      >
        {context ? "重新读取局部采纳对照" : "读取局部采纳对照"}
      </button>
      {loading && <p aria-live="polite">正在读取固定采纳对照…</p>}
      {context && !loading && (
        <>
          <div className="compare">
            <section>
              <h4>参考稿 选中要采用的片段</h4>
              <pre
                ref={sourceNode}
                tabIndex={0}
                aria-label="局部采纳参考稿"
                onMouseUp={() => select("source")}
                onKeyUp={() => select("source")}
              >
                {context.source}
              </pre>
              <p aria-live="polite">
                {source
                  ? `已选参考片段：${source.quote}`
                  : "尚未选择参考片段。"}
              </p>
            </section>
            <section>
              <h4>当前正文 {context.title}</h4>
              <pre
                ref={targetNode}
                tabIndex={0}
                aria-label="局部采纳目标正文"
                onMouseUp={() => select("target")}
                onKeyUp={() => select("target")}
              >
                {context.before}
              </pre>
              <p aria-live="polite">
                {target
                  ? context.before
                    ? `已选替换片段：${target.quote}`
                    : "当前正文为空，将写入所选参考片段。"
                  : "尚未选择正文中要替换的片段。"}
              </p>
            </section>
          </div>
          <button
            disabled={busy || loading || !source || !target}
            onClick={() =>
              void run(async () => {
                preview(
                  await desktop.author("adoption_partial", {
                    token: context.token,
                    source,
                    target,
                  }),
                );
              })
            }
          >
            预览选中片段
          </button>
        </>
      )}
    </details>
  );
}
