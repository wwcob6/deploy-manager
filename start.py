# -*- coding: utf-8 -*-
import http.server
import json
import os
import re
import socket
import sys

if sys.version_info[0] >= 3:
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError
else:
    from urllib2 import Request, urlopen, HTTPError

PORT = int(os.environ.get('PORT', 3000))
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '')
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, 'data.json')
GIT_CONFIG_FILE = os.path.join(BASE_DIR, 'git-config.json')

sessions = {}

if not os.path.exists(DATA_FILE):
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump({'_version': 0, 'years': [], 'windows': []}, f, ensure_ascii=False, indent=2)
if not os.path.exists(GIT_CONFIG_FILE):
    with open(GIT_CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump({'provider': 'github', 'gitlab': {'host': '', 'token': ''}, 'github': {'owner': '', 'repo': '', 'token': ''}}, f, ensure_ascii=False, indent=2)

def read_json(filepath, default=None):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return default if default is not None else {}

def write_json(filepath, obj):
    tmp = filepath + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, filepath)

def sanitize_git_config(cfg):
    github = cfg.get('github') or {}
    gitlab = cfg.get('gitlab') or {}
    return {
        'provider': cfg.get('provider', 'github'),
        'github': {'owner': github.get('owner', ''), 'repo': github.get('repo', ''), 'hasToken': bool(github.get('token'))},
        'gitlab': {'host': gitlab.get('host', ''), 'hasToken': bool(gitlab.get('token'))}
    }

def merge_git_config(incoming, current):
    next_cfg = {
        'provider': incoming.get('provider') or current.get('provider', 'github'),
        'github': dict(current.get('github') or {}, **incoming.get('github', {})),
        'gitlab': dict(current.get('gitlab') or {}, **incoming.get('gitlab', {}))
    }
    if not (incoming.get('github') or {}).get('token'):
        next_cfg['github']['token'] = (current.get('github') or {}).get('token', '')
    if not (incoming.get('gitlab') or {}).get('token'):
        next_cfg['gitlab']['token'] = (current.get('gitlab') or {}).get('token', '')
    return next_cfg

def provider_token(cfg):
    provider = cfg.get('provider', 'github')
    if provider == 'github':
        return (cfg.get('github') or {}).get('token', '')
    else:
        return (cfg.get('gitlab') or {}).get('token', '')

def request_json(url, headers=None):
    req = Request(url, headers=headers or {})
    try:
        resp = urlopen(req)
        return json.loads(resp.read().decode('utf-8'))
    except HTTPError as e:
        body = e.read().decode('utf-8') if e.fp else ''
        err = Exception('HTTP %d: %s' % (e.code, body[:200]))
        err.status = e.code
        raise err

