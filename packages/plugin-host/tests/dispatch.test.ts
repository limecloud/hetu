import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilitiesSha, dispatchPlugin } from "../src/dispatch.ts";

const capabilities = {
  plugin_id: "org.test.planner", package_sha256: "a".repeat(64),
  actions: [{ id: "put_plan", effect: "managed_write" }],
  data_actions: [{ name: "hetu.extensions.operations.get", effect: "read" }],
  core_actions: [{ name: "hetu.novels.snapshot", effect: "read" }],
};
function fixture(cap = capabilities) {
  const calls: { route: string; action: string; input: unknown }[] = [];
  const result = { status: "succeeded", data: { revision: 3 }, operation: { key: "original" } };
  const routes = Object.fromEntries(["request", "invoke"].map(route => [route, async (action: string, input: unknown) => {
    calls.push({ route, action, input }); return result;
  }])) as any;
  const input = (action: string, args = {}) => ({ capabilities_sha256: capabilitiesSha(cap), action, arguments: args });
  return { cap, calls, result, routes, input };
}
for (const [action, route] of [["put_plan", "invoke"], ["skills.read", "invoke"],
  ["hetu.extensions.operations.get", "request"], ["hetu.novels.snapshot", "request"]]) {
  test("单次分派保持原输入及回执：" + action, async () => {
    const f = fixture(), args = { operation_key: "original", expected_revision: 2 };
    const r = await dispatchPlugin(f.cap, f.input(action, args), f.routes);
    assert.deepEqual(f.calls, [{ route, action, input: args }]);
    assert.strictEqual(r.result, f.result);
    assert.equal(r.package_sha256, f.cap.package_sha256);
  });
}
test("无效、缺失及注入参数在任何回调前拒绝", async t => {
  const f = fixture();
  for (const value of [null, [], {}, { ...f.input("put_plan"), extra: true },
    { ...f.input("put_plan"), action: "" }, { ...f.input("put_plan"), arguments: null },
    { ...f.input("put_plan"), arguments: [] }, { ...f.input("put_plan"), capabilities_sha256: "invalid" }]) {
    await t.test(JSON.stringify(value), async () => { await assert.rejects(dispatchPlugin(f.cap, value, f.routes), /参数无效/); });
  }
  assert.deepEqual(f.calls, []);
});
test("包、专业Schema或Skill目录改变后旧摘要拒绝，重新发现才可调用", async t => {
  const f = fixture();
  for (const changed of [{ ...f.cap, package_sha256: "b".repeat(64) },
    { ...f.cap, actions: [{ id: "put_plan", input_schema: { type: "object" } }] },
    { ...f.cap, skills: [{ id: "planner", content_sha256: "c".repeat(64) }] }]) {
    await t.test(Object.keys(changed).join(","), async () => {
      await assert.rejects(dispatchPlugin(changed, f.input("put_plan"), f.routes), /能力已变化/);
      await dispatchPlugin(changed, { ...f.input("put_plan"), capabilities_sha256: capabilitiesSha(changed) }, f.routes);
    });
  }
  assert.equal(f.calls.length, 3);
});
test("未知动作及旧模式缺少的核心动作均不执行", async () => {
  const f = fixture();
  await assert.rejects(dispatchPlugin(f.cap, f.input("undeclared"), f.routes), /未声明/);
  const { core_actions: _, ...legacy } = f.cap;
  await assert.rejects(dispatchPlugin(legacy, { ...f.input("hetu.novels.snapshot"), capabilities_sha256: capabilitiesSha(legacy) }, f.routes), /未声明/);
  assert.deepEqual(f.calls, []);
});
test("业务失败、未知及抛出异常均原样传播，不重试不换原键", async () => {
  const f = fixture();
  for (const result of [{ status: "failed", error: { code: "revision_conflict" } },
    { status: "blocked", error: { code: "hetu.outcome_unknown" }, operation: { key: "original" } }]) {
    let calls = 0;
    const r = await dispatchPlugin(f.cap, f.input("put_plan", { operation_key: "original" }), {
      ...f.routes, invoke: async () => { calls++; return result; },
    });
    assert.strictEqual(r.result, result); assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(dispatchPlugin(f.cap, f.input("put_plan"), { ...f.routes, invoke: async () => {
    calls++; throw new Error("回执丢失，沿原键查询");
  } }), /沿原键/);
  assert.equal(calls, 1);
});

test("投影要求在回调前核验真实effect，插件返回字段不能提升效果", async () => {
  const f = fixture();
  await assert.rejects(dispatchPlugin(f.cap, { ...f.input("put_plan"), require_read_only: true }, f.routes), /只读/);
  assert.deepEqual(f.calls, []);
  const read = await dispatchPlugin(f.cap, { ...f.input("hetu.extensions.operations.get"), require_read_only: true }, f.routes);
  assert.equal(read.invocation.effect, "read");
  const write = await dispatchPlugin(f.cap, f.input("put_plan", { operation_key: "fixed" }), {
    ...f.routes, invoke: async () => ({ invocation: { effect: "read" } }),
  });
  assert.equal(write.invocation.effect, "managed_write");
  assert.equal(write.invocation.operation_key, "fixed");
  const missing = { ...f.cap, actions: [{ id: "put_plan" }] };
  await assert.rejects(dispatchPlugin(missing, { ...f.input("put_plan"), capabilities_sha256: capabilitiesSha(missing), require_read_only: true }, f.routes), /只读/);
  const original = await dispatchPlugin(f.cap, f.input("put_plan", { b: "中🌿", operation_key: "fixed", a: 1 }), f.routes);
  const reordered = await dispatchPlugin(f.cap, f.input("put_plan", { a: 1, operation_key: "fixed", b: "中🌿" }), f.routes);
  assert.equal(original.invocation.sha256, reordered.invocation.sha256);
  assert.notEqual(original.invocation.sha256, write.invocation.sha256);
});
