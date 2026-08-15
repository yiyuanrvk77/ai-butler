#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 管家 · 平台版本地服务器（零依赖，纯 Python 标准库）

功能：账号注册登录、角色系统、每人每角色的独立记忆、聊天、用药提醒。
数据库：同目录下的 platform.db（SQLite 单文件）。
真实 AI：在 config.json 里填模型接口；不填则用内置模拟回复。
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DIR = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(DIR, 'platform.db')
PORT = 8001

LLM = {}
try:
    with open(os.path.join(DIR, 'config.json'), encoding='utf-8') as f:
        LLM = (json.load(f) or {}).get('llm', {}) or {}
except Exception:
    pass

SEED_PERSONAS = [
    # (名称, 头像, 性格设定, 颜色, 适用人群 all/child/youth/adult/elder)
    ('暖心管家', '🏠', '温柔、耐心、细心，像家人一样说话；关心对方的身体和心情，主动提醒吃药和作息；说话简短亲切，一次只说重点。', '#e8865a', 'all'),
    ('温柔女友', '💕', '温柔体贴、善解人意的恋人，会撒娇也会心疼人；记住对方的小习惯和心情，说话像真实的恋人一样自然。', '#e07a9e', 'youth'),
    ('毒舌朋友', '😏', '嘴硬心软的损友，说话直接爱吐槽但处处为对方好；不用客套话，偶尔带点损人的幽默。', '#5b7db1', 'youth'),
    ('督学学姐', '📚', '考研二战上岸的严厉学姐，说话直接不留情面，但会给具体的学习建议；盯着进度，不许偷懒。', '#8a6bbf', 'youth'),
    ('养生顾问', '🌿', '懂养生和慢病管理的健康顾问，语气温和专业；会关心饮食、作息、血压血糖，给出实用的建议。', '#4f9d69', 'adult'),
    ('追星同好', '💫', '和对方有共同喜欢的偶像和圈子，聊得火热；懂梗、会安利、一起追星一起吐槽。', '#c46bae', 'youth'),
    ('树洞朋友', '🌙', '耐心的倾听者，不评判、不急着给建议；陪对方把心里的话说完，给予理解和安全感。', '#6b7bbf', 'adult'),
    ('家庭秘书', '📒', '细心的家庭助手，帮忙记日程、缴费日、水电、老人孩子的安排；提醒干净利落，条理清楚。', '#4f8f8a', 'adult'),
    ('健康管家', '💊', '贴心的健康管家，盯着吃药、血压血糖和饮食作息；语气温和但认真，像家里最可靠的那个人。', '#4f9d69', 'elder'),
    ('知心哥哥', '🧑‍🎓', '像大哥哥一样耐心温和；陪孩子聊学校和生活，鼓励尝试，教安全常识；绝不说任何不适合孩子的话。', '#5b8dd9', 'child'),
    ('知心姐姐', '👩‍🎓', '像大姐姐一样温柔有趣；听孩子讲心事和烦恼，一起想解决办法；内容安全、阳光、有爱。', '#e08aa0', 'child'),
]


