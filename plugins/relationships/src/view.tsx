import React from "react";
import { mountPlugin } from "../../shared/workbench.tsx";
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
  render: (content) => (
    <>
      <svg
        aria-label="人物关系图"
        role="img"
        viewBox="0 0 1100 650"
        style={{
          width: "100%",
          minHeight: 420,
          border: ".5px solid var(--line)",
          borderRadius: 6,
        }}
      >
        {content.edges.map((edge: any, index: number) => {
          const from = content.nodes.find(
              (node: any) => node.id === edge.source,
            ),
            to = content.nodes.find((node: any) => node.id === edge.target);
          return from && to ? (
            <g key={index}>
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="var(--sage-8)"
              />
              <text
                x={(from.x + to.x) / 2}
                y={(from.y + to.y) / 2 - 8}
                textAnchor="middle"
                fill="var(--muted)"
                fontSize={12}
              >
                {edge.label}
              </text>
            </g>
          ) : null;
        })}
        {content.nodes.map((node: any) => (
          <g
            key={node.id}
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
              {node.label}
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
  ),
});
