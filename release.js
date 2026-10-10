#!/usr/bin/env node
'use strict';
/*
 * release.js —— 一条命令完成「打包 + 校验 + 发布到 GitHub Releases」
 *
 * 为什么需要它：应用内的「检查更新」走 electron-updater → GitHub Releases。
 * 但只要有一次忘了发 release，所有已安装的机器就永远收不到更新
 * （v1.15.0 ~ v1.20.0 连续 6 个版本就是这样：GitHub 上最新还停在 1.14.0，
 *   应用每次都报告「已是最新版本」，用户只能靠人工装包升级）。
 *
 * 它把过去必须手工记住、且已经忘过 3 次的检查固化下来：
 *   1. package.json 版本 == 界面上的版本串（两处字面量，漏改一处界面就显示旧版本）
 *   2. runtime/ 与源码逐文件一致（runtime/ 是安装包内容的唯一来源，极易忘记刷新）
 *   3. 语法检查（主进程/服务端 node --check；index.html 内联脚本编译一次）
 *   4. electron-builder 打包
 *   5. 产物自检：latest.yml 的 version/sha512/size 与磁盘一致；解包后 resources/runtime 与源码逐文件一致
 *   6. gh release create 上传「ASCII 名安装包 + latest.yml」（electron-updater 按 latest.yml 里的 path 下载，
 *      少改名或漏传 latest.yml 都会让自动更新 404）
 *
 * 用法：
 *   node release.js                 # 打包 + 自检，不发 release（安全默认）
 *   node release.js --publish       # 打包 + 自检 + 发布
 *   node release.js --publish-only  # 不重新打包，用 dist/ 里已自检过的产物发布
 *   node release.js --allow-dirty   # 允许工作树有未提交改动（会让 tag 与产物不对应，慎用）
 *   node release.js --notes FILE    # 指定 release 说明文件（默认用 git log 自动生成）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const ROOT = __dirname;
const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const argVal = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : null; };

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const V = pkg.version;
const APPNAME = pkg.build.productName;                       // 工作日报
const ASCII_EXE = `jzd-daily-app-setup-${V}.exe`;
const CN_EXE = `${APPNAME} Setup ${V}.exe`;
const DIST = path.join(ROOT, 'dist');
const RUNTIME = path.join(ROOT, 'runtime');

// 安装包内容里属于「业务静态文件」的 9 个：runtime/ 是它们的唯一来源
const NINE = ['index.html', 'styles.css', 'server.js', 'news.js', 'stock.js',
  'translate-core.js', 'translate.js', 'translate.html', 'keyhook.ps1'];
// 绝不能出现在 runtime/ / 安装包里的（db_config.json 有明文密码；main.js/preload.js 属 app.asar 里的应用代码，
// 在 runtime/ 放一份只会让人误以为改它有用。注意 runtime/package.json（95 B 的精简版，供内置 node.exe 起服务用）
// 与 runtime/package-lock.json 是**有意存在**的，不要列入禁用名单。）
const FORBIDDEN_IN_PACKAGE = ['db_config.json', 'main.js', 'preload.js'];

let failed = false;
const log = (...a) => console.log(...a);
const ok = (m) => log('  \u2713 ' + m);
const bad = (m) => { failed = true; log('  \u2717 ' + m); };
function step(t) { log('\n=== ' + t + ' ==='); }
function sh(cmd, args, opts) {
  const r = cp.spawnSync(cmd, args, Object.assign({ cwd: ROOT, encoding: 'utf8', shell: false }, opts || {}));
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');
const sha512b64 = (buf) => require('crypto').createHash('sha512').update(buf).digest('base64');

/* ---------- 1. 版本字面量一致性（D3：两处独立硬编码） ---------- */
step('1/6 版本号一致性');
const htmlPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const uiVer = (html.match(/桌面版 v(\d+\.\d+\.\d+)/) || [])[1];
log(`  package.json version = ${V}`);
log(`  index.html 界面版本串 = ${uiVer || '(未找到)'}`);
if (uiVer !== V) bad(`不一致：请把 index.html 里的「桌面版 v${uiVer}」改成「桌面版 v${V}」`); else ok('一致');

