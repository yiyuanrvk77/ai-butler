/* ============================================================
 * AI 管家 · 内嵌版（Widget）
 * 用法：在任意网页里加一行
 *   <script src="butler-widget.js" data-butler-name="小管家" data-color="#e8865a"></script>
 * 可选：在脚本之前定义 window.__BUTLER_CONFIG 接入真实 AI
 *   window.__BUTLER_CONFIG = { api: { baseUrl, model, key } };
 * 记忆存在当前网站的浏览器本地，每个用户、每个网站各一份。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__butlerWidgetLoaded) return;
  window.__butlerWidgetLoaded = true;

  var LS_KEY = 'butler-widget-data-v1';

  /* ---------- 配置 ---------- */
  var config = { name: '小管家', color: '#e8865a', api: null };
  try {
    var script = document.currentScript ||
      document.querySelector('script[data-butler-name]') ||
      document.querySelector('script[src*="butler-widget.js"]');
    if (script) {
      if (script.getAttribute('data-butler-name')) config.name = script.getAttribute('data-butler-name');
      if (script.getAttribute('data-color')) config.color = script.getAttribute('data-color');
    }
    if (window.__BUTLER_CONFIG) {
      var cfg = window.__BUTLER_CONFIG;
      if (cfg.name) config.name = cfg.name;
      if (cfg.api) config.api = cfg.api;
    }
  } catch (e) { /* 保持默认 */ }

  /* ---------- 数据 ---------- */
  function defaults() {
    return { userName: '', facts: [], vitals: { bp: null, bs: null }, chat: [], greeted: false };
  }
  function load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        d.facts = d.facts || [];
        d.chat = d.chat || [];
        d.vitals = d.vitals || { bp: null, bs: null };
        return d;
      }
    } catch (e) { /* 隐私模式等场景下静默 */ }
    return defaults();
  }
  var data = load();
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* 忽略 */ }
  }

  function uid() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hm() {
    var d = new Date();
    return (d.getHours() < 10 ? '0' + d.getHours() : d.getHours()) + ':' +
      (d.getMinutes() < 10 ? '0' + d.getMinutes() : d.getMinutes());
  }
  function greetingWord() {
    var h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  /* ---------- 样式 ---------- */
  var css = [
    '#bwRoot{--bw-a:' + config.color + ';position:fixed;right:18px;bottom:18px;z-index:999999;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;font-size:15px;line-height:1.55;color:#3a352f}',
    '#bwRoot *{box-sizing:border-box;margin:0;padding:0}',
    '#bwFab{width:60px;height:60px;border-radius:50%;border:0;background:var(--bw-a);color:#fff;font-size:28px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}',
    '#bwFab:hover{transform:scale(1.06)}',
    '#bwPanel{position:fixed;right:18px;bottom:18px;width:360px;max-width:calc(100vw - 24px);height:min(560px,78vh);background:#fff;border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden}',
    '#bwPanel[hidden]{display:none}',
    '#bwHead{background:var(--bw-a);color:#fff;padding:12px 14px;display:flex;align-items:center;gap:10px}',
    '#bwHead .bw-av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-size:20px;flex:none}',
    '#bwHead .bw-ti{flex:1;min-width:0}',
    '#bwHead .bw-ti b{display:block;font-size:16px}',
    '#bwHead .bw-ti span{display:block;font-size:12px;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#bwClose{border:0;background:rgba(255,255,255,.2);color:#fff;width:28px;height:28px;border-radius:50%;font-size:16px;cursor:pointer;flex:none}',
    '#bwTabs{display:flex;border-bottom:1px solid #eee;background:#fff}',
    '#bwTabs button{flex:1;padding:10px;border:0;background:none;font-size:14px;color:#8a8177;cursor:pointer;border-bottom:2px solid transparent}',
    '#bwTabs button.on{color:var(--bw-a);border-bottom-color:var(--bw-a);font-weight:700}',
    '#bwBody{flex:1;display:flex;min-height:0}',
    '.bw-view{flex:1;display:flex;flex-direction:column;min-height:0}',
    '.bw-view[hidden]{display:none}',
    '#bwMsgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}',
    '.bw-m{max-width:82%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-break:break-word;font-size:14.5px}',
    '.bw-m.u{align-self:flex-end;background:var(--bw-a);color:#fff;border-bottom-right-radius:4px}',
    '.bw-m.a{align-self:flex-start;background:#f6f3ec;border-bottom-left-radius:4px}',
    '.bw-m.ty{color:#8a8177;font-style:italic}',
    '.bw-t{font-size:11px;color:#b3aca2;margin-top:2px}',
    '#bwChips{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 6px}',
    '#bwChips button{border:1px solid var(--bw-a);background:#fff7f1;color:var(--bw-a);border-radius:15px;padding:5px 11px;font-size:12.5px;cursor:pointer}',
    '#bwInRow{display:flex;gap:8px;padding:8px 12px 12px}',
    '#bwInRow input{flex:1;border:1px solid #e5ded4;border-radius:10px;padding:9px 12px;font-size:14.5px;outline:none}',
    '#bwInRow input:focus{border-color:var(--bw-a)}',
    '#bwSend{border:0;background:var(--bw-a);color:#fff;border-radius:10px;padding:0 18px;font-size:14.5px;cursor:pointer}',
    '#bwMemView{padding:12px;overflow-y:auto}',
    '#bwMemList{flex:1;overflow-y:auto;margin-bottom:10px}',
    '.bw-fi{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 2px;border-bottom:1px dashed #eee;font-size:14px}',
    '.bw-fi button{border:1px solid #eee;background:#fff;border-radius:7px;padding:3px 8px;font-size:12px;cursor:pointer;color:#8a8177}',
    '#bwMemInput{width:100%;border:1px solid #e5ded4;border-radius:10px;padding:9px 12px;font-size:14px;outline:none}',
    '.bw-hint{font-size:12px;color:#b3aca2;margin-top:6px}',
    '.bw-empty{color:#b3aca2;font-size:13px;text-align:center;padding:22px 8px}',
    '@media (max-width:480px){#bwPanel{right:0;bottom:0;width:100%;max-width:100%;height:100%;border-radius:0}}'
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ---------- DOM ---------- */
  var root = document.createElement('div');
  root.id = 'bwRoot';
  root.innerHTML =
    '<button id="bwFab" title="打开管家">🏠</button>' +
    '<div id="bwPanel" hidden>' +
    '  <div id="bwHead">' +
    '    <span class="bw-av">🏠</span>' +
    '    <div class="bw-ti"><b id="bwName"></b><span>记着您的每一件小事</span></div>' +
    '    <button id="bwClose">×</button>' +
    '  </div>' +
    '  <div id="bwTabs"><button class="on" data-tab="chat">聊天</button><button data-tab="mem">记忆</button></div>' +
    '  <div id="bwBody">' +
    '    <div class="bw-view" id="bwChatView">' +
    '      <div id="bwMsgs"></div>' +
    '      <div id="bwChips"></div>' +
    '      <div id="bwInRow"><input id="bwInput" placeholder="和管家说点什么…"><button id="bwSend">发送</button></div>' +
    '    </div>' +
    '    <div class="bw-view" id="bwMemView" hidden>' +
    '      <div id="bwMemList"></div>' +
    '      <input id="bwMemInput" placeholder="比如：我喜欢喝绿茶（回车记下）">' +
    '      <p class="bw-hint">聊天时直接说"我喜欢…"也会自动记住</p>' +
    '    </div>' +
    '  </div>' +
    '</div>';
  document.body.appendChild(root);

  var fab = root.querySelector('#bwFab');
  var panel = root.querySelector('#bwPanel');
  var closeBtn = root.querySelector('#bwClose');
  var nameEl = root.querySelector('#bwName');
  var msgsEl = root.querySelector('#bwMsgs');
  var chipsEl = root.querySelector('#bwChips');
  var inputEl = root.querySelector('#bwInput');
  var sendBtn = root.querySelector('#bwSend');
  var memListEl = root.querySelector('#bwMemList');
  var memInputEl = root.querySelector('#bwMemInput');
  var chatView = root.querySelector('#bwChatView');
  var memView = root.querySelector('#bwMemView');
  var typingEl = null;
  var sending = false;
  nameEl.textContent = config.name;

  /* ---------- 聊天 ---------- */
  function addMsg(role, text) {
    var wrap = document.createElement('div');
    wrap.className = 'bw-m ' + role;
    wrap.textContent = text;
    msgsEl.appendChild(wrap);
    var t = document.createElement('div');
    t.className = 'bw-t';
    t.textContent = hm();
    wrap.appendChild(t);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'bw-m a ty';
    typingEl.textContent = '正在输入…';
    msgsEl.appendChild(typingEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  /* ---------- 自动记忆 ---------- */
  function extract(text) {
    var added = [];
    var mName = text.match(/我(?:叫|的名字是)\s*([\u4e00-\u9fa5A-Za-z]{1,8})/);
    if (mName) { data.userName = mName[1]; added.push('称呼：' + mName[1]); }
    var patterns = [
      [/我(?:最喜欢|喜欢)(?:喝|吃)?\s*(.{2,20})/, '喜欢'],
      [/我(?:最爱|爱)(?:喝|吃)?\s*(.{2,20})/, '爱'],
      [/我(?:讨厌|不喜欢)(?:喝|吃)?\s*(.{2,20})/, '不喜欢'],
      [/我(?:特别)?怕\s*(.{1,10})/, '怕'],
      [/我对\s*(.{1,10})\s*过敏/, '过敏'],
      [/我每天\s*(.{2,20})/, '每天'],
      [/每天\s*(.{2,20})/, '每天']
    ];
    var skip = ['你', '您', '这', '那', '他', '她', '它'];
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i][0]);
      if (!m || !m[1]) continue;
      var v = m[1].trim();
      if (v.length < 2 || skip.indexOf(v) >= 0) continue;
      if (/[吗呢吧？?。！!的$]/.test(v.slice(-1))) continue;
      var f = patterns[i][1] + '：' + v;
      if (!data.facts.some(function (x) { return x.text === f; })) {
        data.facts.push({ id: uid(), text: f, time: Date.now() });
        added.push(f);
      }
    }
    var mBp = text.match(/血压[是用]?\s*(\d{2,3})\s*[\/／]\s*(\d{2,3})/);
    if (mBp) { data.vitals.bp = { value: mBp[1] + '/' + mBp[2], time: Date.now() }; added.push('血压 ' + data.vitals.bp.value); }
    var mBs = text.match(/血糖[是用]?\s*(\d+(?:\.\d+)?)\s*(?:mmol\/?L|毫摩)?/i);
    if (mBs) { data.vitals.bs = { value: mBs[1], time: Date.now() }; added.push('血糖 ' + data.vitals.bs.value); }
    if (added.length) save();
    return added;
  }

  /* ---------- 回复 ---------- */
  function mockReply(text, added) {
    var t = text.trim();
    if (/^(你好|您好|hi|hello|嗨|哈喽|早上好|中午好|下午好|晚上好)/i.test(t) && t.length <= 12) {
      return greetingWord() + '！我是' + config.name + '。有什么想聊的、想让我记的，都可以说。';
    }
    if (/记得|记住|还记得|认识|了解我|知道我|记得什么/.test(t)) {
      if (data.facts.length) {
        return '我记得这些：' + data.facts.slice(-6).map(function (f) { return f.text; }).join('；') + '。随时可以纠正我。';
      }
      return '我还在慢慢了解您。可以说说您喜欢什么，我会记住。';
    }
    if (/记(住|着|下来|一下)?/.test(t)) {
      if (added.length) return '好，我记下了：' + added.join('；') + '。';
      return '想让我记什么？直接说就行，比如「我喜欢喝绿茶」。';
    }
    if (/药|吃药|服药|用药/.test(t)) {
      return '用药提醒在完整版管家里有。这里我可以先帮您记着，比如告诉我「每天8点吃阿司匹林」。';
    }
    if (/你是谁|你叫什么|自我介绍|你是什么/.test(t)) {
      return '我是' + config.name + '，一个可以嵌在任何网站里的 AI 管家。帮您记小事、陪您聊天。';
    }
    if (/血压|血糖/.test(t)) {
      var parts = [];
      if (data.vitals.bp) parts.push('血压 ' + data.vitals.bp.value);
      if (data.vitals.bs) parts.push('血糖 ' + data.vitals.bs.value);
      if (parts.length) return '您最近记的是：' + parts.join('，') + '。下次量了告诉我，我接着记。';
      return '我还没记过。量完直接告诉我数字就行，比如「血压 130/85」。';
    }
    if (/心情|难过|不开心|烦|累|压力|睡不着|失眠|孤单/.test(t)) return '我在呢。心里不舒服就说出来，我听着。';
    if (/谢谢|辛苦|感谢/.test(t)) return '不客气，这是我该做的。';
    if (/晚安|再见|睡了|休息/.test(t)) return '晚安，好好休息。';
    if (added.length) return '好，我记下了：' + added.join('；') + '。还有别的吗？';
    var gentle = ['好的，我听着呢。', '嗯，您继续说。', '我记在心里了。'];
    return gentle[Math.floor(Math.random() * gentle.length)];
  }

  function buildSystemPrompt() {
    var now = new Date();
    var facts = data.facts.length ? data.facts.map(function (f) { return f.text; }).join('；') : '暂无';
    var vitals = [];
    if (data.vitals.bp) vitals.push('血压 ' + data.vitals.bp.value);
    if (data.vitals.bs) vitals.push('血糖 ' + data.vitals.bs.value);
    return [
      '你是「' + config.name + '」，一位温柔、耐心、细心的 AI 管家，嵌在一个网站上为访客服务。',
      '你服务的人：' + (data.userName || '用户'),
      '现在是 ' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + hm(),
      '你记得的小事：' + facts,
      vitals.length ? '健康记录：' + vitals.join('；') : '',
      '要求：说话口语化、简短亲切，一次只说重点；不要编造不存在的记忆。'
    ].filter(Boolean).join('\n');
  }

  function apiReply() {
    var cfg = config.api;
    if (!cfg || !cfg.baseUrl || !cfg.model) return Promise.resolve(null);
    var messages = [{ role: 'system', content: buildSystemPrompt() }];
    data.chat.slice(-20).forEach(function (m) {
      messages.push({ role: m.role, content: m.text });
    });
    var url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (cfg.key || '') },
      body: JSON.stringify({ model: cfg.model, messages: messages, temperature: 0.8 })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      return j.choices && j.choices[0] ? j.choices[0].message.content : null;
    }).catch(function () { return null; });
  }

  function send(text) {
    if (!text.trim() || sending) return;
    sending = true;
    addMsg('u', text);
    data.chat.push({ role: 'user', text: text, time: Date.now() });
    if (data.chat.length > 60) data.chat = data.chat.slice(-60);
    save();
    var added = extract(text);
    showTyping();
    setTimeout(function () {
      apiReply().then(function (reply) {
        hideTyping();
        if (!reply) reply = mockReply(text, added);
        addMsg('a', reply);
        data.chat.push({ role: 'assistant', text: reply, time: Date.now() });
        if (data.chat.length > 60) data.chat = data.chat.slice(-60);
        save();
        renderChips();
        sending = false;
      });
    }, 500 + Math.random() * 600);
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    var list = ['你记得我什么？', '我喜欢喝绿茶', '我血压 130/85'];
    if (!data.facts.length) list.unshift('帮我记着：我喜欢喝绿茶');
    list.forEach(function (c) {
      var b = document.createElement('button');
      b.textContent = c;
      b.addEventListener('click', function () { inputEl.value = ''; send(c); });
      chipsEl.appendChild(b);
    });
  }

  /* ---------- 记忆 ---------- */
  function renderMem() {
    memListEl.innerHTML = '';
    if (!data.facts.length) {
      var e = document.createElement('div');
      e.className = 'bw-empty';
      e.textContent = '还没有记录。说一句"我喜欢…"，我就记住。';
      memListEl.appendChild(e);
    }
    data.facts.slice().reverse().forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'bw-fi';
      var span = document.createElement('span');
      span.textContent = f.text;
      var del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', function () {
        data.facts = data.facts.filter(function (x) { return x.id !== f.id; });
        save();
        renderMem();
      });
      row.appendChild(span);
      row.appendChild(del);
      memListEl.appendChild(row);
    });
  }

  /* ---------- 事件 ---------- */
  fab.addEventListener('click', function () {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !data.greeted) {
      data.greeted = true;
      var g = greetingWord() + '！我是' + config.name + '。以后您在这个网站上的小事，都可以交给我记着。';
      addMsg('a', g);
      data.chat.push({ role: 'assistant', text: g, time: Date.now() });
      save();
    }
    renderChips();
    if (!panel.hidden) inputEl.focus();
  });
  closeBtn.addEventListener('click', function () { panel.hidden = true; });

  sendBtn.addEventListener('click', function () {
    var v = inputEl.value;
    inputEl.value = '';
    send(v);
  });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var v = inputEl.value;
      inputEl.value = '';
      send(v);
    }
  });

  root.querySelectorAll('#bwTabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      root.querySelectorAll('#bwTabs button').forEach(function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
      chatView.hidden = btn.dataset.tab !== 'chat';
      memView.hidden = btn.dataset.tab !== 'mem';
      if (!memView.hidden) renderMem();
    });
  });

  memInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var v = memInputEl.value.trim();
      if (!v) return;
      if (!data.facts.some(function (f) { return f.text === v; })) {
        data.facts.push({ id: uid(), text: v, time: Date.now() });
        save();
      }
      memInputEl.value = '';
      renderMem();
    }
  });

  /* 历史对话恢复 */
  data.chat.forEach(function (m) { addMsg(m.role, m.text); });
})();
