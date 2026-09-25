"""B22: remove the live instance domain from the OpenAPI document prose.

Replaces `https://feed.881019.xyz` with the `$MF_ORIGIN` placeholder (matching
the existing `$MF_TOKEN` convention) in OpenApiDocument.ts and the mirrored
translation entry in OpenApiTranslations.ts, and rewords the example sentences
so both the English key and the Chinese value stay byte-identical for the
translations-completeness check.
"""
import io

DOMAIN = "https://feed.881019.xyz"
PLACEHOLDER = "$MF_ORIGIN"

REPLACEMENTS = [
    # English prose (OpenApiDocument.ts + the en key in translations)
    ("All examples below use the live instance `$MF_ORIGIN`",
     "All examples below use the placeholder origin `$MF_ORIGIN`"),
    ("Replace `$MF_TOKEN` with your own credential.",
     "Replace `$MF_ORIGIN` with your instance origin and `$MF_TOKEN` "
     "with your own credential."),
    # Chinese prose (the zh value in translations)
    ("以下示例均使用线上实例 `$MF_ORIGIN`",
     "以下示例均使用占位源 `$MF_ORIGIN`"),
    ("请将 `$MF_TOKEN` 替换为你自己的凭证。",
     "请将 `$MF_ORIGIN` 替换为你的实例源，并将 `$MF_TOKEN` 替换为你自己的凭证。"),
]

FILES = [
    r"D:/git/AiCode/microfeed/src/shared/OpenApiDocument.ts",
    r"D:/git/AiCode/microfeed/src/shared/OpenApiTranslations.ts",
]

for path in FILES:
    with io.open(path, encoding="utf-8") as f:
        text = f.read()
    domain_count = text.count(DOMAIN)
    text = text.replace(DOMAIN, PLACEHOLDER)
    applied = []
    for old, new in REPLACEMENTS:
        if old in text:
            text = text.replace(old, new)
            applied.append(old[:40])
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    print(f"{path.split('/')[-1]}: domains={domain_count}, sentences={len(applied)}")
