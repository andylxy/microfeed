import {errorMessage} from "@/client/request-error";
import type {CloudUsageSnapshot} from "@/shared/CloudUsage";

/** 看板三态：加载中 / 整体失败（可重试）/ 就绪（含未配置的引导态）。 */
export type CloudUsageLoadState =
  | {status: "loading"}
  | {status: "failed"; message: string}
  | {status: "ready"; snapshot: CloudUsageSnapshot};

/** `GET /ajax/cloud-usage` 的信封形状，与详情页现状一致。 */
export interface SnapshotResponse {
  ok?: boolean;
  data?: CloudUsageSnapshot;
  error?: string;
}

/** 倒计时每分钟走一格。 */
export const COUNTDOWN_TICK_MS = 60_000;

/**
 * 纯判定：把服务端信封折成三态。缺 `ok` 或缺 `data` 都算整体失败，
 * message 优先取服务端已经本地化的 `error` 文案。
 */
export function cloudUsageStateFromResponse(
  response: SnapshotResponse,
  failedFallback: string,
): CloudUsageLoadState {
  if (!response.ok || !response.data) {
    return {status: "failed", message: response.error || failedFallback};
  }
  return {status: "ready", snapshot: response.data};
}

export interface CloudUsageSnapshotLoaderOptions {
  /** 取一次快照；IO 由调用方注入，测试可直接替换实现 */
  fetchSnapshot: () => Promise<SnapshotResponse>;
  /** 服务端没给错误文案时的兜底（调用方传入已翻译的字符串） */
  failedFallback: () => string;
}

export interface CloudUsageSnapshotView {
  state: CloudUsageLoadState;
  nowMs: number;
}

type Listener = () => void;

/**
 * 「Cloudflare 使用情况」看板的取数协调器：挂载取一次、`refresh()` 重取，
 * 并接管全仓唯一的倒计时定时器。
 *
 * tick 与取数互不触发：interval 回调只推进 `nowMs`，取数只由 `start()` 的
 * 首次调用与显式 `refresh()` 发起。引导态（`configured` 为 false）属于 ready
 * 的一种，由消费方按快照判定，协调器不做区分。
 */
export class CloudUsageSnapshotLoader {
  private readonly fetchSnapshot: () => Promise<SnapshotResponse>;
  private readonly failedFallback: () => string;
  private currentState: CloudUsageLoadState = {status: "loading"};
  private currentNowMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor({
    fetchSnapshot,
    failedFallback,
  }: CloudUsageSnapshotLoaderOptions) {
    this.fetchSnapshot = fetchSnapshot;
    this.failedFallback = failedFallback;
    this.currentNowMs = Date.now();
  }

  get state(): CloudUsageLoadState {
    return this.currentState;
  }

  get nowMs(): number {
    return this.currentNowMs;
  }

  getView(): CloudUsageSnapshotView {
    return {state: this.currentState, nowMs: this.currentNowMs};
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 挂载时调用：先取一次，再启动倒计时 tick；返回停止函数。 */
  start(): () => void {
    void this.refresh();
    this.timer = setInterval(() => {
      this.currentNowMs = Date.now();
      this.notify();
    }, COUNTDOWN_TICK_MS);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    this.apply({status: "loading"});
    try {
      const response = await this.fetchSnapshot();
      const next = cloudUsageStateFromResponse(response, this.failedFallback());
      // 取数成功后校准时钟，倒计时从新快照的时刻继续走（同旧实现）。
      if (next.status === "ready") {
        this.currentNowMs = Date.now();
      }
      this.apply(next);
    } catch (error) {
      this.apply({status: "failed", message: errorMessage(error, this.failedFallback())});
    }
  }

  private apply(next: CloudUsageLoadState) {
    this.currentState = next;
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}
