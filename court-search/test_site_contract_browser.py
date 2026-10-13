import unittest
from shutil import which

from playwright.sync_api import sync_playwright

from site_contract import FORM_INSPECTION_JS, inspection_argument


CHROME = which('google-chrome') or which('chromium') or which('chromium-browser')


REDESIGNED_FORM = """
<!doctype html>
<html><head><title>바뀐 사건검색 화면</title></head><body>
  <h1>나의 사건검색</h1>
  <select id="new-court">
    <option>대법원</option><option>서울고등법원</option>
    <option>서울중앙지방법원</option><option>서울동부지방법원</option>
    <option>서울남부지방법원</option><option>서울북부지방법원</option>
    <option>서울서부지방법원</option><option>인천지방법원</option>
    <option>수원지방법원</option><option>부산지방법원</option>
    <option>대전지방법원</option><option>광주지방법원</option>
  </select>
  <select id="new-year"><option>2024</option><option>2025</option><option>2026</option></select>
  <select id="new-type"><option>가단</option><option>가합</option><option>타인</option></select>
  <div>일련번호 <input id="new-serial"></div>
  <div>당사자명 <input id="new-party"></div>
  <div>자동입력 방지문자 <input id="new-answer"></div>
  <img id="new-code-image" alt="자동입력 방지문자" width="120" height="40"
       src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
  <button id="new-submit">검색</button>
</body></html>
"""


@unittest.skipUnless(CHROME, 'system Chrome is unavailable')
class BrowserContractMutationTests(unittest.TestCase):
    def inspect(self, html):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=True,
                executable_path=CHROME,
                args=['--no-sandbox', '--disable-dev-shm-usage'],
            )
            try:
                page = browser.new_page(locale='ko-KR')
                page.set_content(html)
                return page.evaluate(FORM_INSPECTION_JS, inspection_argument())
            finally:
                browser.close()

    def test_semantic_fallback_survives_all_id_changes(self):
        report = self.inspect(REDESIGNED_FORM)

        self.assertTrue(report['formOk'])
        self.assertTrue(report['captchaOk'])
        self.assertEqual(report['missingForm'], [])
        self.assertEqual(report['missingCaptcha'], [])
        self.assertEqual(report['resolved']['court']['id'], 'new-court')
        self.assertEqual(report['resolved']['search']['id'], 'new-submit')

    def test_missing_captcha_is_not_reported_as_network_failure(self):
        html = REDESIGNED_FORM.replace(
            '<div>자동입력 방지문자 <input id="new-answer"></div>', ''
        ).replace(
            '<img id="new-code-image" alt="자동입력 방지문자" width="120" height="40"\n'
            '       src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">',
            '',
        )
        report = self.inspect(html)

        self.assertTrue(report['formOk'])
        self.assertFalse(report['captchaOk'])
        self.assertCountEqual(
            report['missingCaptcha'], ['captcha_input', 'captcha_image']
        )


if __name__ == '__main__':
    unittest.main()
