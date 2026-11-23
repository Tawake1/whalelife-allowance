import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context, ToolSession } from "whalelife";
import {
  availableCents,
  decide,
  deposit,
  formatYuan,
  LIMITS,
  propose,
  summary,
  updateSettings,
  WalletError,
  withdraw,
  type Order,
} from "./src/ledger.ts";
import { WalletStore } from "./src/store.ts";
import { APP_JS, PAGE_HTML } from "./src/page.ts";

const BASE = "/plugins/allowance/";
const ORIGIN = { platform: "零花钱" } as const;
const MAX_BODY = 16 * 1024;

const newId = () => randomUUID();

function errorText(error: unknown): string {
  if (error instanceof WalletError) return error.message;
  return "零花钱插件内部错误，请查看日志";
}

function sourceOf(session: ToolSession): string | null {
  const parts = [session.origin?.platform, session.channel].filter((p): p is string => typeof p === "string" && !!p);
  return parts.length ? [...new Set(parts)].join(" / ").slice(0, 60) : null;
}

export function apply(ctx: Context) {
  const store = new WalletStore(ctx.config);

  const fail = (error: unknown) => {
    if (!(error instanceof WalletError)) ctx.logger.error("零花钱操作失败", error);
    return { ok: false, error: errorText(error) };
  };

  // ── 角色可用的工具：只能查看、提交、撤回，没有任何付款或批准入口 ──

  ctx.tools.register({
    name: "allowance_wallet",
    danger: "safe",
    origin: { ...ORIGIN, action: "查看零花钱" },
    description:
      "查看你自己的零花钱：余额、可用余额（扣除待审批购物单后）、等待用户决定的购物单、最近的审批结果和提交限制。" +
      "零花钱由用户发放，花在哪里由你自己决定；但真正付款要用户同意并亲自完成。",
    schema: { type: "object", additionalProperties: false, properties: {} },
    run: async () => {
      try {
        return { ok: true, ...summary(await store.read()) };
      } catch (error) {
        return fail(error);
      }
    },
  });

  ctx.tools.register({
    name: "allowance_propose",
    danger: "safe",
    origin: { ...ORIGIN, action: "提交购物单" },
    description:
      "用自己的零花钱提出想买的东西。平台、商品和理由都由你自己决定。提交后只是一张等待用户决定的购物单，" +
      "不代表已经购买，也不会自动付款；在用户同意之前不要说已经买到了。" +
      "同一次提交重试时沿用同一个 requestId。价格以人民币元为单位。",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "item", "platform", "price", "reason"],
      properties: {
        requestId: { type: "string", maxLength: LIMITS.requestId, description: "这次提交的稳定 ID，重试时保持不变" },
        item: { type: "string", maxLength: LIMITS.item, description: "想买的商品或服务名称" },
        platform: { type: "string", maxLength: LIMITS.platform, description: "在哪个平台或店铺买，例如 淘宝、京东、B站" },
        price: { type: "number", exclusiveMinimum: 0, description: "价格（元），最多两位小数" },
        url: { type: "string", maxLength: LIMITS.url, description: "可选，商品页面的 http/https 链接" },
        reason: { type: "string", maxLength: LIMITS.reason, description: "你为什么想买它" },
      },
    },
    run: async (args: Record<string, unknown>, session) => {
      try {
        const result = await store.update((state) => {
          const r = propose(state, args as never, {
            now: new Date(),
            newId,
            sessionId: typeof session.id === "string" ? session.id : null,
            source: sourceOf(session),
          });
          return { state: r.state, result: { order: r.order, duplicate: r.duplicate, available: availableCents(r.state) } };
        });
        const { order } = result;
        return {
          ok: true,
          duplicate: result.duplicate,
          orderId: order.id,
          status: order.status,
          message: `购物单「${order.item}」（${formatYuan(order.priceCents)}）已提交，正在等用户决定，还没有购买。`,
          available: formatYuan(result.available),
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  ctx.tools.register({
    name: "allowance_withdraw",
    danger: "safe",
    origin: { ...ORIGIN, action: "撤回购物单" },
    description: "撤回一张自己提交、用户还没处理的购物单，例如改主意了或找到了更合适的。orderId 来自 allowance_wallet。",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["orderId"],
      properties: {
        orderId: { type: "string", description: "要撤回的购物单编号" },
        reason: { type: "string", maxLength: LIMITS.note, description: "可选，撤回原因" },
      },
    },
    run: async (args: Record<string, unknown>) => {
      try {
        const order = await store.update((state) => {
          const r = withdraw(state, args.orderId, args.reason, new Date());
          return { state: r.state, result: r.order };
        });
        return { ok: true, orderId: order.id, status: order.status, message: `已撤回购物单「${order.item}」。` };
      } catch (error) {
        return fail(error);
      }
    },
  });

  // ── 把用户的决定记进她的经历，下次聊天时她会知道结果 ──

  async function remember(sessionId: string | null, eventId: string, outcome: "succeeded" | "denied", text: string, at: string) {
    if (!sessionId) return;
    try {
      await ctx.memory.recordExperience(sessionId, {
        event_id: eventId,
        outcome,
        text: [...text].slice(0, 500).join(""),
        occurred_at: at,
        origin: { ...ORIGIN, action: "用户处理零花钱" },
      });
    } catch (error) {
      ctx.logger.warn("零花钱结果未能写入经历", error instanceof Error ? error.message : error);
    }
  }

  function decisionText(order: Order, balanceCents: number): string {
    const head = `「${order.item}」（${order.platform}，${formatYuan(order.priceCents)}）`;
    const note = order.note ? `用户附言：${order.note}` : "";
    return order.status === "approved"
      ? `用户同意了你的购物单${head}，并已亲自付款。零花钱余额 ${formatYuan(balanceCents)}。${note}`
      : `用户没有同意你的购物单${head}，没有购买。${note}`;
  }

  async function currentSession(): Promise<string | null> {
    try {
      return typeof ctx.sessions?.current === "function" ? await ctx.sessions.current() : null;
    } catch {
      return null;
    }
  }

  // ── 控制台页面（用户本人使用，继承控制台登录） ──

  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.statusCode = status;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

  async function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new WalletError("请求过大");
      chunks.push(chunk as Buffer);
    }
    signal.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw new WalletError("请求格式无效");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WalletError("请求格式无效");
    return parsed as Record<string, unknown>;
  }

  ctx.web.page(
    BASE + "home",
    (_req, res) => send(res, 200, "text/html; charset=utf-8", PAGE_HTML),
    { title: "零花钱", settings: true, navigation: true },
  );
  ctx.web.page(BASE + "app.js", (_req, res) => send(res, 200, "text/javascript; charset=utf-8", APP_JS));

  ctx.web.api(BASE + "api", async (req, res, { signal }) => {
    if (req.method !== "POST") return json(res, 405, { error: "只接受 POST" });
    try {
      const input = await readBody(req, signal);
      const now = new Date();
      switch (input.action) {
        case "read":
          break;
        case "approve":
        case "reject": {
          const decision = input.action;
          const { order, balanceCents } = await store.update((state) => {
            const r = decide(state, input.orderId, decision, input.note, now, newId);
            return { state: r.state, result: { order: r.order, balanceCents: r.state.balanceCents } };
          });
          await remember(
            order.sessionId,
            `allowance:${order.id}:${order.status}`,
            order.status === "approved" ? "succeeded" : "denied",
            decisionText(order, balanceCents),
            order.decidedAt ?? now.toISOString(),
          );
          break;
        }
        case "deposit": {
          const entry = await store.update((state) => {
            const r = deposit(state, input.amount, input.note, now, newId);
            return { state: r.state, result: r.entry };
          });
          await remember(
            await currentSession(),
            `allowance:deposit:${entry.id}`,
            "succeeded",
            `用户给你发了 ${formatYuan(entry.amountCents)} 零花钱（${entry.note}），现在余额 ${formatYuan(entry.balanceCents)}。`,
            entry.at,
          );
          break;
        }
        case "settings":
          await store.update((state) => ({ state: updateSettings(state, input), result: null }));
          break;
        default:
          throw new WalletError("操作无效");
      }
      const state = await store.read();
      json(res, 200, { state, available: availableCents(state) });
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof WalletError)) ctx.logger.error("零花钱页面请求失败", error);
      json(res, error instanceof WalletError ? 400 : 500, { error: errorText(error) });
    }
  });

  ctx.logger.info("零花钱插件已加载");
}
