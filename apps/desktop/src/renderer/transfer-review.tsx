import React, { useEffect, useState } from "react";
import { desktop, data } from "./bridge.ts";

export type TransferKind = "import" | "delivery";
export function transferKind(action: string): TransferKind | undefined {
  if (["hetu.documents.import", "hetu.documents.import_batch"].includes(action)) return "import";
  if (["hetu.documents.export", "hetu.bundles.export"].includes(action)) return "delivery";
}
function messages(value: any): string[] {
  if (!value || typeof value !== "object") return typeof value === "string" ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(messages);
  return Object.entries(value).flatMap(([key, child]) =>
    ["message", "reason", "warnings", "losses", "report", "exclusions", "blockers"].includes(key)
      ? messages(child) : [],
  );
}
const formats: Record<string, string> = {
  markdown: "Markdown", fountain: "Fountain 剧本", txt: "TXT", docx: "Word", pdf: "PDF",
};

/** 固定管理方案的人类可读投影；不提供导入、执行或作者权限桥接。 */
export function TransferDetails({ view }: { view: any }) {
  const kind = transferKind(view.action),
    input = view.input,
    fixed = input.preview,
    request = fixed?.request,
    files = fixed?.files ?? [];
  const [verified, setVerified] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setVerified(undefined);
    setError("");
  }, [view.proposal_id, view.proposal_sha256]);
  const notes = [...new Set(messages(kind === "import" ? fixed?.converted : fixed))];
  const texts: { title: string; content: string }[] = kind === "import"
    ? view.action === "hetu.documents.import"
      ? [{ title: input.title, content: fixed?.converted?.content ?? "" }]
      : (view.preview.documents ?? []).map((item: any) => ({
          title: item.document.title,
          content: view.changes.find((change: any) =>
            change.path.includes(`/documents/${item.document.document_id}/`) && /\.(md|fountain)$/.test(change.path),
          )?.after ?? "未取得固定正文，请检查完整方案。",
        }))
    : [];
  return (
    <section aria-label={kind === "import" ? "固定导入内容" : "固定交付选集"}>
      <p>
        {kind === "import"
          ? `导入到当前${input.work_ref?.kind === "drama" ? "剧本的分集目录" : "小说的章节目录"}，保留原稿与转换报告。`
          : `${request?.profile === "production_delivery" ? "正式交付包" : request?.profile === "review_delivery" ? "审阅交付包" : "文稿导出"}，包含固定版本的选集。`}
      </p>
      {kind === "delivery" && <p>格式：{formats[request?.format] ?? "ZIP 作品包"}；{files.length} 个文件。</p>}
      {kind === "delivery" && (
        <section aria-label="所选文稿">
          <h3>所选文稿</h3>
          <ol>{(fixed?.selected_documents ?? fixed?.provenance ?? []).map((item: any) =>
            <li key={item.document_ref.document_id}>{item.title}</li>,
          )}</ol>
        </section>
      )}
      {notes.length > 0 && (
        <section aria-label="转换与交付说明">
          <h3>范围与转换说明</h3>
          <ul>{notes.map((note, i) => <li key={i}>{note}</li>)}</ul>
        </section>
      )}
      {texts.map((text, i) => (
        <article className="reader" key={i} aria-label={`导入正文 ${i + 1}`}>
          <h3>{text.title}</h3>
          <pre>{text.content}</pre>
        </article>
      ))}
      {!!files.length && (
        <details>
          <summary>交付文件清单（{files.length}）</summary>
        <table className="delivery-files">
          <thead><tr><th>文件</th><th>字节数</th></tr></thead>
          <tbody>{files.map((file: any) => <tr key={file.path}><td>{file.path}</td><td>{file.size_bytes.toLocaleString()}</td></tr>)}</tbody>
        </table>
        </details>
      )}
      {view.state === "executed" && view.result?.path && (
        <section aria-label="实际交付结果">
          <h3>交付文件已生成</h3>
          <p>作品目录内的位置：<code>{view.result.path}</code></p>
          <details><summary>交付文件摘要</summary><p>SHA-256：<code>{view.result.sha256}</code></p></details>
          {view.action === "hetu.bundles.export" && (
            <button disabled={busy} onClick={() => {
              setBusy(true);
              setError("");
              void desktop.management("verify", {
                proposal_id: view.proposal_id,
                proposal_sha256: view.proposal_sha256,
              }).then((result) => setVerified(data(result)))
                .catch((e) => setError(e.message)).finally(() => setBusy(false));
            }}>核验实际交付包</button>
          )}
          {verified && <p role="status">{verified.verified ? "实际文件完整性核验通过。" : "未取得完整性核验结果。"} 该结果不代表内容认可或版权证明。</p>}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <details>
        <summary>固定来源与完整方案</summary>
        <pre>{JSON.stringify({ action: view.action, input, preview: view.preview, result: view.result }, null, 2)}</pre>
      </details>
    </section>
  );
}
