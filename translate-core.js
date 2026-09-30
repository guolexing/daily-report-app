/* ================= 翻译工具共享核心 =================
 * 被 index.html（⑨ 工具箱 → 翻译工具）与 translate.html（划词结果浮窗）共用：
 *   - 配置读取/保存（专用配置为空时自动沿用「数据管理 → AI 设置」）
 *   - 调用 OpenAI 兼容接口完成翻译
 *   - 常用复制格式模板（纯译文 / 双语对照 / 逐段对照 / Markdown / JSON / 表格）
 */
(function () {
  var KEY = 'jzd_tr_v1', AIKEY = 'jzd_ai_v1';
  function readJSON(k, def) {
    try { var v = JSON.parse(localStorage.getItem(k)); return (v && typeof v === 'object') ? v : def; } catch (e) { return def; }
  }
  function aiCfg() {
    var a = readJSON(AIKEY, {}) || {};
    return {
      base: String(a.base || 'https://api.deepseek.com/v1').trim(),
      key: String(a.key || '').trim(),
      model: String(a.model || 'deepseek-chat').trim()
    };
  }
  // 翻译配置：本工具留空的字段自动回落到 AI 设置
  function cfg() {
    var t = readJSON(KEY, {}) || {}, a = aiCfg();
    var base = String(t.base || '').trim(), key = String(t.key || '').trim(), model = String(t.model || '').trim();
    return {
      base: base || a.base,
      key: key || a.key,
      model: model || a.model,
      provider: String(t.provider || '').trim() || 'ai',
      deeplKey: String(t.deeplKey || '').trim(),
      deeplFree: t.deeplFree !== false,
      ydAppKey: String(t.ydAppKey || '').trim(),
      ydAppSecret: String(t.ydAppSecret || '').trim(),
      target: String(t.target || '').trim() || '中文',
      shortcut: String(t.shortcut || '').trim() || 'Control+Alt+Q',
      pasteShortcut: String(t.pasteShortcut || '').trim() || 'Control+Alt+V',
      own: !!(base || key || model),
      fromAI: !(key || base)
    };
  }
  function save(patch) {
    var t = readJSON(KEY, {}) || {};
    Object.keys(patch || {}).forEach(function (k) { t[k] = patch[k]; });
    localStorage.setItem(KEY, JSON.stringify(t));
    return cfg();
  }
  function endpoint() {
    if (location.protocol === 'file:') return 'http://127.0.0.1:8080/api/ai/chat';
    return '/api/ai/chat';
  }
  function endpointTranslate() {
    if (location.protocol === 'file:') return 'http://127.0.0.1:8080/api/translate';
    return '/api/translate';
  }
  var PROVIDERS = [
    { id: 'ai', label: 'AI 模型', tip: '指令可控：保留 Markdown/代码、判断原文语言；速度 1~4 秒' },
    { id: 'fast', label: '极速（免密钥）', tip: '有道公开接口，约 0.05~0.2 秒；失败自动回退 AI' },
    { id: 'deepl', label: 'DeepL', tip: '需 API Key；质量好、速度快，失败自动回退 AI' },
    { id: 'youdao', label: '有道智云', tip: '需 appKey + appSecret；国内速度稳，失败自动回退 AI' }
  ];
  function providerLabel(id, model) {
    if (id === 'ai') return model || 'AI';
    var p = PROVIDERS.filter(function (x) { return x.id === id; })[0];
    return p ? p.label : id;
  }
  // 走服务端代理调用专用翻译通道
  async function translateByProvider(provider, text, target, c) {
    var resp = await fetch(endpointTranslate(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: provider, text: text, target: target,
        cfg: { deeplKey: c.deeplKey, deeplFree: c.deeplFree, ydAppKey: c.ydAppKey, ydAppSecret: c.ydAppSecret }
      })
    });
    var j = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(j.error || ('HTTP ' + resp.status));
    if (!j.translation) throw new Error('接口未返回译文');
    return { translation: String(j.translation).trim(), ms: j.ms || 0, label: j.label || provider, provider: provider };
  }
  function splitParas(s) {
    return String(s == null ? '' : s).replace(/\r\n?/g, '\n').split(/\n\s*\n/)
      .map(function (x) { return x.trim(); }).filter(Boolean);
  }
  // 返回 {translation, source, target, model, ms}
  // 走 AI 模型（OpenAI 兼容）
  async function translateByAI(src, tgt, c) {
    if (!c.key) throw new Error('未配置 API Key：可在「⑨ 工具箱」填写，或到「数据管理 → AI 设置」配置');
    var t0 = Date.now();
    var sys = '你是专业翻译引擎，把用户提供的文本翻译成' + tgt + '。严格遵守：\n'
      + '1) 只输出译文本身，不要任何解释、前言、引号或代码块包裹；\n'
      + '2) 保留原文的段落结构：原文分段，译文也用空行分段，段落顺序一一对应；\n'
      + '3) 代码、命令、URL、文件名、变量名、Markdown 标记原样保留不翻译；\n'
      + '4) 专有名词使用通行译名，必要时中英并列；\n'
      + '5) 若原文已经是' + tgt + '，则翻译成英文。';
    var resp = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base: c.base, key: c.key, model: c.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: src }]
      })
    });
    var j = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(j.error || ('HTTP ' + resp.status));
    var out = String(j.content || '').trim();
    if (!out) throw new Error('接口未返回译文');
    return { translation: out, provider: 'ai', label: c.model, ms: Date.now() - t0 };
  }

  var CACHE = new Map();   // 同文 + 同通道只翻一次，重复划词秒出
  async function translate(text, targetOverride) {
    var c = cfg();
    var src = String(text == null ? '' : text);
    if (!src.trim()) throw new Error('没有可翻译的内容');
    var tgt = String(targetOverride || c.target || '中文').trim();
    var prov = String(c.provider || 'ai');
    var ck = prov + '|' + c.model + '|' + tgt + '|' + src;
    if (CACHE.has(ck)) {
      var hit = CACHE.get(ck);
      return { translation: hit.translation, source: src, target: tgt, model: hit.model,
               provider: hit.provider, label: hit.label, fallback: hit.fallback, ms: 0, cached: true };
    }
    // 非 AI 通道：失败自动回退到 AI 模型
    var r = null, fallback = '';
    if (prov !== 'ai') {
      try { r = await translateByProvider(prov, src, tgt, c); }
      catch (e) { fallback = String((e && e.message) || e); }
    }
    if (!r) {
      if (!c.key) {
        if (fallback) throw new Error(fallback + '；且没有可回退的 AI 配置');
        throw new Error('未配置 API Key：可在「⑨ 工具箱」填写，或到「数据管理 → AI 设置」配置');
      }
      r = await translateByAI(src, tgt, c);
    }
    var rec = {
      translation: r.translation, source: src, target: tgt,
      model: r.label || c.model, provider: r.provider || 'ai', label: r.label || c.model,
      fallback: fallback || null, ms: r.ms || 0
    };
    if (CACHE.size > 200) CACHE.clear();
    CACHE.set(ck, rec);
    histAdd(rec);   // 进入历史，粘贴时可选
    return rec;
  }
  // ---------- 翻译历史（供「粘贴时选择内容」使用，主窗与浮窗共用同一 localStorage） ----------
  var HKEY = 'jzd_tr_hist_v1', FKEY = 'jzd_tr_fmt_v1';
  function hist() {
    try { var a = JSON.parse(localStorage.getItem(HKEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function histAdd(rec) {
    var a = hist().filter(function (x) { return !(x.src === rec.source && x.dst === rec.translation); });
    a.unshift({ at: Date.now(), src: rec.source, dst: rec.translation, target: rec.target, model: rec.model });
    if (a.length > 12) a = a.slice(0, 12);
    try { localStorage.setItem(HKEY, JSON.stringify(a)); } catch (e) {}
    return a;
  }
  function histClear() { try { localStorage.removeItem(HKEY); } catch (e) {} }
  function lastFmt() { try { return localStorage.getItem(FKEY) || 'text'; } catch (e) { return 'text'; } }
  function setLastFmt(f) { try { localStorage.setItem(FKEY, f); } catch (e) {} }

  // ---------- 命名风格转换（把译文变成可直接用的标识符） ----------
  // "用户登录时间" → translate → "user login time" → testData/TestData/test_data/TEST_DATA
  function words(s) {
    return String(s == null ? '' : s)
      .replace(/[\u2018\u2019\u201c\u201d'"`]/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')            // camelCase → camel Case
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')          // HTTPServer → HTTP Server
      .split(/[^0-9A-Za-z]+/)
      .filter(Boolean);
  }
  function ident(s, mode) {
    var w = words(s);
    if (!w.length) return '';
    var low = w.map(function (x) { return x.toLowerCase(); });
    var cap = function (x) { return x.charAt(0).toUpperCase() + x.slice(1); };
    if (mode === 'snake') return low.join('_');
    if (mode === 'constant') return w.map(function (x) { return x.toUpperCase(); }).join('_');
    if (mode === 'kebab') return low.join('-');
    if (mode === 'pascal') return low.map(cap).join('');
    return low[0] + low.slice(1).map(cap).join('');       // camel
  }

  var FORMATS = [
    { id: 'text', label: '纯译文', tip: '译文原样输出，适合句子/段落' },
    { id: 'camel', label: 'camelCase', tip: '例：testData —— 变量 / 方法名' },
    { id: 'pascal', label: 'PascalCase', tip: '例：TestData —— 类名 / 组件名' },
    { id: 'snake', label: 'snake_case', tip: '例：test_data —— 数据库字段 / Python' },
    { id: 'constant', label: 'CONSTANT_CASE', tip: '例：TEST_DATA —— 常量 / 枚举' },
    { id: 'kebab', label: 'kebab-case', tip: '例：test-data —— CSS 类名 / URL' }
  ];
  function cleanCell(s) { return String(s == null ? '' : s).replace(/\t/g, ' ').replace(/\r?\n/g, ' ⏎ '); }
  // 取某个格式的结果；标识符格式在译文非英文时自动退回纯译文
  function build(id, source, translation, meta) {
    meta = meta || {};
    var dst = String(translation == null ? '' : translation);
    if (!id || id === 'text') return dst;
    var v = ident(dst, id);
    return v || dst;
  }
  // 某格式是否适用于这段译文（供界面提示"仅英文可转命名"）
  function usable(id, translation) {
    if (!id || id === 'text') return true;
    return !!ident(String(translation == null ? '' : translation), id);
  }
  window.TRCore = {
    KEY: KEY, AIKEY: AIKEY,
    cfg: cfg, save: save, aiCfg: aiCfg, translate: translate,
    formats: FORMATS, build: build, usable: usable, ident: ident, words: words, splitParas: splitParas,
    providers: PROVIDERS, providerLabel: providerLabel,
    hist: hist, histAdd: histAdd, histClear: histClear, lastFmt: lastFmt, setLastFmt: setLastFmt
  };
})();
