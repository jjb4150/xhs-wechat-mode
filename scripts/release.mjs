#!/usr/bin/env node
/**
 * 发版脚本：一条命令完成版本发布。
 *
 *   node scripts/release.mjs 0.7.1 "修复 xxx"
 *
 * 做的事：
 *   1. 校验 CHANGELOG.md 里已有该版本的条目（没有则提示先补）
 *   2. 更新脚本头部的 @version
 *   3. 语法检查 + Prettier 格式检查
 *   4. 提交、打 tag、推送
 *
 * 推送 tag 后，GitHub Actions 会自动：
 *   - 跑 ci.yml 校验
 *   - 从 CHANGELOG 提取说明，创建 Release 并附上脚本文件
 *   - 通过 sync-greasyfork.yml 把脚本同步到 Greasyfork（需配 secrets）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "xhs-wechat-mode.user.js");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

const [version, message] = process.argv.slice(2);

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// Windows 下 execFileSync 直接调 npx/git 会因 .cmd 解析失败（EINVAL），统一走 shell
const IS_WIN = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const useShell = IS_WIN && (cmd === "npx" || cmd === "npm");
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
    shell: useShell,
    ...opts,
  });
}

function runCapture(cmd, args) {
  const useShell = IS_WIN && (cmd === "npx" || cmd === "npm");
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: useShell }).trim();
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  die("用法：node scripts/release.mjs <版本号 x.y.z> [提交说明]\n例：node scripts/release.mjs 0.7.1 \"修复滚动误点赞\"");
}

// 1. CHANGELOG 必须有该版本条目
const changelog = readFileSync(CHANGELOG, "utf8");
if (!changelog.includes(`## [${version}]`)) {
  die(
    `CHANGELOG.md 中找不到 "## [${version}]" 条目。\n` +
      `请先在 CHANGELOG.md 顶部补上本次版本的变更说明，再执行发版。`
  );
}
console.log(`✓ CHANGELOG 已包含 ${version}`);

// 2. 更新 @version
const src = readFileSync(SCRIPT, "utf8");
const versionRe = /^\/\/ @version\s+\S+/m;
if (!versionRe.test(src)) die("脚本头部找不到 @version 字段");
const current = /^\/\/ @version\s+(\S+)/m.exec(src)[1];
if (current === version) {
  console.log(`• @version 已是 ${version}，跳过修改`);
} else {
  writeFileSync(SCRIPT, src.replace(versionRe, `// @version      ${version}`), "utf8");
  console.log(`✓ @version ${current} → ${version}`);
}

// 3. 校验
console.log("\n—— 语法检查 ——");
run(process.execPath, ["--check", SCRIPT]);
console.log("✓ 语法通过");

console.log("\n—— 格式检查 ——");
try {
  runCapture("npx", ["--yes", "prettier@3", "--no-config", "--print-width", "110", "--check", SCRIPT]);
  console.log("✓ 格式通过");
} catch (e) {
  console.log("• 格式不符，正在自动格式化…");
  run("npx", ["--yes", "prettier@3", "--no-config", "--print-width", "110", "--write", SCRIPT]);
  run(process.execPath, ["--check", SCRIPT]);
  console.log("✓ 已格式化并通过语法检查");
}

// 4. 提交 + 打 tag + 推送
const branch = runCapture("git", ["branch", "--show-current"]);
if (branch !== "master" && branch !== "main") {
  die(`当前分支是 ${branch}，发版请在 master/main 上操作`);
}

console.log("\n—— 提交 ——");
run("git", ["add", "-A"]);
const hasStaged = (() => {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT });
    return false;
  } catch {
    return true;
  }
})();
if (hasStaged) {
  run("git", ["commit", "-m", `v${version}${message ? `：${message}` : ""}`]);
  console.log("✓ 已提交");
} else {
  console.log("• 无待提交改动");
}

console.log("\n—— 打 tag ——");
try {
  runCapture("git", ["rev-parse", `v${version}`]);
  die(`tag v${version} 已存在，请换版本号或先删除该 tag`);
} catch {
  // 不存在，正常
}
run("git", ["tag", "-a", `v${version}`, "-m", `v${version}${message ? `：${message}` : ""}`]);
console.log(`✓ tag v${version} 已创建`);

console.log("\n—— 推送 ——");
run("git", ["push", "origin", branch]);
run("git", ["push", "origin", `v${version}`]);
console.log(`\n✓ 完成。GitHub Actions 将自动创建 Release 并同步 Greasyfork。`);
console.log(`  https://github.com/jjb4150/xhs-wechat-mode/releases/tag/v${version}\n`);