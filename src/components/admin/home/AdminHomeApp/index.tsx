import {useState} from "react";
import type {FeedContent, OnboardingResult} from "@/types";
import AdminPageApp from "@/components/admin/shared/AdminPageApp";
import UsageSummaryStrip from "@/components/admin/cloud-usage/UsageSummaryStrip";
import WhatsNewApp from "./component/WhatsNewApp";
import DistributionApp from "./component/DistributionApp";
import SetupChecklistApp from "./component/SetupChecklistApp";

interface Props {
  feedContent: FeedContent;
  onboardingResult: OnboardingResult;
  /**
   * 服务端预判的用量看板读权限（`system:cloud-usage:read`，与菜单可见性同源）。
   * false 的账号（editor / readonly）整块不渲染：组件不挂载、不发请求。
   */
  canReadCloudUsage: boolean;
}

export default function AdminHomeApp({feedContent, onboardingResult, canReadCloudUsage}: Props) {
  const [checklistComplete, setChecklistComplete] = useState(
    onboardingResult.allOk,
  );
  const checklistSection = (
    <div key="setup-checklist">
      <SetupChecklistApp
        feed={feedContent}
        onboardingResult={onboardingResult}
        onCompletionChange={setChecklistComplete}
      />
    </div>
  );
  const publicAccessSection = (
    <div key="public-access">
      <DistributionApp />
    </div>
  );
  const primarySections = checklistComplete
    ? [publicAccessSection, checklistSection]
    : [checklistSection, publicAccessSection];
  // 摘要条恒为左栏第一个子件：无论清单是否完成、两块顺序如何翻转，
  // 它都在设置清单上方，位置不依赖清单状态。
  const leftSections = canReadCloudUsage
    ? [
      <div key="cloud-usage">
        <UsageSummaryStrip />
      </div>,
      ...primarySections,
    ]
    : primarySections;

  return (
    <AdminPageApp>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="grid grid-cols-1 gap-4 xl:col-span-8">
          {leftSections}
        </div>
        <div className="grid grid-cols-1 gap-4 xl:col-span-4">
          <div>
            <WhatsNewApp />
          </div>
        </div>
      </div>
    </AdminPageApp>
  );
}
