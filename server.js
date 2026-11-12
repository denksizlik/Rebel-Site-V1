const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'data.json');

app.use(express.json({ limit: '100kb' }));
// Sadece pictures/ klasörü dışarı açık (data.json, server.js vs. asla servis edilmez)
app.use('/pictures', express.static(path.join(__dirname, 'pictures')));

/* ------------------------------------------------------------------ */
/*  RANKS  (level yükseldikçe yetki artar)                             */
/* ------------------------------------------------------------------ */
const RANKS = [
    { id: 'founder',           name: 'Founder',           level: 100, color: '#fbbf24' },
    { id: 'project_leader',    name: 'Project Leader',    level: 90,  color: '#ef4444' },
    { id: 'project_co_leader', name: 'Project Co Leader', level: 80,  color: '#f97316' },
    { id: 'management',        name: 'Management',        level: 60,  color: '#ec4899' },
    { id: 'administrator',     name: 'Administrator',     level: 40,  color: '#3b82f6' },
    { id: 'anti_cheats',       name: 'Anti Cheats',       level: 30,  color: '#10b981' },
    { id: 'member',            name: 'Member',            level: 0,   color: '#9ca3af' }
];
const rankOf = id => RANKS.find(r => r.id === id) || RANKS[RANKS.length - 1];

// Yetki eşikleri — istersen buradan değiştir
const THREAD_COOLDOWN_MS = 10 * 60 * 1000;   // 10 dakikada 1 konu (yetkililer muaf)
const PERM = {
    MODERATE: 30,     // forum sabitle / kilitle / prefix ver / konu & mesaj sil  (Anti Cheats ve üstü)
    BAN_USERS: 60,    // site hesabı banlama (Management ve üstü)
    SITE_ADMIN: 80    // rank verme, leaderboard, turf  (Project Co Leader ve üstü)
};

/* ------------------------------------------------------------------ */
/*  DATABASE (data.json)                                               */
/* ------------------------------------------------------------------ */
const DEFAULT_CATEGORIES = [
    { id: 'unban-request', name: 'Unban Request', icon: 'fa-unlock-keyhole', color: '#10b981',
      description: 'Banlandıysan itirazını buradan yap. Yetkililer konunu inceleyip sonuç yazar.',
      template: 'In-game name:\nBan reason:\nBanned by (admin):\nWhy should we unban you?\n' },
    { id: 'complaints', name: 'Complaints About Players', icon: 'fa-triangle-exclamation', color: '#ef4444',
      description: 'Kural ihlali yapan oyuncuları kanıtla birlikte bildir.',
      template: 'Reported player:\nDate / Time:\nWhat happened?\nEvidence (clip link):\n' },
    { id: 'general', name: 'General Discussion', icon: 'fa-comments', color: '#3b82f6',
      description: 'Sunucu hakkında her şey: öneriler, sohbet, takım arayışı.', template: '' }
];
const DEFAULT_PREFIXES = [
    { id: 'on_consideration', name: 'On Consideration', color: '#f59e0b' },
    { id: 'approved',         name: 'Approved',         color: '#10b981' },
    { id: 'rejected',         name: 'Rejected',         color: '#ef4444' },
    { id: 'resolved',         name: 'Resolved',         color: '#3b82f6' }
];

let db = {
    nextId: 1, users: [], threads: [], posts: [], highlights: [], sessions: {},
    categories: DEFAULT_CATEGORIES, prefixes: DEFAULT_PREFIXES,
    leaderboard: [
        { rank: 1, name: 'Rio Rebel', kills: 1420, deaths: 310, kd: 4.58 },
        { rank: 2, name: 'Lee Apex',  kills: 1280, deaths: 350, kd: 3.65 },
        { rank: 3, name: 'Zwox',      kills: 1150, deaths: 410, kd: 2.80 },
        { rank: 4, name: 'Ghost',     kills: 980,  deaths: 390, kd: 2.51 },
        { rank: 5, name: 'Viper',     kills: 890,  deaths: 400, kd: 2.22 }
    ],
    turf: {
        dominance: '100%', gangName: 'Families (Rebel FamQ)', leader: 'Rio Rebel',
        territory: 'Los Santos Entire Turf / South Central', image: 'pictures/serverbanner.png'
    }
};

