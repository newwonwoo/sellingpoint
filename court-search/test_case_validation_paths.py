"""실제 배치 스케줄러·차단기·저장 경로를 임시 파일과 mock으로 검증."""
import asyncio
from collections import Counter
from contextlib import ExitStack, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import openpyxl
from test_search_scheduler import SEARCH


class BatchPathTests(unittest.IsolatedAsyncioTestCase):
    async def run_scenario(self, values, lookup, *, rescue=False):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            root = Path(tmp)
            source, output = root / 'input.json', root / 'output.json'
            source.write_text(json.dumps([{'court': '서울남부지방법원', 'case_no': v} for v in values]))
            page = MagicMock()
            context = MagicMock(new_page=AsyncMock(return_value=page))
            browser = MagicMock(new_context=AsyncMock(return_value=context), close=AsyncMock())
            playwright = MagicMock()
            playwright.chromium.launch = AsyncMock(return_value=browser)
            manager = MagicMock(__aenter__=AsyncMock(return_value=playwright), __aexit__=AsyncMock())

            async def offline_upload(publisher):
                while True:
                    item = await publisher.queue.get()
                    publisher.queue.task_done()
                    if item is None:
                        return

            env = {'COURT_WORKERS': '1', 'COURT_MAX_WORKERS': '2' if rescue else '1',
                   'COURT_PARTIAL_DIR': str(root / 'partial'),
                   'COURT_ARTIFACT_QUEUE_DIR': str(root / 'queue'), 'COURT_PARTIAL_SIZE': '2'}
            stack.enter_context(patch.dict(os.environ, env, clear=True))
            stack.enter_context(patch.object(SEARCH.sys, 'argv', ['search.py', str(source), str(output)]))
            stack.enter_context(patch.object(SEARCH, 'async_playwright', return_value=manager))
            stack.enter_context(patch.object(SEARCH, 'search_one', side_effect=lookup))
            stack.enter_context(patch.object(SEARCH, 'load_success_dataset', return_value={'loaded': 0, 'skipped': 0}))
            stack.enter_context(patch.object(SEARCH, 'FAST_CAPTCHA_PATH', False))
            stack.enter_context(patch.object(SEARCH, 'IMMEDIATE_RETRY_WORKER', rescue))
            stack.enter_context(patch.object(SEARCH.PartialResultPublisher, '_upload_worker', offline_upload))
            stack.enter_context(patch('socket.socket.connect', side_effect=AssertionError('network forbidden')))
            stack.enter_context(redirect_stdout(io.StringIO()))
            await SEARCH.main()
            rows = json.loads(output.read_text())['results']
            self.assertEqual([r['사건번호'] for r in rows], values)
            # 최신 revision의 각 구간이 최종 결과와 같은 순서/오류를 보존한다.
            chunks = {}
            for path in (root / 'partial').glob('*.xlsx'):
                key = path.stem.removesuffix('-r1')
                if key not in chunks or path.stem.endswith('-r1'):
                    chunks[key] = path
            partials = []
            for key in sorted(chunks):
                wb = openpyxl.load_workbook(chunks[key])
                partials.extend([(r[1], r[2]) for r in list(wb.active.values)[1:]])
                wb.close()
            self.assertEqual(partials, [(r['사건번호'], r['사건명']) for r in rows])
            return rows

    async def check_retry_path(self, rescue):
        calls = Counter()
        async def lookup(page, court, case_no, *args):
            calls[case_no] += 1
            await asyncio.sleep(0)  # 구조대와 일반 워커가 실제로 교차 실행되게 한다.
            if case_no in ('2026타인1', '2026타인2'):
                if calls[case_no] == 1:
                    return {'법원': court, '사건번호': case_no, '사건명': '조회실패: 캡차 오류'}
                if case_no == '2026타인1':
                    raise RuntimeError('retry row failed')
            return {'법원': court, '사건번호': case_no, '사건명': '정상'}
        rows = await self.run_scenario(['2026타인1', '202타인4330', '2026타인2', '2026타인3'], lookup, rescue=rescue)
        self.assertEqual(calls, {'2026타인1': 2, '2026타인2': 2, '2026타인3': 1})
        self.assertTrue(rows[0]['사건명'].startswith('조회오류: RuntimeError'))
        self.assertTrue(rows[1]['사건명'].startswith('입력오류'))
        self.assertEqual([r['사건명'] for r in rows[2:]], ['정상', '정상'])

    async def test_end_of_batch_retry_continues_after_exception(self):
        await self.check_retry_path(rescue=False)

    async def test_rescue_worker_continues_after_exception(self):
        await self.check_retry_path(rescue=True)

    async def test_circuits_stop_new_queries_preserve_invalid_and_defer_remaining(self):
        for event, reason in [('event', '법원 사이트 접속 불가'), ('structure_event', '법원 사이트 구조변경 감지')]:
            with self.subTest(event=event):
                calls = []
                async def lookup(page, court, case_no, party, prepare, executor, circuit, state):
                    calls.append(case_no)
                    circuit[event].set()
                    return {'법원': court, '사건번호': case_no, '사건명': f'조회실패: {reason}'}
                rows = await self.run_scenario(['2026타인1', '202타인4330', '2026타인2'], lookup)
                self.assertEqual(calls, ['2026타인1'])
                self.assertTrue(rows[1]['사건명'].startswith('입력오류'))
                self.assertEqual(rows[2]['사건명'], f'조회보류: {reason}')


