/* ================= 翻译通道（服务端代理，规避浏览器跨域） =================
 * 由 server.js 调用： translate.handleTranslate(req, res, json)
 * 通道：
 *   fast   免密钥极速（有道 aidemo，POST 表单，实测 40~200ms；多行按行翻译）
 *   deepl  DeepL API（api-free / api，需 Key）
 *   youdao 有道智云 v3（需 appKey + appSecret，sha256 签名）
 * 任何通道失败都由前端回退到 AI 模型，这里只负责"能不能翻出来"。
 * 注意：专用翻译接口不听指令（不会保留 Markdown/代码、不会判断原文是否已是目标语言），
 *       这些差异由前端的通道选择与回退策略兜底。
 */
'use strict';

const crypto = require('crypto');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function isChinese(target) {
  return /中|zh|chinese/i.test(String(target || ''));
}
function withTimeout(ms) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, ms || 8000);
  return { signal: ctl.signal, done: function () { clearTimeout(timer); } };
}
async function postForm(url, params, timeoutMs) {
  const t = withTimeout(timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: t.signal
    });
    const txt = await r.text();
    return { status: r.status, text: txt };
  } finally { t.done(); }
}

// ---------- 免密钥极速：有道 ----------
async function fastOne(line, target) {
  const to = isChinese(target) ? 'zh-CHS' : 'en';
  const r = await postForm('https://aidemo.youdao.com/trans', { q: line, from: 'auto', to: to }, 8000);
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { throw new Error('极速通道返回异常（HTTP ' + r.status + '）'); }
  const out = (j.translation || []).join('').trim();
  if (!out) throw new Error('极速通道未返回译文（' + (j.errorCode || r.status) + '）');
  return out;
}
async function viaFast(text, target) {
  const lines = String(text).split(/\r?\n/);
  if (lines.filter(function (l) { return l.trim(); }).length > 1) {
    if (lines.length > 40) throw new Error('极速通道一次最多 40 行，请改用 AI 模型');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i].trim() ? await fastOne(lines[i], target) : '');
    }
    return out.join('\n');
  }
  return fastOne(text, target);
}

// ---------- DeepL ----------
async function viaDeepL(text, target, key, useFree) {
  if (!key) throw new Error('未配置 DeepL API Key');
  const host = (useFree === false) ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
  const r = await postForm(host + '/v2/translate', {
    auth_key: key, text: String(text), target_lang: isChinese(target) ? 'ZH' : 'EN-US'
  }, 12000);
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { throw new Error('DeepL 返回异常（HTTP ' + r.status + '）'); }
  if (r.status !== 200) throw new Error('DeepL ' + r.status + '：' + String(j.message || j.detail || r.text).slice(0, 120));
  const out = j.translations && j.translations[0] && j.translations[0].text;
  if (!out) throw new Error('DeepL 未返回译文');
  return String(out).trim();
}

// ---------- 有道智云 v3 ----------
async function viaYoudao(text, target, appKey, appSecret) {
  if (!appKey || !appSecret) throw new Error('未配置有道智云 appKey / appSecret');
  const q = String(text);
  const salt = String(Date.now()) + Math.floor(Math.random() * 1000);
  const curtime = String(Math.floor(Date.now() / 1000));
  const input = q.length <= 20 ? q : (q.slice(0, 10) + q.length + q.slice(-10));
  const sign = crypto.createHash('sha256').update(appKey + input + salt + curtime + appSecret).digest('hex');
  const r = await postForm('https://openapi.youdao.com/api', {
    q: q, from: 'auto', to: isChinese(target) ? 'zh-CHS' : 'en',
    appKey: appKey, salt: salt, sign: sign, signType: 'v3', curtime: curtime
  }, 12000);
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { throw new Error('有道智云返回异常（HTTP ' + r.status + '）'); }
  if (String(j.errorCode) !== '0') {
    const codes = { 108: '应用 ID 无效', 110: '无权访问该接口', 202: '签名校验失败', 203: '访问 IP 不在白名单', 401: '账户已欠费' };
    throw new Error('有道智云错误 ' + j.errorCode + (codes[j.errorCode] ? ('（' + codes[j.errorCode] + '）') : ''));
  }
  const out = (j.translation || [])[0];
  if (!out) throw new Error('有道智云未返回译文');
  return String(out).trim();
}

const LABEL = { fast: '有道极速', deepl: 'DeepL', youdao: '有道智云' };

async function handleTranslate(req, res, json) {
  let body = '';
  try { for await (const chunk of req) body += chunk; } catch (e) {}
  let cfg = null;
  try { cfg = JSON.parse(body || '{}'); } catch (e) { json(res, 400, { error: '请求体不是合法JSON' }); return; }
  const provider = String(cfg.provider || 'fast');
  const text = String(cfg.text || '');
  const target = String(cfg.target || '英文');
  if (!text.trim()) { json(res, 400, { error: '没有可翻译的内容' }); return; }
  const c = cfg.cfg || {};
  const t0 = Date.now();
  try {
    let out = '';
    if (provider === 'fast') out = await viaFast(text, target);
    else if (provider === 'deepl') out = await viaDeepL(text, target, String(c.deeplKey || '').trim(), c.deeplFree);
    else if (provider === 'youdao') out = await viaYoudao(text, target, String(c.ydAppKey || '').trim(), String(c.ydAppSecret || '').trim());
    else { json(res, 400, { error: '未知翻译通道：' + provider }); return; }
    json(res, 200, { translation: out, provider: provider, label: LABEL[provider] || provider, ms: Date.now() - t0 });
  } catch (e) {
    json(res, 502, { error: String((e && e.message) || e), provider: provider });
  }
}

module.exports = { handleTranslate: handleTranslate, _internal: { viaFast: viaFast, viaDeepL: viaDeepL, viaYoudao: viaYoudao } };
