/**
 * 零花钱账本：纯数据逻辑，不访问宿主、文件或网络，方便单独测试。
 * 金额一律以“分”为整数保存，避免浮点误差。
 *
 * 安全边界：这里只有“提交 / 撤回”是给角色用的；“批准 / 拒绝 / 发零花钱 / 改设置”
 * 只由控制台页面（用户本人）调用。角色没有任何能让钱真正流出的入口。
 */

export type OrderStatus = "pending" | "approved" | "rejected" | "withdrawn";

export interface Order {
  id: string;
  requestId: string;
  item: string;
  platform: string;
  url: string | null;
  priceCents: number;
  reason: string;
  status: OrderStatus;
  createdAt: string;
  decidedAt: string | null;
  /** 用户批准/拒绝时的附言，或角色撤回时的原因。 */
  note: string | null;
  /** 提交时所在会话，用于事后把审批结果记进她的经历。 */
  sessionId: string | null;
  /** 提交来源（渠道/平台），仅供用户在审批页核对。 */
  source: string | null;
}

export interface LedgerEntry {
  id: string;
  at: string;
  kind: "deposit" | "purchase";
  /** 有符号：发零花钱为正，购买为负。 */
  amountCents: number;
  balanceCents: number;
  note: string;
  orderId?: string;
}

export interface Settings {
  /** 单张购物单的价格上限（分）。 */
  maxPriceCents: number;
  /** 同时等待审批的购物单数量上限。 */
  maxPending: number;
  /** 最近 24 小时内最多提交几张购物单（防止被刷单）。 */
  dailyProposals: number;
  /** 可用余额不足时是否仍允许提交。 */
  allowOverBudget: boolean;
}

export interface WalletState {
  schema: 1;
  balanceCents: number;
  orders: Order[];
  ledger: LedgerEntry[];
  settings: Settings;
}

export class WalletError extends Error {}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  maxPriceCents: 20000,
  maxPending: 5,
  dailyProposals: 10,
  allowOverBudget: false,
});

/** 单笔金额的绝对上限：100 万元。 */
export const MAX_AMOUNT_CENTS = 100_000_000;
const MAX_ORDERS = 200;
const MAX_LEDGER = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export const LIMITS = Object.freeze({ item: 80, platform: 40, reason: 300, note: 200, url: 2000, requestId: 100 });

export function emptyState(): WalletState {
  return { schema: 1, balanceCents: 0, orders: [], ledger: [], settings: { ...DEFAULT_SETTINGS } };
}

/** 元 → 分。接受数字或数字字符串，最多两位小数，必须为正。 */
export function parseYuan(value: unknown, label = "金额"): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new WalletError(`${label}须为正数，最多两位小数`);
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new WalletError(`${label}须大于 0`);
  if (cents > MAX_AMOUNT_CENTS) throw new WalletError(`${label}超出上限`);
  return cents;
}

export function formatYuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function text(value: unknown, label: string, max: number, required = true): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new WalletError(`缺少${label}`);
    return "";
  }
  if (typeof value !== "string") throw new WalletError(`${label}须为文字`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new WalletError(`缺少${label}`);
  if ([...trimmed].length > max) throw new WalletError(`${label}最长 ${max} 字`);
  return trimmed;
}

