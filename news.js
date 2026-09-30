/* ================= 摸鱼新闻：热榜聚合 + 搜索（服务端代理，规避浏览器跨域） =================
 * 由 server.js 调用：news.handleNews(req, res, json) / news.handleNewsSearch(req, res, json)
 * 全部使用公开免密钥接口；单个来源失败不影响其它来源；带内存缓存避免频繁打上游。
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SOURCES = [
  { key: 'baidu', name: '百度热搜', group: '综合' },
  { key: 'toutiao', name: '今日头条', group: '综合' },
  { key: 'bili', name: 'B站热门', group: '视频' },
  { key: 'juejin', name: '掘金热榜', group: '技术' },
  { key: 'sspai', name: '少数派', group: '技术' }
];
const SOURCE_MAP = {};
SOURCES.forEach(function (s) { SOURCE_MAP[s.key] = s; });

const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
  return Promise.resolve().then(fn).then(function (data) { cache.set(key, { at: Date.now(), data: data }); return data; });
}

async function fetchAny(url, headers, asJson) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 12000);
  try {
    const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}), signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return asJson ? await r.json() : await r.text();
  } finally { clearTimeout(timer); }
}

// 去标签 + 反转义，得到干净的纯文本标题
function plain(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ').trim();
}
function xmlPick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}
function isoOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : v);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return null;   // 掘金热榜 ctime 为 0，避免显示 1970 年
  return d.toISOString();
}

// 上游偶发限流/风控时重试一次
function withRetry(fn, times) {
  return fn().catch(function (e) {
    if (!times) throw e;
    return new Promise(function (res) { setTimeout(res, 500); }).then(function () { return withRetry(fn, times - 1); });
  });
}

const LOADERS = {
  // 百度热搜：data.cards[0].content[0].content[] -> {word,url,isTop}
  baidu: async function () {
    const j = await fetchAny('https://top.baidu.com/api/board?platform=wise&tab=realtime', {}, true);
    if (!j.success) throw new Error('百度热搜返回 success=false');
    let list = [];
    ((j.data && j.data.cards) || []).forEach(function (c) {
      ((c.content || [])[0] && c.content[0].content || []).forEach(function (x) { list.push(x); });
    });
    return list.map(function (it, i) {
      const w = plain(it.word);
      return {
        rank: i + 1, title: w,
        url: it.url || ('https://www.baidu.com/s?wd=' + encodeURIComponent(w)),
        hot: null, time: null, extra: ''
      };
    });
  },
  // 今日头条热榜：data[] -> {Title,Url,HotValue,Label}
  toutiao: async function () {
    const j = await fetchAny('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', {}, true);
    return (j.data || []).map(function (it, i) {
      return {
        rank: i + 1, title: plain(it.Title),
        url: it.Url || ('https://www.toutiao.com/trending/' + (it.ClusterIdStr || it.ClusterId) + '/'),
        hot: Number(it.HotValue) || null, time: null, extra: plain(it.Label || '')
      };
    });
  },
  // B站排行榜：data.list[] -> {title,short_link_v2,stat.view,pubdate,owner.name}
  bili: async function () {
    // 注意：B站缺 Origin 头会被风控直接返回 code=-352（且 HTTP 仍是 200，静默变空列表）
    const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    const j = await fetchAny('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
      { Referer: 'https://www.bilibili.com/v/popular/rank/all', Origin: 'https://www.bilibili.com', Cookie: 'buvid3=' + uuid + 'infoc' }, true);
    if (j.code !== 0) throw new Error('B站风控 code=' + j.code);
    const list = (j.data && j.data.list) || [];
    return list.map(function (it, i) {
      return {
        rank: i + 1, title: plain(it.title),
        url: it.short_link_v2 || ('https://www.bilibili.com/video/' + (it.bvid || '')),
        hot: it.stat ? it.stat.view : null,
        time: isoOrNull(it.pubdate ? it.pubdate * 1000 : null),
        extra: it.owner ? plain(it.owner.name) : ''
      };
    });
  },
  // 掘金热榜：data[] -> {content:{title,content_id,brief,ctime}, content_counter:{view}}
  juejin: async function () {
    const j = await fetchAny('https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot', {}, true);
    if (j.err_no !== 0) throw new Error('掘金返回 err_no=' + j.err_no);
    return (j.data || []).map(function (it, i) {
      const c = it.content || {}, cc = it.content_counter || {};
      return {
        rank: i + 1, title: plain(c.title),
        url: 'https://juejin.cn/post/' + (c.content_id || ''),
        hot: cc.view || null, time: isoOrNull(c.ctime),
        extra: plain(c.brief || '').slice(0, 90)
      };
    });
  },
  // 少数派 RSS
  sspai: async function () {
    const xml = await fetchAny('https://sspai.com/feed', {}, false);
    const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return blocks.slice(0, 30).map(function (b, i) {
      return {
        rank: i + 1, title: plain(xmlPick(b, 'title')),
        url: xmlPick(b, 'link'),
        hot: null, time: isoOrNull(xmlPick(b, 'pubDate')),
        extra: plain(xmlPick(b, 'description')).slice(0, 90)
      };
    });
  }
};

async function searchJuejin(q) {
  const j = await fetchAny('https://api.juejin.cn/search_api/v1/search?query=' + encodeURIComponent(q) + '&id_type=2&cursor=0&limit=30&search_type=0', {}, true);
  return (j.data || []).map(function (it, i) {
    const ai = (it.result_model && it.result_model.article_info) || {};
    return {
      rank: i + 1, source: 'juejin', sourceName: '掘金搜索', group: '搜索',
      title: plain(ai.title), url: 'https://juejin.cn/post/' + (ai.article_id || ''),
      hot: ai.view_count || null, time: isoOrNull(ai.ctime),
      extra: plain(ai.brief_content || '').slice(0, 90)
    };
  }).filter(function (x) { return x.title && x.url; });
}
async function searchHN(q) {
  const j = await fetchAny('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(q) + '&tags=story&hitsPerPage=30', {}, true);
  return (j.hits || []).filter(function (h) { return h && h.title; }).map(function (h, i) {
    return {
      rank: i + 1, source: 'hn', sourceName: 'Hacker News', group: '搜索',
      title: plain(h.title),
      url: h.url || ('https://news.ycombinator.com/item?id=' + h.objectID),
      hot: h.points || null, time: isoOrNull(h.created_at),
      extra: (h.num_comments || 0) + ' 条评论'
    };
  });
}
function search(q, engine) {
  return engine === 'hn' ? searchHN(q) : searchJuejin(q);
}


// ================= 应用内阅读：正文提取 =================
function metaOf(head, name) {
  const tags = head.match(/<meta[^>]*>/gi) || [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t.toLowerCase().indexOf(String(name).toLowerCase()) < 0) continue;
    const c = t.match(/content=("[^"]*"|'[^']*'|[^\s>]+)/i);
    if (!c) continue;
    let v = c[1];
    if ((v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') || (v.charAt(0) === "'" && v.charAt(v.length - 1) === "'")) v = v.slice(1, -1);
    return plain(v);
  }
  return '';
}
function extractArticle(html, url) {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  h = h.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  h = h.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  h = h.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  h = h.replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');
  const head = h.slice(0, 300000);
  let title = '';
  const h1 = head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) title = plain(h1[1]);
  if (!title || title.length < 4) title = metaOf(head, 'og:title') || metaOf(head, 'twitter:title');
  if (!title || title.length < 4) title = plain((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (title.length > 16) {
    const cut = title.replace(/\s*[-_|·]\s*[^-_|·]{1,20}$/, '');   // 去掉末尾站点名（如 "标题 - 掘金"）
    if (cut.length >= 8) title = cut;
  }
  let site = metaOf(head, 'og:site_name');
  if (!site) { try { site = new URL(url).hostname; } catch (e) { site = ''; } }
  const image = metaOf(head, 'og:image');
  // 正文范围：优先 article 容器，其次常见正文容器
  let scope = h;
  const cands = [/<article[\s\S]*?<\/article>/i, /<div[^>]+(?:id|class)=["'][^"']*(?:article|content|post|main)[^"']*["'][\s\S]*?<\/div>/i];
  for (let i = 0; i < cands.length; i++) {
    const m = h.match(cands[i]);
    if (m && m[0].length > 600) { scope = m[0]; break; }
  }
  function uniq(arr) { const seen = {}; return arr.filter(function (t) { if (seen[t]) return false; seen[t] = 1; return true; }); }
  let paras = uniq((scope.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).map(function (p) { return plain(p); }).filter(function (t) { return t.length >= 10; }));
  let text = paras.join('\n');
  if (text.length < 200) {
    const raw = String(scope)
      .replace(/<\/(p|div|li|h[1-6]|tr|section|td)>/gi, '\n')
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ');
    paras = uniq(raw.split('\n').map(function (x) { return plain(x); }).filter(function (t) { return t.length >= 12; }));
    text = paras.join('\n');
  }
  if (text.length > 20000) text = text.slice(0, 20000);
  return { url: url, title: title, site: site, image: image, paragraphs: paras.slice(0, 200), text: text, chars: text.length };
}

async function fetchArticle(url) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 15000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow', signal: ctl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer()).slice(0, 3 * 1024 * 1024);
    const ct = String(r.headers.get('content-type') || '');
    const sniff = buf.slice(0, 4096).toString('latin1');
    let enc = ((ct.match(/charset=([\w-]+)/i) || [])[1] || (sniff.match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8').toLowerCase();
    let html;
    if (enc === 'gbk' || enc === 'gb2312' || enc === 'gb18030') {
      try { html = new TextDecoder('gb18030').decode(buf); } catch (e) { html = buf.toString('utf8'); }
    } else {
      html = buf.toString('utf8');
    }
    return extractArticle(html, url);
  } finally { clearTimeout(timer); }
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h.indexOf('[') === 0) return true;
  return false;
}

async function handleNewsArticle(req, res, json) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const target = String(u.searchParams.get('url') || '').trim();
  if (!/^https?:\/\//i.test(target)) { json(res, 400, { error: '仅支持 http/https 链接' }); return; }
  let host = '';
  try { host = new URL(target).hostname; } catch (e) { json(res, 400, { error: '链接格式不合法' }); return; }
  if (isPrivateHost(host)) { json(res, 400, { error: '不允许访问内网地址' }); return; }
  try {
    const art = await cached('art:' + target, 600000, function () { return fetchArticle(target); });
    json(res, 200, art);
  } catch (e) {
    json(res, 502, { error: String((e && e.message) || e) });
  }
}

async function handleNews(req, res, json) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const src = String(u.searchParams.get('source') || 'all').toLowerCase();
  const wanted = src === 'all' ? SOURCES.map(function (s) { return s.key; }) : (SOURCE_MAP[src] ? [src] : []);
  if (!wanted.length) { json(res, 400, { error: '未知来源：' + src }); return; }
  const results = await Promise.all(wanted.map(function (k) {
    return cached('src:' + k, 60000, function () { return withRetry(function () { return LOADERS[k](); }, 1); })
      .then(function (items) {
        if (!items || !items.length) throw new Error('未取到数据（可能被上游限流）');
        return { key: k, ok: true, items: items };
      })
      .catch(function (e) { return { key: k, ok: false, error: String((e && e.message) || e), items: [] }; });
  }));
  const items = [];
  results.forEach(function (r) {
    (r.items || []).forEach(function (it) {
      it.source = r.key;
      it.sourceName = SOURCE_MAP[r.key].name;
      it.group = SOURCE_MAP[r.key].group;
      items.push(it);
    });
  });
  json(res, 200, {
    updatedAt: new Date().toISOString(),
    sources: results.map(function (r) { return { key: r.key, name: SOURCE_MAP[r.key].name, ok: r.ok, error: r.error || null, count: (r.items || []).length }; }),
    items: items
  });
}

async function handleNewsSearch(req, res, json) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const q = String(u.searchParams.get('q') || '').trim();
  const engine = String(u.searchParams.get('engine') || 'juejin').toLowerCase();
  if (!q) { json(res, 400, { error: '缺少搜索关键词 q' }); return; }
  if (engine !== 'juejin' && engine !== 'hn') { json(res, 400, { error: '未知搜索引擎：' + engine }); return; }
  try {
    const items = await cached('q:' + engine + ':' + q, 120000, function () { return search(q, engine); });
    json(res, 200, { query: q, engine: engine, updatedAt: new Date().toISOString(), items: items });
  } catch (e) {
    json(res, 502, { error: String((e && e.message) || e) });
  }
}

module.exports = { handleNews: handleNews, handleNewsSearch: handleNewsSearch, handleNewsArticle: handleNewsArticle, SOURCES: SOURCES, _internal: { LOADERS: LOADERS, search: search, fetchArticle: fetchArticle, extractArticle: extractArticle } };