try {
    if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) { console.error('data.json okunamadı, yeni veritabanı kullanılıyor:', e.message); }

// Eski sürümden kalan Highlights forum kategorisini ve bağlı konularını temizle
db.categories = db.categories.filter(c => c.id !== 'highlights');
{
    const dead = db.threads.filter(t => t.categoryId === 'highlights' || t.highlightId).map(t => t.id);
    if (dead.length) {
        db.posts = db.posts.filter(p => !dead.includes(p.threadId));
        db.threads = db.threads.filter(t => !dead.includes(t.id));
    }
    db.highlights.forEach(h => { delete h.threadId; });
}

let saveTimer = null;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const tmp = DB_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(db));
            fs.renameSync(tmp, DB_FILE);
        } catch (e) { console.error('Kaydedilemedi:', e.message); }
    }, 150);
}
const newId = () => db.nextId++;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(pw, salt, 64);
    const real = Buffer.from(hash, 'hex');
    return test.length === real.length && crypto.timingSafeEqual(test, real);
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const levelOf = u => (u ? rankOf(u.rank).level : 0);
const findUserByName = n => db.users.find(u => u.username.toLowerCase() === String(n).toLowerCase());
const cleanText = (s, max) => String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

function publicUser(u) {
    if (!u) return { id: 0, username: '[deleted]', rank: 'member', rankName: 'Member', color: '#9ca3af', level: 0, avatar: '' };
    const r = rankOf(u.rank);
    return { id: u.id, username: u.username, rank: r.id, rankName: r.name, color: r.color, level: r.level, avatar: u.avatar || '' };
}
function selfUser(u) {
    return Object.assign(publicUser(u), {
        bio: u.bio || '', discord: u.discord || '', createdAt: u.createdAt, root: !!u.root,
        nextThreadAt: isMod(u) ? 0 : (u.lastThreadAt || 0) + THREAD_COOLDOWN_MS,
        can: {
            moderate: levelOf(u) >= PERM.MODERATE || !!u.root,
            banUsers: levelOf(u) >= PERM.BAN_USERS || !!u.root,
            siteAdmin: levelOf(u) >= PERM.SITE_ADMIN || !!u.root
        }
    });
}
const isMod = u => !!u && (u.root || levelOf(u) >= PERM.MODERATE);
const isSiteAdmin = u => !!u && (u.root || levelOf(u) >= PERM.SITE_ADMIN);

function ytId(url) {
    const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}
function safeUrl(u) {
    if (!u) return '';
    try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href.slice(0, 300) : ''; }
    catch { return ''; }
}

// çok basit rate limit
const hits = new Map();
function limited(key, max, windowMs) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();

/* ------------------------------------------------------------------ */
/*  Seed: Rio hesabı                                                   */
/* ------------------------------------------------------------------ */
if (!findUserByName('rio')) {
    db.users.push({
        id: newId(), username: 'rio',
        passwordHash: hashPassword(process.env.RIO_PASSWORD || 'zwoxzwox01'),
        rank: 'project_co_leader', root: true, bio: '', discord: 'onenightsuddenly', avatar: '',
        createdAt: Date.now(), banned: false
    });
    save();
}

/* ------------------------------------------------------------------ */
/*  Auth middleware                                                    */
/* ------------------------------------------------------------------ */
const COOKIE = 'rp_session';
function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(p => {
        const i = p.indexOf('=');
        if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
}
function setSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const maxAge = 30 * 24 * 3600;
    db.sessions[sha(token)] = { userId, exp: Date.now() + maxAge * 1000 };
    save();
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}
app.use((req, res, next) => {
    req.user = null;
    const token = parseCookies(req)[COOKIE];
    if (token) {
        const s = db.sessions[sha(token)];
        if (s && s.exp > Date.now()) {
            const u = db.users.find(x => x.id === s.userId);
            if (u && !u.banned) req.user = u;
        }
    }
    // CSRF: yazma istekleri sadece JSON ile kabul
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method) && req.path.startsWith('/api/')) {
        const ct = req.headers['content-type'] || '';
        if (req.method !== 'DELETE' && !ct.includes('application/json')) return res.status(415).json({ error: 'JSON gerekli.' });
        if (req.headers['x-requested-with'] !== 'rebel') return res.status(403).json({ error: 'Geçersiz istek.' });
    }
    next();
});
const needAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Giriş yapmalısın.' });
const needMod = (req, res, next) => isMod(req.user) ? next() : res.status(403).json({ error: 'Yetkin yok.' });
const needSiteAdmin = (req, res, next) => isSiteAdmin(req.user) ? next() : res.status(403).json({ error: 'Yetkin yok.' });

