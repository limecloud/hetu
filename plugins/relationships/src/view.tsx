import React from "react";
import { mountPlugin } from "../../shared/workbench.tsx";
import {labelLines,relationshipGeometry} from "./geometry.mts";
mountPlugin({
  title: "人物关系图",
  kind: "relationships",
  initial: { nodes: [], edges: [] },
  arrange: true,
  add: (content, label) => ({
    ...content,
    nodes: [
      ...content.nodes,
      {
        id: crypto.randomUUID(),
        label,
        x: 120 + (content.nodes.length % 4) * 210,
        y: 90 + Math.floor(content.nodes.length / 4) * 140,
      },
    ],
  }),
  render: (content) => {
    const geometry=relationshipGeometry(content);
    return (
    <>
      <svg
        aria-label="人物关系图"
        role="img"
        viewBox={geometry.viewBox}
        style={{
          width: "100%",
          minHeight: 420,
          border: ".5px solid var(--line)",
          borderRadius: 6,
        }}
      >
        <g aria-hidden="true">{geometry.edges.map((edge,index)=><path key={index} d={edge.path} fill="none" stroke="var(--sage-8)" strokeWidth={0.5} vectorEffect="non-scaling-stroke"/>)}</g>
        {geometry.edges.map((edge, index) => (
            <g key={index} data-relationship-label>
              <rect aria-hidden="true" x={edge.position.x-92} y={edge.position.y-edge.lines.length*8-4} width={184} height={edge.lines.length*16+8} fill="var(--page)"/>
              <text
                x={edge.position.x}
                y={edge.position.y-(edge.lines.length-1)*8}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="var(--muted)"
                fontSize={12}
              >
                <title>{edge.label}</title>
                {edge.lines.map((line,index)=><tspan key={index} x={edge.position.x} dy={index?16:0}>{line}</tspan>)}
              </text>
            </g>
        ))}
        {content.nodes.map((node: any) => (
          <g
            key={node.id}
            data-relationship-node
            transform={"translate(" + node.x + "," + node.y + ")"}
          >
            <rect
              x={-70}
              y={-25}
              width={140}
              height={50}
              rx={6}
              fill="var(--jade-soft)"
              stroke="var(--jade-7)" strokeWidth={0.5}
            />
            <text
              textAnchor="middle"
              dominantBaseline="middle"
              fill="var(--jade)"
              fontSize={14}
            >
              <title>{node.label}</title>
              {labelLines(node.label,8).map((line,index,lines)=><tspan key={index} x={0} dy={index?16:-(lines.length-1)*8}>{line}</tspan>)}
            </text>
          </g>
        ))}
      </svg>
      <details>
        <summary>可访问的人物与关系列表</summary>
        <ul>
          {content.nodes.map((n: any) => (
            <li key={n.id}>{n.label}</li>
          ))}
        </ul>
        <ul>
          {content.edges.map((e: any, i: number) => (
            <li key={i}>
              {content.nodes.find((n: any) => n.id === e.source)?.label} —{" "}
              {e.label} —{" "}
              {content.nodes.find((n: any) => n.id === e.target)?.label}
            </li>
          ))}
        </ul>
      </details>
    </>
  );},
});