class Handler(http.server.BaseHTTPRequestHandler):
    def send_json(self, code, obj):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length > 10 * 1024 * 1024:
            return None
        return self.rfile.read(length).decode('utf-8')

    def check_admin(self):
        auth = self.headers.get('Authorization', '')
        token = auth[7:] if auth.startswith('Bearer ') else ''
        return token in sessions

    def set_cors(self):
        origin = self.headers.get('origin', '')
        if ALLOWED_ORIGIN and origin == ALLOWED_ORIGIN:
            self.send_header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    def do_OPTIONS(self):
        self.send_response(204)
        self.set_cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        qs = dict(re.findall(r'([^=&]+)=([^&]*)', self.path.split('?')[-1] if '?' in self.path else ''))
        self.send_response(200)
        self.set_cors()

        if path == '/api/data':
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(read_json(DATA_FILE, {'_version': 0, 'years': [], 'windows': []}), ensure_ascii=False).encode('utf-8'))
            return

        if path == '/api/git':
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            cfg = read_json(GIT_CONFIG_FILE, {})
            self.wfile.write(json.dumps(sanitize_git_config(cfg), ensure_ascii=False).encode('utf-8'))
            return

        if path == '/api/repos':
            cfg = read_json(GIT_CONFIG_FILE, {})
            provider = cfg.get('provider', 'github')
            token = provider_token(cfg)
            if not token:
                self.send_json(400, {'ok': False, 'message': '未配置 Token'})
                return
            page = qs.get('page', '1')
            try:
                if provider == 'github':
                    url = 'https://api.github.com/user/repos?per_page=100&page=%s&sort=updated' % page
                    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'deploy-manager'}
                else:
                    host = (cfg.get('gitlab') or {}).get('host', '').rstrip('/')
                    if not host:
                        self.send_json(400, {'ok': False, 'message': '未配置 GitLab 地址'})
                        return
                    url = host + '/api/v4/projects?membership=true&per_page=100&page=' + page
                    headers = {'PRIVATE-TOKEN': token}
                self.send_json(200, request_json(url, headers))
            except Exception as e:
                self.send_json(getattr(e, 'status', 500), {'ok': False, 'message': str(e)})
            return

        if path == '/api/branches':
            cfg = read_json(GIT_CONFIG_FILE, {})
            provider = cfg.get('provider', 'github')
            token = provider_token(cfg)
            repo = qs.get('repo', '')
            if not token:
                self.send_json(400, {'ok': False, 'message': '未配置 Token'})
                return
            if not repo:
                self.send_json(400, {'ok': False, 'message': '缺少仓库参数'})
                return
            try:
                if provider == 'github':
                    parts = repo.split('/')
                    if len(parts) < 2:
                        self.send_json(400, {'ok': False, 'message': '仓库格式错误'})
                        return
                    url = 'https://api.github.com/repos/%s/%s/branches?per_page=100' % (parts[0], parts[1])
                    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'deploy-manager'}
                else:
                    host = (cfg.get('gitlab') or {}).get('host', '').rstrip('/')
                    if not host:
                        self.send_json(400, {'ok': False, 'message': '未配置 GitLab 地址'})
                        return
                    url = host + '/api/v4/projects/' + repo + '/repository/branches?per_page=100'
                    headers = {'PRIVATE-TOKEN': token}
                self.send_json(200, request_json(url, headers))
            except Exception as e:
                self.send_json(getattr(e, 'status', 500), {'ok': False, 'message': str(e)})
            return

        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        with open(os.path.join(BASE_DIR, 'index.html'), 'rb') as f:
            self.wfile.write(f.read())

    def do_POST(self):
        self.set_cors()
        body = self.read_body()
        if body is None:
            self.send_json(413, {'ok': False, 'message': '请求体过大'})
            return

        if self.path == '/api/login':
            try:
                data = json.loads(body)
                if data.get('password') == ADMIN_PASSWORD:
                    token = os.urandom(32).hex()
                    sessions[token] = True
                    self.send_json(200, {'ok': True, 'token': token})
                else:
                    self.send_json(401, {'ok': False, 'message': '密码错误'})
            except Exception as e:
                self.send_json(400, {'ok': False, 'message': str(e)})
            return

        if self.path == '/api/data':
            try:
                incoming = json.loads(body)
                current = read_json(DATA_FILE, {'_version': 0, 'years': [], 'windows': []})
                if incoming.get('_version') != current.get('_version'):
                    self.send_json(409, {'ok': False, 'conflict': True, 'message': '数据已被他人修改，请刷新页面后重试', 'serverVersion': current.get('_version')})
                    return
                incoming['_version'] = current.get('_version', 0) + 1
                write_json(DATA_FILE, incoming)
                self.send_json(200, {'ok': True, '_version': incoming['_version']})
            except Exception as e:
                self.send_json(400, {'ok': False, 'message': str(e)})
            return

        if self.path == '/api/git':
            if not self.check_admin():
                self.send_json(403, {'ok': False, 'message': '需要管理员登录'})
                return
            try:
                incoming = json.loads(body)
                write_json(GIT_CONFIG_FILE, merge_git_config(incoming, read_json(GIT_CONFIG_FILE, {})))
                self.send_json(200, {'ok': True})
            except Exception as e:
                self.send_json(400, {'ok': False, 'message': str(e)})
            return

        self.send_response(200)
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
    print('  投产需求清单管理工具')
    print('=' * 50)
    print('  http://localhost:%d' % PORT)
    print('  http://%s:%d' % (ip, PORT))
    print('  Admin password: %s' % ADMIN_PASSWORD)
    print('  Ctrl+C 停止')
    print('=' * 50)
    httpd = http.server.HTTPServer(('0.0.0.0', PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
        httpd.server_close()
