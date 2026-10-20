import {useCallback, useEffect, useState} from "react";

import {useTranslation} from "@/client/i18n";
import Requests from "@/client/requests";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {
  CloudUsageSnapshotLoader,
  type CloudUsageLoadState,
  type SnapshotResponse,
} from "./CloudUsageSnapshotLoader";

export interface CloudUsageSnapshotResult {
  state: CloudUsageLoadState;
  nowMs: number;
  refresh: () => void;
}

/**
 * 「Cloudflare 使用情况」看板的取数入口：挂载取一次，`refresh()` 重取，
 * `nowMs` 由协调器内唯一的倒计时 tick 推进（一分钟一格，只走时钟、
 * 不触发取数）。三态与兜底文案沿用详情页现状。
 */
export function useCloudUsageSnapshot(): CloudUsageSnapshotResult {
  const {t} = useTranslation();
  const [loader] = useState(
    () =>
      new CloudUsageSnapshotLoader({
        fetchSnapshot: async () => {
          const response = await Requests.axiosGet(ADMIN_URLS.ajaxCloudUsage());
          return response.data as SnapshotResponse;
        },
        failedFallback: () => t("cloudUsage.failed"),
      }),
  );
  const [view, setView] = useState(() => loader.getView());

  useEffect(() => {
    const unsubscribe = loader.subscribe(() => setView(loader.getView()));
    const stop = loader.start();
    return () => {
      unsubscribe();
      stop();
    };
  }, [loader]);

  const refresh = useCallback(() => {
    void loader.refresh();
  }, [loader]);

  return {state: view.state, nowMs: view.nowMs, refresh};
}
