import React from "react";
import { mountPlugin } from "../../shared/workbench.tsx";
mountPlugin({
  title: "故事时间线",
  kind: "timeline",
  initial: { events: [] },
  add: (content, label) => ({
    events: [
      ...content.events,
      {
        id: crypto.randomUUID(),
        title: label,
        time: "待定位",
        description: "",
      },
    ],
  }),
  render: (content) => (
    <ol
      aria-label="故事时间线"
      style={{
        listStyle: "none",
        padding: 0,
        borderLeft: ".5px solid var(--line)",
        marginLeft: 16,
      }}
    >
      {content.events.map((event: any) => (
        <li
          key={event.id}
          style={{ position: "relative", padding: "12px 28px 28px" }}
        >
          <span
            style={{
              position: "absolute",
              left: -6,
              top: 20,
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "var(--sage-8)",
            }}
          />
          <small style={{ color: "var(--muted)" }}>{event.time}</small>
          <h3 style={{ margin: "5px 0", fontWeight: 500 }}>{event.title}</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{event.description}</p>
        </li>
      ))}
    </ol>
  ),
});
