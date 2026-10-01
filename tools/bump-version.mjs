#!/usr/bin/env node
/**
 * bump-version.mjs — 版本号单一来源维护
 *
 * 用法：
 *   node tools/bump-version.mjs --check            校验各处版本号是否一致（CI 用）
 *   node tools/bump-version.mjs --check --strict   发版级校验：CHANGELOG 不允许「待发布」
 *   node tools/bump-version.mjs 1.3.2              升版本（写 manifest / package.json / README 徽章）
 *   node tools/bump-version.mjs 1.3.2 --date 2026-10-02
 *   node tools/bump-version.mjs 1.3.2 --dry-run    只打印将要修改的内容
 *
 * 唯一真源：src/manifest.json 的 version。其余位置（package.json、README 徽章、
 * CHANGELOG 标题）由本脚本同步，避免手工改漏导致 CI 版本校验失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'src', 'manifest.json');
const PKG = path.join(ROOT, 'package.json');
const README = path.join(ROOT, 'README.md');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const SEMVER = /^\d+\.\d+\.\d+$/;

const argv = process.argv.slice(2);
const checkMode = argv.includes('--check');
const strict = argv.includes('--strict');
const dryRun = argv.includes('--dry-run');
const dateArgIdx = argv.indexOf('--date');
const today = dateArgIdx >= 0 ? argv[dateArgIdx + 1] : new Date().toISOString().slice(0, 10);
const version = argv.find((a) => !a.startsWith('--') && a !== today);

const read = (p) => fs.readFileSync(p, 'utf8');

/** 只替换第一处匹配，保持文件其余格式（含内联数组）原样不动 */
function replaceOnce(src, re, replacement, label) {
  if (!re.test(src)) throw new Error(`未找到可替换的目标：${label}`);
  return src.replace(re, replacement);
}

const manifestSrc = read(MANIFEST);
const manifestVersion = JSON.parse(manifestSrc).version;
const pkgSrc = read(PKG);
const pkgVersion = JSON.parse(pkgSrc).version;
const readmeSrc = read(README);
const readmeVersion = (readmeSrc.match(/badge\/Version-(\d+\.\d+\.\d+)-/) || [])[1];
const changelogSrc = read(CHANGELOG);

const headingRe = (v) => new RegExp(`^## v${v.replace(/\./g, '\\.')}.*$`, 'm');
const pendingRe = (v) => new RegExp(`^## v${v.replace(/\./g, '\\.')} \\(待发布\\)`, 'm');

if (checkMode) {
  const found = { 'src/manifest.json': manifestVersion, 'package.json': pkgVersion, 'README.md 徽章': readmeVersion };
  const uniq = [...new Set(Object.values(found))];
  console.log('版本号分布：');
  for (const [k, v] of Object.entries(found)) console.log(`  ${k.padEnd(18)} ${v || '(缺失)'}`);
  if (uniq.length !== 1 || !uniq[0]) {
    console.error('\n❌ 版本号不一致 —— 运行 `npm run bump <版本号>` 统一');
    process.exit(1);
  }
  const v = uniq[0];
  if (!headingRe(v).test(changelogSrc)) {
    console.error(`\n❌ CHANGELOG.md 缺少 v${v} 章节`);
    process.exit(1);
  }
  if (pendingRe(v).test(changelogSrc)) {
    // 开发期允许「待发布」（版本号可先于发布日期存在）；发版流程用 --strict 卡死
    if (strict) {
      console.error(`\n❌ CHANGELOG.md 的 v${v} 仍标记「待发布」，发版前请改为日期`);
      process.exit(1);
    }
    console.log(`\n⚠️ 版本号一致（v${v}），但 CHANGELOG 仍标记「待发布」——发版前需改为日期`);
    process.exit(0);
  }
  console.log(`\n✅ 版本一致且 CHANGELOG 已就绪：v${v}`);
  process.exit(0);
}

if (!version || !SEMVER.test(version)) {
  console.error('用法: node tools/bump-version.mjs <x.y.z> [--date YYYY-MM-DD] [--dry-run]');
  console.error('      node tools/bump-version.mjs --check');
  process.exit(1);
}

const changes = [];

const nextManifest = replaceOnce(manifestSrc, /"version":\s*"\d+\.\d+\.\d+"/, `"version": "${version}"`, 'manifest version');
changes.push(['src/manifest.json', `${manifestVersion} → ${version}`, nextManifest]);

const nextPkg = replaceOnce(pkgSrc, /"version":\s*"\d+\.\d+\.\d+"/, `"version": "${version}"`, 'package.json version');
changes.push(['package.json', `${pkgVersion} → ${version}`, nextPkg]);

const nextReadme = replaceOnce(readmeSrc, /badge\/Version-\d+\.\d+\.\d+-/, `badge/Version-${version}-`, 'README 版本徽章');
changes.push(['README.md', `${readmeVersion} → ${version}（徽章）`, nextReadme]);

// CHANGELOG：新版本标题若已存在且标记「待发布」，替换为发布日期
if (pendingRe(version).test(changelogSrc)) {
  const nextChangelog = changelogSrc.replace(pendingRe(version), `## v${version} (${today})`);
  changes.push(['CHANGELOG.md', `「待发布」→ ${today}`, nextChangelog]);
} else if (!headingRe(version).test(changelogSrc)) {
  console.warn(`⚠️ CHANGELOG.md 中还没有 v${version} 章节，请补写后再发版`);
}

console.log(`${dryRun ? '【dry-run】' : ''}版本 ${manifestVersion} → ${version}\n`);
for (const [file, desc] of changes) console.log(`  ${file.padEnd(18)} ${desc}`);

if (dryRun) {
  console.log('\n（未写入任何文件）');
  process.exit(0);
}
for (const [file, , content] of changes) {
  fs.writeFileSync(path.join(ROOT, file), content);
}
console.log('\n✅ 已写入。下一步：补/改 CHANGELOG → 提交 → git tag v' + version + ' → push（CI 会校验一致性）');
