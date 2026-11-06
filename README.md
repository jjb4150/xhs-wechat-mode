# 小红书微信模式

把小红书网页版首页变成**微信式左右分栏界面**：左栏是笔记"会话列表"，右栏以聊天气泡形式阅读笔记正文和评论，支持发送评论、点赞、收藏。

> UI 架构改造自 [Chiphell 微信模式](https://greasyfork.org/zh-CN/scripts/590132)（作者 Codex，MIT），数据层针对小红书完全重写。

## 特性

- **微信式分栏**：左栏笔记列表（封面 + 标题 + 作者 + 点赞数、未读红点），右栏气泡详情，分隔条可拖拽调宽
- **气泡阅读**：笔记正文 + 话题标签 + 图片九宫格（点开大图，滚轮缩放/拖拽平移/双击复位）；视频笔记可直接播放
- **评论体验**：评论以聊天气泡展示，自己的评论在右侧绿色气泡，作者回复带"作者"标记
- **楼中楼**：子回复缩进展示，点哪条"展开"就只展开哪条（单条按需加载）
- **评论图片**：评论中的表情按原位置内联，用户上传的图片显示缩略图、点击放大
- **评论分批加载**：滚动到底自动加载下一批，长评论区不卡
- **互动**：底部输入框发评论（Enter 发送）、点赞、收藏，即时反馈（乐观更新，失败自动回滚）
- **字号缩放**：详情页右上 A− / A+（80%–150%），仅影响详情区，偏好持久化
- **暗黑模式**：顶栏 🌙 一键切换，偏好持久化
- **丝滑优化**：悬停预取、跟读预取（备好下一条）、骨架屏、入场动画、详情缓存
- **键盘操作**：`j` / `k` 上下切换笔记

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 新建脚本，将 `xhs-wechat-mode.user.js` 全文粘贴进去，`Ctrl + S` 保存
3. 打开 <https://www.xiaohongshu.com/explore> 并**登录**，界面自动切换为微信模式
4. 退出微信模式：导航栏 ⏏ 按钮（退出后页面右下角有绿色悬浮球可随时回来，也可用油猴菜单切换）

## 技术方案

小红书接口带请求签名，直接调 API 需要逆向并承担风控风险。本脚本采用**零签名、零伪造请求**的路线：

| 数据                 | 获取方式                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| 笔记流               | 读取页面自身渲染的 feed DOM（MutationObserver 增量扫描 + 分片解析）         |
| 笔记正文             | `fetch` 笔记页 HTML，解析内嵌 `__INITIAL_STATE__`                           |
| 评论                 | 隐藏 iframe 加载真实笔记页，读取其评论区 DOM（与浏览器缓存/登录态天然一致） |
| 点赞 / 收藏 / 发评论 | 驱动隐藏 iframe 中真实页面控件完成，不构造任何请求                          |

所有设置仅保存在本地 Tampermonkey 存储，无任何数据上报。

## 已知限制

- 仅首页"发现" feed 生效；搜索页、个人主页保持原网站样式
- 依赖小红书页面结构，站点改版后部分功能可能失效（会持续跟进）
- 依赖登录态，未登录时评论等内容不完整
- 评论区翻页依赖驱动隐藏页面滚动，热帖连续快速翻页时可能略慢

## 常见问题

**为什么有的评论图/表情不显示？**
脚本按小红书当前的页面结构解析。若站点改版，可能部分内容抓不到，欢迎 [提 issue](https://github.com/jjb4150/xhs-wechat-mode/issues) 并附上控制台日志。

**点赞/收藏没反应？**
点赞收藏是通过驱动真实页面完成的。若提示"未定位到按钮"，可点右上角「原页」直接操作。

**装了没反应？**
确认已登录小红书、且当前在首页"发现" feed（其他页面不接管）。

<details>
<summary><b>开发者：项目结构与发版流程</b>（点击展开）</summary>

| 文件                      | 说明                                   |
| ------------------------- | -------------------------------------- |
| `xhs-wechat-mode.user.js` | 主脚本，单文件、零依赖、无构建         |
| `scripts/release.mjs`     | 发版脚本                               |
| `demo.html` / `demo.css`  | UI 静态预览页                          |
| `.github/workflows/`      | CI 校验、自动 Release、Greasyfork 同步 |
| `CHANGELOG.md`            | 版本变更记录                           |

调试：浏览器控制台过滤 `[小红书微信模式]` 查看运行日志。

代码风格检查：

```bash
npx prettier@3 --no-config --print-width 110 --check xhs-wechat-mode.user.js
```

### 发版

先在 `CHANGELOG.md` 顶部补该版本条目，然后：

```bash
node scripts/release.mjs 0.7.1 "本次改了什么"
```

自动完成版本号更新、语法与格式校验、提交、打 tag、推送。推送后 Actions 会跑 CI、
从 CHANGELOG 提取说明创建 Release（附脚本文件），并同步到 Greasyfork。

### 自动同步 Greasyfork

推荐用 **Webhook**（Greasyfork 主动来拉，本机无需访问 Greasyfork）：

1. Greasyfork 脚本「管理」页把同步源设为：
   ```
   https://raw.githubusercontent.com/jjb4150/xhs-wechat-mode/master/xhs-wechat-mode.user.js
   ```
2. GitHub 仓库 → Settings → Webhooks → Add webhook：

   | 字段         | 值                                                                |
   | ------------ | ----------------------------------------------------------------- |
   | Payload URL  | `https://api.greasyfork.org/zh-CN/users/1635640-jin-bill/webhook` |
   | Content type | `application/json`                                                |
   | Secret       | 留空                                                              |
   | 事件         | 勾选 Pushes 和 Releases                                           |

备选：在 `Settings → Secrets and variables → Actions` 配 `GREASYFORK_SCRIPT_ID`（`592020`）
和 `GREASYFORK_TOKEN`（Greasyfork 账号页底部），由 Actions 主动推送。未配置时该 workflow 自动跳过。

</details>

## 贡献

欢迎提 [Issue](https://github.com/jjb4150/xhs-wechat-mode/issues) 反馈问题或建议。提交代码前请：

- 跑 `node --check xhs-wechat-mode.user.js` 与 Prettier 格式检查
- 在 `CHANGELOG.md` 补充本次改动
- 说明实测环境（浏览器、脚本管理器版本）

## 许可

[MIT](LICENSE)。UI 架构改造自 Chiphell 微信模式（作者 Codex，MIT），数据层针对小红书完全重写。
