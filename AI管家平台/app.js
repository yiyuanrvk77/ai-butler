'use strict';

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let state = { user: null, personas: [], current: null, meds: [], memories: [], members: [], member: 0 };
let personaFilter = 'all';
let sending = false;
let pendingDose = null;

/* 提醒去重（今天提醒过的时段不再重复弹） */
const REMIND_KEY = 'butler-reminded-v1';
let reminded = {};
try { reminded = JSON.parse(localStorage.getItem(REMIND_KEY)) || {}; } catch (e) { reminded = {}; }
function saveReminded() {
  try { localStorage.setItem(REMIND_KEY, JSON.stringify(reminded)); } catch (e) { /* 忽略 */ }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let j = {};
  try { j = await res.json(); } catch (e) { /* 空响应 */ }
  if (!res.ok) {
    const err = new Error(j.error || '请求失败（' + res.status + '）');
    err.status = res.status;
    throw err;
  }
  return j;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* ============ 登录 / 注册 ============ */
async function doLogin() {
  const username = $('loginUser').value.trim();
  const password = $('loginPass').value;
  try {
    await api('/api/login', { method: 'POST', body: { username, password } });
    const me = await api('/api/me');
    await enterMain(me);
  } catch (e) {
    $('authMsg').textContent = e.message;
  }
}

async function doRegister() {
  const username = $('regUser').value.trim();
  const password = $('regPass').value;
  const display_name = $('regName').value.trim();
  try {
    await api('/api/register', {
      method: 'POST',
      body: { username, password, display_name, age_group: $('regAge').value }
    });
    const me = await api('/api/me');
    await enterMain(me);
  } catch (e) {
    $('authMsg').textContent = e.message;
  }
}

function showAuth() {
  $('authView').hidden = false;
  $('mainView').hidden = true;
}

/* ============ 主界面 ============ */
function applyUser(me) {
  state.user = me.user;
  state.personas = me.personas;
  state.members = me.members || [];
  personaFilter = me.user.age_group || 'all';
  $('meName').textContent = me.user.display_name || me.user.username;
  $('authView').hidden = true;
  $('mainView').hidden = false;
  renderPersonaList();
  renderPersonaFilter();
  renderMemberChips();
  applyMemberMode();
}

async function enterMain(me) {
  applyUser(me);
  if (state.personas.length) {
    await selectPersona(state.personas[0].id);
  } else {
    $('personaTitle').textContent = '还没有角色，点左边「＋ 新建角色」';
    $('personaAvatar').textContent = '🤖';
    $('msgs').innerHTML = '';
    $('chips').innerHTML = '';
  }
}

/* ============ 家人档案（全年龄） ============ */
function renderMemberChips() {
  const el = $('memberChips');
  el.innerHTML = '';
  const chips = [{ id: 0, name: '我', avatar: '👤', mode: 'adult' }].concat(state.members);
  chips.forEach(m => {
    const c = document.createElement('button');
    c.className = 'member-chip' + (state.member === m.id ? ' on' : '');
    c.innerHTML = `<span class="mc-av">${esc(m.avatar)}</span><span class="mc-n">${esc(m.name)}</span>`;
    c.addEventListener('click', () => selectMember(m.id));
    if (m.id !== 0) {
      const d = document.createElement('span');
      d.className = 'mc-del';
      d.textContent = '×';
      d.title = '删除这位家人';
      d.addEventListener('click', async ev => {
        ev.stopPropagation();
        if (!confirm(`删除家人「${m.name}」？ta 的用药安排也会一起删除。`)) return;
        try {
          await api('/api/members/' + m.id, { method: 'DELETE' });
          if (state.member === m.id) state.member = 0;
          const me = await api('/api/me');
          applyUser(me);
          loadMeds(state.member);
        } catch (e) { toast(e.message); }
      });
      c.appendChild(d);
    }
    el.appendChild(c);
  });
}

function selectMember(id) {
  state.member = id;
  renderMemberChips();
  applyMemberMode();
  loadMeds(id);
}

function applyMemberMode() {
  const m = state.members.find(x => x.id === state.member);
  document.body.classList.toggle('big', !!(m && m.mode === 'elder'));
}

async function addMember() {
  const name = $('mmName').value.trim();
  if (!name) { toast('请填写家人称呼'); return; }
  try {
    await api('/api/members', {
      method: 'POST',
      body: {
        name,
        relation: $('mmRelation').value.trim(),
        avatar: $('mmAvatar').value.trim() || '👤',
        mode: $('mmMode').value
      }
    });
    $('memberModal').classList.remove('show');
    $('mmName').value = '';
    $('mmRelation').value = '';
    $('mmAvatar').value = '';
    const me = await api('/api/me');
    applyUser(me);
  } catch (e) { toast(e.message); }
}

function renderPersonaList() {
  const el = $('personaList');
  el.innerHTML = '';
  const list = state.personas.filter(p =>
    personaFilter === 'all' || p.audience === personaFilter || p.audience === 'all'
  );
  list.forEach(p => {
    const b = document.createElement('button');
    b.className = 'persona-item' + (state.current && state.current.id === p.id ? ' on' : '');
    const sub = p.last_message
      ? p.last_message.slice(0, 14)
      : (p.memory_count ? p.memory_count + ' 条记忆' : '开始聊天吧');
    b.innerHTML = `<span class="p-av">${esc(p.avatar)}</span><span class="p-n"><b>${esc(p.name)}</b><span>${esc(sub)}</span></span>`;
    if (p.is_mine) {
      const d = document.createElement('button');
      d.className = 'mini-btn';
      d.textContent = '×';
      d.title = '删除这个角色';
      d.style.flex = 'none';
      d.addEventListener('click', async ev => {
        ev.stopPropagation();
        if (!confirm('删除这个角色？它的记忆和聊天记录也会一起删除。')) return;
        try {
          await api('/api/personas/' + p.id, { method: 'DELETE' });
          const me = await api('/api/me');
          await enterMain(me);
        } catch (e) { toast(e.message); }
      });
      b.appendChild(d);
    }
    b.addEventListener('click', () => selectPersona(p.id));
    el.appendChild(b);
  });
}

function renderPersonaFilter() {
  const el = $('personaFilter');
  el.innerHTML = '';
  const items = [
    ['all', '全部'], ['child', '儿童'], ['youth', '年轻人'],
    ['adult', '中年人'], ['elder', '长辈']
  ];
  items.forEach(([v, label]) => {
    const b = document.createElement('button');
    b.className = 'filter-chip' + (personaFilter === v ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      personaFilter = v;
      renderPersonaFilter();
      renderPersonaList();
    });
    el.appendChild(b);
  });
}

