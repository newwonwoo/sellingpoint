"""Guard normal searches without processing CAPTCHA or bypassing access denial."""
import asyncio
import inspect
import os
import re

from site_contract import FORM_INSPECTION_JS, inspection_argument


def enabled():
    return os.environ.get('COURT_FAIL_CLOSED', '').lower() in {'true', '1', 'yes'}


INSPECT = r'''() => {
 const text = document.body ? document.body.innerText : '';
 if (/access denied|forbidden|too many requests|접근.{0,8}(차단|거부|제한)|보안.{0,8}(차단|위반)|비정상.{0,8}접근/i.test(text)) return 'ACCESS_DENIED';
 if (document.querySelector('[id*="captcha" i], [name*="captcha" i], [src*="captcha" i], [id$="_ibx_answer"], input[name="answer"]') || /captcha|자동입력.{0,5}방지|보안문자/i.test(text)) return 'CAPTCHA';
 return 'CLEAR';
}'''
SECURITY_CODES = {'CAPTCHA', 'ACCESS_DENIED', 'RATE_LIMITED'}


class PolicyStop(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def stop(state, reason):
    key = 'security_reason' if reason in SECURITY_CODES else 'structure_reason'
    state.setdefault(key, reason)


def stopped(state):
    return state.get('security_reason') or state.get('structure_reason')


def check(state):
    if stopped(state):
        raise PolicyStop(stopped(state))


async def checkpoint(page, state):
    """Read only classification, never an image/payload or page text for logging."""
    check(state)
    try:
        # Includes child frames; a challenge there must not be ignored.
        frames = page.frames
        targets = frames if isinstance(frames, list) and frames else [page]
        for frame in targets:
            code = await frame.evaluate(INSPECT)
            if code in SECURITY_CODES:
                stop(state, code)
                check(state)
            if code != 'CLEAR':
                raise ValueError('unrecognized safety inspection')
    except PolicyStop:
        raise
    except Exception:
        stop(state, 'STRUCTURE_UNKNOWN')
    check(state)


async def install(page, state):
    installed = state.setdefault('guarded_pages', set())
    if id(page) in installed:
        return

    async def route(request_route):
        if re.search('captcha', request_route.request.url, re.I):
            stop(state, 'CAPTCHA')
        if stopped(state):
            await request_route.abort()
        else:
            await request_route.continue_()

    def response(reply):
        if reply.status in (401, 403, 429):
            stop(state, 'RATE_LIMITED' if reply.status == 429 else 'ACCESS_DENIED')

    await page.context.route('**/*', route)
    page.on('response', response)
    installed.add(id(page))


async def form_ready(page, state, timeout=15):
    """Require the normal input contract; CAPTCHA presence is always a stop."""
    deadline = asyncio.get_running_loop().time() + timeout
    argument = inspection_argument()
    argument['requiredCaptcha'] = []
    while True:
        await checkpoint(page, state)
        try:
            report = await page.evaluate(FORM_INSPECTION_JS, argument)
        except Exception:
            stop(state, 'STRUCTURE_UNKNOWN')
            check(state)
        await checkpoint(page, state)
        resolved = report.get('resolved', {})
        if 'captcha_input' in resolved or 'captcha_image' in resolved:
            stop(state, 'CAPTCHA')
            check(state)
        if report.get('formOk'):
            page._court_contract = report
            return 'NORMAL_FORM'
        if asyncio.get_running_loop().time() >= deadline:
            stop(state, 'STRUCTURE_UNKNOWN')
            check(state)
        await asyncio.sleep(0.25)


async def navigate(page, url, state, attempts=3, delay=5, timeout=30000):
    """Only navigation transport failures retry; inspection failures never do."""
    check(state)
    await install(page, state)
    for attempt in range(attempts):
        check(state)
        try:
            reply = await page.goto(url, wait_until='domcontentloaded', timeout=timeout)
            if reply is not None and reply.status in (401, 403, 429):
                stop(state, 'RATE_LIMITED' if reply.status == 429 else 'ACCESS_DENIED')
            check(state)
            if reply is not None and reply.status >= 500:
                raise OSError('transient server error')
        except PolicyStop:
            raise
        except Exception as error:
            check(state)
            transient = isinstance(error, (OSError, TimeoutError)) or type(error).__name__ == 'TimeoutError' or 'net::ERR_' in str(error)
            if not transient:
                stop(state, 'STRUCTURE_UNKNOWN')
                check(state)
            if attempt + 1 < attempts:
                await asyncio.sleep(min(30, delay * 2 ** attempt))
                continue
            return 'NETWORK_ERROR'
        return await form_ready(page, state, min(15, timeout / 1000))


async def observe(page, url, state, attempts=3, delay=5, timeout=30000):
    async with state.setdefault('policy_lock', asyncio.Lock()):
        try:
            return await navigate(page, url, state, attempts, delay, timeout)
        except PolicyStop as error:
            return error.code


class Guarded:
    """Guard each async page/frame/locator operation, including helper fallbacks.

    Sync locator construction is harmless. Async operations get a fresh DOM
    safety check before and after, so broad helper catches cannot perform the
    next operation after a latched stop. Underlying objects never escape via
    frames, locator chains, or first/last properties.
    """
    def __init__(self, target, page, state):
        self._target, self._page, self._state = target, page, state

    def __getattr__(self, name):
        value = getattr(self._target, name)
        if name == 'frames':
            return [Guarded(frame, self._page, self._state) for frame in value]
        if name in {'first', 'last'}:
            return Guarded(value, self._page, self._state)
        if name in {'locator', 'get_by_text', 'get_by_role', 'nth'}:
            return lambda *args, **kwargs: Guarded(value(*args, **kwargs), self._page, self._state)
        if inspect.iscoroutinefunction(value):
            async def guarded(*args, **kwargs):
                await checkpoint(self._page, self._state)
                try:
                    result = await value(*args, **kwargs)
                except Exception:
                    # Give a concurrent block precedence over helper retries.
                    await checkpoint(self._page, self._state)
                    raise
                await checkpoint(self._page, self._state)
                return result
            return guarded
        return value


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
    code = stopped(state) or code
    success, retryable = code == 'NORMAL_FORM', code == 'NETWORK_ERROR'
    message = ('법원 사이트 통신·입력 폼 정상' if success else
               '법원 사이트 네트워크 연결 실패' if retryable else
               '법원 사이트 구조변경 미확인' if code == 'STRUCTURE_UNKNOWN' else
               '안전정지: ' + code)
    return {'classification': code, 'success': success, 'retryable': retryable,
            'message': message, 'public_ip': None,
            'browser': {'classification': code, 'ok': success}}
