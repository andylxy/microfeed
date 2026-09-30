const base = 'https://feed.881019.xyz/api/AppBookRequest';
async function get(path) {
  const r = await fetch(base + path, { redirect: 'follow' });
  return r.json();
}
function arrLen(j, key) {
  if (Array.isArray(j[key])) return j[key].length;
  if (j.styles) return j.styles.length;
  return '?';
}
(async () => {
  const yao = await get('/GetAllZhongYao');
  const ming = await get('/GetAllMingCi');
  const alia = await get('/GetAliaZhongYao');
  const tips = await get('/GetTipsStyleConfig');
  const nav = await get('/GetNav');
  const cats = nav.data.length;
  const books = nav.data.reduce((a, c) => a + (c.navList ? c.navList.length : 0), 0);
  console.log('GetAllZhongYao      =', arrLen(yao, 'data'), '(expect 172)');
  console.log('GetAllMingCi         =', arrLen(ming, 'data'), '(expect 17)');
  console.log('GetAliaZhongYao      =', arrLen(alia, 'data'), '(expect 339)');
  console.log('GetTipsStyleConfig   =', arrLen(tips, 'styles'), '(expect 13)');
  console.log('GetNav cats/books    =', cats, '/', books, '(expect 5 cats, 13 TCM books + novels)');
  // 抽查一个条文是否带原始标记
  const chap = await get('/GetBookChapter?bookId=Kcb7X2K5LTh'); // 金匮要略・(人纪)
  console.log('GetBookChapter 金匮要略・(人纪) chapters =', chap.data ? chap.data.length : '?');
})();