function httpUrl(value: unknown): string | null {
  const raw = text(value, "链接", LIMITS.url, false);
  if (!raw) return null;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new WalletError("链接格式无效"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WalletError("链接只能是 http 或 https 地址");
  return parsed.href;
}

/** 已为待审批单预留的金额。 */
export function reservedCents(state: WalletState): number {
  return state.orders.filter((o) => o.status === "pending").reduce((sum, o) => sum + o.priceCents, 0);
}

export function availableCents(state: WalletState): number {
  return state.balanceCents - reservedCents(state);
}

function trim(state: WalletState): WalletState {
  let orders = state.orders;
  if (orders.length > MAX_ORDERS) {
    // 只丢弃最旧的已结束单据，待审批单永远保留。
    const excess = orders.length - MAX_ORDERS;
    let dropped = 0;
    orders = orders.filter((o) => (o.status !== "pending" && dropped < excess ? (dropped++, false) : true));
  }
  const ledger = state.ledger.length > MAX_LEDGER ? state.ledger.slice(-MAX_LEDGER) : state.ledger;
  return { ...state, orders, ledger };
}

export interface ProposeInput {
  requestId: unknown;
  item: unknown;
  platform: unknown;
  price: unknown;
  url?: unknown;
  reason: unknown;
}

export interface ProposeContext {
  now: Date;
  newId: () => string;
  sessionId?: string | null;
  source?: string | null;
}

export function propose(state: WalletState, input: ProposeInput, context: ProposeContext) {
  const requestId = text(input.requestId, "requestId", LIMITS.requestId);
  const item = text(input.item, "商品名称", LIMITS.item);
  const platform = text(input.platform, "平台", LIMITS.platform);
  const reason = text(input.reason, "想买的理由", LIMITS.reason);
  const url = httpUrl(input.url);
  const priceCents = parseYuan(input.price, "价格");

  const existing = state.orders.find((o) => o.requestId === requestId);
  if (existing) {
    if (existing.item === item && existing.priceCents === priceCents) return { state, order: existing, duplicate: true };
    throw new WalletError("这个 requestId 已用于另一张购物单，请换一个新的 requestId");
  }

  const { settings } = state;
  if (priceCents > settings.maxPriceCents) {
    throw new WalletError(`单张购物单不能超过 ${formatYuan(settings.maxPriceCents)}`);
  }
  const pending = state.orders.filter((o) => o.status === "pending").length;
  if (pending >= settings.maxPending) {
    throw new WalletError(`已有 ${pending} 张购物单在等用户决定，先等等或撤回一张`);
  }
  const since = context.now.getTime() - DAY_MS;
  const recent = state.orders.filter((o) => Date.parse(o.createdAt) > since).length;
  if (recent >= settings.dailyProposals) {
    throw new WalletError(`最近 24 小时已提交 ${recent} 张购物单，达到上限`);
  }
  if (!settings.allowOverBudget && priceCents > availableCents(state)) {
    throw new WalletError(`可用零花钱只有 ${formatYuan(availableCents(state))}，不够买这个`);
  }

  const order: Order = {
    id: context.newId(),
    requestId,
    item,
    platform,
    url,
    priceCents,
    reason,
    status: "pending",
    createdAt: context.now.toISOString(),
    decidedAt: null,
    note: null,
    sessionId: context.sessionId ?? null,
    source: context.source ?? null,
  };
  return { state: trim({ ...state, orders: [...state.orders, order] }), order, duplicate: false };
}

function findPending(state: WalletState, orderId: unknown): Order {
  if (typeof orderId !== "string" || !orderId) throw new WalletError("缺少购物单编号");
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new WalletError("找不到这张购物单");
  if (order.status !== "pending") throw new WalletError("这张购物单已经处理过了");
  return order;
}

function replaceOrder(state: WalletState, order: Order): Order[] {
  return state.orders.map((o) => (o.id === order.id ? order : o));
}

/** 角色撤回自己尚未处理的购物单。 */
export function withdraw(state: WalletState, orderId: unknown, reason: unknown, now: Date) {
  const order = findPending(state, orderId);
  const note = text(reason, "撤回原因", LIMITS.note, false) || null;
  const updated: Order = { ...order, status: "withdrawn", decidedAt: now.toISOString(), note };
  return { state: { ...state, orders: replaceOrder(state, updated) }, order: updated };
}

/** 用户批准（并已自己付款）或拒绝。只能由控制台调用。 */
export function decide(
  state: WalletState,
  orderId: unknown,
  decision: "approve" | "reject",
  noteInput: unknown,
  now: Date,
  newId: () => string,
) {
  const order = findPending(state, orderId);
  const note = text(noteInput, "附言", LIMITS.note, false) || null;
  const at = now.toISOString();
  if (decision === "reject") {
    const updated: Order = { ...order, status: "rejected", decidedAt: at, note };
    return { state: { ...state, orders: replaceOrder(state, updated) }, order: updated };
  }
  if (order.priceCents > state.balanceCents) {
    throw new WalletError(`余额 ${formatYuan(state.balanceCents)} 不够扣这笔 ${formatYuan(order.priceCents)}，请先发零花钱`);
  }
  const balanceCents = state.balanceCents - order.priceCents;
  const updated: Order = { ...order, status: "approved", decidedAt: at, note };
  const entry: LedgerEntry = {
    id: newId(),
    at,
    kind: "purchase",
    amountCents: -order.priceCents,
    balanceCents,
    note: `${order.platform}：${order.item}`,
    orderId: order.id,
  };
  return {
    state: trim({ ...state, balanceCents, orders: replaceOrder(state, updated), ledger: [...state.ledger, entry] }),
    order: updated,
  };
}

/** 用户发零花钱。只能由控制台调用。 */
export function deposit(state: WalletState, amount: unknown, noteInput: unknown, now: Date, newId: () => string) {
  const amountCents = parseYuan(amount, "金额");
  const balanceCents = state.balanceCents + amountCents;
  if (balanceCents > MAX_AMOUNT_CENTS) throw new WalletError("余额超出上限");
  const entry: LedgerEntry = {
    id: newId(),
    at: now.toISOString(),
    kind: "deposit",
    amountCents,
    balanceCents,
    note: text(noteInput, "备注", LIMITS.note, false) || "零花钱",
  };
  return { state: trim({ ...state, balanceCents, ledger: [...state.ledger, entry] }), entry };
}

function integerIn(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new WalletError(`${label}须为 ${min}–${max} 的整数`);
  }
  return n;
}

