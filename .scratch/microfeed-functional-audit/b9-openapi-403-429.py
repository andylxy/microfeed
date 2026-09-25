"""B9: add 403 + 429 responses to /items/, /pages/, /site-files/, /channels/
operations in OpenApiDocument.ts. Idempotent: skips operations that already
declare 403 or 429 in the same responses block. Other path groups are left
untouched. Run with the managed Python, then verify with yarn lint:openapi.
"""
import re

PATH = r"D:/git/AiCode/microfeed/src/shared/OpenApiDocument.ts"

RATE_MSG = '"429": error("The credential\'s account is rate limited."),'

ITEM_PERM = {
    "get": "read",
    "post": "create",
    "put": "update",
    "delete": "delete",
}

def perm403(group: str, method: str) -> str | None:
    if group == "items":
        perm = ITEM_PERM[method]
        return f'"403": error("The credential\'s account lacks the content:chapter:{perm} permission."),'
    if group == "pages":
        return '"403": error("The credential\'s account lacks the content:page:manage permission."),'
    if group == "site-files":
        return '"403": error("The credential\'s account lacks the content:site_file:manage permission."),'
    if group == "channels":
        return '"403": error("The credential\'s account lacks the content:channel:manage permission."),'
    return None

TARGET_GROUPS = ("/items", "/pages", "/site-files", "/channels")

with open(PATH, encoding="utf-8") as f:
    lines = f.readlines()

current_path: str | None = None
current_method: str | None = None
in_responses = False
seen403 = False
seen429 = False
out: list[str] = []
inserted = 0

for line in lines:
    m = re.match(r'^    "(/[^"]*)": \{', line)
    if m:
        current_path = m.group(1)
        current_method = None
        in_responses = False
    else:
        m2 = re.match(r"^      (get|post|put|delete): \{", line)
        if m2:
            current_method = m2.group(1)
            in_responses = False
        elif re.match(r"^        responses: \{", line):
            in_responses = True
            seen403 = False
            seen429 = False
        elif in_responses and re.match(r'^          "403":', line):
            seen403 = True
        elif in_responses and re.match(r'^          "429":', line):
            seen429 = True

    out.append(line)

    if in_responses and current_path and current_method and not seen403 and not seen429:
        group = next((g.lstrip("/") for g in TARGET_GROUPS if current_path.startswith(g)), None)
        if group and re.match(r'^          "401": error\("The Bearer credential is missing or invalid\."\),$', line):
            s403 = perm403(group, current_method)
            if s403:
                indent = "          "
                out.append(f"{indent}{s403}\n")
                out.append(f"{indent}{RATE_MSG}\n")
                inserted += 1
                seen403 = True
                seen429 = True

with open(PATH, "w", encoding="utf-8", newline="") as f:
    f.writelines(out)

print(f"inserted 403+429 into {inserted} operations")
