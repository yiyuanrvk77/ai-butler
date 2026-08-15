'use strict';

/* ============ 数据层 ============ */
const LS_KEY = 'ai-home-butler-v1';

const DEFAULT_DATA = {
  familyName: '',
  birthday: '',
  butlerName: '小管家',
  persona: '温柔、耐心、细心，像家人一样说话；关心对方的身体和心情；提醒吃药时温和但不唠叨。',
  bigFont: false,
  api: { mode: 'mock', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: '' },
  meds: [],
  facts: [],
  vitals: { bp: null, bs: null },
  chat: [],
  doseState: {}
};

function loadData() {
  let d = JSON.parse(JSON.stringify(DEFAULT_DATA));
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      d = Object.assign(d, p);
      d.api = Object.assign({}, DEFAULT_DATA.api, p.api || {});
    }
  } catch (e) { console.warn('读取本地数据失败', e); }
  d.meds = d.meds || [];
  d.facts = d.facts || [];
  d.chat = d.chat || [];
  d.vitals = d.vitals || { bp: null, bs: null };
  d.doseState = d.doseState || {};
  return d;
}

let data = loadData();

function saveData() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { console.warn(e); }
}

function uid() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function timeStr(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtTime(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr(d)}`;
}
function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return '马上';
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
function normalizeTime(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return `${String(+m[1]).padStart(2, '0')}:${m[2]}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ============ DOM 引用 ============ */
const $ = id => document.getElementById(id);
const messagesEl = $('messages');
const chipsEl = $('chips');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const butlerNameH = $('butlerNameH');
const greetLine = $('greetLine');
const bigFontBtn = $('bigFontBtn');
const settingsBtn = $('settingsBtn');
const settingsModal = $('settingsModal');
const nextDoseEl = $('nextDose');
const addMedBtn = $('addMedBtn');
const medFormEl = $('medForm');
const medNameEl = $('medName');
const medDoseEl = $('medDose');
const medTimesEl = $('medTimes');
const medNoteEl = $('medNote');
const medSaveBtn = $('medSaveBtn');
const medCancelBtn = $('medCancelBtn');
const medListEl = $('medList');
const addFactBtn = $('addFactBtn');
const factInput = $('factInput');
const factListEl = $('factList');
const vitalsEl = $('vitals');
const reminderBannerEl = $('reminderBanner');
const reminderTextEl = $('reminderText');
const reminderOkBtn = $('reminderOkBtn');
const reminderLaterBtn = $('reminderLaterBtn');
const setFamily = $('setFamily');
const setBirthday = $('setBirthday');
const setButler = $('setButler');
const setPersona = $('setPersona');
const apiModeMock = $('apiModeMock');
const apiModeApi = $('apiModeApi');
const apiFields = $('apiFields');
const apiBase = $('apiBase');
const apiModel = $('apiModel');
const apiKey = $('apiKey');
const notifyBtn = $('notifyBtn');
const closeSettings = $('closeSettings');
const saveSettingsBtn = $('saveSettings');
const clearData = $('clearData');

/* ============ 聊天 ============ */
let sending = false;
let typingEl = null;

function appendMsg(role, text, time) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  wrap.appendChild(b);
  if (time) {
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = fmtTime(time);
    wrap.appendChild(t);
  }
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTyping() {
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'msg assistant typing';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = '正在输入…';
  typingEl.appendChild(b);
  messagesEl.appendChild(typingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function trimChat() {
  if (data.chat.length > 60) data.chat = data.chat.slice(-60);
}

async function sendMessage(raw) {
  const text = raw.trim();
  if (!text || sending) return;
  sending = true;

  appendMsg('user', text, Date.now());
  data.chat.push({ role: 'user', text, time: Date.now() });
  trimChat();
  saveData();

  const added = autoExtract(text);
  showTyping();
  await sleep(600 + Math.random() * 800);

  let reply = null;
  if (data.api.mode === 'api') reply = await apiReply();
  if (!reply) reply = mockReply(text, added);

  hideTyping();
  appendMsg('assistant', reply, Date.now());
  data.chat.push({ role: 'assistant', text: reply, time: Date.now() });
  trimChat();
  saveData();
  renderChips();
  sending = false;
}

/* ============ 自动记忆提取 ============ */
function autoExtract(text) {
  const added = [];

  const mName = text.match(/我(?:叫|的名字是)\s*([\u4e00-\u9fa5A-Za-z]{1,8})/);
  if (mName && mName[1] !== data.butlerName) {
    data.familyName = mName[1];
    added.push('家人称呼：' + mName[1]);
  }

  const mBd = text.match(/我(?:的)?(?:生日|生辰)是\s*(\d{1,2})[月\/]\s*(\d{1,2})/);
  if (mBd) {
    data.birthday = `${mBd[1]}月${mBd[2]}日`;
    added.push('生日：' + data.birthday);
  }

  const patterns = [
    [/我(?:最喜欢|喜欢)(?:喝|吃)?\s*(.{2,20})/, '喜欢'],
    [/我(?:最爱|爱)(?:喝|吃)?\s*(.{2,20})/, '爱'],
    [/我(?:讨厌|不喜欢)(?:喝|吃)?\s*(.{2,20})/, '不喜欢'],
    [/我(?:特别)?怕\s*(.{1,10})/, '怕'],
    [/我对\s*(.{1,10})\s*过敏/, '过敏'],
    [/我(?:有|得|患)(?:了)?\s*(高血压|糖尿病|心脏病|高血脂|哮喘|关节炎|胃病)/, '有'],
    [/我每天\s*(.{2,20})/, '每天']
  ];
  const skipWords = ['你', '您', '这', '那', '他', '她', '它', '我们'];
  for (const [re, tag] of patterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const v = m[1].trim();
    if (v.length < 2 || skipWords.includes(v)) continue;
    if (/[吗呢吧？?。！!的$]/.test(v.slice(-1))) continue;
    const f = `${tag}：${v}`;
    if (!data.facts.some(x => x.text === f)) {
      data.facts.push({ id: uid(), text: f, time: Date.now() });
      added.push(f);
    }
  }

  const mBp = text.match(/血压[是用]?\s*(\d{2,3})\s*[\/／]\s*(\d{2,3})/);
  if (mBp) {
    data.vitals.bp = { value: `${mBp[1]}/${mBp[2]}`, time: Date.now() };
    added.push('血压 ' + data.vitals.bp.value);
  }
  const mBs = text.match(/血糖[是用]?\s*(\d+(?:\.\d+)?)\s*(?:mmol\/?L|毫摩)?/i);
  if (mBs) {
    data.vitals.bs = { value: mBs[1], time: Date.now() };
    added.push('血糖 ' + data.vitals.bs.value);
  }

  if (added.length) saveData();
  return added;
}

/* ============ 本地回复（模拟模式） ============ */
function timeGreeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function mockReply(text, added) {
  const t = text.trim();
  const has = re => re.test(t);

  if (has(/^(你好|您好|hi|hello|嗨|哈喽|早上好|中午好|下午好|晚上好)/i) && t.length <= 12) {
    return timeGreeting() + '！我是' + data.butlerName + '。您今天感觉怎么样？';
  }

  if (has(/吃过|喝过|吃了|喝了/)) return markTaken(t);

  if (has(/药|吃药|服药|用药|该吃|该喝/)) return nextDoseInfo();

  if (has(/记得|记住|还记得|认识|了解我|知道我|记得什么/)) {
    if (data.facts.length) {
      const list = data.facts.slice(-6).map(f => f.text).join('；');
      return '当然记得。' + list + '。您随时可以纠正我。';
    }
    return '我现在只记住了您的用药安排，其他的还在慢慢了解。您可以多跟我说说。';
  }

  if (has(/记(住|着|下来|一下)?/)) {
    if (added.length) return '好，我记下了：' + added.join('；') + '。放心，忘不了。';
    return '您想让我记什么？直接告诉我就行，比如「我喜欢喝绿茶」。';
  }

  if (has(/你是谁|你叫什么|自我介绍|介绍一下你自己|你是什么/)) {
    return '我是' + data.butlerName + '，您家里的 AI 管家。帮您记事情、提醒吃药、陪您聊天，随叫随到。';
  }

  if (has(/血压|血糖|心率/)) {
    if (data.vitals.bp || data.vitals.bs) {
      const parts = [];
      if (data.vitals.bp) parts.push('血压 ' + data.vitals.bp.value + '（' + fmtTime(data.vitals.bp.time) + '）');
      if (data.vitals.bs) parts.push('血糖 ' + data.vitals.bs.value + '（' + fmtTime(data.vitals.bs.time) + '）');
      return '您最近一次量的是：' + parts.join('，') + '。下次量了也告诉我，我帮您记着。';
    }
    return '我还没记过您的血压血糖。您量完直接告诉我数字就行，比如「血压 130/85」。';
  }

  if (has(/心情|难过|不开心|烦|累|压力|睡不着|失眠|孤单/)) {
    return '我在呢。心里不舒服就说出来，不用憋着。' + (data.familyName ? data.familyName + '，' : '') + '今天有我做伴，天大的事也先歇一歇。';
  }

  if (has(/谢谢|辛苦|感谢/)) {
    return '不客气，这是我该做的。您好好的，我就放心。';
  }

  if (has(/晚安|再见|睡了|休息/)) {
    return '晚安。好好休息，明天到点了我还提醒您吃药。';
  }

  if (added.length) return '好，我记下了：' + added.join('；') + '。还有别的要交代吗？';

  const gentle = ['好的，我听着呢。', '嗯，您继续说。', '我记在心里了。还有别的想聊的吗？', '我在，您慢慢说。'];
  let reply = gentle[Math.floor(Math.random() * gentle.length)];
  if (data.meds.length && Math.random() < 0.3) reply += ' 对了，别忘了今天的药。';
  return reply;
}

/* ============ 用药 ============ */
function getNextDose() {
  const now = new Date();
  const today = dateKey(now);
  const states = data.doseState[today] || {};
  let best = null;
  for (const med of data.meds) {
    for (const t of med.times) {
      const key = med.id + '_' + t;
      if (states[key] === 'taken') continue;
      const [h, m] = t.split(':').map(Number);
      const due = new Date(now);
      due.setHours(h, m, 0, 0);
      let diff = due - now;
      if (diff < 0) { due.setDate(due.getDate() + 1); diff = due - now; }
      if (!best || diff < best.diff) best = { med, time: t, due, diff };
    }
  }
  return best;
}

function nextDoseInfo() {
  const n = getNextDose();
  if (!n) return '现在没有安排用药。您可以在「吃药提醒」里添加药品和时间，我来帮您记住。';
  const mins = Math.round(n.diff / 60000);
  const isToday = dateKey(n.due) === dateKey(new Date());
  if (isToday && mins <= 5) {
    return `现在这个点，该吃「${n.med.name}」了（${n.time}${n.med.dosage ? '，' + n.med.dosage : ''}）。${n.med.note ? '（' + n.med.note + '）' : ''}`;
  }
  if (isToday && mins < 60) {
    return `下一顿是「${n.med.name}」，${n.time}，还有约 ${mins} 分钟。`;
  }
  const when = isToday ? '今天' : '明天';
  return `下一顿是「${n.med.name}」，${when} ${n.time}${n.med.dosage ? '，每次' + n.med.dosage : ''}。`;
}

function markTaken(text) {
  const now = new Date();
  const today = dateKey(now);
  const states = data.doseState[today] || {};
  let doneKey = null;
  let medName = null;

  for (const med of data.meds) {
    if (!text.includes(med.name)) continue;
    let best = null;
    for (const t of med.times) {
      const key = med.id + '_' + t;
      if (states[key] === 'taken') continue;
      const [h, m] = t.split(':').map(Number);
      const due = new Date(now);
      due.setHours(h, m, 0, 0);
      const diff = (now - due) / 60000;
      if (diff >= -90 && (!best || diff < best.diff)) best = { key, diff };
    }
    if (best && best.diff < 720) { doneKey = best.key; medName = med.name; break; }
  }

  if (!doneKey) {
    let best = null;
    for (const med of data.meds) {
      for (const t of med.times) {
        const key = med.id + '_' + t;
        if (states[key] === 'taken') continue;
        const [h, m] = t.split(':').map(Number);
        const due = new Date(now);
        due.setHours(h, m, 0, 0);
        const diff = (now - due) / 60000;
        if (diff >= 0 && diff <= 300 && (!best || diff < best.diff)) best = { key, med: med.name, diff };
      }
    }
    if (best) { doneKey = best.key; medName = best.med; }
  }

  if (doneKey) {
    states[doneKey] = 'taken';
    data.doseState[today] = states;
    saveData();
    return `好，记下了：${medName} 这顿已经吃过了。`;
  }
  return '好～如果哪顿吃过忘说了，告诉我药名，我帮您记。';
}

function renderNextDose() {
  nextDoseEl.innerHTML = '';
  const n = getNextDose();
  if (!n) {
    nextDoseEl.innerHTML = '<div class="card empty">还没有用药安排，点下面按钮添加。</div>';
    return;
  }
  const card = document.createElement('div');
  card.className = 'card next-card';
  const isToday = dateKey(n.due) === dateKey(new Date());
  const when = isToday ? '今天' : '明天';
  card.innerHTML = `
    <h3>⏰ 下次吃药</h3>
    <div class="big">${esc(n.med.name)}</div>
    <div class="countdown">${when} ${n.time} · ${fmtDuration(n.diff)}后</div>
    <div class="med-sub">${esc(n.med.dosage || '')}${n.med.note ? ' · ' + esc(n.med.note) : ''}</div>`;
  if (n.diff <= 0) {
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = '我吃过了';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', () => {
      const today = dateKey(new Date());
      const states = data.doseState[today] || {};
      states[n.med.id + '_' + n.time] = 'taken';
      data.doseState[today] = states;
      saveData();
      renderMeds();
    });
    card.appendChild(btn);
  }
  nextDoseEl.appendChild(card);
}

function renderMedsList() {
  medListEl.innerHTML = '';
  if (!data.meds.length) {
    medListEl.innerHTML = '<div class="empty">暂未添加药品</div>';
    return;
  }
  const today = dateKey(new Date());
  const states = data.doseState[today] || {};
  data.meds.forEach(med => {
    const card = document.createElement('div');
    card.className = 'card';
    const chips = med.times.map(t => {
      const done = states[med.id + '_' + t] === 'taken';
      return `<span class="${done ? 'done' : ''}">${esc(t)}${done ? ' ✓' : ''}</span>`;
    }).join('');
    card.innerHTML = `
      <div class="med-row">
        <div>
          <div class="med-name">${esc(med.name)}</div>
          <div class="med-sub">${esc(med.dosage || '')}${med.note ? ' · ' + esc(med.note) : ''}</div>
        </div>
        <div class="med-actions">
          <button data-edit="${med.id}">修改</button>
          <button data-del="${med.id}">删除</button>
        </div>
      </div>
      <div class="chips2">${chips}</div>`;
    medListEl.appendChild(card);
  });
  medListEl.querySelectorAll('[data-edit]').forEach(b => {
    b.addEventListener('click', () => openMedForm(b.dataset.edit));
  });
  medListEl.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', () => {
      if (confirm('确定删除这个药吗？')) {
        data.meds = data.meds.filter(m => m.id !== b.dataset.del);
        saveData();
        renderMeds();
      }
    });
  });
}

