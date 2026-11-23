/**
 * 控制台审批页。页面里所有用户/角色提供的文字都经 textContent 写入，不拼接 HTML。
 */

const BASE = "/plugins/allowance/";

export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>零花钱</title>
<style>
  :root { --bg:#fff; --fg:#202332; --muted:#6b7080; --line:#e3e5ec; --card:#f7f8fb; --accent:#6356df; --ok:#1f8a4c; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#17181d; --fg:#e6e7ec; --muted:#9a9fb0; --line:#2c2e37; --card:#1f2027; --accent:#8d84f0; --ok:#4cc47f; --bad:#e8705f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg); font:15px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif; }
  main { max-width:760px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:17px; margin:28px 0 10px; }
  .muted { color:var(--muted); font-size:13px; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; margin:16px 0; }
  .stat { flex:1 1 160px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .stat b { display:block; font-size:22px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:10px; }
  .card .title { font-weight:600; overflow-wrap:anywhere; }
  .card .price { float:right; font-weight:600; margin-left:12px; }
  .card .reason { margin:6px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
  .card a { color:var(--accent); overflow-wrap:anywhere; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px; }
  input, button { font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
  input[type=text] { flex:1 1 200px; min-width:0; }
  input[type=number] { width:120px; }
  button { cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.ok { background:var(--ok); border-color:var(--ok); color:#fff; }
  button.bad { color:var(--bad); }
  button:disabled { opacity:.5; cursor:default; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  td, th { text-align:left; padding:6px 4px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.num { text-align:right; white-space:nowrap; }
  .status-approved { color:var(--ok); } .status-rejected { color:var(--bad); } .status-withdrawn { color:var(--muted); }
  #notice { min-height:1.6em; margin:8px 0; } #notice.error { color:var(--bad); }
  form.grid { display:grid; gap:10px; max-width:420px; }
  form.grid label { display:flex; justify-content:space-between; align-items:center; gap:12px; }
</style>
</head>
<body>
<main>
  <h1>零花钱</h1>
  <p class="muted">她自己挑、自己提购物单；买不买由你决定，付款也由你亲自完成。插件本身不会付款。</p>
  <div class="stats">
    <div class="stat"><span class="muted">余额</span><b id="balance">—</b></div>
    <div class="stat"><span class="muted">可用（扣除待审批）</span><b id="available">—</b></div>
  </div>
  <div id="notice" role="status"></div>

  <h2>等你决定的购物单</h2>
  <div id="pending"><p class="muted">加载中…</p></div>

  <h2>发零花钱</h2>
  <form id="deposit" class="row">
    <input id="depositAmount" type="number" min="0.01" step="0.01" placeholder="金额（元）" required>
    <input id="depositNote" type="text" maxlength="200" placeholder="备注（可选）">
    <button class="primary" type="submit">发放</button>
  </form>

  <h2>最近的购物单</h2>
  <table><thead><tr><th>商品</th><th>状态</th><th class="num">价格</th></tr></thead><tbody id="history"></tbody></table>

  <h2>账本</h2>
  <table><thead><tr><th>时间</th><th>说明</th><th class="num">金额</th><th class="num">余额</th></tr></thead><tbody id="ledger"></tbody></table>

  <h2>限制</h2>
  <form id="settings" class="grid">
    <label>单张购物单上限（元）<input id="maxPrice" type="number" min="0.01" step="0.01" required></label>
    <label>同时待审批最多几张<input id="maxPending" type="number" min="1" max="50" step="1" required></label>
    <label>24 小时内最多提交几张<input id="dailyProposals" type="number" min="1" max="100" step="1" required></label>
    <label>可用余额不够时仍可提交<input id="allowOverBudget" type="checkbox"></label>
    <div><button class="primary" type="submit">保存限制</button></div>
  </form>
</main>
<script src="${BASE}app.js"></script>
</body>
</html>`;

export const APP_JS = `(() => {
  const API = ${JSON.stringify(BASE + "api")};
  const $ = (id) => document.getElementById(id);
  const yuan = (c) => (c < 0 ? "-" : "") + "¥" + Math.floor(Math.abs(c) / 100) + "." + String(Math.abs(c) % 100).padStart(2, "0");
  const time = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(); };
  const STATUS = { pending: "待审批", approved: "已同意", rejected: "未同意", withdrawn: "她撤回了" };
  const el = (tag, props, ...kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); for (const k of kids) n.append(k); return n; };

  function notice(text, error) { const n = $("notice"); n.textContent = text || ""; n.className = error ? "error" : ""; }

  async function call(body) {
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let v = {}; try { v = await r.json(); } catch {}
    if (!r.ok) throw new Error(v.error || "请求失败");
    render(v);
    return v;
  }

  function pendingCard(o) {
    const note = el("input", { type: "text", maxLength: 200, placeholder: "附言（可选，她会看到）" });
    const approve = el("button", { className: "ok", type: "button", textContent: "同意（我已付款）" });
    const reject = el("button", { className: "bad", type: "button", textContent: "不同意" });
    let armed = false;
    const act = (action) => async () => {
      // 控制台以 iframe 展示页面，可能不允许 confirm()，所以用“再点一次”确认。
      if (action === "approve" && !armed) {
        armed = true;
        approve.textContent = "再点一次：确认已付 " + yuan(o.priceCents);
        setTimeout(() => { armed = false; approve.textContent = "同意（我已付款）"; }, 6000);
        return;
      }
      approve.disabled = reject.disabled = true;
      try { await call({ action, orderId: o.id, note: note.value }); notice(action === "approve" ? "已记账，她会知道你同意了。" : "已拒绝，她会知道结果。"); }
      catch (e) { notice(e.message, true); approve.disabled = reject.disabled = false; }
    };
    approve.onclick = act("approve"); reject.onclick = act("reject");
    const card = el("div", { className: "card" },
      el("span", { className: "price", textContent: yuan(o.priceCents) }),
      el("div", { className: "title", textContent: o.platform + " · " + o.item }),
      el("div", { className: "reason", textContent: "她的理由：" + o.reason }));
    if (o.url) card.append(el("div", {}, el("a", { href: o.url, target: "_blank", rel: "noopener noreferrer", textContent: o.url })));
    card.append(el("div", { className: "muted", textContent: "提交于 " + time(o.createdAt) + (o.source ? " · 来源 " + o.source : "") }));
    card.append(el("div", { className: "row" }, note, approve, reject));
    return card;
  }

  function render(v) {
    const s = v.state;
    $("balance").textContent = yuan(s.balanceCents);
    $("available").textContent = yuan(v.available);
    const pending = s.orders.filter((o) => o.status === "pending");
    const box = $("pending"); box.replaceChildren();
    if (!pending.length) box.append(el("p", { className: "muted", textContent: "暂时没有。" }));
    for (const o of pending) box.append(pendingCard(o));

    const history = $("history"); history.replaceChildren();
    for (const o of s.orders.filter((o) => o.status !== "pending").slice(-20).reverse()) {
      const label = STATUS[o.status] + (o.note ? "：" + o.note : "");
      history.append(el("tr", {}, el("td", { textContent: o.platform + " · " + o.item }),
        el("td", { className: "status-" + o.status, textContent: label }), el("td", { className: "num", textContent: yuan(o.priceCents) })));
    }
    const ledger = $("ledger"); ledger.replaceChildren();
    for (const e of s.ledger.slice(-30).reverse()) {
      ledger.append(el("tr", {}, el("td", { textContent: time(e.at) }), el("td", { textContent: e.note }),
        el("td", { className: "num", textContent: (e.amountCents > 0 ? "+" : "") + yuan(e.amountCents) }), el("td", { className: "num", textContent: yuan(e.balanceCents) })));
    }
    if (!document.activeElement || !$("settings").contains(document.activeElement)) {
      $("maxPrice").value = (s.settings.maxPriceCents / 100).toFixed(2);
      $("maxPending").value = s.settings.maxPending;
      $("dailyProposals").value = s.settings.dailyProposals;
      $("allowOverBudget").checked = s.settings.allowOverBudget;
    }
  }

  $("deposit").onsubmit = async (e) => {
    e.preventDefault();
    try { await call({ action: "deposit", amount: $("depositAmount").value, note: $("depositNote").value }); $("depositAmount").value = ""; $("depositNote").value = ""; notice("已发放。"); }
    catch (err) { notice(err.message, true); }
  };
  $("settings").onsubmit = async (e) => {
    e.preventDefault();
    try { await call({ action: "settings", maxPrice: $("maxPrice").value, maxPending: $("maxPending").value, dailyProposals: $("dailyProposals").value, allowOverBudget: $("allowOverBudget").checked }); notice("限制已保存。"); }
    catch (err) { notice(err.message, true); }
  };

  const refresh = () => call({ action: "read" }).catch((e) => notice(e.message, true));
  refresh();
  setInterval(() => {
    const busy = document.querySelector(".card input:focus") || [...document.querySelectorAll(".card input")].some((i) => i.value) ||
      [...document.querySelectorAll(".card button")].some((b) => b.disabled || b.textContent.startsWith("再点一次"));
    if (!document.hidden && !busy) refresh();
  }, 15000);
})();`;
