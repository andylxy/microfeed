import {useTranslation} from "@/client/i18n";
import {permissionDoc} from "@/shared/RbacPermissionDocs";
import type {PermissionNodeRowWithMeta} from "@/shared/PermissionTreeOps";

/**
 * 详情面板顶部的权限说明：功能 / 守的接口 / 注意事项。
 *
 * 码行取自身的权限码，页面行取它的入口门码；分组行不授予权限，只说明归类。
 * 说明来自 `RbacPermissionDocs`（逐条对照代码引用点写成），未登记的码显示
 * 「暂无说明」，不编造内容。
 */
export function PermissionDocBlock({row}: {row: PermissionNodeRowWithMeta}) {
  const {t} = useTranslation();
  if (row.kind === "group") {
    return (
      <p className="mb-4 text-sm leading-6 text-muted-foreground">
        {t("rbac.permissionTree.docGroup")}
      </p>
    );
  }
  const code = row.kind === "code" ? row.permissionCode : row.entryCode;
  const doc = permissionDoc(code);
  if (!doc) {
    return (
      <p className="mb-4 text-sm leading-6 text-muted-foreground">
        {t("rbac.permissionTree.docEmpty")}
      </p>
    );
  }
  return (
    <div className="mb-4 grid gap-2 text-sm leading-6">
      <div className="grid gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t("rbac.permissionTree.docFunction")}
        </span>
        <span>{doc.summary}</span>
      </div>
      <div className="grid gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t("rbac.permissionTree.docGates")}
        </span>
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {doc.gates.map((gate) => (
            <li key={gate}>{gate}</li>
          ))}
        </ul>
      </div>
      {doc.caveats && doc.caveats.length > 0 && (
        <div className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t("rbac.permissionTree.docCaveats")}
          </span>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {doc.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