async function selectPersona(id) {
  const p = state.personas.find(x => x.id === id);
  if (!p) return;
  state.current = p;
  renderPersonaList();
  $('personaTitle').textContent = p.name;
  $('personaAvatar').textContent = p.avatar;
  $('msgs').innerHTML = '';
  try {
    const d = await api('/api/messages?persona_id=' + id);
    d.messages.forEach(m => addMsg(m.role, m.content, m.created_at));
  } catch (e) { toast(e.message); }
  renderChips();
  renderMem();
  loadMeds(state.member);
}

/* ============ 聊天 ============ */
function addMsg(role, text, ts) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  wrap.appendChild(b);
  if (ts) {
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = fmtTime(ts);
    wrap.appendChild(t);
  }
  $('msgs').appendChild(wrap);
  $('msgs').scrollTop = $('msgs').scrollHeight;
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant typing';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = '正在输入…';
  wrap.appendChild(b);
  $('msgs').appendChild(wrap);
  $('msgs').scrollTop = $('msgs').scrollHeight;
  return wrap;
}

function renderChips() {
  const el = $('chips');
  el.innerHTML = '';
  ['你记得我什么？', '我该吃药了吗？', '帮我记着：我喜欢喝绿茶', '我血压 130/85'].forEach(c => {
    const b = document.createElement('button');
    b.textContent = c;
    b.addEventListener('click', () => {
      $('chatInput').value = '';
      sendChat(c);
    });
    el.appendChild(b);
  });
}

function sendChatFromInput() {
  const v = $('chatInput').value;
  $('chatInput').value = '';
  sendChat(v);
}

async function sendChat(text) {
  if (!text.trim() || sending || !state.current) return;
  sending = true;
  addMsg('user', text);
  const typing = addTyping();
  try {
    const r = await api('/api/chat', {
      method: 'POST',
      body: { persona_id: state.current.id, content: text }
    });
    typing.remove();
    addMsg('assistant', r.reply);
    if (r.memories_added && r.memories_added.length) renderMem();
  } catch (e) {
    typing.remove();
    toast(e.message);
  }
  sending = false;
  renderChips();
}