function renderMeds() {
  renderNextDose();
  renderMedsList();
}

let editingMedId = null;

function openMedForm(id) {
  editingMedId = id || null;
  medFormEl.hidden = false;
  const m = id ? data.meds.find(x => x.id === id) : null;
  medNameEl.value = m ? m.name : '';
  medDoseEl.value = m ? m.dosage : '';
  medTimesEl.value = m ? m.times.join(', ') : '';
  medNoteEl.value = m ? m.note : '';
  addMedBtn.textContent = id ? '✎ 正在修改药品' : '＋ 添加药品';
}

function saveMedForm() {
  const name = medNameEl.value.trim();
  const rawTimes = medTimesEl.value.split(/[,，、\s]+/).filter(Boolean);
  const times = [...new Set(rawTimes.map(normalizeTime).filter(Boolean))];
  if (!name) { alert('请填写药名'); return; }
  if (!times.length) { alert('时间格式要像这样：08:00, 12:30, 18:30'); return; }
  const obj = { name, dosage: medDoseEl.value.trim(), times, note: medNoteEl.value.trim() };
  if (editingMedId) {
    const idx = data.meds.findIndex(m => m.id === editingMedId);
    data.meds[idx] = Object.assign({}, data.meds[idx], obj);
  } else {
    data.meds.push(Object.assign({ id: uid() }, obj));
  }
  saveData();
  medFormEl.hidden = true;
  editingMedId = null;
  addMedBtn.textContent = '＋ 添加药品';
  renderMeds();
}

