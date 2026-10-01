import {createHmac, randomUUID} from "node:crypto";
const BASE="http://192.168.2.158:9991";
const accessKeyId="3xl81vfcZMFoFWks14d1iMXzCNmOxyyX";
const accessKeySecret="KZbbYBtUeMXbIimx";
function signedHeaders(method, url){
  const timestamp=String(Date.now());
  const nonce=randomUUID().replace(/-/g,"").toLowerCase();
  const path=url.pathname;
  const stringToSign=[method.toUpperCase(),url.host,path,timestamp,nonce].join("\n");
  const signature=createHmac("sha256",accessKeySecret).update(stringToSign,"utf8").digest("base64");
  return {"app":"2","SessionId":randomUUID().replace(/-/g,""),"Content-Type":"application/json;charset=UTF-8","Accept":"application/json, text/plain, */*","Signature":`Signature ${signature}`,"X-AccessKeyId":accessKeyId,"X-Timestamp":timestamp,"X-Nonce":nonce};
}
async function oldGet(path){
  const url=new URL(BASE+path);
  const res=await fetch(url,{headers:signedHeaders("GET",url),signal:AbortSignal.timeout(30000)});
  return {status:res.status,text:await res.text()};
}
// 先抓 GetNav 拿到 book 列表，找含 桂枝汤 的书；再抓 GetBookIdFang
const nav=await oldGet("/api/AppBookRequest/GetNav");
console.log("GetNav status:",nav.status);
const navJson=JSON.parse(nav.text);
const books=(navJson.data&&navJson.data.bookList)||navJson.bookList||navJson.data||navJson;
console.log("books 类型:",Array.isArray(books)?("数组 "+books.length):typeof books);
// 打印前几个 book 的 id/name
try{
  const arr=Array.isArray(books)?books:(Array.isArray(navJson.data)?navJson.data:[]);
  console.log("前 10 本书:",JSON.stringify(arr.slice(0,10).map(b=>({id:b.bookId??b.id??b.BookId, name:b.bookName??b.name??b.BookName})),null,1));
}catch(e){console.log("books 解析失败:",e.message);}