/* ============ 记忆 ============ */
async function renderMem() {
  if (!state.current) return;
  const el = $('memList');
  try {
    const d = await api('/api/memories?persona_id=' + state.current.id);
    state.memories = d.memories;
    el.innerHTML = '';
    if (!d.memories.length) {
      el.innerHTML = '<div class="empty">还没有记忆。聊过之后，管家记住的事会出现在这里。</div>';
      return;
    }
    d.memories.forEach(m => {
      const row = document.createElement('div');
      row.className = 'fact-item';
      const span = document.createElement('span');
      span.textContent = m.text;
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        try {
          await api('/api/memories/' + m.id, { method: 'DELETE' });
          renderMem();
        } catch (e) { toast(e.message); }
      });
      row.appendChild(span);
      row.appendChild(del);
      el.appendChild(row);
    });
  } catch (e) { toast(e.message); }
}

async function addMemory() {
  const v = $('memInput').value.trim();
  if (!v || !state.current) return;
  try {
    await api('/api/memories', {
      method: 'POST',
      body: { persona_id: state.current.id, text: v }
    });
    $('memInput').value = '';
    renderMem();
  } catch (e) { toast(e.message); }
}

/* ============ 用药提醒 ============ */
async function loadMeds(memberId) {
  const q = memberId === undefined ? '' : '?member_id=' + memberId;
  try {
    const d = await api('/api/meds' + q);
    state.meds = d.meds;
    renderMeds(d.next);
  } catch (e) { toast(e.message); }
}

/* ============ 到点提醒 ============ */
async function checkReminders() {
  if (!state.user) return;
  const now = new Date();
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const bucket = reminded[today] || {};
  try {
    const d = await api('/api/meds');
    state.meds = d.meds;
    for (const med of d.meds) {
      for (const t of med.times) {
        const key = med.id + '_' + t;
        if (bucket[key] || med.taken.indexOf(t) >= 0) continue;
        const [h, m] = t.split(':').map(Number);
        const due = new Date();
        due.setHours(h, m, 0, 0);
        const sec = (now - due) / 1000;
        if (sec >= -60 && sec <= 300) { // 到点前1分钟 ~ 后5分钟
          bucket[key] = true;
          reminded[today] = bucket;
          saveReminded();
          fireReminder(med, t);
        }
      }
    }
  } catch (e) { /* 网络异常时静默，下轮再试 */ }
}

function fireReminder(med, t) {
  pendingDose = { medId: med.id, time: t, name: med.name };
  const who = (med.member_name && med.member_name !== '我')
    ? `「${med.member_name}」该吃药啦：` : '该吃药啦：';
  $('reminderText').textContent = who + `「${med.name}」${med.dosage ? '，' + med.dosage : ''}（${t}）`;
  $('reminderBanner').hidden = false;
  chime();
  if (state.current) {
    addMsg('assistant', `💊 ${who}「${med.name}」（${t}）。`);
    $('msgs').scrollTop = $('msgs').scrollHeight;
  }
}