/* ============ 记忆本 ============ */
function renderMemory() {
  factListEl.innerHTML = '';
  if (!data.facts.length) {
    factListEl.innerHTML = '<div class="empty">还没有记录。聊天时告诉我，比如「我喜欢喝绿茶」，我就会记住。</div>';
  }
  [...data.facts].reverse().forEach(f => {
    const row = document.createElement('div');
    row.className = 'fact-item';
    const span = document.createElement('span');
    span.textContent = f.text;
    const btn = document.createElement('button');
    btn.className = 'fact-del';
    btn.textContent = '删除';
    btn.addEventListener('click', () => {
      data.facts = data.facts.filter(x => x.id !== f.id);
      saveData();
      renderMemory();
    });
    row.appendChild(span);
    row.appendChild(btn);
    factListEl.appendChild(row);
  });

  vitalsEl.innerHTML = '';
  const items = [];
  if (data.vitals.bp) items.push(`最近血压：${esc(data.vitals.bp.value)}（${fmtTime(data.vitals.bp.time)}）`);
  if (data.vitals.bs) items.push(`最近血糖：${esc(data.vitals.bs.value)}（${fmtTime(data.vitals.bs.time)}）`);
  if (items.length) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h3 style="margin-top:0">📊 健康记录</h3>' + items.map(x => `<p style="margin:6px 0">${x}</p>`).join('');
    vitalsEl.appendChild(card);
  }
}

