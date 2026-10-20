import {useTranslation} from "@/client/i18n";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {ADMIN_URLS} from "@/shared/StringUtils";

import {degradedTone, SETTINGS_LINK_CLASS} from "./usageDegradedTone";

interface Props {
  /** 引导态细分原因（`cloudUsage.setup.*` 文案键后缀），由共享判定给出 */
  reason: string;
  /** 该原因能否在设置页处理；false 时不渲染设置页入口 */
  fixableInSettings: boolean;
  /** 首页摘要条用更紧凑的尺寸（票据 03：降级态尺寸收小） */
  compact?: boolean;
}

/**
 * 引导态卡片：未配置 Token / 密文解不开 / 账号 ID 缺失三种原因共用一壳，
 * 标题与正文分别走 `cloudUsage.setup.${reason}Title` / `cloudUsage.setup.${reason}`。
 *
 * 可在设置页处理的原因给一个「设置页 Cloudflare 令牌锚点」入口；账号 ID 缺失
 * 不给（该值来自实例配置，不归设置页管）。详情页与首页摘要渲染同一份内容，
 * 首页多传 `compact` 收小尺寸；尺寸旋钮在共享的 `degradedTone`。
 */
export default function UsageSetupCard({reason, fixableInSettings, compact}: Props) {
  const {t} = useTranslation();
  const tone = degradedTone(compact);
  return (
    <Card size={tone.cardSize}>
      <CardHeader>
        <CardTitle className={tone.titleText}>
          {t(`cloudUsage.setup.${reason}Title`)}
        </CardTitle>
      </CardHeader>
      <CardContent className={tone.contentGap}>
        <p className={tone.bodyText}>
          {t(`cloudUsage.setup.${reason}`)}
        </p>
        {fixableInSettings && (
          <a
            className={`${tone.linkText} ${SETTINGS_LINK_CLASS}`}
            href={`${ADMIN_URLS.settings()}#cloudflare-token`}
          >
            {t("cloudUsage.setup.action")}
          </a>
        )}
      </CardContent>
    </Card>
  );
}