class ExceptionPolicyTests(unittest.IsolatedAsyncioTestCase):
    def circuit(self):
        return {'failed_sessions': set(), 'required_failed_sessions': 1,
                'event': asyncio.Event(), 'diagnosed': True}

    async def test_real_search_structure_exception_opens_existing_circuit(self):
        circuit = self.circuit()
        page = MagicMock(goto=AsyncMock())
        error = SEARCH.SiteContractChanged('FORM_CHANGED', {'missingForm': ['court']})
        with patch.object(SEARCH, 'REUSE_SEARCH_SESSION', False), \
             patch.object(SEARCH, 'ensure_site_contract', side_effect=error), \
             patch.object(SEARCH, 'save_contract_debug', new_callable=AsyncMock), \
             patch('socket.socket.connect', side_effect=AssertionError('network forbidden')):
            for value in ('2026타인1', '2026타인2'):
                row = await SEARCH.search_case_safely(page, {'row': 2, 'court': '서울남부지방법원', 'case_no': value, 'party_name': '주택'}, False, None, circuit, {})
                self.assertEqual(row['사건명'], '조회실패: 법원 사이트 입력 화면 구조변경 감지')
        self.assertTrue(circuit['structure_event'].is_set())
        self.assertEqual(len(circuit['structure_failures']), 2)

    async def test_real_search_connection_timeouts_open_existing_circuit(self):
        circuit = self.circuit()
        page = MagicMock(goto=AsyncMock(side_effect=SEARCH.PlaywrightTimeout('mock timeout')))
        with patch.object(SEARCH, 'REUSE_SEARCH_SESSION', False), \
             patch.object(SEARCH, 'settle_failed_navigation', new_callable=AsyncMock), \
             patch('socket.socket.connect', side_effect=AssertionError('network forbidden')):
            row = await SEARCH.search_case_safely(page, {'row': 2, 'court': '서울남부지방법원', 'case_no': '2026타인1', 'party_name': '주택'}, False, None, circuit, {'worker_id': 1})
        self.assertTrue(circuit['event'].is_set())
        self.assertEqual(page.goto.await_count, SEARCH.MAX_CONNECTION_RETRY)
        self.assertEqual(row['사건명'], '조회실패: 법원 사이트 연결 실패')

    async def test_structure_diagnostic_save_failure_does_not_hide_signal(self):
        circuit = self.circuit()
        page = MagicMock(goto=AsyncMock())
        error = SEARCH.SiteContractChanged('FORM_CHANGED', {'missingForm': ['court']})
        with patch.object(SEARCH, 'REUSE_SEARCH_SESSION', False), \
             patch.object(SEARCH, 'ensure_site_contract', side_effect=error), \
             patch.object(SEARCH, 'save_contract_debug', side_effect=OSError('disk full')):
            for value in ('2026타인1', '2026타인2'):
                row = await SEARCH.search_case_safely(page, {'row': 2, 'court': '서울남부지방법원', 'case_no': value, 'party_name': '주택'}, False, None, circuit, {})
                self.assertIn('구조변경', row['사건명'])
                self.assertTrue(row['사건명'].startswith('조회실패'))
        self.assertTrue(circuit['structure_event'].is_set())

    async def test_escaped_structure_exception_is_registered(self):
        circuit = self.circuit()
        state = {'form_ready': True}
        with patch.object(SEARCH, 'search_one', side_effect=SEARCH.SiteContractChanged('FORM_CHANGED', {})):
            for value in ('2026타인1', '2026타인2'):
                row = await SEARCH.search_case_safely(None, {'row': 2, 'court': '서울남부지방법원', 'case_no': value, 'party_name': '주택'}, False, None, circuit, state)
                self.assertTrue(row['사건명'].startswith('조회실패: 법원 사이트 구조변경'))
        self.assertTrue(circuit['structure_event'].is_set())
        self.assertFalse(state['form_ready'])

    def test_new_error_statuses_cannot_trigger_worker_scale_up(self):
        for name in ('조회오류: RuntimeError', '입력오류: 사건번호 형식 오류'):
            state = {'enabled': True, 'samples': [], 'scale_event': asyncio.Event(), 'extra_worker_retired': False}
            for _ in range(15):
                SEARCH.record_adaptive_health(state, {'사건명': name}, .01)
            self.assertFalse(state['scale_event'].is_set())
            self.assertFalse(any(s['success'] for s in state['samples']))


if __name__ == '__main__':
    unittest.main()
