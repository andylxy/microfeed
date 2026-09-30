import json, urllib.request, urllib.parse, os

BASE = "https://feed.881019.xyz/api/AppBookRequest"
EV = os.path.join(os.path.dirname(__file__))
os.makedirs(EV, exist_ok=True)

def get(path, params=None):
    url = BASE + "/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent":"walk/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8")
    return raw

# 1) GetNav
nav_raw = get("GetNav")
nav = json.loads(nav_raw)
with open(os.path.join(EV,"getnav.json"),"w",encoding="utf-8") as f:
    f.write(nav_raw)

print("=== GetNav: categories & books ===")
target_book = None
for cat in nav["data"]:
    print(f"[cat] {cat['caseId']}  {cat['name']}")
    for b in cat["navList"]:
        print(f"    bookNo={b['bookNo']}  bookName={b['bookName']}  caseTag={b['caseTag']} chapterCount={b['chapterCount']}")
        if b["bookName"] == "伤寒金匮・(宋版)":
            target_book = b["bookNo"]

print()
print("target buggy book channel id =", target_book)

# 2) GetBookChapter for the buggy book
bc_raw = get("GetBookChapter", {"bookId": target_book})
bc = json.loads(bc_raw)
with open(os.path.join(EV,"getbookchapter_shiihanjinkui.json"),"w",encoding="utf-8") as f:
    f.write(bc_raw)
print()
print("=== GetBookChapter (bookId=%s) ===" % target_book)
print("code=%s msg=%s" % (bc.get("code"), bc.get("msg")))
d = bc.get("data") or {}
print("returned keys:", list(d.keys()) if isinstance(d,dict) else type(d))
chapters = d.get("chapters") if isinstance(d,dict) else None
print("chapter count =", len(chapters) if chapters else 0)
if chapters:
    for ch in chapters[:5]:
        print("   ", ch)
    first_ch = chapters[0].get("signatureId") or chapters[0].get("chapterSection") or chapters[0]
    print("first chapter selector =", first_ch)

# save first chapter signatureId for next step
with open(os.path.join(EV,"_first_chapter.json"),"w",encoding="utf-8") as f:
    json.dump({"bookId":target_book,"first_chapter":chapters[0] if chapters else None}, f, ensure_ascii=False, indent=2)