/* ------------------------------------------------------------------ */
/*  AUTH                                                               */
/* ------------------------------------------------------------------ */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;

app.post('/api/auth/register', (req, res) => {
    if (limited('reg:' + req.ip, 5, 3600000)) return res.status(429).json({ error: 'Çok fazla deneme. Daha sonra tekrar dene.' });
    const username = cleanText(req.body.username, 20);
    const password = String(req.body.password || '');
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ . -).' });
    if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı.' });
    if (findUserByName(username)) return res.status(409).json({ error: 'Bu kullanıcı adı alınmış.' });
    const ipHash = sha('ip:' + req.ip);
    if (db.users.some(x => x.ipHash === ipHash)) return res.status(403).json({ error: 'Bu IP adresinden zaten bir hesap açılmış. IP başına yalnızca 1 hesap açılabilir.' });
    const u = { id: newId(), username, passwordHash: hashPassword(password), rank: 'member', bio: '', discord: '', avatar: '', createdAt: Date.now(), banned: false, ipHash };
    db.users.push(u);
    setSession(req, res, u.id);
    res.json({ user: selfUser(u) });
});

app.post('/api/auth/login', (req, res) => {
    if (limited('login:' + req.ip, 10, 900000)) return res.status(429).json({ error: 'Çok fazla deneme. 15 dakika sonra tekrar dene.' });
    const u = findUserByName(cleanText(req.body.username, 20));
    if (!u || !verifyPassword(String(req.body.password || ''), u.passwordHash)) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    if (u.banned) return res.status(403).json({ error: 'Bu hesap banlanmış.' + (u.banReason ? ' Sebep: ' + u.banReason : '') });
    setSession(req, res, u.id);
    res.json({ user: selfUser(u) });
});

app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) { delete db.sessions[sha(token)]; save(); }
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ success: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user ? selfUser(req.user) : null }));

app.get('/api/meta', (req, res) => res.json({ ranks: RANKS, prefixes: db.prefixes }));

/* ------------------------------------------------------------------ */
/*  PROFILE                                                            */
/* ------------------------------------------------------------------ */
app.patch('/api/me', needAuth, (req, res) => {
    const u = req.user;
    if (req.body.username !== undefined && req.body.username !== u.username) {
        const nn = cleanText(req.body.username, 20);
        if (!USERNAME_RE.test(nn)) return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ . -).' });
        const ex = findUserByName(nn);
        if (ex && ex.id !== u.id) return res.status(409).json({ error: 'Bu kullanıcı adı alınmış.' });
        u.username = nn;
    }
    if (req.body.bio !== undefined) u.bio = cleanText(req.body.bio, 300);
    if (req.body.discord !== undefined) u.discord = cleanText(req.body.discord, 40);
    if (req.body.avatar !== undefined) {
        const a = String(req.body.avatar).trim();
        if (a && !safeUrl(a)) return res.status(400).json({ error: 'Avatar geçerli bir http(s) bağlantısı olmalı.' });
        u.avatar = safeUrl(a);
    }
    save();
    res.json({ user: selfUser(u) });
});

