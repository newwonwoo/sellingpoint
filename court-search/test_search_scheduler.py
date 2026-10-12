import asyncio
import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name('search.py')
SPEC = importlib.util.spec_from_file_location('court_search_runtime', MODULE_PATH)
SEARCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SEARCH)


def sample(*, success=True, connection_failure=False, duration=12.0):
    return {
        'success': success,
        'connection_failure': connection_failure,
        'duration': duration,
    }


class FakeLocator:
    def __init__(self, page, kind):
        self.page = page
        self.kind = kind

    @property
    def first(self):
        return self

    async def count(self):
        if self.kind == 'court':
            return int(self.page.form_visible)
        return 1

    async def is_visible(self):
        if self.kind == 'court':
            return self.page.form_visible
        return True

    async def click(self):
        self.page.reload_clicked = True


class FakeFrame:
    def __init__(self, page, can_return=True):
        self.page = page
        self.can_return = can_return

    async def evaluate(self, _script):
        if self.can_return:
            self.page.form_visible = True
        return self.can_return


class FakePage:
    def __init__(self, url='https://ssgo.scourt.go.kr/ssgo/index.on', can_return=True):
        self.url = url
        self.form_visible = False
        self.reload_clicked = False
        self.filled = []
        self.frames = [FakeFrame(self, can_return)]

    def locator(self, selector):
        kind = 'court' if selector == SEARCH.SEL_COURT else 'reload'
        return FakeLocator(self, kind)

    async def wait_for_selector(self, _selector, **_kwargs):
        if not self.form_visible:
            raise TimeoutError('form not visible')

    async def wait_for_timeout(self, _milliseconds):
        return None

    async def fill(self, selector, value):
        self.filled.append((selector, value))


class AdaptiveWorkerTests(unittest.TestCase):
    def test_scale_after_fifteen_fast_stable_cases(self):
        self.assertFalse(SEARCH.adaptive_scale_allowed([sample()] * 14))
        self.assertTrue(SEARCH.adaptive_scale_allowed([sample()] * 15))

    def test_connection_failure_blocks_scale(self):
        samples = [sample()] * 14 + [sample(success=False, connection_failure=True)]
        self.assertFalse(SEARCH.adaptive_scale_allowed(samples))

    def test_two_recent_connection_failures_retire_extra_worker(self):
        samples = [sample()] * 8 + [
            sample(success=False, connection_failure=True),
            sample(success=False, connection_failure=True),
        ]
        self.assertTrue(SEARCH.adaptive_retire_required(samples))

    def test_recording_health_activates_scale_event(self):
        state = {
            'enabled': True,
            'samples': [],
            'scale_event': asyncio.Event(),
            'extra_worker_retired': False,
        }
        for _ in range(15):
            SEARCH.record_adaptive_health(state, {'사건명': '부동산인도명령'}, 12.0)
        self.assertTrue(state['scale_event'].is_set())


class SearchFormReuseTests(unittest.IsolatedAsyncioTestCase):
    async def test_blank_page_uses_normal_site_entry(self):
        page = FakePage(url='about:blank')
        self.assertFalse(await SEARCH.reuse_search_form(page))

    async def test_result_page_returns_to_search_and_refreshes_captcha(self):
        page = FakePage()
        self.assertTrue(await SEARCH.reuse_search_form(page))
        self.assertTrue(page.reload_clicked)
        self.assertIn((SEARCH.SEL_CAPTCHA_INPUT, ''), page.filled)

    async def test_missing_return_button_falls_back_to_normal_entry(self):
        page = FakePage(can_return=False)
        self.assertFalse(await SEARCH.reuse_search_form(page))


if __name__ == '__main__':
    unittest.main()
