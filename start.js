const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const GIT_CONFIG_FILE = path.join(__dirname, 'git-config.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // 默认密码，启动时可改

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

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function checkAdmin(req) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return token && sessions[token];
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://localhost');

    // POST /api/login
    if (url.pathname === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
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
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
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
        // 普通用户看到的是去掉 token 的配置（token 不暴露给前端列表）
        return json(res, 200, cfg);
    }

    // POST /api/git — 保存 Git 配置（仅管理员）
    if (url.pathname === '/api/git' && req.method === 'POST') {
        if (!checkAdmin(req)) { return json(res, 403, { ok: false, message: '需要管理员登录' }); }
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                writeGitConfig(JSON.parse(body));
                json(res, 200, { ok: true });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
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
