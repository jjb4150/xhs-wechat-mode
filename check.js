const fs = require("fs");
const src = fs.readFileSync("xhs-wechat-mode.user.js", "utf8");
const checks = {
  "自动续载（追加后+首屏后）": (src.match(/setTimeout\(\(\) => maybeLoadMoreComments\(\), 350\)/) || []).length === 1 && (src.match(/setTimeout\(\(\) => maybeLoadMoreComments\(\), 600\)/) || []).length === 2,
  "零新增重试（最多2次）": src.includes("commentsNoMoreAttempts") && src.includes("正在重试加载评论"),
  "总数解析": src.includes("function parseTotalFromTotalText"),
  "iframe 内嵌状态兜底": src.includes("function extractInitialStateFromDoc") && src.includes("iframe 内嵌状态兜底成功"),
  "兜底优先级 state 优先于 DOM": /extractInitialStateFromDoc\(doc\);\s*\n\s*if \(!fallback\) fallback = parseNoteFromFrameDoc/.test(src),
  "bodyError 标记": src.includes("state.activeDetail.bodyError = true"),
  "占位符区分媒体/失败/无正文": src.includes("⚠️ 正文加载失败") && src.includes("hasMedia"),
  "预取冷却": src.includes("prefetchCooldownUntil") && src.includes("60 * 1000"),
  "预热也受冷却": /function warmFrameFor\(note\) \{\s*\n\s*if \(Date\.now\(\) < prefetchCooldownUntil\) return;/.test(src),
  "版本 0.6.3": src.includes("@version      0.6.3"),
};
let ok = true;
for (const [n, p] of Object.entries(checks)) {
  console.log((p ? "PASS" : "FAIL") + "  " + n);
  if (!p) ok = false;
}
console.log(ok ? "\n全部通过" : "\n存在失败项");
process.exit(ok ? 0 : 1);
