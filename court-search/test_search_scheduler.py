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
if __name__ == '__main__':
    unittest.main()