/* ============ 提醒 ============ */
let pendingDose = null;

function checkReminders() {
  const now = new Date();
  const today = dateKey(now);
  const states = data.doseState[today] || {};
  let changed = false;
  for (const med of data.meds) {
    for (const t of med.times) {
      const key = med.id + '_' + t;
      if (states[key]) continue;
      const [h, m] = t.split(':').map(Number);
      const due = new Date(now);
      due.setHours(h, m, 0, 0);
      const sec = (now - due) / 1000;
      if (sec >= -30 && sec <= 600) {
        states[key] = 'shown';
        changed = true;
        fireReminder(med, t, key);
      }
    }
  }
  if (changed) {
    data.doseState[today] = states;
    saveData();
  }
}

function fireReminder(med, t, key) {
  pendingDose = { medId: med.id, time: t, key };
  reminderTextEl.textContent = `「${med.name}」${med.dosage ? '，' + med.dosage : ''}（${t}）`;
  reminderBannerEl.hidden = false;
  chime();
  tryNotify('💊 该吃药啦', `${med.name}（${t}）`);
  const note = `💊 到点啦：该吃「${med.name}」了（${t}）。`;
  appendMsg('assistant', note, Date.now());
  data.chat.push({ role: 'assistant', text: note, time: Date.now() });
  trimChat();
  saveData();
}

