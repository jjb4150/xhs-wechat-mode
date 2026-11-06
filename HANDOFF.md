# 小红书微信模式 · 项目交接文档

> 本文档用于在新对话中快速恢复上下文。最后更新：2026-11-06（v0.7.0）

## 一、项目是什么

把小红书网页版首页（`xiaohongshu.com/explore`）变成**微信式左右分栏界面**的油猴脚本：左栏笔记会话列表，右栏以聊天气泡阅读笔记正文和评论，支持发评论、点赞、收藏。

- **作者**：junbiaojin（GitHub: jjb4150）
- **仓库**：https://github.com/jjb4150/xhs-wechat-mode
- **Greasyfork**：https://greasyfork.org/zh-CN/scripts/592020（已有 38 次安装）
- **协议**：MIT。UI 架构改造自 [Chiphell 微信模式](https://greasyfork.org/zh-CN/scripts/590132)（作者 Codex，MIT），数据层针对小红书完全重写

## 二、核心文件

```
C:/Users/FFIT/ZCodeProject/xhs-wechat-mode/
├── xhs-wechat-mode.user.js   # 主脚本（2876 行，单文件、零依赖、无构建）
├── CHANGELOG.md              # 完整版本记录（0.1.0 → 0.7.0）
├── README.md                 # 用户向文档（开发内容折叠在 <details> 内）
├── LICENSE                   # MIT + 原作署名
├── scripts/release.mjs       # 一键发版脚本
├── .github/workflows/        # ci.yml（校验+Release）+ sync-greasyfork.yml
├── demo.html / demo.css      # UI 静态预览页
└── .prettierrc.json / .prettierignore / .editorconfig / .gitattributes
```

测试环境（独立项目，不在仓库内）：`C:/Users/FFIT/ZCodeProject/xhs-test-harness/`

## 三、技术架构（关键：为什么这样做）

### 核心决策：零签名、零伪造请求

小红书接口带 `X-s`/`X-t` 签名，直接调 API 需逆向且风控风险高。本脚本全程不碰签名：

| 数据             | 获取方式                                                                      |
| ---------------- | ----------------------------------------------------------------------------- |
| 笔记流           | 读取页面自身渲染的 feed DOM（MutationObserver 增量 + `scheduler.yield` 分片） |
| 笔记正文         | `fetch` 笔记页 HTML → 解析内嵌 `__INITIAL_STATE__`                            |
| 评论             | **隐藏 iframe 加载真实笔记页**，读其评论区 DOM                                |
| 点赞/收藏/发评论 | 驱动隐藏 iframe 里的真实页面控件                                              |

### 双 iframe 设计（`engine` + `warm`）

- `xhs-wx-engine`：正式引擎，承载评论解析与互动操作
- `xhs-wx-warm`：预热专用，悬停/跟读预热只动它，**绝不打断正在打开的笔记**
- 点击时若 warm 已加载该笔记，`promoteWarmFrame()` 交换两者 id 复用加载结果

### 速度体系（三层预取 + 缓存）

1. **悬停预取**：400ms 拉正文、650ms 预热页面
2. **跟读预取**：打开第 i 条自动备好 i+1（深度 1，事件驱动释放，8s 兜底）
3. **空闲预热**：`requestIdleCallback` 预热列表第一条
4. **详情缓存**：LRU 30 条，10 分钟 TTL；视频 URL 单独按 1 小时计（带签名）

### 竞态防护（重要，别改坏）

- `frameSeq` 序号 + 每处 `await` 后校验 `state.activeNote.noteId`
- `frameDocFor(note)` 守卫：iframe URL 必须包含当前笔记 ID 才允许操作
- 评论增量渲染的**锚点比对**（`commentKey`）：新结果第 N-1 条必须仍是原最后一条，否则全量重绘

## 四、踩过的坑（血泪教训，务必遵守）

### 1. `content-visibility` 两次引发内容吞没 —— 已永久移除

- v0.3.0 加在 `.wx-msg` 层 → 楼中楼消失
- v0.6.0「谨慎」挪到 `.wx-msg-body` 层 → **同样症状再次出现**
- 结论：**不要再加回来**，代码里有注释封印。收益（滚动性能）远小于风险

### 2. `.like-active` 是常驻 class，不代表已点赞

实测一页有 43 个 `.like-wrapper.like-active`，用户从没点过赞。
→ 点赞状态**只能**以 SSR `interactInfo.liked/collected` 为准。

### 3. 滚动会导致误点赞（用户实际反馈）

滚动经过互动条时，浏览器把"按下→滚动→抬起"判成 `click`（scroll-induced click）。
→ 已加 `isScrollGesture()`（位移 >12px 或期间滚动过则忽略）+ `touch-action: pan-y`。

### 4. 评论区 DOM 结构（实测结论，别靠猜）

```
.list-container
  └── .parent-comment
        ├── .comment-item            ← 一级评论
        │     ├── .avatar > img      ← 头像（与 .author 平级，不在其内部）
        │     └── .content           ← 文字 + 表情 img（class 含 emoji）
        ├── .comment-picture > .img-box > img.inner   ← 用户上传的评论图（独立容器！）
        └── .reply-container         ← 楼中楼（与一级评论平级，在 parent-comment 内）
              ├── .list-container（嵌套同名）
              └── .show-more
```

**关键**：楼中楼、评论图片都不在 `.content` 里面，只解析 `.content` 会全丢。

### 5. 其他易错点

- `dataset.noteId` 生成的属性是 `data-note-id`（驼峰转连字符），CSS 选择器别写错
- 预取缓存的 `comments` 必须是 `undefined`（表示"正文就绪、评论待拉"），存 `[]` 会被当成"无评论"
- 预热门控是「**评论未就绪才预热**」，不是「无缓存才预热」（后者逻辑反了，预取越成功越不预热）

## 五、当前状态

- **版本**：v0.7.0，2876 行，已发布 GitHub Release（含脚本附件）
- **CI**：绿色通过（语法 + 元数据 + 版本/CHANGELOG 一致性 + Prettier）
- **工作区**：干净，已推送 `master`

### 已知限制

- 仅首页"发现" feed 生效
- 视频笔记只支持播放，无额外控制
- 评论翻页靠驱动隐藏页面滚动，热帖快速连翻偏慢
- 依赖登录态

## 六、发版流程

```bash
# 1. 先在 CHANGELOG.md 顶部补条目（CI 会校验，缺了发版脚本会拒绝）
# 2. 一键发版
node scripts/release.mjs 0.7.1 "本次改了什么"
```

自动完成：更新 `@version` → 语法/格式校验（不符自动格式化）→ 提交 → 打 tag → 推送。
推送 tag 后 Actions 自动跑 CI + 建 Release（附件含脚本）。

## 七、网络环境（这台机器，重要）

| 目标                         | 直连            | 5081 代理                |
| ---------------------------- | --------------- | ------------------------ |
| `git@github.com`（SSH 推送） | ✅              | —                        |
| `api.github.com`             | ✅              | —                        |
| `github.com` 网页            | ❌ 超时         | —                        |
| `raw.githubusercontent.com`  | ❌ DNS 解析失败 | ✅ 200                   |
| `greasyfork.org` 主站        | ❌ 21s 超时     | ❌ 15s 超时              |
| `api.greasyfork.org`         | ❌              | ✅（406/403 属正常响应） |

- Git remote 已切 SSH：`git@github.com:jjb4150/xhs-wechat-mode.git`（免密码）
- 匿名 GitHub API 额度 60/小时，CLI 调 API 注意频率

## 八、待办 / 遗留问题

### 1. Greasyfork 自动同步（卡住，非代码问题）

**当前状态**：GitHub webhook 已建，但每次都 403。

**已查明的根因**（实测）：

- Greasyfork 脚本 JSON 里**没有 `sync_identifier` 字段** → 说明脚本**还没设 GitHub 同步源**
- 对照实验：不存在的用户 ID 返回 404，真实 ID 返回 403 → 端点正确，是 Greasyfork 主动拒绝
- 用户 webhook 里配了 Secret，但 Greasyfork 要求**留空**

**解决顺序**（用户操作，非代码）：

1. Greasyfork 脚本「管理」页设置同步源为
   `https://raw.githubusercontent.com/jjb4150/xhs-wechat-mode/master/xhs-wechat-mode.user.js`
2. 清空 webhook 的 Secret
3. 回 GitHub 点 Redeliver 验证

用户已表示"先别管了"，此事项暂停。

### 2. 尚未验证的事项

**滚动误点赞修复（v0.7.0）需要真实环境验证**：

- 已搭测试环境（`xhs-test-harness`，真实 Chrome + Playwright 注入脚本 + GM_* shim）
- **卡在需要用户扫码登录一次**（登录态存独立 profile，不影响日常 Chrome）
- 恢复方式：`cd C:/Users/FFIT/ZCodeProject/xhs-test-harness && node harness.mjs login`

### 3. 潜在优化方向（未做，评估过）

- `parseComments` 每次分页全量重解析：实测几百条仅 1~2ms，**评估后决定不做**（增量化的复杂度不值）
- 路线 B（页内签名直调评论 API）：**已明确否决**，与"零签名"立意冲突，风控风险高

## 九、协作方式

用户偏好：

- 中文沟通，直接、诚实，判断错了直接承认
- **用实测数据说话，不要基于代码推测下结论**（反复强调过）
- 会用另一个大模型 review，双方结论需交叉验证后再采纳；对 review 意见要逐条判断，不能照单全收
- 改动前先说方案；不擅自 commit/push（除非明确要求）

代码规范：

- 脚本是单文件产物，内含大段 HTML 模板与 CSS，已加入 `.prettierignore`
- 格式化用临时配置：`npx prettier@3 --no-config --print-width 110 --write xhs-wechat-mode.user.js`
- 行尾统一 LF（`.gitattributes` 已配）