app.post('/api/me/password', needAuth, (req, res) => {
    const { current, next } = req.body;
    if (!verifyPassword(String(current || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Mevcut şifre yanlış.' });
    if (String(next || '').length < 6) return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalı.' });
    req.user.passwordHash = hashPassword(String(next));
    // diğer oturumları kapat
    const keep = sha(parseCookies(req)[COOKIE] || '');
    for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === req.user.id && k !== keep) delete db.sessions[k];
    save();
    res.json({ success: true });
});

app.get('/api/users/:username', (req, res) => {
    const u = findUserByName(req.params.username);
    if (!u) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const posts = db.posts.filter(p => p.authorId === u.id).length;
    const threads = db.threads.filter(t => t.authorId === u.id).length;
    const recent = db.threads.filter(t => t.authorId === u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 8)
        .map(t => ({ id: t.id, title: t.title, createdAt: t.createdAt }));
    res.json({ user: Object.assign(publicUser(u), { bio: u.bio || '', discord: u.discord || '', createdAt: u.createdAt, banned: !!u.banned }), stats: { posts, threads }, recent });
});

/* ------------------------------------------------------------------ */
/*  FORUM                                                              */
/* ------------------------------------------------------------------ */
const prefixOf = id => db.prefixes.find(p => p.id === id) || null;
const userById = id => db.users.find(u => u.id === id);

function threadSummary(t) {
    const posts = db.posts.filter(p => p.threadId === t.id);
    const last = posts.length ? posts.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)) : null;
    return {
        id: t.id, categoryId: t.categoryId, title: t.title, pinned: !!t.pinned, locked: !!t.locked,
        prefix: prefixOf(t.prefix), createdAt: t.createdAt, lastActivity: t.lastActivity, views: t.views || 0,
        replies: Math.max(0, posts.length - 1), author: publicUser(userById(t.authorId)),
        lastPoster: last ? publicUser(userById(last.authorId)) : null, highlightId: t.highlightId || null
    };
}

app.get('/api/forum/categories', (req, res) => {
    res.json(db.categories.map(c => {
        const ts = db.threads.filter(t => t.categoryId === c.id);
        const latest = ts.sort((a, b) => b.lastActivity - a.lastActivity)[0];
        const postCount = db.posts.filter(p => ts.some(t => t.id === p.threadId)).length;
        return Object.assign({}, c, { threads: ts.length, posts: postCount, latest: latest ? threadSummary(latest) : null });
    }));
});

app.get('/api/forum/threads', (req, res) => {
    const cat = req.query.category;
    const q = cleanText(req.query.q, 60).toLowerCase();
    let list = db.threads.filter(t => (!cat || t.categoryId === cat) && (!q || t.title.toLowerCase().includes(q)));
    list.sort((a, b) => (b.pinned - a.pinned) || (b.lastActivity - a.lastActivity));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const per = 20;
    res.json({ total: list.length, page, per, threads: list.slice((page - 1) * per, page * per).map(threadSummary) });
});

app.get('/api/forum/threads/:id', (req, res) => {
    const t = db.threads.find(x => x.id === +req.params.id);
    if (!t) return res.status(404).json({ error: 'Konu bulunamadı.' });
    t.views = (t.views || 0) + 1; save();
    const posts = db.posts.filter(p => p.threadId === t.id).sort((a, b) => a.id - b.id).map((p, i) => {
        const a = userById(p.authorId);
        return {
            id: p.id, content: p.content, createdAt: p.createdAt, editedAt: p.editedAt || null, first: i === 0,
            author: Object.assign(publicUser(a), { postCount: db.posts.filter(x => x.authorId === p.authorId).length, joined: a ? a.createdAt : 0 })
        };
    });
    res.json({ thread: threadSummary(t), category: db.categories.find(c => c.id === t.categoryId), posts });
});

function postCooldown(req, res) {
    if (limited('post:' + req.user.id, 1, 5000)) { res.status(429).json({ error: 'Biraz yavaş! 5 saniye bekle.' }); return true; }
    return false;
}

