"""로컬 HTTP 서버로 진단기를 검증한다. 법원 사이트로 요청을 보내지 않는다."""

import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from connection_probe import probe_browser
from test_site_contract_browser import REDESIGNED_FORM


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        route = self.path.strip('/')
        status = int(route) if route.isdigit() else 200
        html = REDESIGNED_FORM
        if route == 'form-changed':
            html = html.replace('<div>당사자명 <input id="new-party"></div>', '')
        elif route == 'captcha-changed':
            html = html.replace('id="new-answer"', 'type="hidden" id="removed"').replace('alt="자동입력 방지문자"', 'alt="removed"')
        elif route == 'unavailable':
            html = '<h1>Service unavailable</h1>'
        elif route == 'broken-resource':
            html = '<h1>나의 사건검색</h1><script src="/503"></script>'
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        if status == 429:
            self.send_header('Retry-After', '120')
        self.end_headers()
        self.wfile.write(html.encode())


class BrowserProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_real_browser_distinguishes_restrictions_errors_and_structure(self):
        for path, expected in [
            ('healthy', 'HEALTHY'), ('form-changed', 'FORM_CHANGED'),
            ('captcha-changed', 'CAPTCHA_CHANGED'), ('403', 'ACCESS_DENIED'),
            ('429', 'RATE_LIMITED'), ('503', 'SERVER_ERROR'),
            ('unavailable', 'PAGE_UNAVAILABLE'), ('broken-resource', 'PAGE_UNAVAILABLE'),
        ]:
            with self.subTest(path=path):
                report, ok = probe_browser(f'http://127.0.0.1:{self.server.server_port}/{path}', 1)
                self.assertEqual(report['classification'], expected, report)
                self.assertEqual(ok, expected == 'HEALTHY')
                if path == '429':
                    self.assertEqual(report['retry_after'], '120')

    def test_missing_chromium_is_environment_error(self):
        with patch.dict(os.environ, {'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH': '/missing/chrome'}):
            report, ok = probe_browser('http://127.0.0.1/', 1)
        self.assertFalse(ok)
        self.assertEqual(report['classification'], 'BROWSER_ENVIRONMENT_ERROR')


if __name__ == '__main__':
    unittest.main()
