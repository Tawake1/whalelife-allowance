import type { PluginConfig } from "whalelife";
import { loadState, WalletError, type WalletState } from "./ledger.ts";

const FILE = "wallet.json";

/**
 * 把钱包串行读写到插件自己的 data/wallet.json。
 * 所有修改排成一条队列，避免审批页和工具同时写入互相覆盖。
 * 读到无法识别的数据时拒绝写入，不会用空钱包覆盖原文件。
 */
export class WalletStore {
  #config: PluginConfig;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: PluginConfig) {
    this.#config = config;
  }

  async #read(): Promise<WalletState> {
    const raw = await this.#config.read<unknown>(FILE);
    try {
      return loadState(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WalletError(`${message}。为保护原数据，已暂停读写，请检查插件 data/${FILE}`);
    }
  }

  read(): Promise<WalletState> {
    const task = this.#queue.then(() => this.#read());
    this.#queue = task.catch(() => undefined);
    return task;
  }

  /** 读取 → 计算新状态 → 保存，整个过程独占。mutate 抛错时不保存。 */
  update<R>(mutate: (state: WalletState) => { state: WalletState; result: R }): Promise<R> {
    const task = this.#queue.then(async () => {
      const current = await this.#read();
      const { state, result } = mutate(current);
      if (state !== current) await this.#config.save(FILE, state);
      return result;
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }
}
