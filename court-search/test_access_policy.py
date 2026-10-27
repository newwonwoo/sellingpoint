"""Synthetic only: no browser or network is launched."""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, Mock, patch
from types import SimpleNamespace
import access_policy as P
import connection_probe as C
import search as S


class PolicyTests(unittest.IsolatedAsyncioTestCase):
    def page(self, code='CAPTCHA', status=200):
        page=Mock()
        page.context=Mock(route=AsyncMock())
        page.goto=AsyncMock(return_value=SimpleNamespace(status=status))
        page.evaluate=AsyncMock(return_value=code)
        return page

    async def test_security_signals_prevent_all_next_requests(self):
        for code,status,wanted in [('CAPTCHA',200,'CAPTCHA'),('ACCESS_DENIED',200,'ACCESS_DENIED'),('STRUCTURE_UNKNOWN',403,'ACCESS_DENIED'),('STRUCTURE_UNKNOWN',429,'RATE_LIMITED')]:
            with self.subTest(code=code,status=status):
                page=self.page(code,status);state={}
                self.assertEqual(await P.observe(page,'mock://court',state,3,0),wanted)
                route=page.context.route.call_args.args[1]
                request=Mock(request=SimpleNamespace(url='mock://court/next'),abort=AsyncMock(),continue_=AsyncMock())
                await route(request)
                request.abort.assert_awaited_once();request.continue_.assert_not_awaited()
                self.assertEqual(await P.observe(page,'mock://court',state,3,0),wanted)
                page.goto.assert_awaited_once();page.fill.assert_not_called();page.click.assert_not_called()
                page.screenshot.assert_not_called()
                if status != 200:page.evaluate.assert_not_awaited()

    async def test_captcha_request_aborted_before_payload(self):
        page=self.page();state={}
        async def navigate(*a,**k):
            route=page.context.route.call_args.args[1]
            request=Mock(request=SimpleNamespace(url='mock://court/getCaptchaInf.on'),abort=AsyncMock(),continue_=AsyncMock())
            await route(request)
            request.abort.assert_awaited_once();request.continue_.assert_not_awaited()
            raise RuntimeError('aborted')
        page.goto.side_effect=navigate
        self.assertEqual(await P.observe(page,'mock://court',state,3,0),'CAPTCHA')
        page.goto.assert_awaited_once();page.evaluate.assert_not_awaited()

    async def test_transient_retry_and_structural_exception(self):
        page=self.page();page.goto.side_effect=[OSError('temporary'),SimpleNamespace(status=200)]
        self.assertEqual(await P.observe(page,'mock://court',{},3,0),'CAPTCHA')
        self.assertEqual(page.goto.await_count,2)
        page=self.page();page.goto.side_effect=OSError('temporary')
        self.assertEqual(await P.observe(page,'mock://court',{},3,0),'NETWORK_ERROR')
        self.assertEqual(page.goto.await_count,3)
        page=self.page();page.evaluate.side_effect=TimeoutError('schema inspection timeout')
        self.assertEqual(await P.observe(page,'mock://court',{},3,0),'STRUCTURE_UNKNOWN')
        page.goto.assert_awaited_once()

    async def test_cancel_propagates(self):
        page=self.page();page.goto.side_effect=asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):await P.observe(page,'mock://court',{},3,0)

    async def test_all_worker_entries_share_stop_without_solver(self):
        page=self.page();state={}
        case={'court':'synthetic','case_no':'2026가단1','party_name':'PRIVATE_CANARY','row':121}
        with patch.dict(os.environ,{'COURT_FAIL_CLOSED':'true'}),patch.object(S,'search_one',new_callable=AsyncMock) as legacy,patch.object(S,'predict_captcha') as solver:
            rows=await asyncio.gather(*(S.search_case_safely(page,case,connection_circuit=state) for _ in range(8)))
        self.assertTrue(all(r['사건명']=='조회보류: 안전정지: CAPTCHA' for r in rows))
        self.assertNotIn('PRIVATE_CANARY',str(rows));legacy.assert_not_awaited();solver.assert_not_called()
        page.goto.assert_awaited_once()