app.post('/api/forum/threads', needAuth, (req, res) => {
    const cat = db.categories.find(c => c.id === req.body.categoryId);
    if (!cat) return res.status(400).json({ error: 'Kategori seçmelisin.' });
    const title = cleanText(req.body.title, 120), content = cleanText(req.body.content, 5000);
    if (title.length < 5) return res.status(400).json({ error: 'Başlık en az 5 karakter olmalı.' });
    if (content.length < 5) return res.status(400).json({ error: 'Mesaj en az 5 karakter olmalı.' });
    if (!isMod(req.user)) {
        const wait = (req.user.lastThreadAt || 0) + THREAD_COOLDOWN_MS - Date.now();
        if (wait > 0) {
            const total = Math.ceil(wait / 1000);
            return res.status(429).json({ error: `Yeni konu açmak için ${Math.floor(total / 60)} dk ${total % 60} sn beklemelisin (10 dakikada 1 konu).`, retryAfter: total });
        }
    }
    const now = Date.now();
    req.user.lastThreadAt = now;
    const t = { id: newId(), categoryId: cat.id, title, authorId: req.user.id, createdAt: now, lastActivity: now, pinned: false, locked: false, prefix: null, views: 0 };
    db.threads.push(t);
    db.posts.push({ id: newId(), threadId: t.id, authorId: req.user.id, content, createdAt: now });
    save();
    res.json({ success: true, id: t.id });
});

app.post('/api/forum/threads/:id/reply', needAuth, (req, res) => {
    const t = db.threads.find(x => x.id === +req.params.id);
    if (!t) return res.status(404).json({ error: 'Konu bulunamadı.' });
    if (t.locked && !isMod(req.user)) return res.status(403).json({ error: 'Bu konu kilitli.' });
    const content = cleanText(req.body.content, 5000);
    if (content.length < 2) return res.status(400).json({ error: 'Mesaj çok kısa.' });
    if (postCooldown(req, res)) return;
    const p = { id: newId(), threadId: t.id, authorId: req.user.id, content, createdAt: Date.now() };
    db.posts.push(p);
    t.lastActivity = p.createdAt;
    save();
    res.json({ success: true, id: p.id });
});

// sabitle / kilitle / prefix
app.patch('/api/forum/threads/:id', needAuth, needMod, (req, res) => {
    const t = db.threads.find(x => x.id === +req.params.id);
    if (!t) return res.status(404).json({ error: 'Konu bulunamadı.' });
    if (req.body.pinned !== undefined) t.pinned = !!req.body.pinned;
    if (req.body.locked !== undefined) t.locked = !!req.body.locked;
    if (req.body.prefix !== undefined) {
        if (req.body.prefix === null || req.body.prefix === '') t.prefix = null;
        else if (prefixOf(req.body.prefix)) t.prefix = req.body.prefix;
        else return res.status(400).json({ error: 'Geçersiz prefix.' });
    }
    save();
    res.json({ success: true, thread: threadSummary(t) });
});

function removeThread(t) {
    db.posts = db.posts.filter(p => p.threadId !== t.id);
    db.threads = db.threads.filter(x => x.id !== t.id);
}

app.delete('/api/forum/threads/:id', needAuth, needMod, (req, res) => {
    const t = db.threads.find(x => x.id === +req.params.id);
    if (!t) return res.status(404).json({ error: 'Konu bulunamadı.' });
    removeThread(t); save();
    res.json({ success: true });
});

app.patch('/api/forum/posts/:id', needAuth, (req, res) => {
    const p = db.posts.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
    const t = db.threads.find(x => x.id === p.threadId);
    if (p.authorId !== req.user.id && !isMod(req.user)) return res.status(403).json({ error: 'Yetkin yok.' });
    if (t && t.locked && !isMod(req.user)) return res.status(403).json({ error: 'Konu kilitli.' });
    const content = cleanText(req.body.content, 5000);
    if (content.length < 2) return res.status(400).json({ error: 'Mesaj çok kısa.' });
    p.content = content; p.editedAt = Date.now(); save();
    res.json({ success: true });
});

app.delete('/api/forum/posts/:id', needAuth, (req, res) => {
    const p = db.posts.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'Mesaj bulunamadı.' });
    const t = db.threads.find(x => x.id === p.threadId);
    const first = db.posts.filter(x => x.threadId === p.threadId).sort((a, b) => a.id - b.id)[0];
    if (!isMod(req.user) && p.authorId !== req.user.id) return res.status(403).json({ error: 'Yetkin yok.' });
    if (first && first.id === p.id) {
        if (!isMod(req.user)) return res.status(403).json({ error: 'İlk mesajı sadece yetkililer silebilir.' });
        removeThread(t);
    } else db.posts = db.posts.filter(x => x.id !== p.id);
    save();
    res.json({ success: true });
});

