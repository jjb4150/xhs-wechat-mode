// ==UserScript==
// @name         小红书微信模式
// @namespace    xhs-wechat-mode
// @version      0.6.3
// @description  小红书微信式左右分栏界面：笔记会话列表、气泡阅读笔记与评论、发送评论、点赞、收藏。
// @author       junbiaojin
// @license      MIT
// @match        https://www.xiaohongshu.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/*
 * UI 架构改造自《Chiphell 微信模式》（https://greasyfork.org/zh-CN/scripts/590132，作者 Codex，MIT License）
 * 数据层针对小红书完全重写：
 * - 左栏会话列表 = 首页 feed 笔记流（扫描页面 .note-item DOM + MutationObserver）
 * - 右栏气泡 = 笔记正文（fetch 笔记 URL 解析 __INITIAL_STATE__）+ 评论（隐藏 iframe 加载后读 DOM）
 * - 点赞/收藏/发评论/展开楼中楼 = 驱动隐藏 iframe 里的真实页面控件（零签名、零风控）
 * 本脚本同样以 MIT License 发布。
 */

(() => {
  "use strict";

  const ROOT_ID = "xhs-wx-root";
  const LOG_PREFIX = "[小红书微信模式]";
  const STORE_KEYS = {
    enabled: "xhsWxEnabled",
    leftWidth: "xhsWxLeftWidth",
    seenMap: "xhsWxSeenMap",
    likedMap: "xhsWxLikedMap",
    collectedMap: "xhsWxCollectedMap",
    dark: "xhsWxDark",
    fontScale: "xhsWxFontScale",
    followPrefetch: "xhsWxFollowPrefetch",
  };

  /* ============================== 工具 ============================== */

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  function storeGet(key, fallback) {
    try {
      const v = GM_getValue(key);
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      GM_setValue(key, value);
    } catch (e) {
      warn("存储失败", key, e);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 8732 -> "8732"，12400 -> "1.2万"
  function fmtCount(n) {
    const num = Number(n);
    if (!isFinite(num)) return String(n == null ? "" : n);
    if (num >= 10000) {
      const w = num / 10000;
      return (w >= 10 ? Math.round(w) : Math.round(w * 10) / 10) + "万";
    }
    return String(num);
  }

  // 时间戳 -> "3分钟前 / 2天前 / 2025-06-01"
  function fmtTime(ts) {
    const t = Number(ts);
    if (!isFinite(t) || t <= 0) return "";
    const diff = Date.now() - t;
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 3600 * 1000) return Math.floor(diff / 60000) + "分钟前";
    if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + "小时前";
    if (diff < 86400 * 1000 * 30) return Math.floor(diff / 86400000) + "天前";
    const d = new Date(t);
    const now = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return d.getFullYear() === now.getFullYear() ? ymd.slice(5) : ymd;
  }

  function uidFromProfileHref(href) {
    const m = /\/user\/profile\/([0-9a-f]+)/i.exec(href || "");
    return m ? m[1] : "";
  }

  function noteIdFromHref(href) {
    const m = /\/(?:explore|discovery\/item)\/([0-9a-f]+)/i.exec(href || "");
    return m ? m[1] : "";
  }

  // 小红书 CDN 缩放：九宫格加载小图、查看器加载原图（仅对未带处理参数的 URL 生效）
  function cdnThumb(url, width) {
    if (!url || !/xhscdn\.com/i.test(url)) return url;
    if (url.includes("!") || url.includes("?")) return url;
    return url + "?imageView2/2/w/" + width + "/format/jpg";
  }

  /* ============================== 样式 ============================== */

  const CSS = `
#xhs-wx-root * { box-sizing: border-box; margin: 0; padding: 0; }
#xhs-wx-root {
  /* 主题变量（浅色） */
  --bg-app: #f2f2f2;
  --bg-top: #2e2e2e;
  --bg-rail: #2a2a2a;
  --bg-aside: #ffffff;
  --bg-search: #f2f2f2;
  --bg-search-focus: #ececec;
  --bg-detail: #f5f5f5;
  --bg-bubble: #ffffff;
  --bg-bubble-me: #95ec69;
  --bg-bubble-me-text: #1a1a1a;
  --bg-hover: #f5f5f5;
  --bg-active: #ececec;
  --bg-composer: #ffffff;
  --text-1: #1a1a1a;
  --text-2: #999999;
  --text-3: #b3b3b3;
  --border-1: #e4e4e4;
  --border-2: #e8e8e8;
  --scroll: #ddd;
  --accent: #07c160;
  --accent-disabled: #d2d2d2;
  --brand: #ff2442;
  --link: #1668dc;
  --interact-bg: rgba(0,0,0,.04);
  --interact-hover: rgba(0,0,0,.08);
  --cover-bg: #f0f0f0;

  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; flex-direction: column;
  background: var(--bg-app); color: var(--text-1);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px; line-height: 1.5;
}
/* 暗黑主题 */
#xhs-wx-root.dark {
  --bg-app: #111111;
  --bg-top: #1d1d1d;
  --bg-rail: #191919;
  --bg-aside: #232323;
  --bg-search: #2e2e2e;
  --bg-search-focus: #383838;
  --bg-detail: #111111;
  --bg-bubble: #2c2c2c;
  --bg-bubble-me: #3eb575;
  --bg-bubble-me-text: #ffffff;
  --bg-hover: #2a2a2a;
  --bg-active: #333333;
  --bg-composer: #2c2c2c;
  --text-1: #d5d5d5;
  --text-2: #8a8a8a;
  --text-3: #6a6a6a;
  --border-1: #333333;
  --border-2: #2e2e2e;
  --scroll: #3a3a3a;
  --accent: #07c160;
  --accent-disabled: #3a3a3a;
  --link: #6ca6e8;
  --interact-bg: rgba(255,255,255,.07);
  --interact-hover: rgba(255,255,255,.12);
  --cover-bg: #2a2a2a;
}
#xhs-wx-root button { font-family: inherit; cursor: pointer; border: none; background: none; color: inherit; }
#xhs-wx-root img { display: block; }

/* ---- 顶栏 ---- */
#xhs-wx-root .wx-top {
  height: 44px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 14px; background: var(--bg-top); color: #d9d9d9;
}
#xhs-wx-root .wx-brand { font-weight: 600; font-size: 15px; color: #fff; display: flex; align-items: center; gap: 8px; }
#xhs-wx-root .wx-brand-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); }
#xhs-wx-root .wx-top-btn {
  width: 30px; height: 30px; border-radius: 6px; color: #bbb;
  display: inline-flex; align-items: center; justify-content: center;
}
#xhs-wx-root .wx-top-btn:hover { background: rgba(255,255,255,.12); color: #fff; }
#xhs-wx-root .wx-top-tip { margin-left: auto; font-size: 12px; color: #8a8a8a; }

/* ---- 主体三栏 ---- */
#xhs-wx-root .wx-main { flex: 1; min-height: 0; display: flex; }

/* ---- 导航栏 ---- */
#xhs-wx-root .wx-navrail {
  width: 56px; flex: none; background: var(--bg-rail);
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 12px 0;
}
#xhs-wx-root .wx-nav-avatar-wrap { margin-bottom: 8px; position: relative; cursor: pointer; }
#xhs-wx-root .wx-nav-avatar {
  width: 34px; height: 34px; border-radius: 8px; object-fit: cover; background: #444;
}
#xhs-wx-root .wx-nav-btn {
  width: 40px; height: 40px; border-radius: 10px; color: #9a9a9a;
  display: inline-flex; align-items: center; justify-content: center; position: relative;
}
#xhs-wx-root .wx-nav-btn:hover { color: #fff; }
#xhs-wx-root .wx-nav-btn.active { background: rgba(255,255,255,.14); color: #fff; }
#xhs-wx-root .wx-nav-spacer { flex: 1; }

/* ---- 左栏会话列表 ---- */
#xhs-wx-root .wx-aside {
  width: 300px; min-width: 220px; max-width: 480px; flex: none;
  background: var(--bg-aside); border-right: 1px solid var(--border-1);
  display: flex; flex-direction: column; min-height: 0; position: relative;
}
#xhs-wx-root .wx-search { padding: 10px 12px; flex: none; }
#xhs-wx-root .wx-search input {
  width: 100%; height: 30px; border: none; border-radius: 6px;
  background: var(--bg-search); padding: 0 12px; font-size: 13px; outline: none; color: var(--text-1);
}
#xhs-wx-root .wx-search input:focus { background: var(--bg-search-focus); }
#xhs-wx-root .wx-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 16px; }
#xhs-wx-root .wx-list::-webkit-scrollbar { width: 6px; }
#xhs-wx-root .wx-list::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 3px; }

#xhs-wx-root .wx-item {
  display: flex; gap: 10px; padding: 10px; border-radius: 10px;
  cursor: pointer; align-items: flex-start; position: relative;
}
#xhs-wx-root .wx-item:hover { background: var(--bg-hover); }
#xhs-wx-root .wx-item.active { background: var(--bg-active); }
#xhs-wx-root .wx-item-cover {
  width: 58px; height: 58px; border-radius: 6px; object-fit: cover; flex: none;
  background: var(--cover-bg);
}
#xhs-wx-root .wx-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
#xhs-wx-root .wx-item-title {
  font-size: 14px; color: var(--text-1); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.35;
}
#xhs-wx-root .wx-item-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
#xhs-wx-root .wx-item-meta .author { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#xhs-wx-root .wx-item-unread {
  width: 8px; height: 8px; border-radius: 50%; background: var(--brand);
  position: absolute; right: 14px; top: 16px;
}
#xhs-wx-root .wx-empty-list { text-align: center; color: var(--text-3); padding: 60px 20px; font-size: 13px; }
#xhs-wx-root .wx-list-loading { text-align: center; color: var(--text-3); font-size: 12px; padding: 10px 0; }

/* ---- 拖拽分隔 ---- */
#xhs-wx-root .wx-resize-col { width: 4px; flex: none; cursor: col-resize; background: transparent; }
#xhs-wx-root .wx-resize-col:hover, #xhs-wx-root .wx-resize-col.dragging { background: var(--accent); }

/* ---- 右栏详情 ---- */
#xhs-wx-root .wx-detail {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  background: var(--bg-detail); min-height: 0;
  zoom: var(--wx-detail-zoom, 1); /* 详情页整体字号缩放（含气泡与输入框） */
}
#xhs-wx-root .wx-detail-head {
  height: 48px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 16px; background: var(--bg-detail); border-bottom: 1px solid var(--border-2);
}
#xhs-wx-root .wx-detail-title {
  flex: 1; min-width: 0; font-size: 15px; font-weight: 600; color: var(--text-1);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#xhs-wx-root .wx-detail-actions { display: flex; align-items: center; gap: 4px; flex: none; }
#xhs-wx-root .wx-link-btn {
  height: 30px; padding: 0 12px; border-radius: 6px; color: var(--text-2); font-size: 13px;
  display: inline-flex; align-items: center; gap: 5px;
}
#xhs-wx-root .wx-link-btn:hover { background: var(--bg-hover); }
#xhs-wx-root .wx-link-btn.on { color: var(--brand); }

#xhs-wx-root .wx-detail-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 16px 6% 20px;
}
#xhs-wx-root .wx-detail-body::-webkit-scrollbar { width: 8px; }
#xhs-wx-root .wx-detail-body::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 4px; }

#xhs-wx-root .wx-empty-detail {
  height: 100%; display: flex; flex-direction: column; gap: 10px;
  align-items: center; justify-content: center; color: var(--text-3); font-size: 14px;
}
#xhs-wx-root .wx-empty-detail .icon { font-size: 40px; }
#xhs-wx-root .wx-loading-detail { text-align: center; color: var(--text-2); padding: 80px 0; font-size: 13px; }

/* ---- 气泡 ---- */
#xhs-wx-root .wx-msg { display: flex; gap: 10px; margin-bottom: 18px; }
#xhs-wx-root .wx-msg.me { flex-direction: row-reverse; }
#xhs-wx-root .wx-avatar {
  width: 38px; height: 38px; border-radius: 6px; object-fit: cover; flex: none; background: var(--cover-bg);
  cursor: pointer;
}
#xhs-wx-root .wx-msg-body { max-width: 62%; display: flex; flex-direction: column; gap: 4px; }
#xhs-wx-root .wx-msg-name { font-size: 12px; color: var(--text-2); padding: 0 2px; }
#xhs-wx-root .wx-msg.me .wx-msg-name { text-align: right; }
#xhs-wx-root .wx-bubble {
  background: var(--bg-bubble); border-radius: 4px 12px 12px 12px; padding: 10px 12px;
  font-size: 14px; color: var(--text-1); word-break: break-word; white-space: pre-wrap;
  box-shadow: 0 1px 1px rgba(0,0,0,.04);
}
#xhs-wx-root.dark .wx-bubble { box-shadow: none; }
#xhs-wx-root .wx-msg.me .wx-bubble {
  background: var(--bg-bubble-me); border-radius: 12px 4px 12px 12px;
  color: var(--bg-bubble-me-text);
}
#xhs-wx-root .wx-bubble a { color: var(--link); text-decoration: none; }
#xhs-wx-root .wx-bubble .wx-tag { color: var(--link); }
#xhs-wx-root .wx-msg.me .wx-bubble .wx-tag { color: var(--bg-bubble-me-text); }
#xhs-wx-root .wx-bubble-meta { font-size: 12px; color: var(--text-3); padding: 0 2px; display: flex; gap: 8px; }
#xhs-wx-root .wx-msg.me .wx-bubble-meta { justify-content: flex-end; }
#xhs-wx-root .wx-badge {
  display: inline-block; font-size: 11px; line-height: 16px; padding: 0 4px;
  background: var(--brand); color: #fff; border-radius: 3px; margin-right: 6px;
  vertical-align: 1px;
}
#xhs-wx-root .wx-bubble-imgs {
  display: grid; gap: 4px; margin-top: 6px; max-width: 480px;
}
#xhs-wx-root .wx-bubble-imgs.n1 { grid-template-columns: minmax(0, 420px); }
#xhs-wx-root .wx-bubble-imgs.n2, #xhs-wx-root .wx-bubble-imgs.n4 { grid-template-columns: repeat(2, minmax(0, 220px)); }
#xhs-wx-root .wx-bubble-imgs.n3, #xhs-wx-root .wx-bubble-imgs.n5, #xhs-wx-root .wx-bubble-imgs.n6,
#xhs-wx-root .wx-bubble-imgs.n7, #xhs-wx-root .wx-bubble-imgs.n8, #xhs-wx-root .wx-bubble-imgs.n9 { grid-template-columns: repeat(3, minmax(0, 155px)); }
#xhs-wx-root .wx-bubble-imgs img {
  width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 4px;
  background: var(--cover-bg); cursor: zoom-in;
}
#xhs-wx-root .wx-bubble-imgs.n1 img { aspect-ratio: auto; max-height: 420px; object-fit: contain; }
#xhs-wx-root.dark .wx-bubble-imgs.n1 img { background: #000; }

/* 视频播放器（笔记气泡内） */
#xhs-wx-root .wx-bubble-video {
  display: block; width: 100%; max-width: 420px; max-height: 480px;
  border-radius: 6px; background: #000; margin-top: 6px;
}
#xhs-wx-root .wx-msg.me .wx-bubble-video { background: #000; }

/* 楼中楼：在父气泡内缩进展示 */
#xhs-wx-root .wx-subcomments { margin-top: 8px; border-left: 2px solid var(--border-1); padding-left: 10px; display: flex; flex-direction: column; gap: 8px; }
#xhs-wx-root .wx-subcomment { font-size: 13px; }
#xhs-wx-root .wx-subcomment .who { color: var(--link); margin-right: 4px; }
#xhs-wx-root .wx-subcomment .who.author-tag { color: var(--brand); }
#xhs-wx-root .wx-subcomment .sub-meta { color: var(--text-3); font-size: 11px; margin-top: 2px; }
#xhs-wx-root .wx-expand-replies {
  margin-top: 8px; font-size: 12px; color: var(--link); cursor: pointer; user-select: none;
}
#xhs-wx-root .wx-expand-replies:hover { opacity: .8; }

/* 分隔提示 */
#xhs-wx-root .wx-divider {
  text-align: center; color: var(--text-3); font-size: 12px; margin: 18px 0;
}

/* 互动栏（笔记气泡下方） */
#xhs-wx-root .wx-interact {
  display: inline-flex; align-items: center; gap: 4px; margin-top: 8px;
  padding: 4px 10px; border-radius: 14px; background: var(--interact-bg);
  font-size: 12px; color: var(--text-2); user-select: none;
}
#xhs-wx-root .wx-msg.me .wx-interact { background: rgba(0,0,0,.06); color: rgba(0,0,0,.55); }
#xhs-wx-root .wx-interact .act {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer; padding: 2px 6px; border-radius: 10px;
}
#xhs-wx-root .wx-interact .act:hover { background: var(--interact-hover); }
#xhs-wx-root .wx-interact .act.on { color: var(--brand); }
#xhs-wx-root .wx-interact .sep { color: var(--text-3); opacity: .4; }

/* ---- 底部输入 ---- */
#xhs-wx-root .wx-composer { flex: none; padding: 10px 6% 14px; background: var(--bg-detail); }
#xhs-wx-root .wx-composer-inner {
  background: var(--bg-composer); border-radius: 10px; padding: 10px 12px;
  box-shadow: 0 1px 2px rgba(0,0,0,.05);
}
#xhs-wx-root.dark .wx-composer-inner { box-shadow: none; }
#xhs-wx-root .wx-input {
  min-height: 44px; max-height: 140px; overflow-y: auto; outline: none;
  font-size: 14px; color: var(--text-1); word-break: break-word;
}
/* placeholder 由 JS 维护 .empty 类控制，避免 contenteditable 中 :empty 被 <br> 破坏 */
#xhs-wx-root .wx-input.empty::before {
  content: attr(data-placeholder); color: var(--text-3);
}
#xhs-wx-root .wx-composer-bar { display: flex; align-items: center; margin-top: 8px; }
#xhs-wx-root .wx-composer-tip { font-size: 12px; color: var(--text-3); flex: 1; }
#xhs-wx-root .wx-send {
  height: 30px; padding: 0 18px; border-radius: 6px; background: var(--accent);
  color: #fff; font-size: 13px; flex: none;
}
#xhs-wx-root .wx-send:disabled { background: var(--accent-disabled); cursor: default; }

/* ---- 图片查看器 ---- */
#xhs-wx-root .wx-viewer {
  position: fixed; inset: 0; z-index: 2147483600; background: rgba(0,0,0,.9);
  display: flex; align-items: center; justify-content: center;
}
#xhs-wx-root .wx-viewer img { max-width: 92vw; max-height: 88vh; object-fit: contain; transition: transform .12s; }
#xhs-wx-root .wx-viewer-close {
  position: absolute; top: 16px; right: 20px; color: #fff; font-size: 30px; line-height: 1;
  cursor: pointer; opacity: .8;
}
#xhs-wx-root .wx-viewer-index { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); color: #ddd; font-size: 13px; }
#xhs-wx-root .wx-viewer-arrow {
  position: absolute; top: 50%; transform: translateY(-50%); color: #fff; font-size: 34px;
  cursor: pointer; opacity: .6; user-select: none; padding: 10px;
}
#xhs-wx-root .wx-viewer-arrow:hover { opacity: 1; }
#xhs-wx-root .wx-viewer-arrow.left { left: 12px; }
#xhs-wx-root .wx-viewer-arrow.right { right: 12px; }

/* ---- 设置面板 ---- */
#xhs-wx-root .wx-settings { padding: 18px 18px 30px; overflow-y: auto; }
#xhs-wx-root .wx-settings h3 { font-size: 14px; color: var(--text-1); margin: 18px 0 10px; }
#xhs-wx-root .wx-settings .row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 0; border-bottom: 1px solid var(--border-2); font-size: 13px; color: var(--text-1);
}
#xhs-wx-root .wx-settings .row button {
  height: 28px; padding: 0 14px; border-radius: 6px; background: var(--accent); color: #fff; font-size: 12px;
}
#xhs-wx-root .wx-settings .row button.danger { background: #fa5151; }
#xhs-wx-root .wx-settings .row button.neutral { background: transparent; border: 1px solid var(--border-1); color: var(--text-2); }
#xhs-wx-root .wx-settings .hint { color: var(--text-3); font-size: 12px; margin-top: 14px; line-height: 1.7; }

/* ---- toast ---- */
#xhs-wx-root .wx-toast {
  position: fixed; left: 50%; top: 12%; transform: translateX(-50%);
  background: rgba(0,0,0,.75); color: #fff; padding: 9px 18px; border-radius: 8px;
  font-size: 13px; z-index: 2147483647; pointer-events: none;
  animation: wx-toast-in .18s ease-out;
}
@keyframes wx-toast-in { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translate(-50%, 0); } }

/* ---- 丝滑：过渡与动画 ---- */
#xhs-wx-root .wx-item { transition: background-color .15s ease; }
#xhs-wx-root .wx-link-btn { transition: background-color .15s ease, color .15s ease; }
#xhs-wx-root .wx-nav-btn { transition: background-color .15s ease, color .15s ease; }

/* 详情正文到达：轻淡入上移（按需挂 .wx-anim，避免全量重渲时重复播放） */
#xhs-wx-root .wx-msg.wx-anim { animation: wx-msg-in .22s ease-out; }
@keyframes wx-msg-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
/* 评论区整体到达：容器淡入 */
#xhs-wx-root #wx-comments.wx-comments-in { animation: wx-comments-in .25s ease-out; }
@keyframes wx-comments-in { from { opacity: 0; } to { opacity: 1; } }
/* 分批加载追加的评论：滑入 */
#xhs-wx-root .wx-msg.wx-msg-new { animation: wx-msg-slide .3s cubic-bezier(.2,.7,.3,1); }
#xhs-wx-root .wx-subcomments.wx-msg-new { animation: wx-msg-slide .3s cubic-bezier(.2,.7,.3,1); }
@keyframes wx-msg-slide { from { opacity: 0; transform: translateY(26px); } to { opacity: 1; transform: translateY(0); } }
/* 尊重系统减少动效偏好 */
@media (prefers-reduced-motion: reduce) {
  #xhs-wx-root .wx-msg, #xhs-wx-root .wx-msg.wx-msg-new { animation: none; }
}

/* 图片入场淡显（默认可见，仅加动画；未监听到 load 也不影响显示） */
#xhs-wx-root img.wx-img-in { animation: wx-img-in .28s ease-out; }
@keyframes wx-img-in { from { opacity: 0; } to { opacity: 1; } }
/* 加载失败：隐藏裂图图标，露出底色占位 */
#xhs-wx-root img.wx-img-broken { opacity: 0; }

/* 主题（明暗）切换平滑过渡：只给关键容器，避免全局 transition 副作用 */
#xhs-wx-root .wx-top,
#xhs-wx-root .wx-navrail,
#xhs-wx-root .wx-aside,
#xhs-wx-root .wx-detail,
#xhs-wx-root .wx-bubble,
#xhs-wx-root .wx-composer-inner,
#xhs-wx-root .wx-search input { transition: background-color .25s ease, color .25s ease, border-color .25s ease; }

/* 评论富内容：小表情内联；评论图片块级可点开 */
#xhs-wx-root .wx-bubble .wx-c-emoji {
  display: inline-block; width: 20px; height: 20px;
  vertical-align: -5px; margin: 0 1px;
}
#xhs-wx-root .wx-bubble .wx-c-img {
  display: block; max-width: 220px; max-height: 220px;
  border-radius: 6px; margin-top: 6px; cursor: zoom-in;
}
#xhs-wx-root .wx-subcomment .wx-c-emoji { width: 16px; height: 16px; vertical-align: -3px; }

/* 千评热帖滚动优化：两次尝试（v0.3.0 于 .wx-msg 层、v0.6.0 于 .wx-msg-body 层）都出现楼中楼显示缺失，
   已移除。不再重试——收益（滚动渲染）远小于风险（内容吞没） */

/* ---- 骨架屏 ---- */
#xhs-wx-root .wx-skeleton-msg { display: flex; gap: 10px; margin-bottom: 18px; }
#xhs-wx-root .wx-sk-avatar {
  width: 38px; height: 38px; border-radius: 6px; flex: none; background: var(--sk, #e6e6e6);
  animation: wx-shimmer 1.3s ease-in-out infinite;
}
#xhs-wx-root .wx-sk-body { display: flex; flex-direction: column; gap: 10px; flex: 1; max-width: 62%; }
#xhs-wx-root .wx-sk-line {
  height: 14px; border-radius: 4px; background: var(--sk, #e6e6e6);
  animation: wx-shimmer 1.3s ease-in-out infinite;
}
#xhs-wx-root .wx-sk-block {
  border-radius: 8px; background: var(--sk, #e6e6e6);
  animation: wx-shimmer 1.3s ease-in-out infinite;
}
#xhs-wx-root.dark { --sk: #2f2f2f; }
@keyframes wx-shimmer { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
`;

  function injectCss() {
    if (document.getElementById("xhs-wx-style")) return;
    const style = document.createElement("style");
    style.id = "xhs-wx-style";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ============================== toast ============================== */

  let toastTimer = null;
  function toast(message, type = "info") {
    const root = ensureRoot();
    let el = root.querySelector(".wx-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "wx-toast";
      root.appendChild(el);
    }
    el.textContent = message;
    el.style.color = type === "error" ? "#ffd0d0" : type === "success" ? "#c8f7c5" : "#fff";
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = "none"; }, 2200);
  }

  /* ============================== 设置 ============================== */

  function isEnabled() {
    return storeGet(STORE_KEYS.enabled, true) !== false;
  }

  function setEnabled(next) {
    storeSet(STORE_KEYS.enabled, next);
    location.reload();
  }

  function isDark() {
    return storeGet(STORE_KEYS.dark, false) === true;
  }

  function applyDark(on) {
    const rootEl = ensureRoot();
    rootEl.classList.toggle("dark", on);
    const btn = rootEl.querySelector("#wx-theme");
    if (btn) {
      btn.textContent = on ? "☀" : "🌙";
      btn.title = on ? "切换为浅色模式" : "切换为暗黑模式";
    }
  }

  // View Transitions 渐进增强封装：支持则做平滑过渡，不支持则直接执行回调（零风险降级）
  function withViewTransition(updateFn) {
    if (document.hidden) return updateFn(); // 后台标签页不做过渡（省资源）
    if (typeof document.startViewTransition === "function") {
      try {
        return document.startViewTransition(updateFn);
      } catch (e) {
        return updateFn();
      }
    }
    return updateFn();
  }

  function toggleDark() {
    const next = !isDark();
    storeSet(STORE_KEYS.dark, next);
    // 主题切换：浏览器对整块 UI 做 cross-fade 过渡（CSS transition 只覆盖部分属性）
    withViewTransition(() => applyDark(next));
  }

  /* 详情页字号缩放（仅作用于右栏详情区，持久化） */
  function getFontScale() {
    const v = Number(storeGet(STORE_KEYS.fontScale, 1));
    return isFinite(v) && v >= 0.8 && v <= 1.5 ? v : 1;
  }

  function applyFontScale() {
    ensureRoot().style.setProperty("--wx-detail-zoom", String(getFontScale()));
  }

  function stepFontScale(delta) {
    const next = Math.min(1.5, Math.max(0.8, Math.round((getFontScale() + delta) * 10) / 10));
    storeSet(STORE_KEYS.fontScale, next);
    applyFontScale();
    toast("详情页字号 " + Math.round(next * 100) + "%", "info");
  }

  function getSeenMap() {
    return storeGet(STORE_KEYS.seenMap, {});
  }

  /* ============================== 全局状态 ============================== */

  const state = {
    notes: [],            // 左栏笔记会话 {noteId,url,title,cover,author,authorUrl,likeCount}
    notesIndex: new Map(),
    activeNote: null,     // 当前打开的笔记对象
    activeDetail: null,   // 当前笔记的渲染数据（正文+评论）
    myUserId: "",
    myNickname: "",
    myAvatar: "",
    loggedIn: null,      // null=未知，true/false 来自 SSR user.loggedIn 与侧栏 DOM
    keyword: "",
    listBottomHits: 0,
    frameSeq: 0,          // iframe 加载序号（防切换错乱）
    frameBusy: false,
    navTab: "chat",
  };

  function getMyProfileFromDom() {
    try {
      // 侧边栏真实容器为 .channel-list-content（实测），"我"的入口是其内的 /user/profile/ 链接
      const link = document.querySelector('.channel-list-content a[href*="/user/profile/"]');
      if (link) {
        state.loggedIn = true; // 侧边栏有"我"的入口 = 已登录
        state.myUserId = uidFromProfileHref(link.getAttribute("href")) || state.myUserId;
        const img = link.querySelector("img");
        if (img && (img.src || img.getAttribute("data-src"))) {
          state.myAvatar = (img.getAttribute("data-src") || img.src).replace(/^http:\/\//i, "https://");
        }
        log("侧边栏身份：", state.myUserId, state.myNickname || "");
      }
    } catch (e) { /* 忽略 */ }
  }

  // 从笔记页 SSR 数据提取当前登录用户（最可靠的身份来源；登录后 userInfo 才有值）
  function extractMyProfileFromState(stateJson) {
    try {
      const u = stateJson && stateJson.user;
      if (u && typeof u.loggedIn === "boolean") state.loggedIn = u.loggedIn; // 登录态权威来源
      if (!u || !u.userInfo || !u.userInfo.userId) {
        log("SSR 身份提取：未取到 userInfo（loggedIn=", u && u.loggedIn, "）");
        return false;
      }
      const info = u.userInfo;
      state.myUserId = info.userId;
      if (info.nickname) state.myNickname = info.nickname;
      let avatar = info.avatar || "";
      if (!avatar && Array.isArray(info.images) && info.images.length) {
        const first = info.images[0] || {};
        avatar = first.url || (first.infoList && first.infoList.length ? first.infoList[first.infoList.length - 1].url : "") || "";
      } else if (!avatar && info.images && info.images.avatar) {
        avatar = info.images.avatar;
      }
      if (avatar) state.myAvatar = avatar.replace(/^http:\/\//i, "https://");
      log("SSR 身份提取成功：", info.userId, info.nickname || "");
      return true;
    } catch (e) {
      warn("SSR 身份提取异常", e);
      return false;
    }
  }

  /* ============================== 详情缓存 ============================== */

  // noteId -> { at, videoAt, detail }（含评论）。命中则秒开，跳过 fetch/iframe 等待
  const detailCache = new Map();
  const DETAIL_TTL = 10 * 60 * 1000;      // 详情/评论缓存 10 分钟
  const VIDEO_URL_TTL = 60 * 60 * 1000;   // 视频 URL 带签名，按 1 小时计
  const DETAIL_CACHE_MAX = 30;

  function cacheGetDetail(noteId) {
    const hit = detailCache.get(noteId);
    if (!hit) return null;
    const fresh = Date.now() - hit.at < DETAIL_TTL;
    const videoFresh = !hit.detail || !hit.detail.videoUrl || Date.now() - (hit.videoAt || 0) < VIDEO_URL_TTL;
    if (!fresh || !videoFresh) {
      detailCache.delete(noteId);
      return null;
    }
    // LRU：命中后移到最新
    detailCache.delete(noteId);
    detailCache.set(noteId, hit);
    return hit.detail;
  }

  function cachePutDetail(noteId, detail) {
    if (!detail) return;
    const prev = detailCache.get(noteId);
    detailCache.set(noteId, {
      at: Date.now(),
      videoAt: prev && prev.detail && prev.detail.videoUrl === detail.videoUrl ? prev.videoAt : Date.now(),
      detail,
    });
    while (detailCache.size > DETAIL_CACHE_MAX) {
      detailCache.delete(detailCache.keys().next().value);
    }
  }

  /* ============================== UI 骨架 ============================== */

  function ensureRoot() {
    let el = document.getElementById(ROOT_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = ROOT_ID;
    el.innerHTML = `
      <header class="wx-top">
        <div class="wx-brand"><span class="wx-brand-dot"></span>小红书 · 微信模式</div>
        <button type="button" class="wx-top-btn" id="wx-theme" title="切换为暗黑模式">🌙</button>
        <button type="button" class="wx-top-btn" id="wx-refresh" title="刷新列表">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.1-5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M19.5 5.2v4.3h-4.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="wx-top-tip">滚动左栏可加载更多笔记</span>
      </header>
      <div class="wx-main">
        <nav class="wx-navrail" aria-label="主导航">
          <div class="wx-nav-avatar-wrap" id="wx-my-avatar-wrap" title="我">
            <img class="wx-nav-avatar" id="wx-my-avatar" alt="我" />
          </div>
          <button type="button" class="wx-nav-btn active" data-tab="chat" title="笔记">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 6.5c0-1.4 1.1-2.5 2.5-2.5h11c1.4 0 2.5 1.1 2.5 2.5v8c0 1.4-1.1 2.5-2.5 2.5H11l-3.8 2.7c-.5.35-1.2 0-1.2-.6V17H6.5C5.1 17 4 15.9 4 14.5v-8z" fill="currentColor"/></svg>
          </button>
          <button type="button" class="wx-nav-btn" data-tab="settings" title="设置">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
          </button>
          <div class="wx-nav-spacer"></div>
          <button type="button" class="wx-nav-btn" id="wx-exit" title="切回原版界面">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9.5 4.5v4h-5v11h11v-5h4v-10h-10z M13.5 8.5l6-6m0 0h-4.5m4.5 0v4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </nav>
        <aside class="wx-aside" id="wx-aside">
          <div class="wx-search">
            <input id="wx-filter" type="search" placeholder="搜索标题 / 作者" autocomplete="off" />
          </div>
          <div class="wx-list" id="wx-list"></div>
        </aside>
        <div class="wx-resize-col" id="wx-resize-col" title="拖动调整宽度 · 双击还原"></div>
        <section class="wx-detail">
          <div class="wx-detail-head">
            <div class="wx-detail-title" id="wx-detail-title">选择左侧笔记查看</div>
            <div class="wx-detail-actions">
              <button type="button" class="wx-link-btn" id="wx-font-dec" title="缩小详情页字号">A−</button>
              <button type="button" class="wx-link-btn" id="wx-font-inc" title="放大详情页字号">A+</button>
              <button type="button" class="wx-link-btn" id="wx-like-toggle" hidden>点赞</button>
              <button type="button" class="wx-link-btn" id="wx-collect-toggle" hidden>收藏</button>
              <a class="wx-link-btn" id="wx-open-origin" href="#" target="_blank" rel="noopener">原页</a>
            </div>
          </div>
          <div class="wx-detail-body" id="wx-detail-body">
            <div class="wx-empty-detail">
              <div class="icon">◎</div>
              <div>点击左侧列表查看笔记</div>
            </div>
          </div>
          <div class="wx-composer" id="wx-composer" hidden>
            <div class="wx-composer-inner">
              <div id="wx-input" class="wx-input" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="评论一下…"></div>
              <div class="wx-composer-bar">
                <span class="wx-composer-tip" id="wx-composer-tip"></span>
                <button type="button" class="wx-send" id="wx-send" disabled>发送</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    `;
    (document.body || document.documentElement).appendChild(el);
    bindRootEvents(el);
    applyStoredLeftWidth(el);
    return el;
  }

  function applyStoredLeftWidth(rootEl) {
    const w = Number(storeGet(STORE_KEYS.leftWidth, 0));
    if (w >= 220 && w <= 480) {
      rootEl.querySelector("#wx-aside").style.width = w + "px";
    }
  }

  function bindRootEvents(rootEl) {
    // 刷新：重扫当前 DOM
    rootEl.querySelector("#wx-refresh").addEventListener("click", () => {
      scanFeed(true);
      toast("已刷新列表", "success");
    });

    // 暗黑模式切换
    rootEl.querySelector("#wx-theme").addEventListener("click", toggleDark);

    // 详情页字号缩放
    rootEl.querySelector("#wx-font-inc").addEventListener("click", () => stepFontScale(0.1));
    rootEl.querySelector("#wx-font-dec").addEventListener("click", () => stepFontScale(-0.1));

    // 退出微信模式
    rootEl.querySelector("#wx-exit").addEventListener("click", () => {
      setEnabled(false);
    });

    // 导航
    rootEl.querySelectorAll(".wx-nav-btn[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchNav(btn.dataset.tab));
    });

    // 搜索（150ms 防抖，避免每个按键都全量重建列表）
    const filterInput = rootEl.querySelector("#wx-filter");
    let filterTimer = null;
    filterInput.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        state.keyword = filterInput.value.trim().toLowerCase();
        renderList();
      }, 150);
    });

    // 列表滚动到底 -> 驱动原页面加载更多 feed
    const listEl = rootEl.querySelector("#wx-list");
    listEl.addEventListener("scroll", () => {
      if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 60) {
        triggerFeedLoadMore();
      }
    });

    // 列表事件委托（click + 悬停预取/预热）：容器级一次绑定，替代每项三个监听器
    let hoverNoteId = null;
    let hoverFetchTimer = null;
    let hoverWarmTimer = null;
    const clearHoverTimers = () => {
      clearTimeout(hoverFetchTimer);
      clearTimeout(hoverWarmTimer);
    };
    listEl.addEventListener("click", (e) => {
      const item = e.target.closest(".wx-item");
      if (!item) return;
      const note = state.notesIndex.get(item.dataset.noteId);
      if (note) openNote(note);
    });
    listEl.addEventListener("mouseover", (e) => {
      const item = e.target.closest(".wx-item");
      const id = item ? item.dataset.noteId : null;
      if (id === hoverNoteId) return;
      clearHoverTimers();
      hoverNoteId = id;
      if (!id) return;
      const note = state.notesIndex.get(id);
      if (!note) return;
      // 悬停 400ms 预取正文；650ms 预热页面——门控是「评论未就绪」而非「无缓存」
      hoverFetchTimer = setTimeout(() => prefetchNoteDetail(note), 400);
      hoverWarmTimer = setTimeout(() => {
        const hit = detailCache.get(note.noteId);
        if (!hit || !hit.detail || !hit.detail.comments) warmFrameFor(note);
      }, 650);
    });
    listEl.addEventListener("mouseleave", () => {
      clearHoverTimers();
      hoverNoteId = null;
    });

    // 拖拽调宽
    bindResize(rootEl);

    // 输入框（placeholder 用 .empty 类维护，规避 contenteditable 的 :empty 失效问题）
    const input = rootEl.querySelector("#wx-input");
    const sendBtn = rootEl.querySelector("#wx-send");
    input.classList.add("empty");
    const syncComposerState = () => {
      const hasContent = !!(input.textContent || "").trim();
      sendBtn.disabled = !hasContent;
      input.classList.toggle("empty", !hasContent);
    };
    input.addEventListener("input", syncComposerState);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!sendBtn.disabled) sendBtn.click();
      }
    });
    sendBtn.addEventListener("click", () => submitComment());

    // 顶栏点赞/收藏按钮
    rootEl.querySelector("#wx-like-toggle").addEventListener("click", () => actInteract("like"));
    rootEl.querySelector("#wx-collect-toggle").addEventListener("click", () => actInteract("collect"));

    // 图片入场淡显：load 事件不冒泡，用捕获阶段委托（rootEl 绑定一次）
    rootEl.addEventListener(
      "load",
      (e) => {
        const t = e.target;
        if (t && t.tagName === "IMG") t.classList.add("wx-img-in");
      },
      true
    );
    // 图片加载失败兜底：隐藏裂图，露出底色占位（error 同样不冒泡，捕获委托）
    rootEl.addEventListener(
      "error",
      (e) => {
        const t = e.target;
        if (t && t.tagName === "IMG") t.classList.add("wx-img-broken");
      },
      true
    );

    // 详情区事件委托（一次性）
    bindDetailEventsOnce(rootEl);
  }

  function bindResize(rootEl) {
    const col = rootEl.querySelector("#wx-resize-col");
    const aside = rootEl.querySelector("#wx-aside");
    let dragging = false;
    col.addEventListener("mousedown", (e) => {
      dragging = true;
      col.classList.add("dragging");
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rootRect = rootEl.getBoundingClientRect();
      const w = Math.min(480, Math.max(220, e.clientX - rootRect.left - 56));
      aside.style.width = w + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      col.classList.remove("dragging");
      storeSet(STORE_KEYS.leftWidth, parseFloat(aside.style.width) || 300);
    });
    col.addEventListener("dblclick", () => {
      aside.style.width = "300px";
      storeSet(STORE_KEYS.leftWidth, 300);
    });
  }

  function switchNav(tab) {
    state.navTab = tab;
    const rootEl = ensureRoot();
    rootEl.querySelectorAll(".wx-nav-btn[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    const list = rootEl.querySelector("#wx-list");
    if (tab === "settings") {
      renderSettings(list);
    } else {
      renderList();
    }
  }

  /* ============================== feed 扫描 ============================== */

  function scanFeed(force) {
    const items = document.querySelectorAll(".note-item");
    const fresh = [];
    for (const item of items) {
      if (!force && scannedItems.has(item)) continue;
      scannedItems.add(item);
      fresh.push(item);
    }
    if (!fresh.length) {
      if (force && state.navTab === "chat") renderList();
      return 0;
    }
    // 解析分片：一次解析几十张卡片可能超出一帧，按 8ms 切片让出主线程，完成后统一追加
    const added = [];
    runChunked(fresh, (item) => {
      const note = parseNoteItem(item);
      if (!note || !note.noteId) return;
      if (!state.notesIndex.has(note.noteId)) {
        state.notesIndex.set(note.noteId, note);
        state.notes.push(note);
        added.push(note);
      } else if (force) {
        // 刷新时更新已有条目的最新数据
        Object.assign(state.notesIndex.get(note.noteId), note);
      }
    }).then(() => {
      if (added.length > 0) {
        log("feed 扫描：新增", added.length, "条，总计", state.notes.length);
        if (state.navTab === "chat") {
          if (state.keyword) {
            renderList(); // 搜索态下全量重建
          } else {
            appendListItems(added); // 常规增量追加，避免闪烁
          }
        }
      } else if (force) {
        if (state.navTab === "chat") renderList();
      }
    });
    return fresh.length;
  }

  function parseNoteItem(item) {
    try {
      const coverLink = item.querySelector("a.cover[href]") || item.querySelector('a[href*="/explore/"]');
      const href = coverLink ? coverLink.getAttribute("href") : "";
      const noteId = noteIdFromHref(href);
      if (!noteId) return null;
      const titleEl = item.querySelector(".title");
      const title = titleEl ? titleEl.textContent.trim() : "";
      const authorEl = item.querySelector(".author .name");
      const author = authorEl ? authorEl.textContent.trim() : "";
      const authorUrl = authorEl ? (authorEl.getAttribute("href") || "") : "";
      const countEl = item.querySelector(".like-wrapper .count");
      const likeCount = countEl ? countEl.textContent.trim() : "";
      const img = item.querySelector(".cover img, img");
      let cover = "";
      if (img) cover = img.getAttribute("src") || "";
      return {
        noteId,
        url: new URL(href, location.origin).href,
        title: title || "(无标题)",
        cover,
        author,
        authorUrl: authorUrl ? new URL(authorUrl, location.origin).href : "",
        likeCount,
      };
    } catch (e) {
      warn("解析卡片失败", e);
      return null;
    }
  }

  // 已解析过的卡片元素（WeakSet 增量扫描，避免重复 parse）
  const scannedItems = new WeakSet();

  // 观察器：优先盯 feed 容器本身；回调防抖，只做增量扫描
  let scanDebounceTimer = null;
  function observeFeed() {
    const target = document.querySelector(".feeds-container") || document.body;
    const mo = new MutationObserver(() => {
      if (scanDebounceTimer) return;
      scanDebounceTimer = setTimeout(() => {
        scanDebounceTimer = null;
        scanFeed(false);
      }, 150);
    });
    mo.observe(target, { childList: true, subtree: true });
    // 容器兜底：若 React 重建了 feed 容器（observer 失效），通过 body 级观察自愈
    if (target !== document.body) {
      const guard = new MutationObserver(() => {
        const fresh = document.querySelector(".feeds-container");
        if (fresh && fresh !== target) {
          guard.disconnect();
          mo.disconnect();
          observeFeed();
          scanFeed(false);
        }
      });
      guard.observe(document.body, { childList: true, subtree: false });
    }
    log("MutationObserver 已启动，观察目标：", target === document.body ? "body" : ".feeds-container");
  }

  // 驱动原页面滚动，触发小红书 feed 无限加载
  let feedLoadTimer = null;
  function triggerFeedLoadMore() {
    if (feedLoadTimer) return;
    feedLoadTimer = setTimeout(() => {
      feedLoadTimer = null;
      try {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
        log("已驱动原页面滚动加载更多 feed");
      } catch (e) { /* 忽略 */ }
    }, 400);
    showListLoading();
  }

  let listLoadingEl = null;
  function showListLoading() {
    const rootEl = ensureRoot();
    const list = rootEl.querySelector("#wx-list");
    if (list.querySelector(".wx-list-loading")) return;
    listLoadingEl = document.createElement("div");
    listLoadingEl.className = "wx-list-loading";
    listLoadingEl.textContent = "加载更多笔记…";
    list.appendChild(listLoadingEl);
    setTimeout(() => {
      if (listLoadingEl && listLoadingEl.parentNode) listLoadingEl.remove();
      listLoadingEl = null;
    }, 3000);
  }

  /* ============================== 会话列表渲染 ============================== */

  // 构建单个列表项节点（renderList 与增量追加共用）
  function buildListItem(note, seen) {
    const isUnread = !seen[note.noteId];
    const isActive = state.activeNote && state.activeNote.noteId === note.noteId;
    const div = document.createElement("div");
    div.className = "wx-item" + (isActive ? " active" : "");
    div.dataset.noteId = note.noteId;
    div.innerHTML = `
      ${note.cover ? `<img class="wx-item-cover" loading="lazy" src="${escapeHtml(note.cover)}" alt=""/>` : ""}
      <div class="wx-item-main">
        <div class="wx-item-title">${escapeHtml(note.title)}</div>
        <div class="wx-item-meta">
          <span class="author">${escapeHtml(note.author || "未知作者")}</span>
          <span class="likes">♥ ${escapeHtml(note.likeCount || "0")}</span>
        </div>
      </div>
      ${isUnread ? '<span class="wx-item-unread"></span>' : ""}
    `;
    // 点击/悬停事件统一在 #wx-list 容器上委托（见 bindRootEvents），避免上千列表项逐条挂监听
    return div;
  }

  // 预取正文（单并发，避免悬停扫过一排时并发拉一堆）
  let prefetchInFlight = false;
  const prefetchDone = new Set();
  let prefetchCooldownUntil = 0; // fetch 失败（可能限流）后的冷却期，暂停一切预取/预热
  function prefetchNoteDetail(note) {
    if (Date.now() < prefetchCooldownUntil) return;
    if (prefetchDone.has(note.noteId) || detailCache.get(note.noteId)) return;
    if (prefetchInFlight) return;
    prefetchInFlight = true;
    fetchNoteDetail(note)
      .then((detail) => {
        prefetchDone.add(note.noteId);
        if (detail) {
          // comments 必须是 undefined（表示"正文就绪、评论未拉"），
          // openNote 命中缓存后会据此继续走 iframe 评论加载；存 [] 会被当成"无评论"
          cachePutDetail(note.noteId, { ...detail, comments: undefined });
          // 图片预灌：把九宫格缩略图灌进浏览器缓存，点开时第一帧从内存直出
          for (const u of detail.images || []) {
            const pre = new Image();
            pre.src = cdnThumb(u, 480);
          }
        }
        log("预取完成：", note.noteId);
      })
      .catch(() => {
        // 预取失败多为限流信号：冷却 60s，暂停预取与预热，给正常浏览让路
        prefetchCooldownUntil = Date.now() + 60 * 1000;
        log("预取失败，进入 60s 冷却");
      })
      .finally(() => { prefetchInFlight = false; });
  }

  // 全量渲染（初始 / 搜索词变化时使用；点击路径走增量更新避免图片重新加载闪动）
  function renderList() {
    const rootEl = ensureRoot();
    const list = rootEl.querySelector("#wx-list");
    const seen = getSeenMap();
    const kw = state.keyword;
    const items = kw
      ? state.notes.filter(
          (n) => n.title.toLowerCase().includes(kw) || (n.author || "").toLowerCase().includes(kw)
        )
      : state.notes;

    if (!items.length) {
      list.innerHTML = `<div class="wx-empty-list">${
        state.notes.length ? "没有匹配的笔记" : "正在获取笔记流…<br/>请稍候或在原页面确认已登录"
      }</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach((note) => frag.appendChild(buildListItem(note, seen)));
    list.innerHTML = "";
    list.appendChild(frag);
  }

  // 增量追加新笔记（不重建已有节点，避免封面图闪烁）
  function appendListItems(newNotes) {
    const rootEl = ensureRoot();
    const list = rootEl.querySelector("#wx-list");
    const emptyTip = list.querySelector(".wx-empty-list");
    if (emptyTip) emptyTip.remove();
    const seen = getSeenMap();
    const frag = document.createDocumentFragment();
    for (const note of newNotes) frag.appendChild(buildListItem(note, seen));
    list.appendChild(frag);
  }

  // 点击路径：只更新高亮与未读标记，不重建列表
  function updateListItemState(note) {
    const rootEl = ensureRoot();
    const list = rootEl.querySelector("#wx-list");
    list.querySelectorAll(".wx-item").forEach((el) => {
      const isActive = el.dataset.noteId === note.noteId;
      el.classList.toggle("active", isActive);
      if (isActive) {
        const dot = el.querySelector(".wx-item-unread");
        if (dot) dot.remove();
      }
    });
  }

  function markNoteSeen(note) {
    const seen = getSeenMap();
    seen[note.noteId] = Date.now();
    // 只保留最近 800 条，避免无限增长
    const ids = Object.keys(seen);
    if (ids.length > 800) {
      ids.sort((a, b) => seen[a] - seen[b]);
      for (const id of ids.slice(0, ids.length - 800)) delete seen[id];
    }
    storeSet(STORE_KEYS.seenMap, seen);
  }

  /* ============================== 笔记加载：正文（SSR） ============================== */

  // fetch 笔记页 -> 解析内嵌 __INITIAL_STATE__
  async function fetchNoteDetail(note) {
    const res = await fetch(note.url, {
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw new Error("笔记页请求失败 HTTP " + res.status);
    const html = await res.text();
    const m = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html);
    if (!m) throw new Error("未找到 __INITIAL_STATE__");
    let stateJson;
    try {
      stateJson = new Function("return (" + m[1] + ");")();
    } catch (e) {
      throw new Error("解析 __INITIAL_STATE__ 失败：" + e.message);
    }
    const detailMap = stateJson && stateJson.note && stateJson.note.noteDetailMap;
    if (!detailMap) throw new Error("noteDetailMap 不存在");
    // 顺带提取当前登录用户身份（修正导航栏头像与"我的评论"判断）
    if (extractMyProfileFromState(stateJson)) applyMyProfileToUi();
    // 优先精确匹配，否则取第一个
    const entry = detailMap[note.noteId] || Object.values(detailMap)[0];
    const nd = entry && entry.note;
    if (!nd) throw new Error("笔记数据不存在（可能需要登录或链接失效）");
    return normalizeNoteData(nd);
  }

  function normalizeNoteData(nd) {
    const user = nd.user || {};
    const interact = nd.interactInfo || {};
    // 图片列表：图文笔记字段为 url/infoList；视频笔记封面字段为 urlDefault/urlPre
    const images = [];
    for (const img of nd.imageList || []) {
      const url =
        img.url ||
        img.urlDefault ||
        img.urlPre ||
        (img.infoList && img.infoList.length && img.infoList[img.infoList.length - 1].url) ||
        "";
      if (url) images.push(url.replace(/^http:\/\//i, "https://"));
    }
    // 视频播放地址：video.media.stream.h264[0].masterUrl（驼峰字段）；h264 兼容性最好
    let videoUrl = "";
    if (nd.type === "video" && nd.video && nd.video.media && nd.video.media.stream) {
      const streams = nd.video.media.stream;
      const candidates = streams.h264 || streams.h265 || [];
      for (const it of candidates) {
        const u = it.masterUrl || (it.backupUrls && it.backupUrls[0]) || "";
        if (u) {
          videoUrl = u.replace(/^http:\/\//i, "https://");
          break;
        }
      }
      if (!videoUrl) {
        // 兜底：所有编码里逐个找
        for (const codec of Object.values(streams)) {
          if (!Array.isArray(codec)) continue;
          for (const it of codec) {
            const u = it.masterUrl || (it.backupUrls && it.backupUrls[0]) || "";
            if (u) {
              videoUrl = u.replace(/^http:\/\//i, "https://");
              break;
            }
          }
          if (videoUrl) break;
        }
      }
    }
    return {
      noteId: nd.noteId,
      type: nd.type || "normal",
      title: nd.title || "",
      desc: nd.desc || "",
      tagList: (nd.tagList || []).map((t) => ({ id: t.id, name: t.name })),
      time: nd.time || 0,
      ipLocation: nd.ipLocation || "",
      images,
      videoUrl,
      author: {
        userId: user.userId || "",
        nickname: user.nickname || "",
        // 实测小红书 SSR 数据头像在 user.avatar；兼容旧的 images 结构
        avatar: user.avatar || (user.images && (user.images.avatar || user.images.preview)) || "",
        homepage: user.userId ? "https://www.xiaohongshu.com/user/profile/" + user.userId : "",
      },
      interact: {
        liked: !!interact.liked,
        collected: !!interact.collected,
        likedCount: interact.likedCount,
        collectedCount: interact.collectedCount,
        commentCount: interact.commentCount,
        shareCount: interact.shareCount,
      },
    };
  }

  /* ============================== 笔记加载：评论（iframe 引擎） ============================== */

  // 双帧设计：engine（正式引擎，承载评论解析与互动操作）+ warm（预热专用）。
  // 悬停预热只驱动 warm 帧，绝不打断 engine；点击时若 warm 已是该笔记则「提升」为 engine（交换身份）
  function ensureFrame(frameId) {
    let frame = document.getElementById(frameId);
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = frameId;
      Object.assign(frame.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: "1280px",
        height: "900px",
        // 不用 visibility/display 隐藏，避免阻止页面内部懒加载；opacity 0 + 极低层级使其不可见
        opacity: "0",
        zIndex: "-1",
        pointerEvents: "none",
        border: "none",
      });
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      (document.body || document.documentElement).appendChild(frame);
      log("iframe 已创建：", frameId);
    }
    return frame;
  }

  function ensureEngineFrame() {
    return ensureFrame("xhs-wx-engine");
  }

  // 悬停预热：仅驱动 warm 帧（fire-and-forget，不参与等待逻辑，不影响 frameSeq）
  function warmFrameFor(note) {
    if (Date.now() < prefetchCooldownUntil) return; // 冷却期：预热也暂停
    try {
      const warm = ensureFrame("xhs-wx-warm");
      try {
        const href = warm.contentWindow && warm.contentWindow.location && warm.contentWindow.location.href;
        if (href && href.includes(note.noteId)) return; // 该笔记已在预热中
      } catch (e) { /* 忽略 */ }
      warm.src = note.url;
      log("warm 帧预热：", note.noteId);
    } catch (e) { /* 忽略 */ }
  }

  // 打开笔记前调用：若 warm 帧恰好已加载该笔记，把它提升为 engine（原 engine 退位为 warm）
  function promoteWarmFrame(note) {
    try {
      const warm = document.getElementById("xhs-wx-warm");
      if (!warm) return;
      const href = warm.contentWindow && warm.contentWindow.location && warm.contentWindow.location.href;
      if (!href || !href.includes(note.noteId)) return;
      const engine = document.getElementById("xhs-wx-engine");
      const tmpId = "xhs-wx-swap";
      warm.id = tmpId;
      if (engine) engine.id = "xhs-wx-warm";
      warm.id = "xhs-wx-engine";
      log("预热帧已提升为引擎：", note.noteId);
    } catch (e) { /* 忽略 */ }
  }

  // 加载笔记到 iframe，等待正文+评论渲染完成，返回 doc
  function loadNoteInFrame(note, { waitComments = true } = {}) {
    const frame = ensureEngineFrame();
    const seq = ++state.frameSeq;
    const targetUrl = note.url.split("#")[0];
    let currentUrl = "";
    try {
      currentUrl = (frame.contentWindow && frame.contentWindow.location && frame.contentWindow.location.href) || "";
    } catch (e) { /* 忽略 */ }
    const alreadyThere = currentUrl.split("#")[0] === targetUrl && !!frame.contentDocument;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("笔记页加载超时")), 20000);

      function finish(err, doc) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ doc, frame });
      }

      if (alreadyThere) {
        startPolling();
      } else {
        frame.addEventListener("load", () => startPolling(), { once: true });
        frame.src = note.url;
      }

      // 轮询等待评论容器出现（或超时降级为只要正文）
      function startPolling() {
        const started = Date.now();
        (function poll() {
          if (seq !== state.frameSeq) return finish(new Error("已切换到其他笔记"));
          let doc = null;
          try {
            doc = frame.contentDocument;
          } catch (e) {
            return finish(new Error("无法访问引擎页面"));
          }
          if (!doc) {
            if (Date.now() - started > 18000) return finish(new Error("引擎页面不可用"));
            return setTimeout(poll, 300);
          }
          const hasBody = !!doc.querySelector(".note-container, #detail-desc");
          const commentsListed = !!doc.querySelector(".comments-container .comment-item");
          const waited = Date.now() - started;
          if (hasBody && (!waitComments || commentsListed || waited > 8000)) {
            // 再等 600ms 让首批评论尽量渲染完整
            setTimeout(() => {
              if (seq === state.frameSeq) finish(null, doc);
              else finish(new Error("已切换到其他笔记"));
            }, 600);
            return;
          }
          if (!hasBody && waited > 15000) return finish(null, doc); // 降级返回
          setTimeout(poll, 220);
        })();
      }
    });
  }

  // 从 iframe doc 解析评论（含已展开的楼中楼）
  // 实测结构：.list-container > .parent-comment > [.comment-item(一级), .reply-container(楼中楼)]
  // 即 reply-container 与一级评论是兄弟节点（同在 .parent-comment 内），文档序上一级在前，
  // 解析时按文档序把每个 reply-container 归给最近的一级评论
  function parseComments(doc) {
    const container = doc.querySelector(".comments-container");
    if (!container) return { comments: [], totalText: "" };
    const totalEl = container.querySelector(".total, .comments-number, .comment-title");
    const totalText = totalEl ? totalEl.textContent.trim() : "";

    const flat = [...container.querySelectorAll(".comment-item, .reply-container")];
    const comments = [];
    for (const node of flat) {
      if (node.classList.contains("reply-container")) {
        // 楼中楼容器：归给最近的一级评论
        if (!comments.length) continue;
        const parent = comments[comments.length - 1];
        for (const sub of node.querySelectorAll(".comment-item")) {
          if (sub.closest(".reply-container") !== node) continue; // 跳过更深嵌套
          const sc = parseOneComment(sub);
          if (sc) parent.subComments.push(sc);
        }
        const more = node.querySelector(".show-more, .reply-more");
        if (more) parent.moreText = more.textContent.trim();
        continue;
      }
      // 一级评论 = 不处于任何 reply-container 内
      if (node.closest(".reply-container")) continue;
      const c = parseOneComment(node);
      if (c) {
        c.subComments = [];
        comments.push(c);
      }
    }
    return { comments, totalText };
  }

  function parseOneComment(item) {
    // 字段按文档序取第一个（当前评论的节点在楼中楼之前）；无 .name 时回退用 author 区文本
    const authorBox = item.querySelector(".author");
    const nameEl = authorBox && authorBox.querySelector(".name");
    const nameFallback = authorBox ? authorBox.textContent.trim() : "";
    const name = nameEl ? nameEl.textContent.trim() : nameFallback;
    if (!name) return null;
    const authorLink = (nameEl && nameEl.closest("a")) || (authorBox && authorBox.closest("a"));
    const authorHref = authorLink ? authorLink.getAttribute("href") || "" : "";
    const contentEl = item.querySelector(".content");
    const dateEl = item.querySelector(".date");
    const likeEl = item.querySelector(".like");
    // 评论头像实际结构为 .comment-item > .avatar > img（.avatar 与 .author 是兄弟节点）
    const avatarImg =
      item.querySelector(".avatar img") ||
      (authorBox && authorBox.querySelector("img"));
    let avatar = "";
    if (avatarImg) {
      avatar = avatarImg.getAttribute("src") || avatarImg.getAttribute("data-src") || "";
    }
    // “作者”徽标：author 区域内出现红色小标签文本“作者”
    const isAuthor = !!authorBox && /(^|\s)作者(\s|$)/.test(authorBox.textContent || "");
    return {
      author: name,
      authorUrl: authorHref ? new URL(authorHref, "https://www.xiaohongshu.com").href : "",
      userId: uidFromProfileHref(authorHref),
      avatar,
      content: contentEl ? contentEl.textContent.trim() : "",
      // 富内容 HTML：按原位置内联表情图/评论图片（textContent 会把图全部丢掉）
      contentHtml: serializeCommentContent(contentEl),
      date: dateEl ? dateEl.textContent.trim() : "",
      likeText: likeEl ? likeEl.textContent.trim() : "",
      isAuthor,
    };
  }

  // 评论富内容序列化：文字转义保留，img 按类型标记（emoji 小表情内联；普通图片块级可点开），br 转换行
  function serializeCommentContent(el) {
    if (!el) return "";
    const parts = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          // 文本节点
          parts.push(escapeHtml(child.textContent));
        } else if (child.nodeType === 1) {
          const tag = child.tagName;
          if (tag === "IMG") {
            const src = child.getAttribute("src") || child.getAttribute("data-src") || "";
            if (src) {
              const isEmoji = /emoji/i.test(child.getAttribute("class") || "");
              parts.push(
                `<img class="${isEmoji ? "wx-c-emoji" : "wx-c-img"}" src="${escapeHtml(src)}" alt=""/>`
              );
            }
          } else if (tag === "BR") {
            parts.push("\n");
          } else {
            walk(child); // 嵌套容器递归
          }
        }
      }
    };
    walk(el);
    return parts.join("").trim();
  }

  /* ============================== 打开笔记 & 渲染 ============================== */

  /* 跟读预取（深度 1）：打开第 i 条时自动预取下一条的正文+图片；页面预热待引擎空闲后执行。
   * 门控要点：预热条件是「评论未就绪」而非「无缓存」——正文预取成功后缓存必有值，
   * 若按无缓存判断则预取越成功、预热越不执行（方向相反的坑）。
   * 预热时机：事件驱动（当前笔记评论渲染完成后释放）+ 8s 兜底，避免与引擎帧抢带宽。
   * 保护：设置可关；页面切后台暂停 */
  let pendingWarm = null; // { noteId, note, timer }：待引擎空闲后执行的预热

  function clearPendingWarm() {
    if (pendingWarm) {
      clearTimeout(pendingWarm.timer);
      pendingWarm = null;
    }
  }

  function queueWarmAfterEngineIdle(note) {
    clearPendingWarm();
    const entry = { noteId: note.noteId, note, timer: 0 };
    entry.timer = setTimeout(releasePendingWarm, 8000); // 兜底：评论加载迟迟不完成也要预热
    pendingWarm = entry;
  }

  // 引擎空闲（当前笔记评论已渲染/加载结束）时调用，真正执行 warm
  function releasePendingWarm() {
    const entry = pendingWarm;
    if (!entry) return;
    pendingWarm = null;
    clearTimeout(entry.timer);
    if (document.hidden) return;
    if (storeGet(STORE_KEYS.followPrefetch, true) === false) return;
    const hit = detailCache.get(entry.noteId);
    // 评论未就绪才需要预热（正文已缓存但 comments 为 undefined 的，正是预热目标）
    if (!hit || !hit.detail || !hit.detail.comments) warmFrameFor(entry.note);
  }

  function followUpPrefetch(currentNote) {
    if (storeGet(STORE_KEYS.followPrefetch, true) === false) return;
    if (document.hidden) return;
    const idx = state.notes.findIndex((n) => n.noteId === currentNote.noteId);
    if (idx < 0 || idx + 1 >= state.notes.length) return;
    const next = state.notes[idx + 1];
    prefetchNoteDetail(next);       // 正文+图片（轻，立即）
    queueWarmAfterEngineIdle(next); // 页面预热（重，等引擎空闲，8s 兜底）
  }

  async function openNote(note) {
    state.activeNote = note;
    markNoteSeen(note);
    updateListItemState(note); // 增量更新高亮与未读点，不重建列表
    resetCommentPaging();      // 重置评论分批状态
    promoteWarmFrame(note);    // warm 帧恰好预热了这篇则提升为引擎，复用已加载页面
    followUpPrefetch(note);    // 跟读预取：后台备好下一条
    const rootEl = ensureRoot();
    const composer = rootEl.querySelector("#wx-composer");
    const titleEl = rootEl.querySelector("#wx-detail-title");
    const openBtn = rootEl.querySelector("#wx-open-origin");

    titleEl.textContent = note.title;
    openBtn.href = note.url;
    composer.hidden = false;

    // 缓存命中：直接渲染，秒开。预取缓存（无评论）需继续走 iframe 评论加载
    const cached = cacheGetDetail(note.noteId);
    if (cached) {
      state.activeDetail = cached;
      renderDetailShell();
      renderCommentsInto();
      updateInteractButtons();
      if (!cached.comments) {
        try {
          const { doc } = await loadNoteInFrame(note, { waitComments: true });
          if (!state.activeNote || state.activeNote.noteId !== note.noteId) return;
          const frameState = extractFrameState(doc);
          const parsed = parseComments(doc);
          state.activeDetail.comments = parsed.comments;
          state.activeDetail.totalText = parsed.totalText;
          if (frameState.interact) {
            state.activeDetail.interact = { ...state.activeDetail.interact, ...frameState.interact };
          }
          renderCommentsInto(true);
          updateInteractButtons();
          cachePutDetail(note.noteId, state.activeDetail);
          releasePendingWarm(); // 引擎空闲，启动下一条的预热
      setTimeout(() => maybeLoadMoreComments(), 600); // 评论首屏就位后自动续载
        } catch (e) {
          releasePendingWarm(); // 加载失败也让出引擎
          if (state.activeNote && state.activeNote.noteId === note.noteId) {
            state.activeDetail.commentError = e.message;
            renderCommentsInto();
          }
        }
      } else {
        // 评论已就绪：引擎加载完（不等待评论）即释放预热
        loadNoteInFrame(note, { waitComments: false })
          .then(() => releasePendingWarm())
          .catch(() => releasePendingWarm());
      }
      return;
    }

    const body = rootEl.querySelector("#wx-detail-body");
    body.innerHTML = renderSkeleton();
    rootEl.querySelector("#wx-like-toggle").hidden = true;
    rootEl.querySelector("#wx-collect-toggle").hidden = true;

    // 正文与评论并行：SSR fetch 快，先画正文；iframe 到位后只更新评论区
    let detail = null;
    try {
      detail = await fetchNoteDetail(note);
    } catch (e) {
      warn("SSR 解析失败", e);
    }

    // 若已切换笔记则放弃渲染
    if (!state.activeNote || state.activeNote.noteId !== note.noteId) return;
    state.activeDetail = { ...(detail || {}), comments: undefined, commentError: detail ? "" : "正文加载失败，正在从页面重试…" };
    // 正文从骨架到内容：View Transition 平滑 morph（不支持的浏览器直接替换）
    withViewTransition(() => renderDetailShell());

    // iframe：评论 + 互动操作载体 + 正文兜底
    try {
      const { doc } = await loadNoteInFrame(note, { waitComments: true });
      if (!state.activeNote || state.activeNote.noteId !== note.noteId) return;
      // 正文兜底（SSR fetch 失败/被限流时）：优先从 iframe 文档内嵌的 __INITIAL_STATE__
      // 提取（与主路径同源、最可靠），失败再退 DOM 解析
      if (!detail || !detail.desc) {
        let fallback = extractInitialStateFromDoc(doc);
        if (!fallback) fallback = parseNoteFromFrameDoc(doc);
        if (fallback) {
          state.activeDetail = { ...fallback, ...state.activeDetail, comments: state.activeDetail.comments };
          withViewTransition(() => renderDetailShell()); // 重画一次正文（仅失败兜底场景）
        } else if (!detail) {
          state.activeDetail.bodyError = true; // 全部兜底失败：明确告知而非“（无正文）”
          withViewTransition(() => renderDetailShell());
        }
      }
      // 用 iframe 里的实时数据修正互动状态（点赞状态 SSR 里拿到的可能不准）
      const frameState = extractFrameState(doc);
      const parsed = parseComments(doc);
      state.activeDetail.comments = parsed.comments;
      state.activeDetail.totalText = parsed.totalText;
      state.activeDetail.commentError = "";
      if (frameState.interact) {
        state.activeDetail.interact = { ...state.activeDetail.interact, ...frameState.interact };
      }
      renderCommentsInto(true); // 只更新评论区，正文图片不重载
      updateInteractButtons();
      cachePutDetail(note.noteId, state.activeDetail);
      releasePendingWarm(); // 引擎空闲，启动下一条的预热
      setTimeout(() => maybeLoadMoreComments(), 600); // 评论首屏就位后自动续载
      log("评论加载完成：", parsed.comments.length, "条一级评论");
    } catch (e) {
      warn("评论加载失败", e);
      releasePendingWarm(); // 失败也让出引擎，别让下一条的预热卡到兜底超时
      if (state.activeNote && state.activeNote.noteId === note.noteId) {
        state.activeDetail.commentError = e.message;
        renderCommentsInto();
      }
    }
  }

  // SSR 失败时从 iframe 渲染结果兜底解析正文（尽力而为）
  // 优先级更高的路径：iframe 文档内嵌的 __INITIAL_STATE__（与主路径同源）
  function extractInitialStateFromDoc(doc) {
    try {
      const html = doc.documentElement.innerHTML;
      const m = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html);
      if (!m) return null;
      const stateJson = new Function("return (" + m[1] + ");")();
      const detailMap = stateJson && stateJson.note && stateJson.note.noteDetailMap;
      if (!detailMap) return null;
      const entry = Object.values(detailMap)[0];
      const nd = entry && entry.note;
      if (!nd) return null;
      log("iframe 内嵌状态兜底成功");
      return normalizeNoteData(nd);
    } catch (e) {
      return null;
    }
  }

  function parseNoteFromFrameDoc(doc) {
    try {
      const titleEl = doc.querySelector("#detail-desc .title, .note-content .title");
      const descEl = doc.querySelector("#detail-desc .desc, .note-content .desc");
      const userEl = doc.querySelector(".author-container .username, .author-container a");
      const avatarEl = doc.querySelector(".author-container img");
      const dateEl = doc.querySelector(".author-container .date, #detail-desc .date");
      if (!titleEl && !descEl && !userEl) return null;
      const imgs = [...doc.querySelectorAll(".media-container img")]
        .map((i) => i.src || i.getAttribute("data-src") || "")
        .filter(Boolean)
        .map((u) => u.replace(/^http:\/\//i, "https://"));
      const userHref = userEl ? userEl.getAttribute("href") || "" : "";
      return {
        title: titleEl ? titleEl.textContent.trim() : "",
        desc: descEl ? descEl.textContent.trim() : "",
        author: {
          nickname: userEl ? userEl.textContent.trim() : "",
          avatar: avatarEl ? avatarEl.src.replace(/^http:\/\//i, "https://") : "",
          userId: uidFromProfileHref(userHref),
        },
        images: imgs,
        tagList: [],
        interact: {},
        ipLocation: dateEl ? dateEl.textContent.trim() : "",
        time: 0,
      };
    } catch (e) {
      return null;
    }
  }

  /* ============================== 评论分批加载 ============================== */

  // 统计 iframe 中当前已渲染的一级评论数
  function countFrameComments(doc) {
    const box = doc.querySelector(".comments-container");
    if (!box) return 0;
    return [...box.querySelectorAll(".comment-item")].filter(
      (el) => !el.parentElement.closest(".comment-item") && !el.closest(".reply-container")
    ).length;
  }

  // 驱动 iframe 内部滚动触发小红书评论翻页，等待新评论渲染。返回本轮新增一级评论数
  async function loadMoreComments(doc) {
    const before = countFrameComments(doc);
    // 多管齐下：滚动评论容器（多种候选）+ 滚动 iframe 页面
    try {
      for (const sel of [".note-scroller", ".comments-el", ".comments-container"]) {
        for (const el of doc.querySelectorAll(sel)) {
          try { el.scrollTop = el.scrollHeight; } catch (e) { /* 忽略 */ }
        }
      }
      const win = doc.defaultView;
      if (win) {
        try {
          win.scrollTo(0, win.document.documentElement.scrollHeight);
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
    // 轮询等待新评论出现（最多 3.5s）
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      const now = countFrameComments(doc);
      if (now > before) {
        await sleep(400); // 再等一小会儿让本批渲染完整
        return countFrameComments(doc) - before;
      }
    }
    return 0;
  }

  // 评论唯一键（增量渲染的锚点比对用）
  function commentKey(c) {
    if (!c) return "\u0000";
    return (c.userId || c.author || "") + "|" + (c.content || "").slice(0, 80);
  }

  // 详情区滚动到底时自动加载下一页评论
  let commentsLoadingMore = false;
  let commentsNoMore = false;
  let commentsNoMoreAttempts = 0;
  async function maybeLoadMoreComments() {
    const note = state.activeNote;
    const detail = state.activeDetail;
    if (!note || !detail || commentsLoadingMore || commentsNoMore) return;
    if (!detail.comments || detail.commentError) return;
    const doc = frameDocFor(note);
    if (!doc || !doc.querySelector(".comments-container")) return;

    commentsLoadingMore = true;
    setMoreCommentsStatus("正在加载更多评论…");
    try {
      const added = await loadMoreComments(doc);
      if (!state.activeNote || state.activeNote.noteId !== note.noteId) return; // 已切换笔记，丢弃
      if (added > 0) {
        commentsNoMoreAttempts = 0;
        const parsed = parseComments(doc);
        const prevComments = (state.activeDetail && state.activeDetail.comments) || [];
        const prevLen = prevComments.length;
        // 头部插入检测：新结果的第 prevLen-1 条必须仍是原来的最后一条（锚点比对），
        // 保证增量追加安全；锚点对不上说明结构变化（如头部插入/重排），走全量重绘
        const anchorOk =
          prevLen > 0 &&
          parsed.comments.length > prevLen &&
          commentKey(parsed.comments[prevLen - 1]) === commentKey(prevComments[prevLen - 1]);
        state.activeDetail.comments = parsed.comments;
        state.activeDetail.totalText = parsed.totalText;
        if (anchorOk) {
          appendCommentNodes(parsed.comments.slice(prevLen), prevLen); // 增量追加，不重排已有评论
        } else {
          renderCommentsInto(); // 首批（prevLen=0）或结构变化时全量渲染
        }
        cachePutDetail(note.noteId, state.activeDetail);
        setMoreCommentsStatus("");
        log("评论分批：新增", added, "条，累计", state.activeDetail.comments.length);
        // 自动续载：用户仍在底部附近时继续拉下一批（滚动事件不会因追加内容而触发）
        const body = ensureRoot().querySelector("#wx-detail-body");
        if (body && body.scrollTop + body.clientHeight >= body.scrollHeight - 300) {
          setTimeout(() => maybeLoadMoreComments(), 350);
        }
      } else {
        // 零新增：可能是网络慢。总数承诺还有更多时重试（最多 2 次），否则判定到底
        commentsNoMoreAttempts++;
        const totalPromised = parseTotalFromTotalText(detail.totalText);
        const hasMore = !totalPromised || totalPromised > detail.comments.length;
        if (hasMore && commentsNoMoreAttempts <= 2) {
          setMoreCommentsStatus("网络较慢，正在重试加载评论…");
          setTimeout(() => {
            commentsLoadingMore = false;
            maybeLoadMoreComments();
            return;
          }, 1600);
          return;
        }
        commentsNoMore = true;
        setMoreCommentsStatus(detail.comments.length ? "评论已全部加载" : "");
      }
    } finally {
      commentsLoadingMore = false;
    }
  }

  // 从「共 44 条评论」等文案中提取总数
  function parseTotalFromTotalText(text) {
    const m = /(\d+)/.exec(String(text || "").replace(/万/, "0000"));
    return m ? parseInt(m[1], 10) : 0;
  }

  // 评论区底部状态行
  function setMoreCommentsStatus(text) {
    const rootEl = ensureRoot();
    const box = rootEl.querySelector("#wx-comments");
    if (!box) return;
    let el = box.querySelector("#wx-comments-status");
    if (!el) {
      el = document.createElement("div");
      el.id = "wx-comments-status";
      box.appendChild(el);
    }
    el.className = "wx-divider";
    el.textContent = text;
    if (!text) el.remove();
  }

  // 重置分批状态（打开新笔记时调用）
  function resetCommentPaging() {
    commentsLoadingMore = false;
    commentsNoMore = false;
  }

  // 从 iframe 文档提取互动栏数据（数字与激活状态）
  function extractFrameState(doc) {
    try {
      const interactEl = doc.querySelector(".interact-container");
      if (!interactEl) return {};
      // 与 findInteractButtons 同步的特征化识别，位置取数仅作兜底
      const btns = findInteractButtons(doc);
      const countOf = (el) => {
        if (!el) return "";
        const c = el.querySelector(":scope .count") || el.querySelector(".count");
        return c ? c.textContent.trim() : "";
      };
      const counts = [...interactEl.querySelectorAll(".count")].map((el) => el.textContent.trim());
      const liked = btns.like
        ? /like-active|\bactive\b/.test(String(btns.like.className || ""))
        : !!interactEl.querySelector(".like-active");
      return {
        interact: {
          likedCount: countOf(btns.like) || counts[0] || "",
          collectedCount: countOf(btns.collect) || counts[1] || "",
          commentCount: counts[2] || "",
          liked,
        },
      };
    } catch (e) {
      return {};
    }
  }

  function noteHtml(detail) {
    const author = detail.author || {};
    const interact = detail.interact || {};
    const timeStr = fmtTime(detail.time);
    const metaBits = [timeStr, detail.ipLocation].filter(Boolean).join(" · ");
    const tagsHtml = (detail.tagList || [])
      .map((t) => `<a class="wx-tag" href="https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(t.name)}" target="_blank" rel="noopener">#${escapeHtml(t.name)}</a>`)
      .join(" ");

    const images = detail.images || [];
    // 正文占位逻辑：纯图片/视频笔记无文字是正常的，不显示占位；
    // 只有无文字且无媒体时才提示，并区分「加载失败」与「本来就没写」
    const hasMedia = images.length > 0 || !!detail.videoUrl;
    let bodyText;
    if (detail.desc) {
      bodyText = escapeHtml(detail.desc);
    } else if (detail.title) {
      bodyText = "";
    } else if (hasMedia) {
      bodyText = "";
    } else if (detail.bodyError) {
      bodyText = "⚠️ 正文加载失败（可能被限流或已失效），可点右上「原页」查看，或稍后刷新重试";
    } else {
      bodyText = "（无正文）";
    }
    const mediaHtml = detail.videoUrl
      ? `<video class="wx-bubble-video" controls preload="metadata" playsinline src="${escapeHtml(detail.videoUrl)}"${images[0] ? ` poster="${escapeHtml(images[0])}"` : ""}></video>`
      : images.length
      ? `<div class="wx-bubble-imgs n${Math.min(images.length, 9)}" data-imgs>${images
          .map(
            (u) =>
              `<img loading="lazy" src="${escapeHtml(cdnThumb(u, 480))}" data-full="${escapeHtml(u)}" data-viewer alt=""/>`
          )
          .join("")}</div>`
      : "";

    return `
      <div class="wx-msg wx-anim" data-role="note">
        ${author.avatar ? `<img class="wx-avatar" src="${escapeHtml(author.avatar)}" alt=""/>` : `<div class="wx-avatar"></div>`}
        <div class="wx-msg-body">
          <div class="wx-msg-name">${escapeHtml(author.nickname || "")}</div>
          <div class="wx-bubble">
            ${detail.title ? `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(detail.title)}</div>` : ""}
            <div>${bodyText}${tagsHtml ? " " + tagsHtml : ""}</div>
            ${mediaHtml}
            <div class="wx-interact" data-interact>
              <span class="act ${interact.liked ? "on" : ""}" data-act="like" title="点赞">♥ <span class="n">${escapeHtml(fmtCount(interact.likedCount) || "0")}</span></span>
              <span class="sep">|</span>
              <span class="act ${interact.collected ? "on" : ""}" data-act="collect" title="收藏">★ <span class="n">${escapeHtml(fmtCount(interact.collectedCount) || "0")}</span></span>
              <span class="sep">|</span>
              <span class="act" title="评论数">💬 <span class="n">${escapeHtml(fmtCount(interact.commentCount) || "0")}</span></span>
            </div>
          </div>
          <div class="wx-bubble-meta"><span>${escapeHtml(metaBits)}</span></div>
        </div>
      </div>
    `;
  }

  function commentHtml(c, idx) {
    const mine = state.myUserId && c.userId === state.myUserId;
    const name = escapeHtml(c.author || "网友");
    return `
      <div class="wx-msg ${mine ? "me" : ""}" data-idx="${Number.isFinite(idx) ? idx : ""}" data-cid="${escapeHtml(c.userId || "")}">
        ${c.avatar ? `<img class="wx-avatar" src="${escapeHtml(c.avatar)}" alt=""/>` : `<div class="wx-avatar"></div>`}
        <div class="wx-msg-body">
          <div class="wx-msg-name">${c.isAuthor ? '<span class="wx-badge">作者</span>' : ""}${name}</div>
          <div class="wx-bubble">${c.contentHtml || escapeHtml(c.content)}</div>
          ${subCommentsHtml(c)}
          <div class="wx-bubble-meta">
            <span>${escapeHtml(c.date || "")}</span>
            ${c.likeText ? `<span>♥ ${escapeHtml(c.likeText)}</span>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  function subCommentsHtml(c) {
    const subs = c.subComments || [];
    if (!subs.length && !c.moreText) return "";
    return `
      <div class="wx-subcomments">
        ${subs
          .map(
            (s) => `
          <div class="wx-subcomment">
            <div><span class="who ${s.isAuthor ? "author-tag" : ""}">${escapeHtml(s.author)}</span>${s.contentHtml || escapeHtml(s.content)}</div>
            <div class="sub-meta">${escapeHtml(s.date || "")}${s.likeText ? " · ♥ " + escapeHtml(s.likeText) : ""}</div>
          </div>`
          )
          .join("")}
        ${c.moreText ? `<div class="wx-expand-replies" data-more>${escapeHtml(c.moreText)} ↧</div>` : ""}
      </div>
    `;
  }

  // 加载骨架屏（比转圈文字感知更快，形状即最终布局）
  function renderSkeleton() {
    return `
      <div class="wx-skeleton-msg">
        <div class="wx-sk-avatar"></div>
        <div class="wx-sk-body">
          <div class="wx-sk-line" style="width:36%"></div>
          <div class="wx-sk-block" style="height:180px"></div>
          <div class="wx-sk-line" style="width:80%"></div>
          <div class="wx-sk-line" style="width:55%"></div>
        </div>
      </div>
      <div class="wx-skeleton-msg">
        <div class="wx-sk-avatar"></div>
        <div class="wx-sk-body">
          <div class="wx-sk-line" style="width:30%"></div>
          <div class="wx-sk-line" style="width:72%"></div>
        </div>
      </div>
    `;
  }

  // 渲染详情骨架（正文气泡 + 评论占位容器）。评论到位后只更新评论区，避免正文图片重载
  function renderDetailShell() {
    const rootEl = ensureRoot();
    const body = rootEl.querySelector("#wx-detail-body");
    const detail = state.activeDetail;
    if (!detail) return;
    body.innerHTML = noteHtml(detail) + `<div id="wx-comments"></div>`;
    body.scrollTop = 0;
  }

  // 只更新评论区（正文不动，滚动位置不动）。animate：评论数据首次到达时容器淡入
  function renderCommentsInto(animate) {
    const rootEl = ensureRoot();
    const box = rootEl.querySelector("#wx-comments");
    const detail = state.activeDetail;
    if (!box || !detail) return;
    box.classList.toggle("wx-comments-in", !!animate);

    const parts = [];
    if (detail.commentError) {
      const loginHint = state.loggedIn === false ? "（检测到未登录：请先登录小红书后刷新页面）" : "";
      parts.push(`<div class="wx-divider">评论加载失败：${escapeHtml(detail.commentError)}${escapeHtml(loginHint)}</div>`);
    } else if (!detail.comments) {
      parts.push(`<div class="wx-divider">评论加载中…</div>`);
    } else {
      const total = detail.totalText || `共 ${detail.comments.length} 条评论`;
      parts.push(`<div class="wx-divider" id="wx-comments-total">${escapeHtml(total)}${detail.totalText ? ` · 已加载 ${detail.comments.length} 条` : ""}</div>`);
      for (let i = 0; i < detail.comments.length; i++) parts.push(commentHtml(detail.comments[i], i));
      if (!detail.comments.length) {
        if (state.loggedIn === false) {
          parts.push(`<div class="wx-divider">🔍 未检测到登录态：请点右上「原页」登录小红书，然后刷新本页</div>`);
        } else {
          parts.push(`<div class="wx-divider">还没有评论，抢首评</div>`);
        }
      } else if (!commentsNoMore) {
        parts.push(`<div class="wx-divider" id="wx-comments-status">↓ 下滑加载更多评论</div>`);
      }
    }
    box.innerHTML = parts.join("");
  }

  // 更新头部「共 N 条 · 已加载 X 条」统计行（增量渲染时用，避免全量重建）
  function updateCommentsTotalLine() {
    const rootEl = ensureRoot();
    const el = rootEl.querySelector("#wx-comments-total");
    const detail = state.activeDetail;
    if (!el || !detail || !detail.comments) return;
    const total = detail.totalText || `共 ${detail.comments.length} 条评论`;
    el.textContent = total + (detail.totalText ? ` · 已加载 ${detail.comments.length} 条` : "");
  }

  // 增量追加评论节点（分批加载路径：只 append 新评论，不重排已有内容）
  function appendCommentNodes(newComments, startIndex) {
    const rootEl = ensureRoot();
    const box = rootEl.querySelector("#wx-comments");
    const detail = state.activeDetail;
    if (!box || !detail || !detail.comments) return renderCommentsInto();
    if (!detail.comments.length || !newComments.length) return renderCommentsInto();
    const frag = document.createDocumentFragment();
    newComments.forEach((c, k) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = commentHtml(c, startIndex + k);
      const node = wrap.firstElementChild;
      if (node) {
        node.classList.add("wx-msg-new"); // 追加项滑入
        frag.appendChild(node);
      }
    });
    const status = box.querySelector("#wx-comments-status");
    if (status) box.insertBefore(frag, status);
    else box.appendChild(frag);
    updateCommentsTotalLine();
  }

  // 单条替换（楼中楼展开路径：只重画该条评论，其余不动）
  function replaceCommentNode(idx) {
    const rootEl = ensureRoot();
    const box = rootEl.querySelector("#wx-comments");
    const detail = state.activeDetail;
    if (!box || !detail || !detail.comments || !detail.comments[idx]) return renderCommentsInto();
    const old = box.querySelector(`.wx-msg[data-idx="${idx}"]`);
    if (!old) return renderCommentsInto();
    const wrap = document.createElement("div");
    wrap.innerHTML = commentHtml(detail.comments[idx], idx);
    const node = wrap.firstElementChild;
    if (!node) return renderCommentsInto();
    const subs = node.querySelector(".wx-subcomments");
    if (subs) subs.classList.add("wx-msg-new");
    old.replaceWith(node);
  }

  // 详情区事件委托：只绑定一次（在 bindRootEvents 中调用），替代逐条 addEventListener
  function bindDetailEventsOnce(rootEl) {
    const body = rootEl.querySelector("#wx-detail-body");
    body.addEventListener("click", (e) => {
      const img = e.target.closest("img[data-viewer]");
      if (img) {
        const group = img.closest("[data-imgs]");
        // 九宫格：整组可翻页；评论图片：单张打开
        const imgs = group ? [...group.querySelectorAll("img")] : [img];
        const urls = imgs.map((el) => el.getAttribute("data-full") || el.getAttribute("src")).filter(Boolean);
        openImageViewer(urls.indexOf(img.getAttribute("data-full") || img.getAttribute("src")), urls);
        return;
      }
      const act = e.target.closest("[data-interact] .act[data-act]");
      if (act) {
        actInteract(act.dataset.act);
        return;
      }
      const more = e.target.closest("[data-more]");
      if (more) expandReplies(more);
    });
    // 滚动接近底部 -> 分批加载下一页评论（提前 300px 触发，滚到时已就绪）
    body.addEventListener(
      "scroll",
      () => {
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 300) {
          maybeLoadMoreComments();
        }
      },
      { passive: true }
    );

    // j/k 键盘切换笔记（输入框聚焦或查看器打开时不响应）
    document.addEventListener("keydown", (e) => {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (viewerState.el) return;
      const ae = document.activeElement;
      if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
      if (state.navTab !== "chat" || !state.notes.length) return;
      const curIdx = state.activeNote ? state.notes.findIndex((n) => n.noteId === state.activeNote.noteId) : -1;
      const nextIdx = e.key === "j" ? curIdx + 1 : curIdx - 1;
      if (nextIdx < 0 || nextIdx >= state.notes.length || nextIdx === curIdx) return;
      openNote(state.notes[nextIdx]);
      const itemEl = rootEl.querySelector(`.wx-item[data-note-id="${state.notes[nextIdx].noteId}"]`);
      if (itemEl) itemEl.scrollIntoView({ block: "nearest" });
    });
  }

  function updateInteractButtons() {
    const rootEl = ensureRoot();
    const detail = state.activeDetail;
    const likeBtn = rootEl.querySelector("#wx-like-toggle");
    const collectBtn = rootEl.querySelector("#wx-collect-toggle");
    if (!detail || !state.activeNote) return;
    const interact = detail.interact || {};
    likeBtn.hidden = false;
    collectBtn.hidden = false;
    likeBtn.textContent = (interact.liked ? "♥ 已赞 " : "♡ 点赞 ") + (fmtCount(interact.likedCount) || "");
    likeBtn.classList.toggle("on", !!interact.liked);
    collectBtn.textContent = (interact.collected ? "★ 已藏 " : "☆ 收藏 ") + (fmtCount(interact.collectedCount) || "");
    collectBtn.classList.toggle("on", !!interact.collected);
    // 同步气泡内互动条
    const body = rootEl.querySelector("#wx-detail-body");
    const bubbleLike = body.querySelector('[data-act="like"]');
    const bubbleCollect = body.querySelector('[data-act="collect"]');
    if (bubbleLike) {
      bubbleLike.classList.toggle("on", !!interact.liked);
      bubbleLike.querySelector(".n").textContent = fmtCount(interact.likedCount) || "0";
    }
    if (bubbleCollect) {
      bubbleCollect.classList.toggle("on", !!interact.collected);
      bubbleCollect.querySelector(".n").textContent = fmtCount(interact.collectedCount) || "0";
    }
  }

  /* ============================== 互动操作（iframe 驱动） ============================== */

  // 笔记一致性守卫：iframe 必须存在、已加载、且正是当前打开的这篇笔记，才返回其 doc。
  // 防止切换笔记后旧回调把别的笔记数据写进当前界面（评论串台/缓存污染）
  function frameDocFor(note) {
    try {
      const frame = document.getElementById("xhs-wx-engine");
      if (!frame) return null;
      const href = frame.contentWindow && frame.contentWindow.location && frame.contentWindow.location.href;
      if (!href || !note || !href.includes(note.noteId || "\u0000")) return null;
      return frame.contentDocument || null;
    } catch (e) {
      return null;
    }
  }

  // 在引擎 iframe 中定位互动按钮：返回 {like, collect}
  // 识别策略：特征优先（class 关键词 / 收藏文案），位置兜底（含 .count 的按钮块，第1块=赞 第2块=藏）
  function findInteractButtons(doc) {
    const box = doc.querySelector(".interact-container");
    if (!box) return {};
    const result = {};
    // 特征匹配：class 含 like/collect 关键词，或文本为「收藏」
    for (const el of box.querySelectorAll("button, [role=button], div, span")) {
      const cls = (el.getAttribute("class") || "").toLowerCase();
      if (!result.like && /(^|[\s_-])(like|like-wrapper|liked)([\s_-]|$)/.test(cls)) {
        result.like = el;
      }
      if (!result.collect && /(^|[\s_-])(collect|collect-wrapper|collected|fav)([\s_-]|$)/.test(cls)) {
        result.collect = el;
      }
      if (!result.collect && el.children.length <= 2 && /^收藏$/.test((el.textContent || "").trim())) {
        result.collect = el;
      }
    }
    // 位置兜底：含 .count 的最内层按钮容器，前两块依次为 赞 / 藏
    if (!result.like || !result.collect) {
      const holders = [];
      for (const el of box.querySelectorAll("button, [role=button], div, span")) {
        if (el.querySelector(":scope > .count") && !el.querySelector(":scope > * > .count")) {
          holders.push(el);
        }
        if (holders.length >= 4) break;
      }
      if (!result.like && holders[0]) result.like = holders[0];
      if (!result.collect && holders[1]) result.collect = holders[1];
    }
    if (!result.like || !result.collect) {
      log("互动栏结构：", box.innerHTML.slice(0, 600));
    }
    return result;
  }

  async function actInteract(kind) {
    const note = state.activeNote;
    const detail = state.activeDetail;
    if (!note || !detail) return;
    const doc = frameDocFor(note);
    if (!doc) {
      toast("页面引擎未就绪，请重新打开笔记", "error");
      return;
    }
    const buttons = findInteractButtons(doc);
    const target = kind === "like" ? buttons.like : buttons.collect;
    if (!target) {
      toast("未定位到" + (kind === "like" ? "点赞" : "收藏") + "按钮，可点右上「原页」操作", "error");
      return;
    }

    // 乐观更新：先立即生效，失败再回滚（感知零延迟）
    const flagKey = kind === "like" ? "liked" : "collected";
    const countKey = kind === "like" ? "likedCount" : "collectedCount";
    const prevOn = !!(detail.interact && detail.interact[flagKey]);
    const prevCount = detail.interact ? detail.interact[countKey] : "";
    detail.interact = detail.interact || {};
    detail.interact[flagKey] = !prevOn;
    const prevNum = Number(prevCount);
    if (isFinite(prevNum)) detail.interact[countKey] = String(prevOn ? prevNum - 1 : prevNum + 1);
    updateInteractButtons();

    try {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await sleep(900);
      if (!state.activeNote || state.activeNote.noteId !== note.noteId) return; // 已切换笔记，丢弃
      // 以 iframe 实时数字为准（点赞状态 class 匹配不可靠，保留本地推断）
      const frameState = extractFrameState(doc);
      if (frameState.interact) {
        const liveCount = kind === "like" ? frameState.interact.likedCount : frameState.interact.collectedCount;
        if (liveCount) detail.interact[countKey] = liveCount;
        updateInteractButtons();
      }
    } catch (e) {
      warn("互动失败，回滚", e);
      detail.interact[flagKey] = prevOn;
      detail.interact[countKey] = prevCount;
      updateInteractButtons();
      toast("操作失败：" + e.message, "error");
    }
  }

  async function expandReplies(el) {
    const note = state.activeNote;
    if (!note) return;
    // 精准展开：只展开被点击的这条评论的楼中楼（每次展开是一次真实网络请求，避免批量浪费）
    const msgEl = el.closest(".wx-msg");
    const idx = msgEl ? Number(msgEl.dataset.idx) : -1;
    el.textContent = "展开中…";
    const doc = frameDocFor(note);
    if (!doc) {
      el.textContent = "引擎不可用";
      return;
    }
    let target = null;
    if (idx >= 0) {
      // 外层一级评论组：.comments-container > .list-container > .parent-comment（内层同名容器不会被匹配）
      const parents = doc.querySelectorAll(".comments-container > .list-container > .parent-comment");
      const parent = parents[idx];
      if (parent) {
        target = parent.querySelector(".reply-container .show-more, .reply-container .reply-more");
      }
    }
    if (!target) {
      // 精准定位失败（结构变体/分页后错位）时的兜底：点击所有未展开按钮，一次性补全
      const all = [...doc.querySelectorAll(".comments-container .show-more, .comments-container .reply-more")];
      if (!all.length) {
        toast("没有可展开的回复", "info");
        renderCommentsInto();
        return;
      }
      log("精准展开失败，兜底展开全部（", all.length, "处）");
      for (const btn of all) {
        try {
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        } catch (e) { /* 忽略 */ }
      }
    } else {
      try {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } catch (e) { /* 忽略 */ }
    }
    await sleep(900);
    if (!state.activeNote || state.activeNote.noteId !== note.noteId) return; // 已切换笔记，丢弃
    const parsed = parseComments(doc);
    if (state.activeDetail && state.activeNote && state.activeNote.noteId === note.noteId) {
      state.activeDetail.comments = parsed.comments;
      replaceCommentNode(idx); // 只重画这一条，其余评论不动
      cachePutDetail(note.noteId, state.activeDetail);
    }
  }

  /* ============================== 发送评论 ============================== */

  async function submitComment() {
    const rootEl = ensureRoot();
    const input = rootEl.querySelector("#wx-input");
    const sendBtn = rootEl.querySelector("#wx-send");
    const tip = rootEl.querySelector("#wx-composer-tip");
    const text = (input.textContent || "").trim();
    const note = state.activeNote;
    if (!text || !note) return;

    const doc = frameDocFor(note);
    if (!doc) {
      toast("页面引擎未就绪，请重新打开笔记", "error");
      return;
    }

    const box = doc.querySelector('[contenteditable="true"]');
    const submit = doc.querySelector(".submit");
    if (!box || !submit) {
      toast("未找到评论输入区，可点右上「原页」评论", "error");
      return;
    }

    sendBtn.disabled = true;
    tip.textContent = "";
    // 乐观上屏：立即渲染自己的绿色气泡（发送中状态），失败再移除
    const optimistic = {
      author: state.myNickname || "我",
      userId: state.myUserId || "__me__",
      avatar: state.myAvatar || "",
      content: text,
      date: "发送中…",
      likeText: "",
      isAuthor: false,
    };
    const detail = state.activeDetail;
    const commentsArr = (detail.comments = detail.comments || []);
    commentsArr.push(optimistic);
    renderCommentsInto();
    const optimisticIdx = commentsArr.length - 1;
    const body = ensureRoot().querySelector("#wx-detail-body");
    body.scrollTop = body.scrollHeight; // 滚到底部看到自己的气泡

    try {
      box.focus();
      // React 受控 contenteditable：优先在 iframe 文档上下文用 execCommand 触发 input 事件
      box.textContent = "";
      const sel = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      let inserted = false;
      try {
        inserted = doc.execCommand("insertText", false, text);
      } catch (e) {
        inserted = false;
      }
      // execCommand 不可用时直接改内容 + 派发 input
      if (!inserted || (box.textContent || "").trim() !== text) {
        box.textContent = text;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await sleep(300);
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      // 校验真实出现：等 1.5s 后在评论区找这条内容；没找到再等 1.5s 二次确认。
      // 防止风控/频率限制/审核拦截导致"静默失败"却报成功、清空用户输入
      await sleep(1500);
      if (!state.activeNote || state.activeNote.noteId !== note.noteId) return; // 已切换笔记，丢弃
      let parsed = parseComments(doc);
      const isMinePosted = (list) =>
        list.some(
          (c) =>
            c.content === text &&
            (!state.myUserId || !c.userId || c.userId === state.myUserId)
        );
      if (!isMinePosted(parsed.comments)) {
        await sleep(1500);
        if (!state.activeNote || state.activeNote.noteId !== note.noteId) return;
        parsed = parseComments(doc);
      }
      if (!isMinePosted(parsed.comments)) {
        // 判定失败：移除乐观气泡并重绘、保留用户输入，提示到原页确认
        if (detail.comments && detail.comments[optimisticIdx] === optimistic) {
          detail.comments.splice(optimisticIdx, 1);
          renderCommentsInto(); // 重绘，清掉 DOM 里残留的"发送中…"气泡
        }
        input.textContent = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        toast("发送未确认（可能被拦截或需审核），输入已保留，可点「原页」查看", "error");
        return;
      }
      if (state.activeDetail) {
        state.activeDetail.comments = parsed.comments;
        renderCommentsInto();
        cachePutDetail(note.noteId, state.activeDetail);
        // 真实数据替换乐观气泡后，滚到底部展示自己的评论
        const bodyNow = ensureRoot().querySelector("#wx-detail-body");
        bodyNow.scrollTop = bodyNow.scrollHeight;
      }
      input.textContent = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      toast("评论已发送", "success");
    } catch (e) {
      warn("评论发送失败", e);
      // 回滚：移除乐观气泡，恢复输入内容
      if (detail.comments && detail.comments[optimisticIdx] === optimistic) {
        detail.comments.splice(optimisticIdx, 1);
        renderCommentsInto();
      }
      input.textContent = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      toast("评论发送失败：" + e.message, "error");
    } finally {
      sendBtn.disabled = !(input.textContent || "").trim();
      input.classList.toggle("empty", !(input.textContent || "").trim());
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 让出主线程（2025 Baseline 的 scheduler.yield，带 fallback 链）。
  // 用于把长任务（feed 扫描/评论解析）切片，避免阻塞交互帧
  const yieldToMain =
    typeof scheduler !== "undefined" && typeof scheduler.yield === "function"
      ? () => scheduler.yield()
      : (cb) =>
          new Promise((resolve) => {
            if (typeof requestIdleCallback === "function") {
              requestIdleCallback(() => resolve(), { timeout: 200 });
            } else {
              setTimeout(resolve, 0);
            }
            void cb;
          });

  // 分片执行：每 processing 毫秒让出主线程一次
  async function runChunked(items, fn, { chunkMs = 8 } = {}) {
    let batchStart = performance.now();
    for (let i = 0; i < items.length; i++) {
      fn(items[i], i);
      if (performance.now() - batchStart > chunkMs && i < items.length - 1) {
        await yieldToMain();
        batchStart = performance.now();
      }
    }
  }

  /* ============================== 图片查看器 ============================== */

  let viewerState = { urls: [], index: 0, el: null, scale: 1, tx: 0, ty: 0 };

  // 应用查看器变换（缩放 + 平移）
  function applyViewerTransform() {
    const img = viewerState.el && viewerState.el.querySelector("img");
    if (img) {
      img.style.transform = `translate(${viewerState.tx}px, ${viewerState.ty}px) scale(${viewerState.scale})`;
    }
  }

  // 相邻图预加载：翻页时下一张已在缓存，无白屏等待
  function preloadViewerNeighbors(index) {
    const { urls } = viewerState;
    for (const i of [index - 1, index + 1]) {
      if (urls[i]) {
        const pre = new Image();
        pre.src = urls[i];
      }
    }
  }

  // 切图：换 src + 淡入动画（重启动画需强制 reflow）+ 复位缩放与平移
  function showViewerImage(index) {
    const { urls, el } = viewerState;
    const img = el && el.querySelector("img");
    if (!img) return;
    viewerState.scale = 1;
    viewerState.tx = 0;
    viewerState.ty = 0;
    applyViewerTransform();
    img.src = urls[index];
    img.classList.remove("wx-img-in");
    void img.offsetWidth; // 强制 reflow 以重启动画
    img.classList.add("wx-img-in");
    el.querySelector(".wx-viewer-index").textContent = `${index + 1} / ${urls.length}`;
    const left = el.querySelector(".wx-viewer-arrow.left");
    const right = el.querySelector(".wx-viewer-arrow.right");
    if (left) left.style.display = index > 0 ? "" : "none";
    if (right) right.style.display = index < urls.length - 1 ? "" : "none";
    preloadViewerNeighbors(index);
  }

  function openImageViewer(index, urls) {
    closeImageViewer();
    const rootEl = ensureRoot();
    const viewer = document.createElement("div");
    viewer.className = "wx-viewer";
    // Popover API（2025 Baseline）：原生 top-layer、light-dismiss（点外部关闭）、Esc 关闭
    // 不支持的浏览器自动退化为普通 fixed 定位 + 手动关闭逻辑
    const supportsPopover = typeof viewer.showPopover === "function" && typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;
    if (supportsPopover) viewer.popover = "auto";
    viewer.innerHTML = `
      <span class="wx-viewer-close" title="关闭 (Esc)">×</span>
      ${index > 0 ? '<span class="wx-viewer-arrow left" title="上一张">‹</span>' : ""}
      ${index < urls.length - 1 ? '<span class="wx-viewer-arrow right" title="下一张">›</span>' : ""}
      <img alt=""/>
      <div class="wx-viewer-index"></div>
    `;
    // 查看器打开：top-layer 过渡淡入（不支持的浏览器直接显示）
    withViewTransition(() => rootEl.appendChild(viewer));
    if (supportsPopover) {
      try {
        viewer.showPopover();
      } catch (e) { /* 已在顶层或被拦截则忽略 */ }
    }
    viewerState = { urls, index, el: viewer, scale: 1, tx: 0, ty: 0, supportsPopover };

    const img = viewer.querySelector("img");
    const resetViewerTransform = () => {
      viewerState.scale = 1;
      viewerState.tx = 0;
      viewerState.ty = 0;
      applyViewerTransform();
    };
    img.addEventListener("dblclick", resetViewerTransform);
    // 滚轮缩放（40% ~ 400%，双击复位）
    viewer.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        viewerState.scale = Math.max(0.4, Math.min(4, viewerState.scale * factor));
        applyViewerTransform();
      },
      { passive: false }
    );
    // 放大后拖拽平移（scale <= 1 时拖拽无效，避免误触关闭）
    let dragging = false;
    let dragStart = null;
    viewer.addEventListener("mousedown", (e) => {
      if (viewerState.scale <= 1 || e.target !== img) return;
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY, tx: viewerState.tx, ty: viewerState.ty };
      e.preventDefault();
    });
    viewer.addEventListener("mousemove", (e) => {
      if (!dragging || !dragStart) return;
      viewerState.tx = dragStart.tx + (e.clientX - dragStart.x);
      viewerState.ty = dragStart.ty + (e.clientY - dragStart.y);
      applyViewerTransform();
    });
    viewer.addEventListener("mouseup", () => {
      dragging = false;
      dragStart = null;
    });

    viewer.addEventListener("click", (e) => {
      if (e.target === viewer || e.target.classList.contains("wx-viewer-close")) closeImageViewer();
    });
    // Popover 的 light-dismiss 关闭时（Esc/点外部），同步清理状态
    if (supportsPopover) {
      viewer.addEventListener("beforetoggle", (e) => {
        if (e.newState === "closed") closeImageViewer();
      });
    }
    const left = viewer.querySelector(".wx-viewer-arrow.left");
    const right = viewer.querySelector(".wx-viewer-arrow.right");
    if (left) left.addEventListener("click", () => stepViewer(-1));
    if (right) right.addEventListener("click", () => stepViewer(1));
    showViewerImage(index);
    // Popover 自带 Esc 关闭，仅在无 Popover 支持时手动监听键盘
    if (!supportsPopover) document.addEventListener("keydown", viewerKeyHandler);
  }

  function viewerKeyHandler(e) {
    if (!viewerState.el) return;
    if (e.key === "Escape") closeImageViewer();
    else if (e.key === "ArrowLeft") stepViewer(-1);
    else if (e.key === "ArrowRight") stepViewer(1);
  }

  function stepViewer(delta) {
    const { urls, el } = viewerState;
    if (!el || !urls.length) return;
    let next = viewerState.index + delta;
    next = Math.max(0, Math.min(urls.length - 1, next));
    if (next === viewerState.index) return;
    viewerState.index = next;
    showViewerImage(next);
  }

  function closeImageViewer() {
    if (viewerState.el) {
      const el = viewerState.el;
      viewerState.el = null;
      document.removeEventListener("keydown", viewerKeyHandler);
      try {
        if (el.matches(":popover-open")) el.hidePopover();
      } catch (e) { /* 忽略 */ }
      el.remove();
    }
  }

  /* ============================== 设置面板 ============================== */

  function renderSettings(list) {
    const wrap = document.createElement("div");
    wrap.className = "wx-settings";
    wrap.innerHTML = `
      <h3>外观</h3>
      <div class="row"><span>暗黑模式</span><button class="neutral" id="wx-set-dark">${isDark() ? "当前：暗黑 · 切浅色" : "当前：浅色 · 切暗黑"}</button></div>
      <div class="row"><span>左栏宽度</span><button id="wx-set-width">重置宽度</button></div>
      <h3>性能</h3>
      <div class="row"><span>跟读预取（自动备好下一条）</span><button class="neutral" id="wx-set-follow">${storeGet(STORE_KEYS.followPrefetch, true) === false ? "已关 · 开启" : "已开 · 关闭"}</button></div>
      <div class="row"><span>清除已读记录</span><button id="wx-set-clear-seen">清除</button></div>
      <h3>账号</h3>
      <div class="row"><span>当前身份</span><span style="color:#666">${escapeHtml(state.myNickname || state.myUserId || "未识别")}</span></div>
      <h3>模式</h3>
      <div class="row"><span>切回原版界面</span><button class="danger" id="wx-set-exit">退出微信模式</button></div>
      <div class="hint">
        说明：本脚本的评论/点赞/收藏通过页面自身能力完成，不会伪造请求。<br/>
        若笔记或评论加载失败，多为网络或登录态问题，刷新页面即可。<br/>
        快捷键：j / k 上下切换笔记；图片查看器支持滚轮缩放、拖拽平移、双击复位。<br/>
        目前仅支持首页"发现" feed，其他页面（搜索/个人主页）保持原样。
      </div>
    `;
    list.innerHTML = "";
    list.appendChild(wrap);

    wrap.querySelector("#wx-set-dark").addEventListener("click", (e) => {
      toggleDark();
      e.target.textContent = isDark() ? "当前：暗黑 · 切浅色" : "当前：浅色 · 切暗黑";
    });
    wrap.querySelector("#wx-set-width").addEventListener("click", () => {
      document.getElementById("wx-aside").style.width = "300px";
      storeSet(STORE_KEYS.leftWidth, 300);
      toast("已重置宽度", "success");
    });
    wrap.querySelector("#wx-set-follow").addEventListener("click", (e) => {
      const next = storeGet(STORE_KEYS.followPrefetch, true) !== false; // 当前开 -> 关
      storeSet(STORE_KEYS.followPrefetch, !next);
      e.target.textContent = !next ? "已开 · 关闭" : "已关 · 开启";
      toast(next ? "跟读预取已关闭" : "跟读预取已开启", "success");
    });
    wrap.querySelector("#wx-set-clear-seen").addEventListener("click", () => {
      GM_deleteValue(STORE_KEYS.seenMap);
      toast("已清除，刷新后生效", "success");
    });
    wrap.querySelector("#wx-set-exit").addEventListener("click", () => setEnabled(false));
  }

  /* ============================== 启动 ============================== */

  function isFeedPage() {
    return location.pathname === "/explore" || location.pathname === "/" || location.pathname === "";
  }

  // 退出微信模式后，在原页面右下角挂一个悬浮球，点击即可重新进入
  function mountReentryButton() {
    if (document.getElementById("xhs-wx-reentry")) return;
    const btn = document.createElement("div");
    btn.id = "xhs-wx-reentry";
    btn.textContent = "微信";
    btn.title = "进入小红书微信模式";
    Object.assign(btn.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      zIndex: "2147483000",
      width: "46px",
      height: "46px",
      borderRadius: "50%",
      background: "#07c160",
      color: "#fff",
      fontSize: "12px",
      fontWeight: "600",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      boxShadow: "0 2px 10px rgba(0,0,0,.3)",
      userSelect: "none",
    });
    btn.addEventListener("click", () => {
      storeSet(STORE_KEYS.enabled, true);
      location.reload();
    });
    (document.body || document.documentElement).appendChild(btn);
    log("已挂载微信模式重入悬浮球");
  }

  function applyMyProfileToUi() {
    const rootEl = ensureRoot();
    const avatar = rootEl.querySelector("#wx-my-avatar");
    if (state.myAvatar) avatar.src = state.myAvatar;
    rootEl.querySelector("#wx-my-avatar-wrap").title = state.myNickname || "我";
  }

  function boot() {
    if (!isFeedPage()) {
      log("非 feed 页面，跳过启动：" + location.pathname);
      return;
    }
    if (!isEnabled()) {
      // 已退出：挂悬浮球方便随时回来（也可用油猴菜单切换）
      mountReentryButton();
      log("微信模式已停用（右下角悬浮球或油猴菜单可重新启用）");
      return;
    }
    injectCss();
    getMyProfileFromDom();
    ensureRoot();
    applyMyProfileToUi();
    applyDark(isDark());
    applyFontScale();
    scanFeed(true);
    observeFeed();
    // 首屏 feed / 侧边栏"我"可能渲染较晚，延迟补扫补身份
    setTimeout(() => {
      scanFeed(false);
      getMyProfileFromDom();
      applyMyProfileToUi();
    }, 1500);
    setTimeout(() => {
      scanFeed(false);
      getMyProfileFromDom();
      applyMyProfileToUi();
    }, 4000);
    // 空闲预热：浏览器空闲时预取/预热列表第一条（未悬停直接点击的首开提速）。
    // feed 尚未扫出时延迟重试（最多 3 次）
    if (typeof requestIdleCallback === "function") {
      const warmFirstIdle = (attempt) => {
        requestIdleCallback(
          () => {
            const first = state.notes.find((n) => !detailCache.get(n.noteId));
            if (!first) {
              if (attempt < 3 && !state.notes.length) {
                setTimeout(() => warmFirstIdle(attempt + 1), 2500);
              }
              return;
            }
            prefetchNoteDetail(first);
            warmFrameFor(first);
            log("空闲预热完成：", first.noteId);
          },
          { timeout: 5000 }
        );
      };
      warmFirstIdle(0);
    }
    log("微信模式已启动");
  }

  GM_registerMenuCommand("启用 / 停用微信模式", () => {
    setEnabled(!isEnabled());
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