async function finishDose(kind) {
  if (!pendingDose) return;
  const { medId, time, name } = pendingDose;
  $('reminderBanner').hidden = true;
  pendingDose = null;
  if (kind !== 'taken') return;
  try {
    await api('/api/meds/' + medId + '/dose', { method: 'POST', body: { time } });
    if (state.current) {
      addMsg('assistant', `好，记下了：「${name}」${time} 已经吃过了。`);
      $('msgs').scrollTop = $('msgs').scrollHeight;
    }
    loadMeds(state.member);
  } catch (e) { toast(e.message); }
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

function renderMeds(next) {
  const nl = $('nextDose');
  nl.innerHTML = '';
  if (next) {
    const card = document.createElement('div');
    card.className = 'card next-card';
    card.innerHTML = `
      <h3>⏰ 下次吃药</h3>
      <div class="big">${esc(next.name)}</div>
      <div class="countdown">${next.today ? '今天' : '明天'} ${esc(next.time)} · ${next.minutes} 分钟后</div>
      <div class="med-sub">${esc(next.dosage || '')}${next.note ? ' · ' + esc(next.note) : ''}</div>`;
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = '我吃过了';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', async () => {
      try {
        await api('/api/meds/' + next.med_id + '/dose', { method: 'POST', body: { time: next.time } });
        loadMeds(state.member);
      } catch (e) { toast(e.message); }
    });
    card.appendChild(btn);
    nl.appendChild(card);
  } else {
    nl.innerHTML = '<div class="card empty">还没有用药安排，下面添加。</div>';
  }

  const ml = $('medList');
  ml.innerHTML = '';
  if (!state.meds.length) return;
  state.meds.forEach(m => {
    const chips = m.times.map(t =>
      `<span class="${m.taken.indexOf(t) >= 0 ? 'done' : ''}">${esc(t)}${m.taken.indexOf(t) >= 0 ? ' ✓' : ''}</span>`
    ).join('');
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="med-row">
        <div>
          <div class="med-name">${esc(m.name)}</div>
          <div class="med-sub">${esc(m.dosage || '')}${m.note ? ' · ' + esc(m.note) : ''}</div>
        </div>
        <div class="med-actions"><button data-del="${m.id}">删除</button></div>
      </div>
      <div class="chips2">${chips}</div>`;
    card.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm('删除这个药？')) return;
      try {
        await api('/api/meds/' + m.id, { method: 'DELETE' });
        loadMeds(state.member);
      } catch (e) { toast(e.message); }
    });
    ml.appendChild(card);
  });
}

async function saveMed() {
  const name = $('medName').value.trim();
  const times = $('medTimes').value.split(/[,，、\s]+/).filter(Boolean);
  if (!name) { toast('请填写药名'); return; }
  try {
    await api('/api/meds', {
      method: 'POST',
      body: {
        name,
        dosage: $('medDose').value.trim(),
        times,
        note: $('medNote').value.trim(),
        member_id: state.member
      }
    });
    $('medName').value = '';
    $('medDose').value = '';
    $('medTimes').value = '';
    $('medNote').value = '';
    loadMeds(state.member);
  } catch (e) { toast(e.message); }
}

/* ============ 切换页签 ============ */
function switchTab(tab) {
  document.querySelectorAll('.tabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === tab);
  });
  $('viewChat').hidden = tab !== 'chat';
  $('viewMem').hidden = tab !== 'mem';
  $('viewMeds').hidden = tab !== 'meds';
  $('viewToday').hidden = tab !== 'today';
  if (tab === 'mem') renderMem();
  if (tab === 'meds') loadMeds(state.member);
  if (tab === 'today') loadToday();
}

/* ============ 今日关怀 ============ */
async function loadToday() {
  try {
    const [d, v] = await Promise.all([
      api('/api/daily-summary'),
      api('/api/vitals?member_id=' + state.member)
    ]);
    renderDailySummary(d);
    renderHealthChart(v);
  } catch (e) { toast(e.message); }
}

function renderDailySummary(d) {
  const el = $('dailySummary');
  el.innerHTML = '';
  const date = new Date();
  let html = `<div class="card"><h3 style="margin:0 0 6px">📋 ${date.getMonth() + 1}月${date.getDate()}日 · 今日关怀</h3>`;
  if (!d.members.length) {
    html += '<p class="hint">还没有用药安排，去「提醒」里添加。</p>';
  }
  d.members.forEach(m => {
    html += `<div style="margin-top:10px"><b>${esc(m.name)}</b>`;
    m.meds.forEach(med => {
      const times = med.times.map(x =>
        `<span class="${x.taken ? 'done' : ''}">${esc(x.time)}${x.taken ? ' ✓' : ' ○'}</span>`
      ).join(' ');
      html += `<div class="chips2" style="margin-top:4px">💊 ${esc(med.name)}${med.dosage ? '（' + esc(med.dosage) + '）' : ''}：${times}</div>`;
    });
    html += '</div>';
  });
  if (d.vitals_today.length) {
    html += '<div style="margin-top:12px"><b>📊 今日健康记录</b><br><span class="hint">' +
      d.vitals_today.map(x =>
        `${x.type === 'bp' ? '血压' : '血糖'} ${esc(x.value)}（${fmtTime(x.created_at)}）`
      ).join('　') + '</span></div>';
  }
  html += '</div>';
  if (d.tomorrow.length) {
    const first = d.tomorrow.map(x => `${x.member} ${x.time} ${x.name}`).join('、');
    html += `<div class="card"><b>⏰ 明天要记得</b><br><span class="hint">${esc(first)}</span></div>`;
  }
  el.innerHTML = html;
}

function renderHealthChart(v) {
  const el = $('healthChart');
  el.innerHTML = '';
  const series = [];
  if (v.bp && v.bp.length) {
    series.push({ name: '收缩压', color: '#e8865a', values: v.bp.map(x => +x.value.split('/')[0]) });
    series.push({ name: '舒张压', color: '#4f8f8a', values: v.bp.map(x => +x.value.split('/')[1] || 0) });
  }
  if (v.bs && v.bs.length) {
    series.push({ name: '血糖', color: '#8a6bbf', values: v.bs.map(x => +x.value) });
  }
  if (!series.length) {
    el.innerHTML = '<div class="card empty">还没有健康数据。在聊天里说「血压 130/85」或「血糖 5.6」，我会记录并画出趋势。</div>';
    return;
  }
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<h3 style="margin:0 0 8px">📈 健康趋势（最近 14 次）</h3>';
  const all = series.reduce((a, s) => a.concat(s.values), []);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = (max - min) || 1;
  const W = 640, H = 170, P = 30;
  series.forEach(s => {
    const n = s.values.length;
    const step = n > 1 ? (W - 2 * P) / (n - 1) : 0;
    const pts = s.values.map((val, i) =>
      `${P + i * step},${H - P - ((val - min) / span) * (H - 2 * P)}`
    );
    const line = `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round"/>`;
    const dots = pts.map((p, i) => {
      const [x, y] = p.split(',');
      return `<circle cx="${x}" cy="${y}" r="3.5" fill="${s.color}"><title>${s.values[i]}</title></circle>`;
    }).join('');
    const last = s.values[s.values.length - 1];
    const [lx, ly] = pts[pts.length - 1].split(',');
    const label = `<text x="${lx}" y="${+ly - 8}" fill="${s.color}" font-size="12" text-anchor="middle">${s.name} ${last}</text>`;
    card.innerHTML += `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-bottom:4px">${line}${dots}${label}</svg>`;
  });
  el.appendChild(card);
}