def db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        pass_hash TEXT NOT NULL,
        display_name TEXT DEFAULT '',
        age_group TEXT DEFAULT 'adult',
        created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER DEFAULT 0,
        name TEXT NOT NULL,
        avatar TEXT DEFAULT '🤖',
        system_prompt TEXT NOT NULL,
        color TEXT DEFAULT '#e8865a',
        public INTEGER DEFAULT 0,
        audience TEXT DEFAULT 'all'
    );
    CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        persona_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        persona_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        member_id INTEGER DEFAULT 0,
        name TEXT NOT NULL,
        dosage TEXT DEFAULT '',
        times TEXT NOT NULL,
        note TEXT DEFAULT '',
        created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS med_doses (
        user_id INTEGER NOT NULL,
        med_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        time TEXT NOT NULL,
        state TEXT DEFAULT 'taken',
        PRIMARY KEY (user_id, med_id, day, time)
    );
    CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        relation TEXT DEFAULT '',
        avatar TEXT DEFAULT '👤',
        mode TEXT DEFAULT 'adult',
        created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS vitals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        member_id INTEGER DEFAULT 0,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER
    );
    ''')
    cols = [r['name'] for r in conn.execute('PRAGMA table_info(meds)').fetchall()]
    if 'member_id' not in cols:
        conn.execute('ALTER TABLE meds ADD COLUMN member_id INTEGER DEFAULT 0')
    pcols = [r['name'] for r in conn.execute('PRAGMA table_info(personas)').fetchall()]
    if 'audience' not in pcols:
        conn.execute('ALTER TABLE personas ADD COLUMN audience TEXT DEFAULT "all"')
    ucols = [r['name'] for r in conn.execute('PRAGMA table_info(users)').fetchall()]
    if 'age_group' not in ucols:
        conn.execute('ALTER TABLE users ADD COLUMN age_group TEXT DEFAULT "adult"')
    conn.execute('UPDATE personas SET audience="youth" WHERE name IN ("温柔女友","毒舌朋友","督学学姐")')
    conn.execute('UPDATE personas SET audience="adult" WHERE name="养生顾问"')
    row = conn.execute('SELECT COUNT(*) c FROM personas WHERE user_id=0').fetchone()
    if row['c'] == 0:
        conn.executemany(
            'INSERT INTO personas (user_id,name,avatar,system_prompt,color,public,audience) VALUES (0,?,?,?,?,1,?)',
            SEED_PERSONAS)
    conn.commit()
    conn.close()


def hash_password(pw):
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), bytes.fromhex(salt), 120000).hex()
    return salt + '$' + h


def verify_password(pw, stored):
    try:
        salt, h = stored.split('$', 1)
    except Exception:
        return False
    calc = hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), bytes.fromhex(salt), 120000).hex()
    return hmac.compare_digest(calc, h)


def create_session(user_id):
    token = secrets.token_hex(24)
    conn = db()
    conn.execute('DELETE FROM sessions WHERE expires < ?', (int(time.time()),))
    conn.execute('INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)',
                 (token, user_id, int(time.time()) + 30 * 86400))
    conn.commit()
    conn.close()
    return token


def user_from_request(handler):
    cookies = handler.headers.get('Cookie') or ''
    m = re.search(r'btoken=([0-9a-f]+)', cookies)
    if not m:
        return None
    conn = db()
    row = conn.execute(
        'SELECT s.user_id, s.expires, u.username, u.display_name '
        ', u.age_group '
        'FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?',
        (m.group(1),)).fetchone()
    conn.close()
    if not row or row['expires'] < int(time.time()):
        return None
    return {'id': row['user_id'], 'username': row['username'],
            'display_name': row['display_name'], 'age_group': row['age_group']}


def today_str():
    return datetime.now().strftime('%Y-%m-%d')


def fmt_memory_time(ts):
    d = datetime.fromtimestamp(ts)
    return '%d月%d日 %02d:%02d' % (d.month, d.day, d.hour, d.minute)


def extract_memories(conn, user_id, persona_id, text):
    """从一句话里提取值得记住的小事，存进该角色记忆库。"""
    added = []
    def save(fact):
        if fact and not conn.execute(
                'SELECT 1 FROM memories WHERE user_id=? AND persona_id=? AND text=?',
                (user_id, persona_id, fact)).fetchone():
            conn.execute('INSERT INTO memories (user_id,persona_id,text,created_at) VALUES (?,?,?,?)',
                         (user_id, persona_id, fact, int(time.time())))
            added.append(fact)

    m = re.search(r'我(?:叫|的名字是)\s*([\u4e00-\u9fa5A-Za-z]{1,8})', text)
    if m:
        save('称呼：' + m.group(1))

    patterns = [
        (r'我(?:最喜欢|喜欢)(?:喝|吃)?\s*(.{2,20})', '喜欢'),
        (r'我(?:最爱|爱)(?:喝|吃)?\s*(.{2,20})', '爱'),
        (r'我(?:讨厌|不喜欢)(?:喝|吃)?\s*(.{2,20})', '不喜欢'),
        (r'我(?:特别)?怕\s*(.{1,10})', '怕'),
        (r'我对\s*(.{1,10})\s*过敏', '过敏'),
        (r'我(?:有|得|患)(?:了)?\s*(高血压|糖尿病|心脏病|高血脂|哮喘|关节炎|胃病)', '有'),
        (r'我每天\s*(.{2,20})', '每天'),
        (r'每天\s*(.{2,20})', '每天'),
    ]
    skip = ['你', '您', '这', '那', '他', '她', '它']
    for pat, tag in patterns:
        m = re.search(pat, text)
        if not m:
            continue
        v = m.group(1).strip()
        if len(v) < 2 or v in skip or re.search(r'[吗呢吧？?。！!的$]', v[-1]):
            continue
        save('%s：%s' % (tag, v))

    m = re.search(r'血压[是用]?\s*(\d{2,3})\s*[\/／]\s*(\d{2,3})', text)
    if m:
        save('血压 %s/%s（%s）' % (m.group(1), m.group(2), fmt_memory_time(time.time())))
        conn.execute('INSERT INTO vitals (user_id,member_id,type,value,created_at) VALUES (?,?,?,?,?)',
                     (user_id, 0, 'bp', m.group(1) + '/' + m.group(2), int(time.time())))
    m = re.search(r'血糖[是用]?\s*(\d+(?:\.\d+)?)\s*(?:mmol/?L|毫摩)?', text, re.I)
    if m:
        save('血糖 %s（%s）' % (m.group(1), fmt_memory_time(time.time())))
        conn.execute('INSERT INTO vitals (user_id,member_id,type,value,created_at) VALUES (?,?,?,?,?)',
                     (user_id, 0, 'bs', m.group(1), int(time.time())))
    return added


def next_dose(conn, user_id, meds):
    now = datetime.now()
    today = now.strftime('%Y-%m-%d')
    best = None
    for med in meds:
        for t in sorted(med['times']):
            hh, mm = map(int, t.split(':'))
            due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            day = today
            diff = due - now
            if diff < timedelta(0):
                due += timedelta(days=1)
                day = due.strftime('%Y-%m-%d')
                diff = due - now
            if conn.execute('SELECT 1 FROM med_doses WHERE user_id=? AND med_id=? AND day=? AND time=?',
                            (user_id, med['id'], day, t)).fetchone():
                continue
            if best is None or diff < best['diff']:
                best = {'med': med, 'time': t, 'day': day, 'diff': diff, 'due': due}
    return best


def mark_taken_from_text(conn, user, meds, text):
    now = datetime.now()
    today = now.strftime('%Y-%m-%d')
    for med in meds:
        if med['name'] in text:
            best = None
            for t in med['times']:
                hh, mm = map(int, t.split(':'))
                due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
                diff = now - due
                if diff < timedelta(0) or diff > timedelta(hours=12):
                    continue
                if conn.execute('SELECT 1 FROM med_doses WHERE user_id=? AND med_id=? AND day=? AND time=?',
                                (user['id'], med['id'], today, t)).fetchone():
                    continue
                if best is None or diff < best['diff']:
                    best = {'t': t, 'name': med['name'], 'mid': med['id']}
            if best:
                conn.execute('INSERT OR REPLACE INTO med_doses (user_id,med_id,day,time,state) VALUES (?,?,?,?,"taken")',
                             (user['id'], med['id'], today, best['t']))
                return '好，记下了：%s %s 这顿已经吃过了。' % (best['name'], best['t'])
    best = None
    for med in meds:
        for t in med['times']:
            hh, mm = map(int, t.split(':'))
            due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            diff = now - due
            if diff < timedelta(0) or diff > timedelta(hours=5):
                continue
            if conn.execute('SELECT 1 FROM med_doses WHERE user_id=? AND med_id=? AND day=? AND time=?',
                            (user['id'], med['id'], today, t)).fetchone():
                continue
            if best is None or diff < best['diff']:
                best = {'t': t, 'name': med['name'], 'mid': med['id']}
    if best:
        conn.execute('INSERT OR REPLACE INTO med_doses (user_id,med_id,day,time,state) VALUES (?,?,?,?,"taken")',
                     (user['id'], best['mid'], today, best['t']))
        return '好，记下了：%s %s 这顿已经吃过了。' % (best['name'], best['t'])
    return None


def mock_reply(persona, user, text, memories, meds, conn, added):
    t = text.strip()
    if re.search(r'^(你好|您好|hi|hello|嗨|哈喽|早上好|中午好|下午好|晚上好)', t, re.I) and len(t) <= 12:
        h = datetime.now().hour
        g = '夜深了' if h < 5 else '早上好' if h < 11 else '中午好' if h < 14 else '下午好' if h < 18 else '晚上好'
        return '%s！我是%s。有什么想聊的、想让我记的，都可以说。' % (g, persona['name'])

    if re.search(r'吃过|喝过|吃了|喝了', t):
        r = mark_taken_from_text(conn, user, meds, t)
        if r:
            return r
        return '好～如果哪顿吃过忘说了，告诉我药名，我帮您记。'

    if re.search(r'药|吃药|服药|用药|该吃|该喝', t):
        n = next_dose(conn, user['id'], meds)
        if not n:
            return '今天的药都吃过了，明天见。'
        when = '今天' if n['day'] == today_str() else '明天'
        extra = '，每次' + n['med']['dosage'] if n['med']['dosage'] else ''
        return '下一顿是「%s」，%s %s%s%s。' % (n['med']['name'], when, n['time'], extra,
                                                '（' + n['med']['note'] + '）' if n['med']['note'] else '')

    if re.search(r'记得|记住|还记得|认识|了解我|知道我|记得什么', t):
        if memories:
            return '我记得这些：' + '；'.join(memories[-6:]) + '。随时可以纠正我。'
        return '我还在慢慢了解您。可以说说您喜欢什么，我会记住。'

    if re.search(r'记(住|着|下来|一下)?', t):
        if added:
            return '好，我记下了：' + '；'.join(added) + '。'
        return '想让我记什么？直接说就行，比如「我喜欢喝绿茶」。'

    if re.search(r'你是谁|你叫什么|自我介绍|你是什么', t):
        return '我是%s，您的专属管家。帮您记小事、提醒吃药、陪您聊天。' % persona['name']

    if re.search(r'血压|血糖', t):
        hits = [m for m in memories if m.startswith('血压') or m.startswith('血糖')]
        if hits:
            return '您最近记的是：' + '；'.join(hits[-2:]) + '。下次量了告诉我，我接着记。'
        return '我还没记过。量完直接告诉我数字就行，比如「血压 130/85」。'

    if re.search(r'心情|难过|不开心|烦|累|压力|睡不着|失眠|孤单', t):
        return '我在呢。心里不舒服就说出来，我听着。'
    if re.search(r'谢谢|辛苦|感谢', t):
        return '不客气，这是我该做的。'
    if re.search(r'晚安|再见|睡了|休息', t):
        return '晚安，好好休息。'
    if added:
        return '好，我记下了：' + '；'.join(added) + '。还有别的要交代吗？'
    gentle = ['好的，我听着呢。', '嗯，您继续说。', '我记在心里了。']
    return gentle[int(time.time()) % len(gentle)]


def llm_reply(persona, user, content, memories, meds, history):
    if not LLM.get('key') or not LLM.get('baseUrl'):
        return None
    now = datetime.now()
    lines = [
        '你是「%s」，%s' % (persona['name'], persona['system_prompt']),
        '你服务的人：%s' % (user['display_name'] or user['username']),
        '现在是 %d年%d月%d日 %s' % (now.year, now.month, now.day, now.strftime('%H:%M')),
    ]
    if memories:
        lines.append('你记得的事：' + '；'.join(memories[-10:]))
    if meds:
        lines.append('用药安排：' + '；'.join(
            '%s %s 每天 %s' % (m['name'], m['dosage'], '、'.join(m['times'])) for m in meds))
    lines.append('要求：说话口语化、简短亲切，一次只说重点；不要编造不存在的记忆。')
    messages = [{'role': 'system', 'content': '\n'.join(lines)}] + history + [{'role': 'user', 'content': content}]
    url = LLM['baseUrl'].rstrip('/') + '/chat/completions'
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps({'model': LLM.get('model', ''), 'messages': messages, 'temperature': 0.8}).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LLM['key']})
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read().decode('utf-8'))
        return out['choices'][0]['message']['content'].strip()
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, status=400):
        self._send({'error': msg}, status)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw.decode('utf-8')) if raw else {}
        except Exception:
            return {}

    def _static(self, path):
        name = path.strip('/') or 'index.html'
        if name not in ('index.html', 'app.js', 'style.css'):
            self.send_error(404)
            return
        fpath = os.path.join(DIR, name)
        if not os.path.isfile(fpath):
            self.send_error(404)
            return
        ctype = {'index.html': 'text/html; charset=utf-8',
                 'app.js': 'application/javascript; charset=utf-8',
                 'style.css': 'text/css; charset=utf-8'}.get(name, 'application/octet-stream')
        with open(fpath, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def do_DELETE(self):
        self._route('DELETE')

    def _route(self, method):
        path = urlparse(self.path).path
        user = user_from_request(self)
        if method == 'GET' and not path.startswith('/api/'):
            self._static(path)
            return
        try:
            if path == '/api/register' and method == 'POST':
                return self.api_register()
            if path == '/api/login' and method == 'POST':
                return self.api_login()
            if path == '/api/logout' and method == 'POST':
                return self.api_logout(user)
            if not user:
                return self._err('请先登录', 401)
            if path == '/api/me' and method == 'GET':
                return self.api_me(user)
            if path == '/api/members' and method == 'GET':
                return self.api_members(user)
            if path == '/api/members' and method == 'POST':
                return self.api_add_member(user)
            m = re.match(r'^/api/members/(\d+)$', path)
            if m and method == 'DELETE':
                return self.api_delete_member(user, int(m.group(1)))
            if path == '/api/personas' and method == 'GET':
                return self.api_personas(user)
            if path == '/api/personas' and method == 'POST':
                return self.api_create_persona(user)
            m = re.match(r'^/api/personas/(\d+)$', path)
            if m and method == 'DELETE':
                return self.api_delete_persona(user, int(m.group(1)))
            if path == '/api/memories' and method == 'GET':
                return self.api_memories(user)
            if path == '/api/memories' and method == 'POST':
                return self.api_add_memory(user)
            m = re.match(r'^/api/memories/(\d+)$', path)
            if m and method == 'DELETE':
                return self.api_delete_memory(user, int(m.group(1)))
            if path == '/api/messages' and method == 'GET':
                return self.api_messages(user)
            if path == '/api/chat' and method == 'POST':
                return self.api_chat(user)
            if path == '/api/meds' and method == 'GET':
                return self.api_meds(user)
            if path == '/api/meds' and method == 'POST':
                return self.api_add_med(user)
            if path == '/api/daily-summary' and method == 'GET':
                return self.api_daily_summary(user)
            if path == '/api/vitals' and method == 'GET':
                return self.api_vitals(user)
            m = re.match(r'^/api/meds/(\d+)$', path)
            if m and method == 'DELETE':
                return self.api_delete_med(user, int(m.group(1)))
            m = re.match(r'^/api/meds/(\d+)/dose$', path)
            if m and method == 'POST':
                return self.api_mark_dose(user, int(m.group(1)))
            self._err('接口不存在', 404)
        except Exception as e:
            self._err('服务器错误：' + str(e), 500)

    def api_register(self):
        b = self._body()
        username = (b.get('username') or '').strip()
        password = b.get('password') or ''
        display = (b.get('display_name') or '').strip() or username
        age_group = b.get('age_group') or 'adult'
        if age_group not in ('child', 'youth', 'adult', 'elder'):
            age_group = 'adult'
        if not re.fullmatch(r'[A-Za-z0-9_\u4e00-\u9fa5]{2,20}', username):
            return self._err('用户名需为 2-20 位中文、字母或数字')
        if len(password) < 6:
            return self._err('密码至少 6 位')
        conn = db()
        if conn.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
            conn.close()
            return self._err('用户名已被注册')
        cur = conn.execute('INSERT INTO users (username,pass_hash,display_name,age_group,created_at) VALUES (?,?,?,?,?)',
                           (username, hash_password(password), display, age_group, int(time.time())))
        user_id = cur.lastrowid
        conn.commit()
        conn.close()
        self._login(user_id, username, display)

    def api_login(self):
        b = self._body()
        username = (b.get('username') or '').strip()
        password = b.get('password') or ''
        conn = db()
        row = conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        conn.close()
        if not row or not verify_password(password, row['pass_hash']):
            return self._err('用户名或密码不对')
        self._login(row['id'], row['username'], row['display_name'])

    def _login(self, user_id, username, display_name):
        token = create_session(user_id)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Set-Cookie', 'btoken=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' % token)
        body = json.dumps({'ok': True, 'user': {'id': user_id, 'username': username, 'display_name': display_name}},
                          ensure_ascii=False).encode('utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def api_logout(self, user):
        if user:
            conn = db()
            conn.execute('DELETE FROM sessions WHERE user_id=?', (user['id'],))
            conn.commit()
            conn.close()
        self._send({'ok': True})

    def _persona_rows(self, user):
        conn = db()
        rows = conn.execute(
            'SELECT p.*,'
            ' (SELECT COUNT(*) FROM memories m WHERE m.user_id=? AND m.persona_id=p.id) mc,'
            ' (SELECT content FROM messages msg WHERE msg.user_id=? AND msg.persona_id=p.id'
            '   AND msg.role="assistant" ORDER BY msg.id DESC LIMIT 1) last'
            ' FROM personas p WHERE p.user_id=0 OR p.user_id=? ORDER BY p.user_id DESC, p.id',
            (user['id'], user['id'], user['id'])).fetchall()
        conn.close()
        return rows

    def api_me(self, user):
        rows = self._persona_rows(user)
        conn = db()
        mrows = conn.execute('SELECT * FROM members WHERE owner_id=? ORDER BY id', (user['id'],)).fetchall()
        conn.close()
        self._send({
            'user': {'username': user['username'],
                     'display_name': user['display_name'] or user['username'],
                     'age_group': user.get('age_group', 'adult')},
            'members': [{
                'id': r['id'], 'name': r['name'], 'relation': r['relation'],
                'avatar': r['avatar'], 'mode': r['mode']
            } for r in mrows],
            'personas': [{
                'id': r['id'], 'name': r['name'], 'avatar': r['avatar'], 'color': r['color'],
                'system_prompt': r['system_prompt'], 'is_mine': r['user_id'] == user['id'],
                'memory_count': r['mc'], 'last_message': r['last'], 'audience': r['audience']
            } for r in rows]
        })

    def api_members(self, user):
        conn = db()
        rows = conn.execute('SELECT * FROM members WHERE owner_id=? ORDER BY id', (user['id'],)).fetchall()
        conn.close()
        self._send({'members': [{
            'id': r['id'], 'name': r['name'], 'relation': r['relation'],
            'avatar': r['avatar'], 'mode': r['mode']
        } for r in rows]})

    def api_add_member(self, user):
        b = self._body()
        name = (b.get('name') or '').strip()
        if not name:
            return self._err('请填写家人称呼')
        conn = db()
        cur = conn.execute(
            'INSERT INTO members (owner_id,name,relation,avatar,mode,created_at) VALUES (?,?,?,?,?,?)',
            (user['id'], name[:20], (b.get('relation') or '').strip()[:20],
             (b.get('avatar') or '👤').strip()[:4], (b.get('mode') or 'adult').strip(),
             int(time.time())))
        conn.commit()
        conn.close()
        self._send({'ok': True, 'id': cur.lastrowid})

    def api_delete_member(self, user, mid):
        conn = db()
        cur = conn.execute('DELETE FROM members WHERE id=? AND owner_id=?', (mid, user['id']))
        conn.execute('DELETE FROM meds WHERE user_id=? AND member_id=?', (user['id'], mid))
        conn.execute('DELETE FROM med_doses WHERE user_id=? AND med_id NOT IN (SELECT id FROM meds WHERE user_id=?)',
                     (user['id'], user['id']))
        conn.commit()
        conn.close()
        if cur.rowcount == 0:
            return self._err('家人不存在', 404)
        self._send({'ok': True})

    def api_personas(self, user):
        rows = self._persona_rows(user)
        self._send({'personas': [{
            'id': r['id'], 'name': r['name'], 'avatar': r['avatar'], 'color': r['color'],
            'is_mine': r['user_id'] == user['id'], 'memory_count': r['mc'], 'last_message': r['last'],
            'audience': r['audience']
        } for r in rows]})

    def api_create_persona(self, user):
        b = self._body()
        name = (b.get('name') or '').strip()
        prompt = (b.get('system_prompt') or '').strip()
        if not name or not prompt:
            return self._err('请填写角色名字和性格设定')
        conn = db()
        audience = b.get('audience') or 'all'
        if audience not in ('all', 'child', 'youth', 'adult', 'elder'):
            audience = 'all'
        cur = conn.execute('INSERT INTO personas (user_id,name,avatar,system_prompt,color,audience) VALUES (?,?,?,?,?,?)',
                           (user['id'], name, (b.get('avatar') or '🤖').strip()[:2],
                            prompt, (b.get('color') or '#e8865a').strip(), audience))
        conn.commit()
        conn.close()
        self._send({'ok': True, 'id': cur.lastrowid})

    def api_delete_persona(self, user, pid):
        conn = db()
        row = conn.execute('SELECT id FROM personas WHERE id=? AND user_id=?', (pid, user['id'])).fetchone()
        if not row:
            conn.close()
            return self._err('只能删除自己创建的角色', 404)
        conn.execute('DELETE FROM personas WHERE id=?', (pid,))
        conn.execute('DELETE FROM memories WHERE user_id=? AND persona_id=?', (user['id'], pid))
        conn.execute('DELETE FROM messages WHERE user_id=? AND persona_id=?', (user['id'], pid))
        conn.commit()
        conn.close()
        self._send({'ok': True})

    def _get_persona(self, user, pid):
        conn = db()
        row = conn.execute('SELECT * FROM personas WHERE id=? AND (user_id=0 OR user_id=?)',
                           (pid, user['id'])).fetchone()
        conn.close()
        return row

    def api_memories(self, user):
        pid = int(self._query('persona_id') or 0)
        if not self._get_persona(user, pid):
            return self._err('角色不存在', 404)
        conn = db()
        rows = conn.execute('SELECT * FROM memories WHERE user_id=? AND persona_id=? ORDER BY id DESC',
                            (user['id'], pid)).fetchall()
        conn.close()
        self._send({'memories': [{'id': r['id'], 'text': r['text'], 'created_at': r['created_at']} for r in rows]})

    def _query(self, key):
        qs = urlparse(self.path).query
        for part in qs.split('&'):
            if '=' in part:
                k, v = part.split('=', 1)
                if k == key:
                    return v
        return None

    def api_add_memory(self, user):
        b = self._body()
        pid = int(b.get('persona_id') or 0)
        text = (b.get('text') or '').strip()
        if not self._get_persona(user, pid):
            return self._err('角色不存在', 404)
        if not text:
            return self._err('内容不能为空')
        conn = db()
        cur = conn.execute('INSERT INTO memories (user_id,persona_id,text,created_at) VALUES (?,?,?,?)',
                           (user['id'], pid, text, int(time.time())))
        conn.commit()
        conn.close()
        self._send({'ok': True, 'id': cur.lastrowid})

    def api_delete_memory(self, user, mid):
        conn = db()
        cur = conn.execute('DELETE FROM memories WHERE id=? AND user_id=?', (mid, user['id']))
        conn.commit()
        conn.close()
        if cur.rowcount == 0:
            return self._err('记忆不存在', 404)
        self._send({'ok': True})

    def api_messages(self, user):
        pid = int(self._query('persona_id') or 0)
        if not self._get_persona(user, pid):
            return self._err('角色不存在', 404)
        conn = db()
        rows = conn.execute('SELECT * FROM messages WHERE user_id=? AND persona_id=? ORDER BY id',
                            (user['id'], pid)).fetchall()
        conn.close()
        self._send({'messages': [{'id': r['id'], 'role': r['role'], 'content': r['content'],
                                  'created_at': r['created_at']} for r in rows]})

    def api_chat(self, user):
        b = self._body()
        pid = int(b.get('persona_id') or 0)
        content = (b.get('content') or '').strip()
        if not pid or not content:
            return self._err('缺少参数')
        persona = self._get_persona(user, pid)
        if not persona:
            return self._err('角色不存在', 404)
        conn = db()
        conn.execute('INSERT INTO messages (user_id,persona_id,role,content,created_at) VALUES (?,?,?,"user",?)',
                     (user['id'], pid, content, int(time.time())))
        added = extract_memories(conn, user['id'], pid, content)
        memories = [r['text'] for r in conn.execute(
            'SELECT text FROM memories WHERE user_id=? AND persona_id=? ORDER BY id', (user['id'], pid)).fetchall()]
        meds = [dict(r) for r in conn.execute('SELECT * FROM meds WHERE user_id=?', (user['id'],)).fetchall()]
        for m in meds:
            m['times'] = json.loads(m['times'])
        history = [{'role': r['role'], 'content': r['content']} for r in conn.execute(
            'SELECT role,content FROM messages WHERE user_id=? AND persona_id=? ORDER BY id DESC LIMIT 20',
            (user['id'], pid)).fetchall()]
        history.reverse()
        reply = llm_reply(persona, user, content, memories, meds, history) or \
            mock_reply(persona, user, content, memories, meds, conn, added)
        conn.execute('INSERT INTO messages (user_id,persona_id,role,content,created_at) VALUES (?,?,?,"assistant",?)',
                     (user['id'], pid, reply, int(time.time())))
        conn.commit()
        conn.close()
        self._send({'reply': reply, 'memories_added': added})

    def api_meds(self, user):
        conn = db()
        rows = conn.execute('SELECT * FROM meds WHERE user_id=? ORDER BY id', (user['id'],)).fetchall()
        mrows = conn.execute('SELECT * FROM members WHERE owner_id=?', (user['id'],)).fetchall()
        member_map = {r['id']: r for r in mrows}
        today = today_str()
        mq = self._query('member_id')
        mq = int(mq) if mq and mq.isdigit() else None
        meds = []
        for r in rows:
            med = {'id': r['id'], 'name': r['name'], 'dosage': r['dosage'],
                   'times': json.loads(r['times']), 'note': r['note'],
                   'member_id': r['member_id']}
            if mq is not None and med['member_id'] != mq:
                continue
            if med['member_id']:
                mm = member_map.get(med['member_id'])
                med['member_name'] = mm['name'] if mm else '家人'
                med['member_avatar'] = mm['avatar'] if mm else '👤'
            else:
                med['member_name'] = '我'
                med['member_avatar'] = '👤'
            med['taken'] = [t for t in med['times'] if conn.execute(
                'SELECT 1 FROM med_doses WHERE user_id=? AND med_id=? AND day=? AND time=?',
                (user['id'], med['id'], today, t)).fetchone()]
            meds.append(med)
        n = next_dose(conn, user['id'], meds)
        next_info = None
        if n:
            next_info = {'med_id': n['med']['id'], 'name': n['med']['name'], 'time': n['time'],
                         'dosage': n['med']['dosage'], 'note': n['med']['note'],
                         'today': n['day'] == today, 'minutes': int(n['diff'].total_seconds() // 60)}
        conn.close()
        self._send({'meds': meds, 'next': next_info})

    def api_add_med(self, user):
        b = self._body()
        name = (b.get('name') or '').strip()
        times = b.get('times') or []
        member_id = int(b.get('member_id') or 0)
        if not name:
            return self._err('请填写药名')
        if member_id:
            conn0 = db()
            own = conn0.execute('SELECT 1 FROM members WHERE id=? AND owner_id=?',
                                (member_id, user['id'])).fetchone()
            conn0.close()
            if not own:
                return self._err('家人不存在')
        clean = []
        for t in times:
            m = re.fullmatch(r'(\d{1,2}):(\d{2})', str(t).strip())
            if m:
                clean.append('%02d:%s' % (int(m.group(1)), m.group(2)))
        if not clean:
            return self._err('时间格式要像这样：08:00, 12:30, 18:30')
        conn = db()
        cur = conn.execute('INSERT INTO meds (user_id,member_id,name,dosage,times,note,created_at) VALUES (?,?,?,?,?,?,?)',
                           (user['id'], member_id, name, (b.get('dosage') or '').strip(),
                            json.dumps(sorted(set(clean)), ensure_ascii=False),
                            (b.get('note') or '').strip(), int(time.time())))
        conn.commit()
        conn.close()
        self._send({'ok': True, 'id': cur.lastrowid})

    def api_daily_summary(self, user):
        conn = db()
        today = today_str()
        meds = [dict(r) for r in conn.execute(
            'SELECT * FROM meds WHERE user_id=? ORDER BY id', (user['id'],)).fetchall()]
        mrows = conn.execute('SELECT * FROM members WHERE owner_id=?', (user['id'],)).fetchall()
        member_map = {r['id']: r for r in mrows}

        def mname(mid):
            return member_map[mid]['name'] if mid else '我'

        members_out = {}
        order = []
        for med in meds:
            med['times'] = json.loads(med['times'])
            key = med['member_id']
            if key not in members_out:
                members_out[key] = {'name': mname(key), 'meds': []}
                order.append(key)
            entries = []
            for t in sorted(med['times']):
                taken = bool(conn.execute(
                    'SELECT 1 FROM med_doses WHERE user_id=? AND med_id=? AND day=? AND time=?',
                    (user['id'], med['id'], today, t)).fetchone())
                entries.append({'time': t, 'taken': taken})
            members_out[key]['meds'].append({
                'name': med['name'], 'dosage': med['dosage'], 'note': med['note'], 'times': entries
            })

        midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        vrows = conn.execute(
            'SELECT type,value,created_at FROM vitals WHERE user_id=? AND created_at>=? ORDER BY id',
            (user['id'], int(midnight.timestamp()))).fetchall()

        tomorrow = []
        now = datetime.now()
        for med in meds:
            for t in sorted(med['times']):
                tomorrow.append({'name': med['name'], 'time': t,
                                 'member': mname(med['member_id']), 'dosage': med['dosage']})
        tomorrow.sort(key=lambda x: x['time'])
        conn.close()
        self._send({
            'date': today,
            'members': [members_out[k] for k in order],
            'vitals_today': [{'type': r['type'], 'value': r['value'], 'created_at': r['created_at']}
                             for r in vrows],
            'tomorrow': tomorrow[:6]
        })

    def api_vitals(self, user):
        mq = self._query('member_id')
        member_id = int(mq) if mq and mq.isdigit() else 0
        tq = self._query('type')
        types = [tq] if tq in ('bp', 'bs') else ['bp', 'bs']
        conn = db()
        out = {}
        for t in types:
            rows = conn.execute(
                'SELECT value,created_at FROM vitals WHERE user_id=? AND member_id=? AND type=? ORDER BY id DESC LIMIT 14',
                (user['id'], member_id, t)).fetchall()
            out[t] = [{'value': r['value'], 'created_at': r['created_at']} for r in reversed(rows)]
        conn.close()
        self._send(out)

    def api_delete_med(self, user, mid):
        conn = db()
        cur = conn.execute('DELETE FROM meds WHERE id=? AND user_id=?', (mid, user['id']))
        conn.execute('DELETE FROM med_doses WHERE user_id=? AND med_id=?', (user['id'], mid))
        conn.commit()
        conn.close()
        if cur.rowcount == 0:
            return self._err('药品不存在', 404)
        self._send({'ok': True})

    def api_mark_dose(self, user, mid):
        b = self._body()
        t = (b.get('time') or '').strip()
        conn = db()
        med = conn.execute('SELECT * FROM meds WHERE id=? AND user_id=?', (mid, user['id'])).fetchone()
        if not med:
            conn.close()
            return self._err('药品不存在', 404)
        conn.execute('INSERT OR REPLACE INTO med_doses (user_id,med_id,day,time,state) VALUES (?,?,?,?,"taken")',
                     (user['id'], mid, today_str(), t))
        conn.commit()
        conn.close()
        self._send({'ok': True})


def main():
    init_db()
    port = PORT
    while True:
        try:
            srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            port += 1
    print('AI 管家平台已启动：http://127.0.0.1:%d' % port)
    webbrowser.open('http://127.0.0.1:%d' % port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