// özel prefix ekle (Management+)
app.post('/api/forum/prefixes', needAuth, (req, res) => {
    if (!(req.user.root || levelOf(req.user) >= PERM.BAN_USERS)) return res.status(403).json({ error: 'Yetkin yok.' });
    const name = cleanText(req.body.name, 24);
    const color = String(req.body.color || '');
    if (name.length < 2) return res.status(400).json({ error: 'Prefix adı çok kısa.' });
    if (!/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ error: 'Geçersiz renk.' });
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || ('p' + newId());
    if (prefixOf(id)) return res.status(409).json({ error: 'Bu prefix zaten var.' });
    db.prefixes.push({ id, name, color }); save();
    res.json({ success: true, prefixes: db.prefixes });
});

app.delete('/api/forum/prefixes/:id', needAuth, (req, res) => {
    if (!(req.user.root || levelOf(req.user) >= PERM.BAN_USERS)) return res.status(403).json({ error: 'Yetkin yok.' });
    db.prefixes = db.prefixes.filter(p => p.id !== req.params.id);
    db.threads.forEach(t => { if (t.prefix === req.params.id) t.prefix = null; });
    save();
    res.json({ success: true, prefixes: db.prefixes });
});

/* ------------------------------------------------------------------ */
/*  ADMIN: kullanıcılar / rank / ban                                   */
/* ------------------------------------------------------------------ */
app.get('/api/admin/users', needAuth, (req, res) => {
    if (!(req.user.root || levelOf(req.user) >= PERM.BAN_USERS)) return res.status(403).json({ error: 'Yetkin yok.' });
    const q = cleanText(req.query.q, 20).toLowerCase();
    const list = db.users.filter(u => !q || u.username.toLowerCase().includes(q))
        .sort((a, b) => levelOf(b) - levelOf(a) || a.username.localeCompare(b.username))
        .slice(0, 500)
        .map(u => Object.assign(publicUser(u), { banned: !!u.banned, hasIp: !!u.ipHash, banReason: u.banReason || '', bannedBy: u.bannedBy || '', createdAt: u.createdAt, root: !!u.root }));
    res.json(list);
});

app.get('/api/admin/stats', needAuth, (req, res) => {
    if (!(req.user.root || levelOf(req.user) >= PERM.BAN_USERS)) return res.status(403).json({ error: 'Yetkin yok.' });
    res.json({
        users: db.users.length, staff: db.users.filter(u => levelOf(u) >= PERM.MODERATE).length,
        banned: db.users.filter(u => u.banned).length, threads: db.threads.length, posts: db.posts.length,
        newToday: db.users.filter(u => Date.now() - u.createdAt < 86400000).length,
        ranks: RANKS.map(r => ({ id: r.id, name: r.name, color: r.color, count: db.users.filter(u => u.rank === r.id).length })),
        recent: db.users.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map(u => Object.assign(publicUser(u), { createdAt: u.createdAt }))
    });
});

function canManage(actor, target) {
    if (actor.root) return !target.root || actor.id === target.id;
    if (target.root) return false;
    return levelOf(actor) === 100 ? true : levelOf(actor) > levelOf(target);
}

app.post('/api/admin/users/:id/rank', needAuth, needSiteAdmin, (req, res) => {
    const target = userById(+req.params.id);
    const newRank = RANKS.find(r => r.id === req.body.rank);
    if (!target || !newRank) return res.status(400).json({ error: 'Geçersiz istek.' });
    if (target.root && target.id !== req.user.id) return res.status(403).json({ error: 'Bu hesabın rankı değiştirilemez.' });
    if (target.root) return res.status(403).json({ error: 'Kendi rankını buradan değiştiremezsin.' });
    if (!canManage(req.user, target)) return res.status(403).json({ error: 'Senden yüksek/eşit rankı değiştiremezsin.' });
    if (!req.user.root && levelOf(req.user) < 100 && newRank.level >= levelOf(req.user)) return res.status(403).json({ error: 'Kendi rankından yüksek/eşit rank veremezsin.' });
    target.rank = newRank.id; save();
    res.json({ success: true });
});