/* ---------- 2. runtime/ 同步（D31） ---------- */
step('2/6 runtime/ 与源码一致性（安装包内容唯一来源）');
let synced = 0;
if (!fs.existsSync(RUNTIME)) fs.mkdirSync(RUNTIME);
NINE.forEach((f) => {
  const s = path.join(ROOT, f), t = path.join(RUNTIME, f);
  if (!fs.existsSync(s)) { bad(`源码缺少 ${f}`); return; }
  const same = fs.existsSync(t) && sha256(fs.readFileSync(s)) === sha256(fs.readFileSync(t));
  if (same) { ok(`${f} 已是最新`); return; }
  fs.copyFileSync(s, t);
  synced++;
  log(`  \u21bb 已刷新 runtime/${f}`);
});
FORBIDDEN_IN_PACKAGE.forEach((f) => {
  if (fs.existsSync(path.join(RUNTIME, f))) bad(`runtime/${f} 不该存在（会进入安装包）`);
});
if (failed) { log(`\n预检未通过，已中止。`); process.exit(1); }
log(`  同步了 ${synced} 个文件`);

/* ---------- 3. 语法检查 ---------- */
step('3/6 语法检查');
['main.js', 'server.js', 'preload.js', 'news.js', 'stock.js', 'translate-core.js', 'translate.js'].forEach((f) => {
  const r = sh(process.execPath, ['--check', path.join(ROOT, f)]);
  if (r.code === 0) ok(`${f} node --check`); else bad(`${f} 语法错误：${r.err || r.out}`);
});
{ // index.html 内联脚本编译一次
  const opens = html.split(/\r?\n/).reduce((a, l, i) => (/<script(?![^>]*\bsrc=)/i.test(l) ? a.concat(i) : a), []);
  const lines = html.split(/\r?\n/);
  const s = opens[opens.length - 1];
  let e = lines.findIndex((l, i) => i > s && /<\/script>/i.test(l)); if (e < 0) e = lines.length;
  try { new vm.Script(lines.slice(s + 1, e).join('\n'), { filename: 'index.html:inline' }); ok(`index.html 内联脚本可编译（${e - s - 1} 行）`); }
  catch (err) { bad('index.html 内联脚本编译失败：' + err.message); }
}
if (failed) { log('\n语法检查未通过，已中止。'); process.exit(1); }

/* ---------- 4. 工作树状态（tag 必须对应产物） ---------- */
step('4/6 工作树状态');
const st = sh('git', ['status', '--porcelain']);
const dirty = st.out.split(/\r?\n/).filter(Boolean);
if (dirty.length) {
  log('  未提交的改动：');
  dirty.forEach((l) => log('    ' + l));
  if (!has('--allow-dirty')) bad('请先提交（否则 release 的 tag 指向的代码与安装包不一致）。确认无妨可用 --allow-dirty');
  else log('  （--allow-dirty：继续）');
} else ok('工作树干净');
const head = sh('git', ['rev-parse', '--short', 'HEAD']).out;
const headFull = sh('git', ['rev-parse', 'HEAD']).out;
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
log(`  HEAD = ${head}（${branch}）`);
if (failed) { log('\n已中止。'); process.exit(1); }
// 发布前必须先把提交推到远端：gh release create 是在 GitHub 侧建 tag，
// 指向一个远端不存在的 commit 会直接失败。
if (has('--publish') || has('--publish-only')) {
  const remote = sh('git', ['rev-parse', 'origin/' + branch]).out;
  if (remote !== headFull) {
    log(`  origin/${branch} 落后于本地（${remote.slice(0, 7) || '不存在'} ≠ ${head}）→ 推送`);
    const r = sh('git', ['push', 'origin', branch], { stdio: 'inherit' });
    if (r.code !== 0) { bad('git push 失败（无权限或网络不通）'); log('\n已中止。'); process.exit(1); }
  } else ok(`origin/${branch} 已是最新`);
}