class DiagnosticTests(unittest.TestCase):
    def test_guarded_diagnostic_never_calls_legacy_or_control_probes(self):
        report={'classification':'CAPTCHA','success':False,'retryable':False,'message':'안전정지: CAPTCHA','public_ip':None,'browser':{}}
        with patch.dict(os.environ,{'COURT_FAIL_CLOSED':'true'}),patch.object(P,'diagnostic',new_callable=AsyncMock,return_value=report) as diagnostic,patch.object(C,'probe') as probe,patch.object(C,'probe_browser') as browser,patch.object(C,'discover_public_ip') as ip:
            self.assertEqual(C.diagnose('mock://court',1,1,attempts=3),report)
        diagnostic.assert_awaited_once();probe.assert_not_called();browser.assert_not_called();ip.assert_not_called()

class MergePolicyTests(unittest.TestCase):
    def test_security_hold_mixed_with_network_and_input_error_disables_fallback(self):
        import tempfile
        from pathlib import Path
        from contextlib import ExitStack, redirect_stdout
        import io
        import resume_batch as R
        from test_resume_batch import SyntheticEvidence, workbook_bytes
        with ExitStack() as stack:
            root=Path(stack.enter_context(tempfile.TemporaryDirectory()))
            fixture=SyntheticEvidence();fixture.patches(stack)
            stack.enter_context(redirect_stdout(io.StringIO()))
            R.prepare(root/'evidence',fixture.fetch)
            rows=fixture.results(121,320,failure='조회보류: 법원 사이트 접속 불가')
            rows[1][2]='조회보류: 안전정지: CAPTCHA'
            pending=root/'pending.xlsx';pending.write_bytes(workbook_bytes(rows))
            report=R.finalize(root/'evidence',pending,root/'final.xlsx')
            self.assertTrue(report['security_stop'])
            self.assertFalse(report['global_connection_failure'])
            self.assertEqual(report['queryable'],199)
            final=R.table((root/'final.xlsx').read_bytes())
            self.assertEqual(len(final),321)
            self.assertEqual(final[157][2][:4],'입력오류')
            self.assertEqual([r[:2] for r in final[1:]],[r[:2] for r in fixture.source[1:]])

class BatchPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_batch_preserves_order_input_error_and_no_solver_or_retry(self):
        from contextlib import ExitStack, redirect_stdout
        from pathlib import Path
        import tempfile
        import io
        import resume_batch as R
        from test_resume_batch import SyntheticEvidence
        from unittest.mock import MagicMock
        with ExitStack() as stack:
            tmp=Path(stack.enter_context(tempfile.TemporaryDirectory()))
            fixture=SyntheticEvidence();fixture.patches(stack)
            stack.enter_context(redirect_stdout(io.StringIO()))
            root=tmp/'evidence';R.prepare(root,fixture.fetch)
            page=PolicyTests().page()
            context=MagicMock(new_page=AsyncMock(return_value=page),close=AsyncMock())
            browser=MagicMock(new_context=AsyncMock(return_value=context),close=AsyncMock())
            playwright=MagicMock();playwright.chromium.launch=AsyncMock(return_value=browser)
            manager=MagicMock(__aenter__=AsyncMock(return_value=playwright),__aexit__=AsyncMock())
            stack.enter_context(patch.dict(os.environ,{'COURT_FAIL_CLOSED':'true','COURT_RESUME_DIR':str(root),'COURT_WORKERS':'3','COURT_MAX_WORKERS':'4','COURT_PARTIAL_DIR':str(tmp/'parts')},clear=True))
            stack.enter_context(patch.object(S.sys,'argv',['search.py',str(root/'remaining.xlsx'),str(tmp/'new.xlsx')]))
            stack.enter_context(patch.object(S,'async_playwright',return_value=manager))
            legacy=stack.enter_context(patch.object(S,'search_one',new_callable=AsyncMock))
            solver=stack.enter_context(patch.object(S,'warmup_captcha_solver'))
            dataset=stack.enter_context(patch.object(S,'load_success_dataset'))
            stack.enter_context(patch.object(S.PartialResultPublisher,'_upload_worker',new_callable=AsyncMock))
            await S.main()
            report=R.finalize(root,tmp/'new.xlsx',tmp/'final.xlsx')
            self.assertEqual(report['new_failures'],200)
            self.assertTrue(report['security_stop']);self.assertFalse(report['global_connection_failure'])
            page.goto.assert_awaited_once();page.fill.assert_not_called();page.click.assert_not_called()
            legacy.assert_not_awaited();solver.assert_not_called();dataset.assert_not_called()
            self.assertFalse(any(call.args[0]=='response' and getattr(call.args[1],'__name__','')=='capture_captcha_response' for call in page.on.call_args_list))
