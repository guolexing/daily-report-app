/* ================= 股市行情：腾讯行情/分时/K线/搜索（服务端代理） =================
 * 由 server.js 调用；全部免密钥；带内存缓存。注意：qt.gtimg.cn 返回 GBK，必须按 GB18030 解码。
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
  return Promise.resolve().then(fn).then(function (d) { cache.set(key, { at: Date.now(), data: d }); return d; });
}
async function getBuf(url, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 12000);
  try {
    const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}), signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}
function gbk(buf) {
  try { return new TextDecoder('gb18030').decode(buf); } catch (e) { return buf.toString('utf8'); }
}
async function getGBK(url, headers) { return gbk(await getBuf(url, headers)); }
async function getJson(url, headers) {
  const txt = (await getBuf(url, headers)).toString('utf8');
  try { return JSON.parse(txt); } catch (e) { throw new Error('返回不是合法 JSON'); }
}
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
// 腾讯对部分 A 股名称会插入空格（如 "五 粮 液"），纯中文名去掉空格
function normName(s) { const v = String(s == null ? '' : s).trim(); return /^[\u4e00-\u9fff\s]+$/.test(v) ? v.replace(/\s+/g, '') : v; }
function fmtTime(ts) {   // 20260930140818 -> 14:08:18
  const s = String(ts || '');
  return s.length >= 14 ? (s.slice(8, 10) + ':' + s.slice(10, 12) + ':' + s.slice(12, 14)) : '';
}
function cleanCode(c) {
  const s = String(c || '').trim().replace(/[^A-Za-z0-9.]/g, '');
  const m = s.match(/^(sh|sz|bj|hk|us)(.+)$/i);
  if (m) {
    const p = m[1].toLowerCase(), rest = m[2];
    // A 股代码小写；港股/美股指数代码腾讯要求大写（hkHSI / usDJI / usIXIC / usINX）
    return (p === 'sh' || p === 'sz' || p === 'bj') ? p + rest.toLowerCase() : p + rest.toUpperCase();
  }
  if (/^(6|5|9)/.test(s)) return 'sh' + s;
  if (/^(0|1|2|3)/.test(s)) return 'sz' + s;
  return s;
}
function unesc(s) { return String(s == null ? '' : s).replace(/\\u([0-9a-f]{4})/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); }); }
// 腾讯行情行 -> 结构化（三市场字段位置一致：3 现价 / 4 昨收 / 5 今开 / 31 涨跌 / 32 涨幅 / 33 最高 / 34 最低）
function parseQuote(code, line) {
  const m = String(line).match(/="([^"]*)"/);
  if (!m) return null;
  const f = m[1].split('~');
  if (f.length < 35) return null;
  const price = num(f[3]), prev = num(f[4]);
  let change = num(f[31]), pct = num(f[32]);
  if (change === null && price !== null && prev !== null) change = Math.round((price - prev) * 1000) / 1000;
  if (pct === null && change !== null && prev) pct = Math.round(change / prev * 10000) / 100;
  return {
    code: code, name: normName(f[1]), price: price, prevClose: prev, open: num(f[5]),
    change: change, changePct: pct, high: num(f[33]), low: num(f[34]),
    volume: num(f[36]), amount: num(f[37]), turnover: num(f[38]),
    time: /^\d{14}$/.test(String(f[30] || '')) ? fmtTime(f[30]) : ''   // 港/美股时间字段位置不同，取不到就留空
  };
}
async function quotes(codes) {
  const list = (Array.isArray(codes) ? codes : String(codes || '').split(',')).map(cleanCode).filter(Boolean).slice(0, 60);
  if (!list.length) return [];
  const txt = await getGBK('https://qt.gtimg.cn/q=' + list.join(','));
  const byCode = {};
  txt.split(';').forEach(function (line) {
    const m = line.match(/v_([a-z0-9.]+)=/i);
    if (!m) return;
    const key = cleanCode(m[1]);
    const q = parseQuote(key, line);
    if (q) byCode[key] = q;
  });
  return list.map(function (c) { return byCode[c] || { code: c, name: '', price: null, error: '未取到' }; });
}
async function minute(code) {
  const c = cleanCode(code);
  const j = await getJson('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + c);
  const node = (j.data || {})[c];
  if (!node) throw new Error('未取到分时数据');
  const d = (node.data || {});
  const rows = d.data || [];
  const points = rows.map(function (row) {
    const p = String(row).split(/\s+/);
    return { t: p[0] || '', price: num(p[1]), vol: num(p[2]) || 0 };
  }).filter(function (x) { return x.price !== null; });
  const qt = (node.qt || {})[c] || [];
  return { code: c, name: qt[1] || '', date: d.date || '', prevClose: num(qt[4]), points: points };
}
async function kline(code, days) {
  const c = cleanCode(code), n = Math.min(Math.max(parseInt(days, 10) || 60, 5), 240);
  const j = await getJson('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + c + ',day,,,' + n + ',qfq');
  const node = (j.data || {})[c] || {};
  const rows = node.qfqday || node.day || [];
  return {
    code: c, name: ((node.qt || {})[c] || [])[1] || '',
    bars: rows.map(function (r) {
      return { date: r[0], open: num(r[1]), close: num(r[2]), high: num(r[3]), low: num(r[4]), volume: num(r[5]) };
    }).filter(function (b) { return b.date && b.close !== null; })
  };
}
async function search(q) {
  const kw = String(q || '').trim();
  if (!kw) return [];
  const txt = await getGBK('https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(kw) + '&t=all');
  const m = txt.match(/="([^"]*)"/);
  if (!m) return [];
  return m[1].split('^').map(function (seg) {
    const f = seg.split('~');
    if (f.length < 3) return null;
    const market = f[0], code = f[1], name = normName(unesc(f[2]));
    if (!market || !code || !name) return null;
    return { symbol: cleanCode(market + code), code: code, name: name, market: market, type: f[4] || '' };
  }).filter(Boolean).filter(function (x) { return /^(sh|sz|bj|hk|us)$/.test(x.market); }).slice(0, 12);
}
const INDEX_CODES = ['sh000001', 'sz399001', 'sz399006', 'sh000688', 'hkHSI', 'usDJI', 'usIXIC', 'usINX'];

function parseCodes(req) {
  const u = new URL(req.url, 'http://127.0.0.1');
  return String(u.searchParams.get('codes') || INDEX_CODES.join(','));
}
async function handleStockQuotes(req, res, json) {
  try { json(res, 200, { updatedAt: new Date().toISOString(), items: await cached('q:' + parseCodes(req), 5000, function () { return quotes(parseCodes(req)); }) }); }
  catch (e) { json(res, 502, { error: String((e && e.message) || e) }); }
}
async function handleStockMinute(req, res, json) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const code = String(u.searchParams.get('code') || '');
  if (!code) { json(res, 400, { error: '缺少 code' }); return; }
  try { json(res, 200, await cached('m:' + code, 30000, function () { return minute(code); })); }
  catch (e) { json(res, 502, { error: String((e && e.message) || e) }); }
}
async function handleStockKline(req, res, json) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const code = String(u.searchParams.get('code') || '');
  const days = String(u.searchParams.get('days') || '60');
  if (!code) { json(res, 400, { error: '缺少 code' }); return; }
  try { json(res, 200, await cached('k:' + code + ':' + days, 300000, function () { return kline(code, days); })); }
  catch (e) { json(res, 502, { error: String((e && e.message) || e) }); }
}
async function handleStockSearch(req, res, json) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const q = String(u.searchParams.get('q') || '');
  try { json(res, 200, { items: await cached('s:' + q, 300000, function () { return search(q); }) }); }
  catch (e) { json(res, 502, { error: String((e && e.message) || e) }); }
}

module.exports = {
  handleStockQuotes: handleStockQuotes, handleStockMinute: handleStockMinute,
  handleStockKline: handleStockKline, handleStockSearch: handleStockSearch,
  INDEX_CODES: INDEX_CODES,
  _internal: { quotes: quotes, minute: minute, kline: kline, search: search, parseQuote: parseQuote }
};
