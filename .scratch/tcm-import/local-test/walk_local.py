#!/usr/bin/env python3
# 本地/远端 AppBookRequest 取数链路验证脚本（与 netcoer 比对前的本地基线）
# 用法：python walk_local.py <base_url> [out_dir]
# 例：python walk_local.py http://localhost:8787 .scratch/tcm-import/local-test/run-local
import json, urllib.request, urllib.parse, os, sys

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787").rstrip("/") + "/api/AppBookRequest"
EV = sys.argv[2] if len(sys.argv) > 2 else ".scratch/tcm-import/local-test/run-local"
os.makedirs(EV, exist_ok=True)

def get(path, params=None):
    url = BASE + "/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "walk-local/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")

def save(name, raw):
    with open(os.path.join(EV, name), "w", encoding="utf-8") as f:
        f.write(raw)

print("BASE =", BASE)
summary = []
all_chapters = {}
try:
    nav = json.loads(get("GetNav"))
except Exception as e:
    print("GET GetNav FAILED:", e)
    sys.exit(1)
save("getnav.json", json.dumps(nav, ensure_ascii=False))
print("=== GetNav 分类与书 ===")
for cat in nav.get("data", []):
    print(f"  [cat] {cat.get('caseId')}  {cat.get('name')}")
    for b in cat.get("navList", []):
        bid = b.get("bookNo")
        try:
            bc = json.loads(get("GetBookChapter", {"bookId": bid}))
        except Exception as e:
            print("    GetBookChapter fail", bid, e); continue
        chapters = bc.get("data") or []
        cnt = len(chapters)
        secs0 = "-"
        hdr0 = ""
        if cnt:
            cid = chapters[0].get("signatureId")
            try:
                cc = json.loads(get("GetChapterContent", {"chapterId": cid}))
                blk = (cc.get("data") or [])
                secs0 = len(blk[0]["data"]) if blk and blk[0].get("data") else 0
                hdr0 = chapters[0].get("chapterHeader", "")
            except Exception as e:
                print("    GetChapterContent fail", cid, e)
        summary.append((cat.get("name"), b.get("bookName"), bid, cnt, b.get("caseTag"), secs0, hdr0))
        all_chapters[bid] = chapters

print("\n=== 每本书 卷章/首章条文数 ===")
print(f"{'cat':<8}{'bookName':<22}{'bookId':<12}{'chaps':<6}{'case':<7}{'secs0':<6}首章标题")
for row in summary:
    cat, name, bid, cnt, ct, secs0, hdr0 = row
    print(f"{str(cat):<8}{str(name):<22}{str(bid):<12}{cnt:<6}{str(ct):<7}{str(secs0):<6}{hdr0}")

with open(os.path.join(EV, "summary.json"), "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)
with open(os.path.join(EV, "chapters.json"), "w", encoding="utf-8") as f:
    json.dump(all_chapters, f, ensure_ascii=False, indent=2)

# 单独抓出「伤寒金匮/伤寒论宋版」频道，确认名实
print("\n=== 名实核对：伤寒金匮 vs 伤寒论 ===")
for cat, name, bid, cnt, ct, secs0, hdr0 in summary:
    if "伤寒" in str(name):
        print(f"  bookId={bid} name={name} chaps={cnt} 首章={hdr0}")

print("\n保存于", EV)
