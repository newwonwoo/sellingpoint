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


class ConnectionCircuitTests(unittest.IsolatedAsyncioTestCase):
    def circuit(self):
        return {
            'failed_sessions': set(),
            'required_failed_sessions': 3,
            'event': asyncio.Event(),
            # 단위 테스트에서는 외부 DNS/HTTP 진단을 실행하지 않는다.
            'diagnosed': True,
        }

    async def test_retries_from_one_session_do_not_stop_batch(self):
        circuit = self.circuit()
        page = object()
        for _ in range(4):
            await SEARCH.mark_session_connection_failure(
                page, circuit, {'worker_id': 1}
            )
        self.assertEqual(circuit['failed_sessions'], {1})
        self.assertFalse(circuit['event'].is_set())

    async def test_three_distinct_failed_sessions_stop_batch(self):
        circuit = self.circuit()
        page = object()
        for worker_id in (1, 2, 3):
            await SEARCH.mark_session_connection_failure(
                page, circuit, {'worker_id': worker_id}
            )
        self.assertEqual(circuit['failed_sessions'], {1, 2, 3})
        self.assertTrue(circuit['event'].is_set())


class StructureCircuitTests(unittest.TestCase):
    def test_same_case_does_not_open_structure_circuit_twice(self):
        circuit = {}
        SEARCH.register_shared_failure(
            circuit, 'failures', 'event', '2026타인3944', 2
        )
        count, opened = SEARCH.register_shared_failure(
            circuit, 'failures', 'event', '2026타인3944', 2
        )

        self.assertEqual(count, 1)
        self.assertFalse(opened)
        self.assertFalse(circuit['event'].is_set())

    def test_two_distinct_cases_open_structure_circuit(self):
        circuit = {}
        SEARCH.register_shared_failure(
            circuit, 'failures', 'event', '2026타인3944', 2
        )
        count, opened = SEARCH.register_shared_failure(
            circuit, 'failures', 'event', '2026타인3273', 2
        )

        self.assertEqual(count, 2)
        self.assertTrue(opened)
        self.assertTrue(circuit['event'].is_set())


if __name__ == '__main__':
    unittest.main()
