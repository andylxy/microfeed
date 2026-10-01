import {DatabaseSync} from "node:sqlite";
const db=new DatabaseSync("D:/git/AiCode/microfeed/.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374e950a08be5ad11bdf5fb22c7e803a0aa157cfb660080323535bcb8.sqlite");
const item=db.prepare("SELECT data FROM items WHERE id='UN8KV9xhXQH'").get();
const d=JSON.parse(item.data);
console.log("=== 桂枝汤 _microfeed ===");
console.log("no:",d._microfeed.no,"| sourceBookId:",d._microfeed.sourceBookId,"| bookId:",d._microfeed.bookId);
console.log("yaoList:",JSON.stringify(d._microfeed.yaoList),"| fangList:",JSON.stringify(d._microfeed.fangList),"| yaoCount:",d._microfeed.yaoCount);
db.close();