/** 用户修改限制。只能由控制台调用。 */
export function updateSettings(state: WalletState, input: Record<string, unknown>): WalletState {
  const settings: Settings = {
    maxPriceCents: parseYuan(input.maxPrice, "单笔上限"),
    maxPending: integerIn(input.maxPending, "待审批上限", 1, 50),
    dailyProposals: integerIn(input.dailyProposals, "每日提交上限", 1, 100),
    allowOverBudget: input.allowOverBudget === true,
  };
  return { ...state, settings };
}

/**
 * 校验从磁盘读出的数据。空对象视为全新钱包；
 * 其他无法识别的内容抛错，绝不静默清零。
 */
export function loadState(raw: unknown): WalletState {
  if (raw === null || raw === undefined) return emptyState();
  if (typeof raw !== "object" || Array.isArray(raw)) throw new WalletError("钱包数据格式无效");
  const data = raw as Record<string, unknown>;
  if (Object.keys(data).length === 0) return emptyState();
  if (data.schema !== 1) throw new WalletError("钱包数据版本无法识别");
  if (!Number.isSafeInteger(data.balanceCents)) throw new WalletError("钱包余额数据无效");
  if (!Array.isArray(data.orders) || !Array.isArray(data.ledger)) throw new WalletError("钱包记录数据无效");
  const s = (data.settings ?? {}) as Record<string, unknown>;
  const pick = (key: keyof Settings, ok: (v: unknown) => boolean) => (ok(s[key]) ? s[key] : DEFAULT_SETTINGS[key]);
  const positiveInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
  return {
    schema: 1,
    balanceCents: data.balanceCents as number,
    orders: data.orders as Order[],
    ledger: data.ledger as LedgerEntry[],
    settings: {
      maxPriceCents: pick("maxPriceCents", positiveInt) as number,
      maxPending: pick("maxPending", positiveInt) as number,
      dailyProposals: pick("dailyProposals", positiveInt) as number,
      allowOverBudget: pick("allowOverBudget", (v) => typeof v === "boolean") as boolean,
    },
  };
}

function orderView(o: Order) {
  return {
    id: o.id,
    item: o.item,
    platform: o.platform,
    price: formatYuan(o.priceCents),
    status: o.status,
    createdAt: o.createdAt,
    decidedAt: o.decidedAt,
    note: o.note,
  };
}

/** 给角色看的钱包概况。 */
export function summary(state: WalletState) {
  const pending = state.orders.filter((o) => o.status === "pending");
  const decided = state.orders.filter((o) => o.status !== "pending").slice(-5).reverse();
  return {
    balance: formatYuan(state.balanceCents),
    available: formatYuan(availableCents(state)),
    pending: pending.map(orderView),
    recent: decided.map(orderView),
    limits: {
      maxPrice: formatYuan(state.settings.maxPriceCents),
      maxPending: state.settings.maxPending,
      dailyProposals: state.settings.dailyProposals,
      allowOverBudget: state.settings.allowOverBudget,
    },
  };
}
