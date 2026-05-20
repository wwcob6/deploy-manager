const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const GIT_CONFIG_FILE = path.join(__dirname, 'git-config.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // 默认密码，启动时可改
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

// session tokens in memory (cleared on restart)
const sessions = {};

if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ _version: 0, years: [], windows: [] }, null, 2));
}
if (!fs.existsSync(GIT_CONFIG_FILE)) {
    fs.writeFileSync(GIT_CONFIG_FILE, JSON.stringify({ provider: 'github', gitlab: { host: '', token: '' }, github: { owner: '', repo: '', token: '' } }, null, 2));
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
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return token && sessions[token];
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
                const { password } = JSON.parse(body);
                if (password === ADMIN_PASSWORD) {
                    const token = crypto.randomBytes(32).toString('hex');
                    sessions[token] = Date.now();
                    return json(res, 200, { ok: true, token });
                }
                json(res, 401, { ok: false, message: '密码错误' });
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
        readBody(req, body => {
            try {
                const incoming = JSON.parse(body);
                const current = readAll();
                if (incoming._version !== current._version) {
                    return json(res, 409, { ok: false, conflict: true, message: '数据已被他人修改，请刷新页面后重试', serverVersion: current._version });
                }
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