function finishDose(state) {
  if (!pendingDose) return;
  const today = dateKey(new Date());
  const states = data.doseState[today] || {};
  states[pendingDose.key] = state;
  data.doseState[today] = states;
  saveData();
  reminderBannerEl.hidden = true;
  if (state === 'taken') {
    const med = data.meds.find(m => m.id === pendingDose.medId);
    const text = `好，记下了：「${med ? med.name : '这顿药'}」${pendingDose.time || ''}已经吃过了。`;
    appendMsg('assistant', text, Date.now());
    data.chat.push({ role: 'assistant', text, time: Date.now() });
    trimChat();
    saveData();
  }
  pendingDose = null;
  renderMeds();
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[660, 0], [880, 0.22]].forEach(([f, d]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      o.connect(g);
      g.connect(ctx.destination);
      const t0 = ctx.currentTime + d;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      o.start(t0);
      o.stop(t0 + 0.38);
    });
  } catch (e) { /* 不支持就静默 */ }
}

function tryNotify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch (e) { /* 忽略 */ }
}

/* ============ 接入真实 AI ============ */
function buildSystemPrompt() {
  const now = new Date();
  const medsText = data.meds.length
    ? data.meds.map(m => `「${m.name}」${m.dosage || ''}，每天 ${m.times.join('、')}${m.note ? '，备注：' + m.note : ''}`).join('；')
    : '暂无';
  const factsText = data.facts.length ? data.facts.map(f => f.text).join('；') : '暂无';
  const vitalsText = [];
  if (data.vitals.bp) vitalsText.push('血压 ' + data.vitals.bp.value + '（' + fmtTime(data.vitals.bp.time) + '）');
  if (data.vitals.bs) vitalsText.push('血糖 ' + data.vitals.bs.value + '（' + fmtTime(data.vitals.bs.time) + '）');
  const name = data.familyName || '用户';
  return [
    `你是「${data.butlerName}」，一位${data.persona}`,
    `你服务的人是：${name}${data.birthday ? '，生日 ' + data.birthday : ''}`,
    `现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${timeStr(now)}`,
    `你记得的用药安排：${medsText}`,
    `你记得的家人小事：${factsText}`,
    vitalsText.length ? `健康记录：${vitalsText.join('；')}` : '',
    '要求：说话口语化、简短亲切，一次只说重点；提醒吃药时要说出具体药名和时间；不要编造不存在的记忆。'
  ].filter(Boolean).join('\n');
}

