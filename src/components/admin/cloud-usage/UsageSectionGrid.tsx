import type {UsageCard as UsageCardData} from "@/shared/CloudUsage";

import UsageCard from "./UsageCard";

interface Props {
  cards: UsageCardData[];
  /** 单卡重试入口，透传给每张 UsageCard */
  onRetry: () => void;
}

/** 分区的卡片网格：详情页三分区与首页摘要条共用这一份栅格与卡片渲染。 */
export default function UsageSectionGrid({cards, onRetry}: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((entry) => (
        <UsageCard card={entry} key={entry.key} onRetry={onRetry} />
      ))}
    </div>
  );
}