// aynı IP'den ikinci hesap açılmasına izin vermek için kullanıcının IP kaydını sil
app.post('/api/admin/users/:id/clear-ip', needAuth, needSiteAdmin, (req, res) => {
    const target = userById(+req.params.id);
    if (!target) return res.status(404).json({ error: 'Kullanıcı yok.' });
    delete target.ipHash; save();
    res.json({ success: true });
});

app.post('/api/admin/users/:id/ban', needAuth, (req, res) => {
    if (!(req.user.root || levelOf(req.user) >= PERM.BAN_USERS)) return res.status(403).json({ error: 'Yetkin yok.' });
    const target = userById(+req.params.id);
    if (!target) return res.status(404).json({ error: 'Kullanıcı yok.' });
    if (target.id === req.user.id || !canManage(req.user, target)) return res.status(403).json({ error: 'Bu kullanıcıyı banlayamazsın.' });
    target.banned = !!req.body.banned;
    target.banReason = target.banned ? cleanText(req.body.reason, 200) : '';
    target.bannedBy = target.banned ? req.user.username : '';
    if (target.banned) for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === target.id) delete db.sessions[k];
    save();
    res.json({ success: true });
});

/* ------------------------------------------------------------------ */
/*  HIGHLIGHTS  (ana sayfa, forumdan bağımsız)                         */
/* ------------------------------------------------------------------ */
app.get('/api/highlights', (req, res) => {
    res.json(db.highlights.slice().sort((a, b) => b.id - a.id).map(h => ({ id: h.id, title: h.title, url: h.url, date: h.date, author: publicUser(userById(h.authorId)) })));
});

app.post('/api/highlights', needAuth, (req, res) => {
    const title = cleanText(req.body.title, 120);
    const id = ytId(req.body.url);
    if (title.length < 3) return res.status(400).json({ error: 'Başlık gerekli.' });
    if (!id) return res.status(400).json({ error: 'Geçerli bir YouTube bağlantısı gir.' });
    if (postCooldown(req, res)) return;
    const h = { id: newId(), title, url: `https://www.youtube.com/embed/${id}`, authorId: req.user.id, date: new Date().toISOString().split('T')[0] };
    db.highlights.push(h); save();
    res.json({ success: true, highlight: h });
});

app.delete('/api/highlights/:id', needAuth, (req, res) => {
    const h = db.highlights.find(x => x.id === +req.params.id);
    if (!h) return res.status(404).json({ error: 'Klip bulunamadı.' });
    if (h.authorId !== req.user.id && !isMod(req.user)) return res.status(403).json({ error: 'Yetkin yok.' });
    db.highlights = db.highlights.filter(x => x.id !== h.id); save();
    res.json({ success: true });
});

/* ------------------------------------------------------------------ */
/*  LEADERBOARD & TURF  (Project Co Leader+)                           */
/* ------------------------------------------------------------------ */
app.get('/api/leaderboard', (req, res) => res.json(db.leaderboard));
app.get('/api/turf', (req, res) => res.json(db.turf));

app.post('/api/leaderboard', needAuth, needSiteAdmin, (req, res) => {
    const list = req.body.newLeaderboard;
    if (!Array.isArray(list) || list.length > 25) return res.status(400).json({ error: 'Geçersiz veri formatı!' });
    db.leaderboard = list.map((p, i) => {
        const kills = Math.max(0, parseInt(p.kills) || 0), deaths = Math.max(0, parseInt(p.deaths) || 0);
        return { rank: i + 1, name: cleanText(p.name, 30), kills, deaths, kd: deaths === 0 ? kills : +(kills / deaths).toFixed(2) };
    }).filter(p => p.name);
    db.leaderboard.forEach((p, i) => p.rank = i + 1);
    save();
    res.json({ success: true, leaderboard: db.leaderboard });
});

app.post('/api/turf', needAuth, needSiteAdmin, (req, res) => {
    const { gangName, leader, territory } = req.body;
    if (gangName) db.turf.gangName = cleanText(gangName, 60);
    if (leader) db.turf.leader = cleanText(leader, 40);
    if (territory) db.turf.territory = cleanText(territory, 120);
    save();
    res.json({ success: true, turfData: db.turf });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Bulunamadı.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Rebel PvP Website running on port ${PORT}`));
