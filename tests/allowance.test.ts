import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  decide,
  deposit,
  emptyState,
  formatYuan,
  loadState,
  parseYuan,
  propose,
  updateSettings,
  WalletError,
  withdraw,
  type WalletState,
} from "../src/ledger.ts";
import { apply } from "../index.ts";

let seq = 0;
const newId = () => `id-${++seq}`;
const now = new Date("2026-11-23T12:00:00Z");

function funded(cents = 10000): WalletState {
  return deposit(emptyState(), cents / 100, "测试", now, newId).state;
}
const goodInput = (over: Record<string, unknown> = {}) => ({
  requestId: "r1", item: "小熊挂件", platform: "淘宝", price: 12.5, reason: "很可爱", ...over,
});

test("金额换算精确到分", () => {
  assert.equal(parseYuan(12.5), 1250);
  assert.equal(parseYuan("0.01"), 1);
  assert.equal(parseYuan(0.1), 10);
  for (const bad of [0, -1, "1.234", "abc", null, NaN, "1e3"]) assert.throws(() => parseYuan(bad), WalletError);
  assert.equal(formatYuan(1250), "¥12.50");
  assert.equal(formatYuan(-5), "-¥0.05");
});

test("提交购物单不会动余额，只预留可用额度", () => {
  const r = propose(funded(), goodInput(), { now, newId, sessionId: "s1", source: "QQ" });
  assert.equal(r.order.status, "pending");
  assert.equal(r.state.balanceCents, 10000);
  assert.equal(r.order.sessionId, "s1");
});

test("同一 requestId 重试返回原单，内容不同则拒绝", () => {
  const first = propose(funded(), goodInput(), { now, newId });
  const again = propose(first.state, goodInput(), { now, newId });
  assert.equal(again.duplicate, true);
  assert.equal(again.order.id, first.order.id);
  assert.throws(() => propose(first.state, goodInput({ price: 99 }), { now, newId }), /requestId/);
});

test("各项限制生效", () => {
  assert.throws(() => propose(funded(), goodInput({ price: 500 }), { now, newId }), /不能超过/);
  assert.throws(() => propose(funded(1000), goodInput({ price: 20 }), { now, newId }), /不够/);
  assert.throws(() => propose(funded(), goodInput({ url: "javascript:alert(1)" }), { now, newId }), /http/);
  assert.throws(() => propose(funded(), goodInput({ reason: "" }), { now, newId }), /理由/);

  let state = updateSettings(funded(100000), { maxPrice: 100, maxPending: 2, dailyProposals: 3, allowOverBudget: false });
  state = propose(state, goodInput({ requestId: "a" }), { now, newId }).state;
  state = propose(state, goodInput({ requestId: "b" }), { now, newId }).state;
  assert.throws(() => propose(state, goodInput({ requestId: "c" }), { now, newId }), /等用户决定/);
  const id = state.orders[0].id;
  state = withdraw(state, id, "改主意", now).state;
  state = propose(state, goodInput({ requestId: "c" }), { now, newId }).state;
  state = withdraw(state, state.orders[1].id, "", now).state; // 腾出待审批名额，只剩 24 小时上限
  assert.throws(() => propose(state, goodInput({ requestId: "d" }), { now, newId }), /24 小时/);
});

test("允许超支时可以提交，但批准仍要求余额足够", () => {
  let state = updateSettings(funded(500), { maxPrice: 100, maxPending: 5, dailyProposals: 10, allowOverBudget: true });
  const r = propose(state, goodInput({ price: 20 }), { now, newId });
  assert.throws(() => decide(r.state, r.order.id, "approve", "", now, newId), /请先发零花钱/);
  state = deposit(r.state, 50, "", now, newId).state;
  const ok = decide(state, r.order.id, "approve", "", now, newId);
  assert.equal(ok.state.balanceCents, 3500);
});

test("批准扣款并记账，拒绝不扣款，处理过的单不能再处理", () => {
  const p = propose(funded(), goodInput(), { now, newId });
  const approved = decide(p.state, p.order.id, "approve", "挑得好", now, newId);
  assert.equal(approved.state.balanceCents, 10000 - 1250);
  assert.equal(approved.order.note, "挑得好");
  const last = approved.state.ledger.at(-1)!;
  assert.equal(last.amountCents, -1250);
  assert.equal(last.balanceCents, 8750);
  assert.throws(() => decide(approved.state, p.order.id, "reject", "", now, newId), /处理过/);

  const p2 = propose(funded(), goodInput(), { now, newId });
  const rejected = decide(p2.state, p2.order.id, "reject", "太贵", now, newId);
  assert.equal(rejected.state.balanceCents, 10000);
  assert.equal(rejected.order.status, "rejected");
});

