import {escapeHtml} from "@/shared/StringUtils";
import {managementCommand} from "@/shared/ManagementCli";
import {type AdminLanguage} from "@/shared/AdminLanguage";
import {translate} from "@/shared/i18n";

export interface AdminOwner {
  email: string;
  id: string;
}

export const ADMIN_DASHBOARD_LOGIN_HELP_URL =
  "https://github.com/microfeed/microfeed#manage-the-dashboard-login";

interface AdminDashboardLockedOptions {
  instanceName?: string;
  local?: boolean;
  preview?: boolean;
}

function dashboardAuthCommand(
  action: "disable" | "setup",
  instanceName?: string,
  preview = false,
): string {
  const normalizedInstanceName = instanceName?.trim();
  const instanceOption = normalizedInstanceName &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalizedInstanceName)
    ? ` --instance ${normalizedInstanceName}`
    : "";
  // `manage auth` targets the production login unless `--preview` is explicit,
  // so a preview deployment has to say so — otherwise the printed command sends
  // the reader to the wrong site's credentials.
  const previewOption = preview ? " --preview" : "";
  return managementCommand(
    `auth ${action}${instanceOption}${previewOption}`,
  );
}

export async function adminOwner(
  database: D1Database,
): Promise<AdminOwner | undefined> {
  const owner = await database.prepare(
    'SELECT "id", "email" FROM "auth_user" ORDER BY "createdAt" LIMIT 1',
  ).first<AdminOwner>();
  return owner ?? undefined;
}

export async function hasAdminOwner(
  database: D1Database,
): Promise<boolean> {
  return Boolean(await adminOwner(database));
}

export function adminDashboardLockedResponse(
  html = true,
  options: AdminDashboardLockedOptions = {},
  language: AdminLanguage = "en",
): Response {
  const setupCommand = dashboardAuthCommand(
    "setup",
    options.instanceName,
    options.preview,
  );
  const disableCommand = options.local
    ? dashboardAuthCommand("disable", options.instanceName, options.preview)
    : undefined;
  const text = (key: string) => translate(`errors.dashboard.${key}`, language);
  const title = text("lockedTitle");
  const message = text("lockedMessage");
  const setupIntro = text(
    html ? "lockedSetupIntro" : "lockedSetupIntroPlain",
  );
  const helpIntro = text("lockedHelpIntro");
  const body = html
    ? `<!doctype html>
<html lang="${language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p>${escapeHtml(setupIntro)}</p>
      <pre><code>${escapeHtml(setupCommand)}</code></pre>
      ${disableCommand
        ? `<p>${escapeHtml(text("lockedDisableIntro"))}</p>
      <pre><code>${escapeHtml(disableCommand)}</code></pre>
      `
        : ""}<p>${escapeHtml(helpIntro)} <a href="${ADMIN_DASHBOARD_LOGIN_HELP_URL}">${escapeHtml(text("lockedHelpLink"))}</a></p>
    </main>
  </body>
</html>
`
    : `${message}\n\n` +
      `${setupIntro}\n` +
      `${setupCommand}\n` +
      (disableCommand
        ? `\n${text("lockedDisableIntro")}\n${disableCommand}\n`
        : "") +
      `\n${helpIntro} ${ADMIN_DASHBOARD_LOGIN_HELP_URL}\n`;
  return new Response(body, {
    headers: {
      "content-type": html
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8",
    },
    status: 403,
  });
}