/* ---------- 5. 打包 + 产物自检 ---------- */
step('5/6 打包 + 产物自检');
if (has('--publish-only')) {
  log('  --publish-only：跳过打包，使用 dist/ 里的现有产物');
} else {
  log('  运行 electron-builder --win nsis ...');
  const r = sh(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', 'nsis'],
    { env: Object.assign({}, process.env, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }), stdio: 'inherit' });
  if (r.code !== 0) { bad('electron-builder 失败'); log('\n已中止。'); process.exit(1); }
}
const cnPath = path.join(DIST, CN_EXE);
const asciiPath = path.join(DIST, ASCII_EXE);
const asciiBlockmap = asciiPath + '.blockmap';
if (!fs.existsSync(cnPath) && !fs.existsSync(asciiPath)) { bad(`找不到产物 ${CN_EXE}`); log('\n已中止。'); process.exit(1); }
if (fs.existsSync(cnPath)) fs.copyFileSync(cnPath, asciiPath);   // electron-updater 按 latest.yml 里的 ASCII 名下载
// blockmap 也必须发，且同样要用 ASCII 名（electron-updater 请求的是「latest.yml 里那个文件名 + .blockmap」）。
// 少了它：增量更新 404 → 回退成整包全量下载，用户每次更新都要重下 103MB（实测日志：
//   Cannot download differentially, fallback to full download: ... .blockmap, status 404）。
if (fs.existsSync(cnPath + '.blockmap')) fs.copyFileSync(cnPath + '.blockmap', asciiBlockmap);
if (fs.existsSync(asciiBlockmap)) log(`  blockmap ${path.basename(asciiBlockmap)} = ${fs.statSync(asciiBlockmap).size} B`);
else bad('缺少 blockmap（增量更新会退化为全量下载）');
const exeBuf = fs.readFileSync(asciiPath);
log(`  安装包 ${ASCII_EXE} = ${exeBuf.length} B`);
// latest.yml 自检
const ymlPath = path.join(DIST, 'latest.yml');
if (!fs.existsSync(ymlPath)) bad('dist/latest.yml 不存在');
else {
  const yml = fs.readFileSync(ymlPath, 'utf8');
  const g = (re) => (yml.match(re) || [])[1];
  const yVer = g(/version:\s*(\S+)/), yPath = g(/path:\s*(\S+)/), ySha = g(/sha512:\s*(\S+)/), ySize = g(/size:\s*(\d+)/);
  if (yVer !== V) bad(`latest.yml version=${yVer}，应为 ${V}`); else ok(`latest.yml version=${yVer}`);
  if (yPath !== ASCII_EXE) bad(`latest.yml path=${yPath}，应为 ${ASCII_EXE}`); else ok(`latest.yml path=${yPath}`);
  if (ySha !== sha512b64(exeBuf)) bad('latest.yml sha512 与磁盘安装包不一致'); else ok('latest.yml sha512 与磁盘一致');
  if (Number(ySize) !== exeBuf.length) bad(`latest.yml size=${ySize}，磁盘 ${exeBuf.length}`); else ok(`latest.yml size=${ySize}`);
}
// 解包核对：安装包里的 resources/runtime == 源码 runtime/
{
  const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  const tmp = path.join(os.tmpdir(), 'jzd-release-unpack-' + V);
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const r = sh(sevenZip, ['x', asciiPath, '-o' + tmp, '-y']);
  if (r.code !== 0) bad('解包失败：' + (r.err || r.out));
  else {
    let mism = 0;
    NINE.forEach((f) => {
      const p = path.join(tmp, 'resources', 'runtime', f);
      if (!fs.existsSync(p)) { bad(`包内缺少 resources/runtime/${f}`); mism++; return; }
      if (sha256(fs.readFileSync(p)) !== sha256(fs.readFileSync(path.join(RUNTIME, f)))) { bad(`包内 ${f} 与 runtime/${f} 不一致`); mism++; }
    });
    FORBIDDEN_IN_PACKAGE.forEach((f) => { if (fs.existsSync(path.join(tmp, 'resources', 'runtime', f))) { bad(`包内出现不该有的 ${f}`); mism++; } });
    if (!mism) ok('解包核对：resources/runtime 9 个业务文件与源码逐文件一致，且无敏感文件');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) { log('\n产物自检未通过，已中止（未发布）。'); process.exit(1); }

/* ---------- 6. 发布 ---------- */
step('6/6 发布到 GitHub Releases');
if (!has('--publish') && !has('--publish-only')) {
  log('  （未加 --publish，本次只到「已打包并自检通过」为止）');
  log(`\n产物就绪：dist/${ASCII_EXE}  dist/latest.yml`);
  log(`发布命令：node release.js --publish-only`);
  process.exit(0);
}
const tag = 'v' + V;
const ASSETS = [asciiPath, ymlPath, asciiBlockmap].filter((p) => fs.existsSync(p));
let notesFile = argVal('--notes');
if (!notesFile) {
  const prev = sh('git', ['describe', '--tags', '--abbrev=0', tag + '^']).out;
  const log2 = prev ? sh('git', ['log', '--pretty=format:- %s', prev + '..HEAD']) : { out: '' };
  notesFile = path.join(os.tmpdir(), `jzd-release-notes-${V}.md`);
  fs.writeFileSync(notesFile, `## ${tag}\n\n${log2.out || '- 详见仓库提交记录'}\n`, 'utf8');
  log(`  说明文件由 git log 生成（${prev || '首个版本'}..HEAD）`);
}
const title = argVal('--title') || `${tag} ${(sh('git', ['log', '-1', '--pretty=format:%s']).out || '').replace(/^\w+(\([^)]*\))?:\s*/, '')}`.slice(0, 120);
const exists = sh('gh', ['release', 'view', tag, '--json', 'tagName']).code === 0;
if (exists) {
  log(`  release ${tag} 已存在 → 用 --clobber 覆盖上传资产`);
  const r = sh('gh', ['release', 'upload', tag].concat(ASSETS, ['--clobber']), { stdio: 'inherit' });
  if (r.code !== 0) { bad('上传失败'); process.exit(1); }
} else {
  log(`  创建 release ${tag}（tag → ${head}）：${title}`);
  const r = sh('gh', ['release', 'create', tag].concat(ASSETS, [
    '--title', title, '--notes-file', notesFile, '--target', headFull]), { stdio: 'inherit' });
  if (r.code !== 0) { bad('gh release create 失败'); process.exit(1); }
}
// 发布后复核：latest.yml 必须能从「最新 release」的下载地址取到，且版本正确
sh('git', ['fetch', '--tags', '--quiet']);   // gh 是在远端建 tag，本地补一次
const check = sh('gh', ['release', 'view', tag, '--json', 'assets,tagName,isDraft,isPrerelease']);
log('  发布结果：' + check.out.replace(/\s+/g, ' '));
const url = `https://github.com/${pkg.build.publish[0].owner}/${pkg.build.publish[0].repo}/releases/latest/download/latest.yml`;
log(`\n  检查线上更新源 ${url} ...`);
(async () => {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const body = await res.text();
    const lv = (body.match(/version:\s*(\S+)/) || [])[1];
    if (res.status === 200 && lv === V) ok(`线上更新源可达，version=${lv}`);
    else bad(`线上更新源检查失败：HTTP ${res.status}，version=${lv || '(未解析到)'}`);
  } catch (e) { bad('线上更新源不可达：' + ((e && e.message) || e)); }
  if (failed) { log('\n发布后检查未通过（release 已创建，请手工核对）。'); process.exit(1); }
  log('\n完成。已安装的旧版本会在下次启动约 5 秒后自动发现并下载 ' + V + '。');
})();
