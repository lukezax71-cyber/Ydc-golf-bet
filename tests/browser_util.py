#!/usr/bin/env python3
"""로컬 서버 + 헤드리스 크로미움 공용 도구."""
import os
import threading
import functools
import http.server
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = '/workspace/.cache/cft/chrome-headless-shell-linux64/chrome-headless-shell'
LIBS = '/workspace/.cache/libs'

MOBILE = {'width': 390, 'height': 844}

# 크로미움 실행에 필요한 공유 라이브러리 경로는 playwright 드라이버가 뜨기 전에 지정해야 한다.
os.environ['LD_LIBRARY_PATH'] = LIBS


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class _Server(socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_server(port=0):
    handler = functools.partial(_Quiet, directory=ROOT)
    httpd = _Server(('127.0.0.1', port), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, 'http://127.0.0.1:%d/' % httpd.server_address[1]


def launch(pw, **kw):
    browser = pw.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
    ctx = browser.new_context(viewport=MOBILE, device_scale_factor=2, locale='ko-KR',
                              timezone_id='Asia/Seoul', **kw)
    try:
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'])
    except Exception:
        pass
    return browser, ctx
