"""
신규 나의사건검색(ssgo.scourt.go.kr) 구조 진단 — 임시 스크립트 (확인 후 삭제)

옛 주소(safind.scourt.go.kr)가 사라졌으므로, 새 주소에서 다음을 로그로 남긴다.
  1) 접속이 되는지 (GitHub 서버 = 해외 IP 에서도 되는지)
  2) 입력 폼 · 캡차(이미지/canvas)가 화면에 어떻게 있는지
  3) 화면이 어떤 서버 주소를 호출하는지
읽기만 하며 아무것도 입력하거나 제출하지 않는다.
"""
import json
import os

from playwright.sync_api import sync_playwright

URL = os.environ.get('PROBE_URL', 'https://ssgo.scourt.go.kr/ssgo/index.on?cortId=www')
UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
)

# 각 프레임(iframe 포함) 안에서 실행해 폼/캡차 후보 요소를 요약한다.
COLLECT_JS = r"""() => {
  const brief = (e) => ({
    tag: e.tagName.toLowerCase(),
    id: e.id || null,
    name: e.getAttribute('name'),
    type: e.getAttribute('type'),
    cls: e.className && e.className.toString ? e.className.toString().slice(0, 60) : null,
    title: e.getAttribute('title'),
    placeholder: e.getAttribute('placeholder'),
    alt: e.getAttribute('alt'),
    src: (e.getAttribute('src') || '').slice(0, 120) || null,
    text: (e.innerText || e.value || '').trim().slice(0, 40),
    visible: !!(e.offsetWidth || e.offsetHeight),
    size: e.width && e.height ? e.width + 'x' + e.height : null,
  });
  const pick = (sel, n) => [...document.querySelectorAll(sel)].slice(0, n).map(brief);
  return {
    title: document.title,
    inputs: pick('input, select, textarea', 60),
    buttons: pick('button, [role=button]', 40),
    imgs: pick('img, canvas', 40),
    iframes: pick('iframe', 10),
    bodyText: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 1000) : '',
  };
}"""


def main():
    out = {'url': URL, 'requests': [], 'console_errors': [], 'failed_requests': []}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage'],
            executable_path=os.environ.get('PROBE_CHROMIUM') or None,  # 로컬 테스트용, 기본은 Playwright 기본 경로
        )
        ctx = browser.new_context(locale='ko-KR', user_agent=UA, viewport={'width': 1280, 'height': 900})
        page = ctx.new_page()

        def on_request(r):
            if r.resource_type in ('document', 'xhr', 'fetch', 'script') and len(out['requests']) < 80:
                out['requests'].append(f'{r.method} {r.resource_type} {r.url[:160]}')

        def on_console(m):
            if m.type == 'error' and len(out['console_errors']) < 15:
                out['console_errors'].append(m.text[:160])

        def on_failed(r):
            if len(out['failed_requests']) < 20:
                out['failed_requests'].append(f'{r.url[:140]} :: {r.failure}')

        page.on('request', on_request)
        page.on('console', on_console)
        page.on('requestfailed', on_failed)

        try:
            resp = page.goto(URL, wait_until='domcontentloaded', timeout=45000)
            out['status'] = resp.status if resp else None
        except Exception as e:  # 접속 실패도 진단 결과이므로 기록하고 계속 진행
            out['goto_error'] = f'{type(e).__name__}: {str(e)[:300]}'

        try:
            page.wait_for_load_state('networkidle', timeout=20000)
        except Exception:
            out['networkidle'] = 'not reached (계속 통신 중이거나 느림)'
        page.wait_for_timeout(3000)  # JS 렌더링 여유

        out['final_url'] = page.url
        out['frames'] = []
        for fr in page.frames:
            try:
                data = fr.evaluate(COLLECT_JS)
            except Exception as e:
                data = {'error': f'{type(e).__name__}: {str(e)[:120]}'}
            out['frames'].append({'url': fr.url[:160], **data})

        browser.close()

    print('=====PROBE_RESULT_BEGIN=====')
    print(json.dumps(out, ensure_ascii=False, indent=1)[:40000])
    print('=====PROBE_RESULT_END=====')


if __name__ == '__main__':
    main()
