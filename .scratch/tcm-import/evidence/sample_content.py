import json, urllib.request, urllib.parse, os
BASE="https://feed.881019.xyz/api/AppBookRequest"
EV=os.path.join(os.path.dirname(__file__))
def get(p,params=None):
    u=BASE+"/"+p+(("?"+urllib.parse.urlencode(params)) if params else "")
    req=urllib.request.Request(u,headers={"User-Agent":"x"})
    return json.loads(urllib.request.urlopen(req,timeout=30).read().decode())
ch=json.load(open(os.path.join(EV,"walk2_chapters.json"),encoding="utf-8"))
# 金匮要略宋版 ydyQltIuQv6 first chapter
bid="ydyQltIuQv6"
chaps=ch.get(bid,[])
cid=chaps[0]["signatureId"]
cc=get("GetChapterContent",{"chapterId":cid})
raw=json.dumps(cc,ensure_ascii=False)
open(os.path.join(EV,"sample_getchaptercontent.json"),"w",encoding="utf-8").write(raw)
print("chapter signatureId=",cid,"header=",chaps[0]["chapterHeader"])
print("response code/msg:",cc.get("code"),cc.get("msg"))
data=cc.get("data") or []
print("outer array len:",len(data))
if data:
    blk=data[0]
    print("block keys:",list(blk.keys()))
    print("block.section=",blk.get("section"),"header=",blk.get("header"),"signatureId=",blk.get("signatureId"))
    secs=blk.get("data") or []
    print("sections count:",len(secs))
    print("section[0] keys:",list(secs[0].keys()))
    print("section[0] sample:",json.dumps(secs[0],ensure_ascii=False)[:300])
