const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ years: [], windows: [] }, null, 2), 'utf-8');
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return { years: [], windows: [] };
  }
}

function writeData(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readData()));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/data') {
    let body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      try {
        writeData(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'production-deploy-manager.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading page');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, function() {
  var os = require('os');
  var ifaces = os.networkInterfaces();
  console.log('========================================');
  console.log('  投产需求清单管理工具 - 服务端');
  console.log('========================================');
  console.log('');
  console.log('  本机: http://localhost:' + PORT);
  console.log('  局域网:');
  Object.keys(ifaces).forEach(function(name) {
    ifaces[name].forEach(function(iface) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log('    http://' + iface.address + ':' + PORT);
      }
    });
  });
  console.log('');
  console.log('  数据文件: ' + DATA_FILE);
  console.log('  Ctrl+C 停止');
  console.log('========================================');
});
