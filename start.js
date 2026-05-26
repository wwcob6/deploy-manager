const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const GIT_CONFIG_FILE = path.join(__dirname, 'git-config.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // 默认密码，启动时可改
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const ROLES = {
    admin: '管理员',
    config: '配置人员',
    developer: '普通开发人员'
};

// session tokens in memory (cleared on restart)
const sessions = {};

if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ _version: 0, years: [], windows: [] }, null, 2));
}
if (!fs.existsSync(GIT_CONFIG_FILE)) {
    fs.writeFileSync(GIT_CONFIG_FILE, JSON.stringify({ provider: 'github', gitlab: { host: '', token: '' }, github: { owner: '', repo: '', token: '' } }, null, 2));
}
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({
        users: [createUserRecord({ username: 'admin', name: '管理员', role: 'admin', password: ADMIN_PASSWORD })]
    }, null, 2));
}

function readAll() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
    catch (e) { return { _version: 0, years: [], windows: [] }; }
}
function writeAll(obj) {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
function readGitConfig() {
    try { return JSON.parse(fs.readFileSync(GIT_CONFIG_FILE, 'utf-8')); }
    catch (e) { return {}; }
}
function writeGitConfig(obj) {
    fs.writeFileSync(GIT_CONFIG_FILE + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(GIT_CONFIG_FILE + '.tmp', GIT_CONFIG_FILE);
}
function readUsers() {
    try {
        const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
        return { users: Array.isArray(raw.users) ? raw.users : [] };
    } catch (e) {
        return { users: [] };
    }
}
function writeUsers(obj) {
    fs.writeFileSync(USERS_FILE + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(USERS_FILE + '.tmp', USERS_FILE);
}
function userId() {
    return 'u_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}
function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(String(salt) + ':' + String(password)).digest('hex');
}
function setUserPassword(user, password) {
    const salt = crypto.randomBytes(16).toString('hex');
    user.salt = salt;
    user.passwordHash = hashPassword(password || '', salt);
    user.passwordPlain = String(password || '');
    return user;
}
function createUserRecord(input) {
    const user = {
        id: input.id || userId(),
        username: String(input.username || '').trim(),
        name: String(input.name || input.username || '').trim(),
        role: ROLES[input.role] ? input.role : 'developer',
        disabled: Boolean(input.disabled)
    };
    return setUserPassword(user, input.password || '');
}
function sanitizeUser(user, includePassword) {
    const result = {
        id: user.id,
        username: user.username,
        name: user.name || user.username,
        role: ROLES[user.role] ? user.role : 'developer',
        roleLabel: ROLES[ROLES[user.role] ? user.role : 'developer'],
        disabled: Boolean(user.disabled)
    };
    if (includePassword) {
        result.passwordText = user.passwordPlain || '';
        result.passwordReadable = Boolean(user.passwordPlain);
    }
    return result;
}
function verifyPassword(user, password) {
    if (!user || user.disabled) return false;
    return user.passwordHash === hashPassword(password || '', user.salt || '');
}
function getSession(req) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return token && sessions[token] ? sessions[token] : null;
}

function sanitizeGitConfig(cfg) {
    const github = cfg.github || {};
    const gitlab = cfg.gitlab || {};
    return {
        provider: cfg.provider || 'github',
        github: {
            owner: github.owner || '',
            repo: github.repo || '',
            hasToken: Boolean(github.token)
        },
        gitlab: {
            host: gitlab.host || '',
            hasToken: Boolean(gitlab.token)
        }
    };
}

function mergeGitConfig(incoming, current) {
    const next = {
        provider: incoming.provider || current.provider || 'github',
        github: Object.assign({}, current.github || {}, incoming.github || {}),
        gitlab: Object.assign({}, current.gitlab || {}, incoming.gitlab || {})
    };
    if (!incoming.github || !incoming.github.token) next.github.token = (current.github || {}).token || '';
    if (!incoming.gitlab || !incoming.gitlab.token) next.gitlab.token = (current.gitlab || {}).token || '';
    return next;
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function checkAdmin(req) {
    const session = getSession(req);
    return session && session.role === 'admin';
}
function issueSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const sessionUser = sanitizeUser(user);
    sessions[token] = Object.assign({ issuedAt: Date.now() }, sessionUser);
    return { token, user: sessionUser };
}
function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function developerComparableData(obj) {
    const clone = JSON.parse(JSON.stringify(obj || {}));
    delete clone._version;
    (clone.windows || []).forEach(win => {
        (win.requirements || []).forEach(req => {
            req.modules = '__editable_by_developer__';
            req.sqlFiles = '__editable_by_developer__';
            req.apis = '__editable_by_developer__';
        });
    });
    return clone;
}
function canWriteData(role, current, incoming) {
    if (role === 'admin' || role === 'config') return { ok: true };
    if (role !== 'developer') return { ok: false, message: '当前用户没有保存权限' };
    if (deepEqual(developerComparableData(current), developerComparableData(incoming))) return { ok: true };
    return { ok: false, message: '普通开发人员只能编辑代码模块、数据库清单和 API' };
}
function adminCount(users) {
    return users.filter(u => u.role === 'admin' && !u.disabled).length;
}

function readBody(req, cb) {
    let body = '';
    req.on('data', c => {
        body += c;
        if (body.length > 1024 * 1024 * 10) req.destroy();
    });
    req.on('end', () => cb(body));
}

function providerToken(cfg) {
    const provider = cfg.provider || 'github';
    return provider === 'github'
        ? ((cfg.github || {}).token || '')
        : ((cfg.gitlab || {}).token || '');
}

function requestJson(url, headers, cb) {
    var mod = url.startsWith('https') ? https : http;
    var req = mod.get(url, { headers: headers }, function(res) {
        var body = '';
        res.on('data', function(c) { body += c; });
        res.on('end', function() {
            var data = null;
            try { data = body ? JSON.parse(body) : null; } catch (e) {}
            if (res.statusCode < 200 || res.statusCode >= 300) {
                var err = new Error('HTTP ' + res.statusCode);
                err.status = res.statusCode;
                err.body = data;
                return cb(err);
            }
            cb(null, data);
        });
    });
    req.on('error', cb);
    req.setTimeout(15000, function() { req.destroy(); cb(new Error('请求超时')); });
}

const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://localhost');

    // POST /api/login
    if (url.pathname === '/api/login' && req.method === 'POST') {
        readBody(req, body => {
            try {
                const { username, password } = JSON.parse(body);
                const users = readUsers().users;
                const loginName = String(username || 'admin').trim();
                const user = users.find(u => u.username === loginName);
                if (verifyPassword(user, password)) {
                    return json(res, 200, Object.assign({ ok: true }, issueSession(user)));
                }
                if (loginName === 'admin' && password === ADMIN_PASSWORD) {
                    return json(res, 200, Object.assign({ ok: true }, issueSession({ id: 'env_admin', username: 'admin', name: '管理员', role: 'admin' })));
                }
                json(res, 401, { ok: false, message: '用户名或密码错误' });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/me
    if (url.pathname === '/api/me' && req.method === 'GET') {
        const session = getSession(req);
        if (!session) return json(res, 401, { ok: false, message: '未登录' });
        return json(res, 200, { ok: true, user: sanitizeUser(session) });
    }

    // POST /api/me/password — 当前用户修改自己的密码
    if (url.pathname === '/api/me/password' && req.method === 'POST') {
        const session = getSession(req);
        if (!session) return json(res, 401, { ok: false, message: '未登录' });
        readBody(req, body => {
            try {
                const payload = JSON.parse(body);
                const oldPassword = String(payload.oldPassword || '');
                const newPassword = String(payload.newPassword || '');
                if (!oldPassword || !newPassword) return json(res, 400, { ok: false, message: '请填写原密码和新密码' });
                const store = readUsers();
                const users = store.users;
                const idx = users.findIndex(u => u.id === session.id || u.username === session.username);
                if (idx < 0) return json(res, 404, { ok: false, message: '当前用户不存在，请重新登录' });
                if (!verifyPassword(users[idx], oldPassword)) return json(res, 400, { ok: false, message: '原密码错误' });
                setUserPassword(users[idx], newPassword);
                writeUsers(store);
                return json(res, 200, { ok: true });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/users — 仅管理员
    if (url.pathname === '/api/users' && req.method === 'GET') {
        if (!checkAdmin(req)) return json(res, 403, { ok: false, message: '需要管理员权限' });
        return json(res, 200, { ok: true, users: readUsers().users.map(u => sanitizeUser(u, true)), roles: ROLES });
    }

    // POST /api/users — 仅管理员
    if (url.pathname === '/api/users' && req.method === 'POST') {
        const session = getSession(req);
        if (!session || session.role !== 'admin') return json(res, 403, { ok: false, message: '需要管理员权限' });
        readBody(req, body => {
            try {
                const payload = JSON.parse(body);
                const store = readUsers();
                const users = store.users;
                if (payload.action === 'delete') {
                    const id = String(payload.id || '');
                    const target = users.find(u => u.id === id);
                    if (!target) return json(res, 404, { ok: false, message: '用户不存在' });
                    if (target.id === session.id) return json(res, 400, { ok: false, message: '不能删除当前登录用户' });
                    if (target.role === 'admin' && adminCount(users) <= 1) return json(res, 400, { ok: false, message: '至少保留一个管理员' });
                    store.users = users.filter(u => u.id !== id);
                    writeUsers(store);
                    return json(res, 200, { ok: true, users: store.users.map(u => sanitizeUser(u, true)) });
                }

                const input = payload.user || {};
                const username = String(input.username || '').trim();
                const name = String(input.name || username).trim();
                const role = ROLES[input.role] ? input.role : '';
                if (!username) return json(res, 400, { ok: false, message: '请填写用户名' });
                if (!role) return json(res, 400, { ok: false, message: '请选择有效角色' });

                if (input.id) {
                    const idx = users.findIndex(u => u.id === input.id);
                    if (idx < 0) return json(res, 404, { ok: false, message: '用户不存在' });
                    if (users.some(u => u.id !== input.id && u.username === username)) return json(res, 400, { ok: false, message: '用户名已存在' });
                    const next = Object.assign({}, users[idx], { username, name, role, disabled: Boolean(input.disabled) });
                    if (users[idx].role === 'admin' && role !== 'admin' && adminCount(users) <= 1) return json(res, 400, { ok: false, message: '至少保留一个管理员' });
                    if (users[idx].role === 'admin' && next.disabled && adminCount(users) <= 1) return json(res, 400, { ok: false, message: '至少保留一个管理员' });
                    if (input.password) {
                        setUserPassword(next, input.password);
                    }
                    users[idx] = next;
                } else {
                    if (users.some(u => u.username === username)) return json(res, 400, { ok: false, message: '用户名已存在' });
                    if (!input.password) return json(res, 400, { ok: false, message: '新用户必须设置密码' });
                    users.push(createUserRecord({ username, name, role, password: input.password, disabled: Boolean(input.disabled) }));
                }

                writeUsers(store);
                return json(res, 200, { ok: true, users: store.users.map(u => sanitizeUser(u, true)) });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/data
    if (url.pathname === '/api/data' && req.method === 'GET') {
        return json(res, 200, readAll());
    }

    // POST /api/data
    if (url.pathname === '/api/data' && req.method === 'POST') {
        const session = getSession(req);
        if (!session) return json(res, 401, { ok: false, message: '请先登录' });
        readBody(req, body => {
            try {
                const incoming = JSON.parse(body);
                const current = readAll();
                if (incoming._version !== current._version) {
                    return json(res, 409, { ok: false, conflict: true, message: '数据已被他人修改，请刷新页面后重试', serverVersion: current._version });
                }
                const permission = canWriteData(session.role, current, incoming);
                if (!permission.ok) return json(res, 403, { ok: false, message: permission.message });
                incoming._version = current._version + 1;
                writeAll(incoming);
                json(res, 200, { ok: true, _version: incoming._version });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/git — 获取 Git 配置（所有用户可读）
    if (url.pathname === '/api/git' && req.method === 'GET') {
        const cfg = readGitConfig();
        return json(res, 200, sanitizeGitConfig(cfg));
    }

    // POST /api/git — 保存 Git 配置（仅管理员）
    if (url.pathname === '/api/git' && req.method === 'POST') {
        if (!checkAdmin(req)) { return json(res, 403, { ok: false, message: '需要管理员登录' }); }
        readBody(req, body => {
            try {
                const incoming = JSON.parse(body);
                writeGitConfig(mergeGitConfig(incoming, readGitConfig()));
                json(res, 200, { ok: true });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/repos — 使用服务端 Token 获取项目列表，避免 Token 暴露到浏览器
    if (url.pathname === '/api/repos' && req.method === 'GET') {
        const cfg = readGitConfig();
        const provider = cfg.provider || 'github';
        const token = providerToken(cfg);
        if (!token) return json(res, 400, { ok: false, message: '未配置 Token' });

        if (provider === 'github') {
            const page = url.searchParams.get('page') || '1';
            const api = 'https://api.github.com/user/repos?per_page=100&page=' + encodeURIComponent(page) + '&sort=updated';
            requestJson(api, {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'deploy-manager'
            }, (err, data) => err ? json(res, err.status || 500, { ok: false, message: err.message }) : json(res, 200, data));
            return;
        }

        const host = ((cfg.gitlab || {}).host || '').replace(/\/+$/, '');
        if (!host) return json(res, 400, { ok: false, message: '未配置 GitLab 地址' });
        const page = url.searchParams.get('page') || '1';
        requestJson(host + '/api/v4/projects?membership=true&per_page=100&page=' + encodeURIComponent(page), {
            'PRIVATE-TOKEN': token
        }, (err, data) => err ? json(res, err.status || 500, { ok: false, message: err.message }) : json(res, 200, data));
        return;
    }

    // GET /api/branches?repo=owner/repo|projectId
    if (url.pathname === '/api/branches' && req.method === 'GET') {
        const cfg = readGitConfig();
        const provider = cfg.provider || 'github';
        const token = providerToken(cfg);
        const repo = url.searchParams.get('repo') || '';
        if (!token) return json(res, 400, { ok: false, message: '未配置 Token' });
        if (!repo) return json(res, 400, { ok: false, message: '缺少仓库参数' });

        if (provider === 'github') {
            const parts = repo.split('/');
            if (!parts[0] || !parts[1]) return json(res, 400, { ok: false, message: '仓库格式错误' });
            const api = 'https://api.github.com/repos/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]) + '/branches?per_page=100';
            requestJson(api, {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'deploy-manager'
            }, (err, data) => err ? json(res, err.status || 500, { ok: false, message: err.message }) : json(res, 200, data));
            return;
        }

        const host = ((cfg.gitlab || {}).host || '').replace(/\/+$/, '');
        if (!host) return json(res, 400, { ok: false, message: '未配置 GitLab 地址' });
        requestJson(host + '/api/v4/projects/' + encodeURIComponent(repo) + '/repository/branches?per_page=100', {
            'PRIVATE-TOKEN': token
        }, (err, data) => err ? json(res, err.status || 500, { ok: false, message: err.message }) : json(res, 200, data));
        return;
    }

    // 静态文件
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
});

server.listen(PORT, () => {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    console.log('http://localhost:' + PORT);
    console.log('Admin password: ' + ADMIN_PASSWORD);
    Object.values(ifaces).forEach(i => i.forEach(d => {
        if (d.family === 'IPv4' && !d.internal) console.log('http://' + d.address + ':' + PORT);
    }));
});
