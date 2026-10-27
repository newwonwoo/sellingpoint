"""Opt-in observation-only policy. Never reads CAPTCHA payloads or submits forms."""
import asyncio
import os
import re


def enabled():
    return os.environ.get('COURT_FAIL_CLOSED', '').lower() in {'true', '1', 'yes'}


INSPECT = r'''() => {
 const text = document.body ? document.body.innerText : '';
 if (/access denied|forbidden|too many requests|접근.{0,8}(차단|거부|제한)|보안.{0,8}(차단|위반)|비정상.{0,8}접근/i.test(text)) return 'ACCESS_DENIED';
 if (document.querySelector('[id*="captcha" i], [name*="captcha" i], [src*="captcha" i]') || /captcha|자동입력.{0,5}방지|보안문자/i.test(text)) return 'CAPTCHA';
 return 'POLICY_HOLD';
}'''


def stop(state, reason):
    state.setdefault('security_reason', reason)


async def observe(page, url, state, attempts=3, delay=5, timeout=30000):
    """Serialize observations; abort every new request after the first policy signal."""
    lock = state.setdefault('policy_lock', asyncio.Lock())
    async with lock:
        if state.get('security_reason'):
            return state['security_reason']

        async def route(request_route):
            if re.search('captcha', request_route.request.url, re.I):
                stop(state, 'CAPTCHA')
            if state.get('security_reason'):
                await request_route.abort()
            else:
                await request_route.continue_()

        def response(reply):
            if reply.status in (401, 403, 429):
                stop(state, 'RATE_LIMITED' if reply.status == 429 else 'ACCESS_DENIED')

        await page.context.route('**/*', route)
        page.on('response', response)
        try:
            for attempt in range(attempts):
                try:
                    reply = await page.goto(url, wait_until='domcontentloaded', timeout=timeout)
                    if reply is not None:
                        response(reply)
                    if state.get('security_reason'):
                        return state['security_reason']
                    if reply is not None and reply.status >= 500:
                        raise OSError('transient server error')
                    try:
                        reason = await page.evaluate(INSPECT)
                    except Exception:
                        stop(state, 'POLICY_HOLD')
                        return state['security_reason']
                    stop(state, reason if reason in {'CAPTCHA', 'ACCESS_DENIED'} else 'POLICY_HOLD')
                    return state['security_reason']
                except Exception as error:
                    if state.get('security_reason'):
                        return state['security_reason']
                    transient = isinstance(error, (OSError, TimeoutError)) or type(error).__name__ == 'TimeoutError' or 'net::ERR_' in str(error)
                    if not transient:
                        stop(state, 'POLICY_HOLD')
                        return state['security_reason']
                    if attempt + 1 < attempts:
                        await asyncio.sleep(min(30, delay * 2 ** attempt))
            return 'NETWORK_ERROR'
        finally:
            # Keep the route installed until context close: late requests stay blocked.
            pass


async def diagnostic(url, timeout, attempts, delay):
    from playwright.async_api import async_playwright
    state = {}
    async with async_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox']}
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'):
            options['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
        browser = await p.chromium.launch(**options)
        context = await browser.new_context(service_workers='block')
        page = await context.new_page()
        try:
            code = await observe(page, url, state, attempts, delay, int(timeout * 1000))
        finally:
            await browser.close()
    retryable = code == 'NETWORK_ERROR'
    return {'classification': code, 'success': False, 'retryable': retryable,
            'message': '법원 사이트 네트워크 연결 실패' if retryable else '안전정지: ' + code,
            'public_ip': None, 'browser': {'classification': code, 'ok': False}}
