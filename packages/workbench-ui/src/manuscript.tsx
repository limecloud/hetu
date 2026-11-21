import React, { forwardRef, useMemo } from "react";
import {manuscriptLines} from "./manuscript-lines.ts";
import {manuscriptFormat} from "./manuscript-format.ts";
import {presentationStyle} from "./manuscript-styles.ts";
import {childGroups, manuscriptGroups, type ManuscriptGroup} from "./manuscript-groups.ts";
import type {FormattedLine} from "./manuscript-format.ts";
import {manuscriptLayoutEvent} from "./annotation-anchors.ts";
import {editingText} from "./editing-labels.ts";
import {styleCardPreview} from "./card-preview.ts";

/** 同一文稿阅读表现；选区和交接由宿主提供，组件不保存作者内容。 */
export const ManuscriptText = forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & {text:string;novel?:boolean;format?:"markdown"|"plain";title?:string}>(({text,novel,format="plain",title,className="",...props},ref) => {
  const language = props.lang ?? (typeof document === "undefined" ? "zh-CN" : document.documentElement.lang);
  const t = (key: Parameters<typeof editingText>[0]) => editingText(key, language);
  const formatted = useMemo(() => format === "markdown" ? manuscriptFormat(text, title) : undefined, [text, format, title]);
  const lines = useMemo(() => {
    const renderLine = (line: FormattedLine) => <span key={line.from}
    className={"manuscript-line manuscript-" + line.kind + (line.marker ? " manuscript-list" : "")} data-prose={line.kind === "prose" && !line.marker || undefined}
    data-manuscript-block={line.attributes?.block} style={line.attributes ? presentationStyle(line.attributes) : undefined}
    role={line.kind === "heading" ? "heading" : line.kind === "rule" ? "separator" : undefined} aria-level={line.kind === "heading" ? Math.min(7, (line.level ?? 1) + 1) : undefined}>
    {line.marker && <span className="manuscript-list-marker" aria-hidden="true">{line.marker}</span>}{line.runs.map(run => <span key={run.from} data-source-from={run.from} data-source-to={run.to} style={run.attributes ? presentationStyle(run.attributes) : undefined} className={run.styles.map(style => "manuscript-" + style).join(" ") || undefined}>{text.slice(run.from, run.to)}</span>)}
  </span>;
    if (formatted) {
      const groups = manuscriptGroups(text, formatted);
      const render = (parent?: ManuscriptGroup): React.ReactNode[] => {
        const children = childGroups(groups, parent), result: React.ReactNode[] = [];
        let until = -1;
        for (const line of formatted.lines) {
          if (line.from < until || parent && (line.from < parent.contentFrom || line.to > parent.contentTo || line.from === parent.titleLine?.from)) continue;
          const group = children.find(group => group.opening.from >= line.from && group.opening.from <= line.to);
          if (group) {
            result.push(<details key={group.from} className={"manuscript-group manuscript-group-" + group.kind} data-group-from={group.from} data-group-to={group.to}
              onToggle={event => {
                const element = event.currentTarget, stage = element.closest<HTMLElement>(".manuscript-stage, .manuscript-reading-scroll");
                if (element.open && !element.dataset.programmatic) { element.dataset.returnTop = String(stage?.scrollTop ?? 0); if (stage) stage.scrollTop += element.getBoundingClientRect().top - stage.getBoundingClientRect().top - 20; }
                delete element.dataset.programmatic;
                element.dispatchEvent(new Event(manuscriptLayoutEvent, {bubbles: true}));
              }}>
              <summary ref={element => {if (element && group.kind === "card") styleCardPreview(element, group);}} onClick={event => {if (event.detail > 1) event.preventDefault();}} onDoubleClick={event => event.stopPropagation()}><span className="manuscript-group-icon" aria-hidden="true">▤</span><span className="manuscript-group-description">
                {group.titleLine ? renderLine(group.titleLine) : <span className="manuscript-line">{t("editing.untitled_page")}</span>}
                <span className="manuscript-group-preview">{group.preview || t("editing.empty_page")}</span>
              </span></summary>
              <button type="button" className="manuscript-group-back" aria-label={t("editing.back_to_parent")} onClick={event => {
                const element = event.currentTarget.closest<HTMLDetailsElement>("details")!, stage = element.closest<HTMLElement>(".manuscript-stage, .manuscript-reading-scroll");
                element.open = false; if (stage) stage.scrollTop = Number(element.dataset.returnTop ?? 0); element.querySelector("summary")?.focus({preventScroll: true});
              }}>← {t("editing.back_to_parent")}</button>
              <div className="manuscript-level">{render(group)}</div>
            </details>);
            until = group.to;
          } else if (!line.hidden) result.push(renderLine(line));
        }
        return result;
      };
      return <div className="manuscript-level">{render()}</div>;
    }
    return manuscriptLines(text).map(line => <React.Fragment key={line.from}>
    <span className="manuscript-line" data-prose={line.prose || undefined} data-source-from={line.from} data-source-to={line.to}>{text.slice(line.from, line.to)}</span>
    {line.breakTo > line.to && <span className="manuscript-break" aria-hidden="true" data-source-from={line.to} data-source-to={line.breakTo}>{text.slice(line.to, line.breakTo)}</span>}
  </React.Fragment>);
  }, [text, formatted, language]);
  return <article {...props} ref={ref} className={"reader"+(novel?" novel-reader":"")+(className?" "+className:"")}>{lines}</article>;
});
