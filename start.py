import http.server
import json
import os

PORT = 3000
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json')
HTML_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')

if not os.path.exists(DATA_FILE):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump({'_version': 0, 'years': [], 'windows': []}, f, ensure_ascii=False, indent=2)

def read_all():
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return {'_version': 0, 'years': [], 'windows': []}

def write_all(obj):
    tmp = DATA_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
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
            self.wfile.write(json.dumps(read_all(), ensure_ascii=False).encode('utf-8'))
        else:
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            with open(HTML_FILE, 'rb') as f:
                self.wfile.write(f.read())

    def do_POST(self):
        if self.path == '/api/data':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode('utf-8')
            try:
                incoming = json.loads(body)
                current = read_all()
                if incoming.get('_version') != current.get('_version'):
                    self.send_response(409)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'ok': False, 'conflict': True, 'message': '数据已被他人修改，请刷新页面后重试', 'serverVersion': current.get('_version')}, ensure_ascii=False).encode('utf-8'))
                else:
                    incoming['_version'] = current.get('_version', 0) + 1
                    write_all(incoming)
                    self.send_response(200)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'ok': True, '_version': incoming['_version']}, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'ok': False, 'message': str(e)}).encode('utf-8'))

    def log_message(self, format, *args):
        print('[%s] %s' % (self.log_date_time_string(), format % args))

print('http://localhost:' + str(PORT))
http.server.HTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
