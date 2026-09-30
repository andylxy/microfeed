# 13 — App 站点配置端点

**What to build:** App 的登录页文案、项目信息、关于页三处不再 404。旧后端这三项来自字典表与配置表，本项目没有对应结构，所以按本项目实际适配到配置存储上，**对外形状保持一致**即可。

**Blocked by:** None — can start immediately

**Status:** done（2026-09-28，worker 测试 4 例 + dev server 实测）

- [x] 四个端点（GetProjectInfo / GetLoginInfo / getAboutInfo / getPicCaptcha）形状与旧后端一致（关于页 `[{text, name}]`；ProjectInfo/LoginInfo 的列表类配置缺失返回空串，与源 `string.Empty` 行为一致）
- [x] 适配落点：`systemName`/`systemLogo`/`systemDescription` ← **主频道** data 的 title/image/description；`getAboutInfo` ← settings 表 `webGlobalSettings` JSON 的可选 `aboutInfo` 数组（后台改 JSON 即生效）；不新建任何结构
- [x] 配置缺失时返回空而不是报错（无主频道 → 空串；无 aboutInfo → `[]`，单测断言）
- [x] 图形验证码：返回旧后端 `PicVierificationCode` 空形状 `{ValidCodeBase64:"", ValidCodeReqNo:"", IsCode:false}`——App 侧 `IsCode=false` 即不强制验证码，登录链路不阻塞
- [x] 单测：主频道映射 / 无主频道降级 / aboutInfo 默认与读取 / 验证码空形状
- [x] dev server 实测：六端点全部 200 且形状正确（dev 库主频道为无 title 的默认种子 ⇒ `systemName:""` 是预期降级）
