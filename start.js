const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ _version: 0, years: [], windows: [] }, null, 2));
}

function readAll() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
    catch (e) { return { _version: 0, years: [], windows: [] }; }
}

function writeAll(obj) {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://localhost');

    // GET /api/data — 返回完整数据（含 _version）
    if (url.pathname === '/api/data' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(readAll()));
    }

    // POST /api/data — 带版本号保存
    if (url.pathname === '/api/data' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const incoming = JSON.parse(body);
                const current = readAll();

                // 版本冲突检测
                if (incoming._version !== current._version) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        ok: false,
                        conflict: true,
                        message: '数据已被他人修改，请刷新页面后重试',
                        serverVersion: current._version
                    }));
                }

                // 版本一致，递增版本号并保存
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