async function apiReply() {
  const cfg = data.api;
  const system = buildSystemPrompt();
  const history = data.chat.slice(-24).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }));
  const messages = [{ role: 'system', content: system }].concat(history);

  if (location.protocol === 'http:' || location.protocol === 'https:') {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: cfg.baseUrl, model: cfg.model, key: cfg.key, messages })
      });
      if (res.ok) {
        const j = await res.json();
        if (j.content) return j.content;
        if (j.error) return '（模型接口提示：' + j.error + '，可到设置里检查接口配置）';
      }
    } catch (e) { /* 本地服务器不可用，尝试直连 */ }
  }

  try {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.8 })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return j.choices[0].message.content;
  } catch (e) {
    return null;
  }
}

/* ============ 界面 ============ */
function renderChips() {
  const list = ['我该吃药了吗？', '今天吃什么药？', '你记得我什么？'];
  if (!data.meds.length) list.push('帮我记着：我喜欢喝绿茶');
  else if (data.facts.length < 2) list.push('帮我记着：我不喜欢太咸');
  chipsEl.innerHTML = '';
  list.forEach(c => {
    const b = document.createElement('button');
    b.textContent = c;
    b.addEventListener('click', () => sendMessage(c));
    chipsEl.appendChild(b);
  });
}

function applyBigFont() {
  document.body.classList.toggle('big', data.bigFont);
  bigFontBtn.textContent = data.bigFont ? '标准' : '大字';
}

function renderAll() {
  butlerNameH.textContent = data.butlerName;
  greetLine.textContent = data.familyName ? `一直陪着${data.familyName}` : '记着家里的每一件小事';
  applyBigFont();
  renderMeds();
  renderMemory();
}

/* ============ 设置 ============ */
function openSettings() {
  setFamily.value = data.familyName;
  setBirthday.value = data.birthday;
  setButler.value = data.butlerName;
  setPersona.value = data.persona;
  (data.api.mode === 'api' ? apiModeApi : apiModeMock).checked = true;
  apiBase.value = data.api.baseUrl;
  apiModel.value = data.api.model;
  apiKey.value = data.api.key;
  toggleApiFields();
  settingsModal.classList.add('show');
}

