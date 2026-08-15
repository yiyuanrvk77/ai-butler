# AI 管家本地服务器：提供网页 + 转发模型接口（绕开浏览器跨域限制）
import json
import os
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8000
DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def do_POST(self):
        if self.path.rstrip('/') != '/api/chat':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            url = body.get('baseUrl', '').rstrip('/') + '/chat/completions'
            payload = {
                'model': body.get('model', ''),
                'messages': body.get('messages', []),
                'temperature': 0.8,
            }
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + body.get('key', ''),
                },
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                out = json.loads(r.read().decode('utf-8'))
            self._json({'content': out['choices'][0]['message']['content']})
        except urllib.error.HTTPError as e:
            self._json({'error': '模型接口返回 HTTP ' + str(e.code)}, 502)
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def main():
    os.chdir(DIR)
    port = PORT
    while True:
        try:
            srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            port += 1
    print('AI 管家已启动：http://127.0.0.1:%d' % port)
    webbrowser.open('http://127.0.0.1:%d' % port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