test("读取磁盘数据：空对象为新钱包，坏数据报错而不清零", () => {
  assert.deepEqual(loadState({}), emptyState());
  assert.deepEqual(loadState(undefined), emptyState());
  assert.throws(() => loadState({ schema: 2 }), WalletError);
  assert.throws(() => loadState({ schema: 1, balanceCents: "100", orders: [], ledger: [] }), WalletError);
  const saved = JSON.parse(JSON.stringify(funded()));
  assert.deepEqual(loadState(saved), saved);
});

// ── 通过模拟宿主验证工具与审批页面接线 ──

function fakeHost() {
  const files = new Map<string, unknown>();
  const tools = new Map<string, any>();
  const apis = new Map<string, any>();
  const pages = new Map<string, any>();
  const experiences: any[] = [];
  const ctx: any = {
    apiVersion: "1.0.0",
    logger: { info() {}, warn() {}, error() {}, debug() {}, log() {} },
    config: {
      async read(file = "config.json") { return structuredClone(files.get(file) ?? {}); },
      async save(file: string, value: unknown) { files.set(file, structuredClone(value)); },
    },
    tools: { register(t: any) { tools.set(t.name, t); return () => tools.delete(t.name); } },
    web: {
      page(path: string, handler: any, entry?: any) { pages.set(path, { handler, entry }); return () => {}; },
      api(path: string, handler: any) { apis.set(path, handler); return () => {}; },
    },
    memory: { async recordExperience(sessionId: string, input: any) { experiences.push({ sessionId, ...input }); return {}; } },
    sessions: { async current() { return "web-session"; } },
  };
  apply(ctx);
  async function post(body: unknown) {
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = "POST";
    let out = "";
    const res: any = { statusCode: 200, setHeader() {}, end(chunk: string) { out = chunk; } };
    await apis.get("/plugins/allowance/api")(req, res, { signal: new AbortController().signal });
    return { status: res.statusCode, body: JSON.parse(out) };
  }
  return { tools, pages, files, experiences, post };
}

test("角色只拿到查看/提交/撤回三个安全级工具", () => {
  const { tools, pages } = fakeHost();
  assert.deepEqual([...tools.keys()].sort(), ["allowance_propose", "allowance_wallet", "allowance_withdraw"]);
  for (const t of tools.values()) assert.equal(t.danger, "safe");
  assert.equal(pages.get("/plugins/allowance/home").entry.navigation, true);
});

test("完整流程：发钱 → 她提交 → 你同意 → 她记得结果", async () => {
  const host = fakeHost();
  const session = { id: "chat-1", permission: "ask", channel: "qq" };

  let r = await host.post({ action: "deposit", amount: "100", note: "这周的" });
  assert.equal(r.status, 200);
  assert.equal(r.body.state.balanceCents, 10000);
  assert.equal(host.experiences.at(-1).sessionId, "web-session");

  const wallet = await host.tools.get("allowance_wallet").run({}, session);
  assert.equal(wallet.balance, "¥100.00");

  const proposed = await host.tools.get("allowance_propose").run(goodInput(), session);
  assert.equal(proposed.ok, true);
  assert.match(proposed.message, /还没有购买/);

  r = await host.post({ action: "approve", orderId: proposed.orderId, note: "给你买了" });
  assert.equal(r.status, 200);
  assert.equal(r.body.state.balanceCents, 8750);
  const exp = host.experiences.at(-1);
  assert.equal(exp.sessionId, "chat-1");
  assert.equal(exp.outcome, "succeeded");
  assert.match(exp.text, /同意.*小熊挂件.*给你买了/);

  const again = await host.post({ action: "approve", orderId: proposed.orderId });
  assert.equal(again.status, 400);
});

test("页面拒绝无效操作，错误不泄露内部信息", async () => {
  const host = fakeHost();
  const r = await host.post({ action: "pay_everything" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "操作无效");
  const tooBig = await host.tools.get("allowance_propose").run(goodInput({ price: 1 }), { permission: "full" });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /不够/);
});

test("工具与审批页同时写入不会互相覆盖", async () => {
  const host = fakeHost();
  await host.post({ action: "settings", maxPrice: "200", maxPending: 50, dailyProposals: 100, allowOverBudget: true });
  const propose = host.tools.get("allowance_propose");
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => propose.run(goodInput({ requestId: `p${i}` }), { permission: "full" })),
    host.post({ action: "deposit", amount: 5 }),
    host.post({ action: "deposit", amount: 7 }),
  ]);
  const state = (host.files.get("wallet.json") as WalletState);
  assert.equal(state.orders.length, 10);
  assert.equal(state.balanceCents, 1200);
});
