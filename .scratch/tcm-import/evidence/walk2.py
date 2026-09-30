import json, urllib.request, urllib.parse, os

BASE = "https://feed.881019.xyz/api/AppBookRequest"
EV = os.path.join(os.path.dirname(__file__))

def get(path, params=None):
    url = BASE + "/" + path
    if params: url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent":"walk/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")

nav = json.loads(get("GetNav"))
summary = []
all_chapters = {}
for cat in nav["data"]:
    for b in cat["navList"]:
        bid = b["bookNo"]
        bc = json.loads(get("GetBookChapter", {"bookId": bid}))
        chapters = bc.get("data") or []
        cnt = len(chapters)
        summary.append((cat["name"], b["bookName"], bid, cnt, b["caseTag"]))
        all_chapters[bid] = chapters
        if cnt:
            # fetch content for first chapter
            ch0 = chapters[0]
            cid = ch0.get("signatureId")
            cc = json.loads(get("GetChapterContent", {"chapterId": cid}))
            ccdata = (cc.get("data") or [])
            secs = ccdata[0]["data"] if ccdata else []
            summary[-1] = (cat["name"], b["bookName"], bid, cnt, b["caseTag"], len(secs), ch0.get("chapterHeader"))

print("=== GetBookChapter chapter counts per book (real endpoint) ===")
print(f"{'category':<8}{'bookName':<22}{'bookId':<12}{'chaps':<6}{'caseTag':<8}{'secs0':<6}firstChapterHeader")
has_chaps = 0
for row in summary:
    cat,name,bid,cnt,ct = row[0],row[1],row[2],row[3],row[4]
    secs0 = row[5] if len(row)>5 else "-"
    hdr = row[6] if len(row)>6 else ""
    if cnt: has_chaps += 1
    print(f"{cat:<8}{name:<22}{bid:<12}{cnt:<6}{ct:<8}{str(secs0):<6}{hdr}")

print()
print("books with chapters:", has_chaps, "/", len(summary))
# save everything
with open(os.path.join(EV,"walk2_summary.json"),"w",encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)
with open(os.path.join(EV,"walk2_chapters.json"),"w",encoding="utf-8") as f:
    json.dump(all_chapters, f, ensure_ascii=False, indent=2)
