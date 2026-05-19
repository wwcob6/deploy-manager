const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const GIT_CONFIG_FILE = path.join(__dirname, 'git-config.json');

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

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://localhost');

    // GET /api/data
    if (url.pathname === '/api/data' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(readAll()));
    }

    // POST /api/data (带版本号)
    if (url.pathname === '/api/data' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const incoming = JSON.parse(body);
                const current = readAll();
                if (incoming._version !== current._version) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ ok: false, conflict: true, message: '数据已被他人修改，请刷新页面后重试', serverVersion: current._version }));
                }
                incoming._version = current._version + 1;
                writeAll(incoming);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, _version: incoming._version }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, message: e.message }));
            }
        });
        return;
    }

    // GET /api/git — 获取 Git 配置（供前端读取 Token）
    if (url.pathname === '/api/git' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(readGitConfig()));
    }

    // POST /api/git — 保存 Git 配置（管理员配置 Token）
    if (url.pathname === '/api/git' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                writeGitConfig(JSON.parse(body));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, message: e.message }));
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
    Object.values(ifaces).forEach(i => i.forEach(d => {
        if (d.family === 'IPv4' && !d.internal) console.log('http://' + d.address + ':' + PORT);
    }));
});
