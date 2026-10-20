import {useTranslation} from "@/client/i18n";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {ADMIN_URLS} from "@/shared/StringUtils";

import {degradedTone, SETTINGS_LINK_CLASS} from "./usageDegradedTone";

interface Props {
  /** 服务端已本地化的错误原文（`cloudUsageStateFromResponse` 取到的 message） */
  message: string;
  /** 重取入口：与 ready 态「刷新」是同一个 `refresh()`，不新增取数路径 */
  onRetry: () => void;
  /** 首页摘要条用更紧凑的尺寸（票据 03：降级态尺寸收小） */
  compact?: boolean;
}

/**
 * 整体失败卡：请求失败或缺快照时渲染。标题 `cloudUsage.failed`、正文是服务端
 * 错误原文，重试按钮调用同一个 `refresh()`；另给一个设置页令牌入口（失败
 * 常因令牌问题，与详情页同源）。可被 fixture 直渲（无 DOM 也能渲染）。
 * 尺寸旋钮与引导态卡共用 `degradedTone`。
 */
export default function UsageFailedCard({message, onRetry, compact}: Props) {
  const {t} = useTranslation();
  const tone = degradedTone(compact);
  return (
    <Card className="border-destructive/40" size={tone.cardSize}>
      <CardHeader>
        <CardTitle className={tone.titleText}>
          {t("cloudUsage.failed")}
        </CardTitle>
      </CardHeader>
      <CardContent className={tone.contentGap}>
        <p className={tone.bodyText} role="alert">
          {message}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={onRetry}
            size={tone.buttonSize}
            type="button"
          >
            {t("cloudUsage.retry")}
          </Button>
          <a
            className={`${tone.linkText} ${SETTINGS_LINK_CLASS}`}
            href={`${ADMIN_URLS.settings()}#cloudflare-token`}
          >
            {t("cloudUsage.settingsLink")}
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