/* ============ 新建角色 ============ */
function openPersonaModal() {
  $('personaModal').classList.add('show');
  $('pName').focus();
}

async function createPersona() {
  const name = $('pName').value.trim();
  const prompt = $('pPrompt').value.trim();
  if (!name || !prompt) { toast('请填写角色名字和性格设定'); return; }
  try {
    const r = await api('/api/personas', {
      method: 'POST',
      body: {
        name,
        avatar: $('pAvatar').value.trim() || '🤖',
        color: $('pColor').value,
        system_prompt: prompt,
        audience: $('pAudience').value
      }
    });
    $('personaModal').classList.remove('show');
    $('pName').value = '';
    $('pAvatar').value = '';
    $('pPrompt').value = '';
    const me = await api('/api/me');
    applyUser(me);
    await selectPersona(r.id);
  } catch (e) { toast(e.message); }
}

/* ============ 初始化 ============ */
document.addEventListener('DOMContentLoaded', async () => {
  $('toReg').addEventListener('click', e => {
    e.preventDefault();
    $('loginForm').hidden = true;
    $('regForm').hidden = false;
    $('authMsg').textContent = '';
  });
  $('toLogin').addEventListener('click', e => {
    e.preventDefault();
    $('loginForm').hidden = false;
    $('regForm').hidden = true;
    $('authMsg').textContent = '';
  });
  $('loginBtn').addEventListener('click', doLogin);
  $('regBtn').addEventListener('click', doRegister);
  ['loginUser', 'loginPass'].forEach(id => {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });
  ['regUser', 'regPass', 'regName'].forEach(id => {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
    location.reload();
  });
  $('newPersonaBtn').addEventListener('click', openPersonaModal);
  $('pCancel').addEventListener('click', () => $('personaModal').classList.remove('show'));
  $('pSave').addEventListener('click', createPersona);
  $('addMemberBtn').addEventListener('click', () => {
    $('memberModal').classList.add('show');
    $('mmName').focus();
  });
  $('mmCancel').addEventListener('click', () => $('memberModal').classList.remove('show'));
  $('mmSave').addEventListener('click', addMember);

  document.querySelectorAll('.tabs button').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  $('sendBtn').addEventListener('click', sendChatFromInput);
  $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChatFromInput(); });
  $('memAddBtn').addEventListener('click', addMemory);
  $('memInput').addEventListener('keydown', e => { if (e.key === 'Enter') addMemory(); });
  $('medSaveBtn').addEventListener('click', saveMed);
  $('rbOk').addEventListener('click', () => finishDose('taken'));
  $('rbLater').addEventListener('click', () => finishDose('later'));

  checkReminders();
  setInterval(checkReminders, 20000);

  try {
    const me = await api('/api/me');
    await enterMain(me);
  } catch (e) {
    showAuth();
  }
});