function toggleApiFields() {
  apiFields.hidden = !apiModeApi.checked;
}

function saveSettings() {
  data.familyName = setFamily.value.trim();
  data.birthday = setBirthday.value.trim();
  data.butlerName = setButler.value.trim() || '小管家';
  data.persona = setPersona.value.trim() || DEFAULT_DATA.persona;
  data.api.mode = apiModeApi.checked ? 'api' : 'mock';
  data.api.baseUrl = apiBase.value.trim().replace(/\/+$/, '') || DEFAULT_DATA.api.baseUrl;
  data.api.model = apiModel.value.trim() || DEFAULT_DATA.api.model;
  data.api.key = apiKey.value.trim();
  saveData();
  settingsModal.classList.remove('show');
  renderAll();
}

/* ============ 初始化 ============ */
function init() {
  renderAll();

  if (!data.chat.length) {
    const h = new Date().getHours();
    const g = (h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好');
    let text = `${g}！我是${data.butlerName}，以后家里的大事小事都可以交给我记着。`;
    const n = getNextDose();
    if (n) text += `对了，下一顿药是「${n.med.name}」，${n.time}，我会提醒您的。`;
    data.chat.push({ role: 'assistant', text, time: Date.now() });
    saveData();
  }
  data.chat.forEach(m => appendMsg(m.role, m.text, m.time));
  renderChips();

  sendBtn.addEventListener('click', () => {
    const v = chatInput.value;
    chatInput.value = '';
    sendMessage(v);
  });
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = chatInput.value;
      chatInput.value = '';
      sendMessage(v);
    }
  });

  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      const panel = document.querySelector(`.panel[data-panel="${btn.dataset.tab}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  bigFontBtn.addEventListener('click', () => {
    data.bigFont = !data.bigFont;
    saveData();
    applyBigFont();
  });
  settingsBtn.addEventListener('click', openSettings);
  closeSettings.addEventListener('click', () => settingsModal.classList.remove('show'));
  saveSettingsBtn.addEventListener('click', saveSettings);
  apiModeMock.addEventListener('change', toggleApiFields);
  apiModeApi.addEventListener('change', toggleApiFields);
  notifyBtn.addEventListener('click', async () => {
    try {
      const perm = await Notification.requestPermission();
      alert(perm === 'granted' ? '已开启系统通知。' : '浏览器没有允许通知，仍会使用页面内提醒和提示音。');
    } catch (e) {
      alert('当前浏览器不支持系统通知，页面内提醒仍然有效。');
    }
  });
  clearData.addEventListener('click', e => {
    e.preventDefault();
    if (confirm('确定清除全部数据吗？聊天记录、记忆和用药安排都会被删除。')) {
      localStorage.removeItem(LS_KEY);
      location.reload();
    }
  });

  addMedBtn.addEventListener('click', () => {
    if (!medFormEl.hidden) { medFormEl.hidden = true; return; }
    openMedForm(null);
  });
  medSaveBtn.addEventListener('click', saveMedForm);
  medCancelBtn.addEventListener('click', () => {
    medFormEl.hidden = true;
    editingMedId = null;
    addMedBtn.textContent = '＋ 添加药品';
  });

  addFactBtn.addEventListener('click', () => {
    factInput.hidden = !factInput.hidden;
    if (!factInput.hidden) factInput.focus();
  });
  factInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = factInput.value.trim();
      if (!v) return;
      if (!data.facts.some(f => f.text === v)) {
        data.facts.push({ id: uid(), text: v, time: Date.now() });
        saveData();
      }
      factInput.value = '';
      factInput.hidden = true;
      renderMemory();
    }
  });

  reminderOkBtn.addEventListener('click', () => finishDose('taken'));
  reminderLaterBtn.addEventListener('click', () => finishDose('shown'));

  checkReminders();
  setInterval(() => {
    checkReminders();
    renderNextDose();
  }, 20000);
}

document.addEventListener('DOMContentLoaded', init);
