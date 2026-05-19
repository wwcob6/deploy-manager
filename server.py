import http.server
import json
import os
import socket

PORT = int(os.environ.get('PORT', 3000))
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json')
HTML_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'production-deploy-manager.html')

if not os.path.exists(DATA_FILE):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump({'years': [], 'windows': []}, f, ensure_ascii=False, indent=2)

def read_data():
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return {'years': [], 'windows': []}

def write_data(data):
    tmp = DATA_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)

class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')

        if path == '/api/data':
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(read_data(), ensure_ascii=False).encode('utf-8'))
        else:
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            try:
                with open(HTML_FILE, 'rb') as f:
                    self.wfile.write(f.read())
            except:
                pass

    def do_POST(self):
        if self.path == '/api/data':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode('utf-8')
            try:
                write_data(json.loads(body))
                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            except Exception as e:
                self.send_response(400)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'ok': False, 'error': str(e)}).encode('utf-8'))
        else:
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()

    def log_message(self, format, *args):
        print('[%s] %s' % (self.log_date_time_string(), format % args))

def get_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return '127.0.0.1'

if __name__ == '__main__':
    ip = get_ip()
    print('=' * 50)
    print('  投产需求清单管理工具 - 服务端已启动')
    print('=' * 50)
    print()
    print('  本机访问: http://localhost:%d' % PORT)
    print('  局域网访问: http://%s:%d' % (ip, PORT))
    print()
    print('  数据文件: %s' % DATA_FILE)
    print('  按 Ctrl+C 停止')
    print('=' * 50)

    server = http.server.HTTPServer(('0.0.0.0', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止')
        server.server_close()
