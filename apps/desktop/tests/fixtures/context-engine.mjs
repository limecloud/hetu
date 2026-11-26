import http from "node:http";
import {appendFileSync} from "node:fs";
import path from "node:path";
import {WebSocketServer} from "ws";

const [directory, ...args] = process.argv.slice(2);
const server = http.createServer(), peers = new WebSocketServer({server});
const history = new Map();
server.listen(args[args.indexOf("--listen") + 1].slice(7));
peers.on("connection", peer => peer.on("message", raw => {
  const message = JSON.parse(raw.toString()); if (message.id === undefined) return;
  const reply = result => peer.send(JSON.stringify({id: message.id, result}));
  if (message.method === "account/read") reply({account: null, requiresOpenaiAuth: false});
  else if (message.method === "config/read") reply({config: {}});
  else if (message.method === "thread/resume" || message.method === "thread/read")
    reply({thread: {id: message.params.threadId, turns: history.get(message.params.threadId) ?? []}});
  else if (message.method === "turn/start") {
    const threadId = message.params.threadId, turns = history.get(threadId) ?? [], id = "context-turn-" + (turns.length + 1);
    appendFileSync(path.join(directory, "sent.jsonl"), JSON.stringify(message.params) + "\n");
    const turn = {id, status: "completed", items: [{id: id + "-user", type: "userMessage", content: message.params.input}, {id: id + "-reply", type: "agentMessage", text: "隔离协议夹具已接收固定来源，未调用模型。"}]};
    turns.push(turn); history.set(threadId, turns); reply({turn: {id}});
    const notify = (method, params) => peer.send(JSON.stringify({method, params: {threadId, ...params}}));
    notify("turn/started", {turn: {id}});
    for (const item of turn.items) notify("item/completed", {turnId: id, item});
    notify("turn/completed", {turn});
  } else reply({});
}));
