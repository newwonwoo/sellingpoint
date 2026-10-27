"""Synthetic page/transport only. Real search helpers and parser run unpatched.

The earlier 89 PASS tested an over-restrictive observation-only policy; it did
not demonstrate a normal search. These positive tests cover that missing path.
"""
import asyncio
from contextlib import ExitStack
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import access_policy as P
import search as S

CASE = {'court':'합성법원', 'case_no':'2026가단1', 'party_name':'PRIVATE_PARTY_CANARY', 'row':121}


class Locator:
    def __init__(self, page, selector):self.page,self.selector=page,selector
    def locator(self, selector):return Locator(self.page,selector)
    async def input_value(self):
        self.page.record('read-value')
        return ''
    async def evaluate_all(self, script):
        self.page.record('read-options' if self.selector=='option' else 'read-tables')
        if self.selector=='option':return [{'value':'court1','label':'합성법원'}]
        return [{'text':'사건명 접수일 재판부', 'rows':[['사건명','합성사건','접수일','2026.10.01','재판부','합성부']]},
                {'text':'일자 내용 공시문', 'rows':[['2026.10.02','합성진행','합성결과','']]}]
    async def inner_text(self, **kwargs):
        self.page.record('read-body')
        return self.page.body


class SyntheticPage:
    def __init__(self, stage=None, signal=None, no_result=False):
        self.context=SimpleNamespace(route=AsyncMock(side_effect=self.route))
        self.frames=[self]
        self.code='CLEAR';self.body='정상 검색 폼'
        self.calls=[];self.routes=[];self.listeners={}
        self.stage,self.signal=stage,signal
        self.no_result=no_result
        self.detected_at=None
        self.actions_after_signal=[]
    async def route(self, pattern, handler):self.routes.append(handler)
    def on(self, name, callback):self.listeners.setdefault(name,[]).append(callback)
    def locator(self, selector):return Locator(self,selector)
    def record(self, stage):
        if self.detected_at is not None:self.actions_after_signal.append(stage)
        self.calls.append(stage)
        if stage==self.stage:
            if isinstance(self.signal,int):
                for callback in self.listeners.get('response',[]):callback(SimpleNamespace(status=self.signal))
            else:self.code=self.signal
            self.detected_at=len(self.calls)
            self.stage=None
    async def goto(self,*args,**kwargs):
        self.record('navigate')
        return SimpleNamespace(status=200)
    async def evaluate(self, script, *args):
        if script==P.INSPECT:return self.code
        if script==P.FORM_INSPECTION_JS:
            self.record('inspect-form')
            return {'formOk':True,'resolved':{}}
        self.record('progress-tab')
        self.body+=' 일자 내용 公示 공시문'
        return True
    async def wait_for_function(self,*args,**kwargs):self.record('wait-options')
    async def wait_for_timeout(self,*args):self.record('wait')
    async def select_option(self, selector, **kwargs):self.record('select-year' if selector==S.SEL_YEAR else 'select')
    async def fill(self,selector,value):self.record('fill-party' if selector==S.SEL_PARTY else 'fill-serial')
    async def click(self,selector):
        self.record('submit')
        self.body='검색결과가 없습니다' if self.no_result else '사건명 재판부 접수일'
    async def content(self):
        self.record('read-content')
        return self.body


class GuardedSearchTests(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, page, state=None):
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ,{'COURT_FAIL_CLOSED':'true'}))
            forbidden=[stack.enter_context(patch.object(S,name,side_effect=AssertionError(name)))
                       for name in ('get_captcha_answer','refresh_captcha_info','predict_captcha',
                                    'save_success_captcha','learn_success','load_success_dataset')]
            result=await S.search_case_safely(page,CASE,connection_circuit={} if state is None else state)
            for call in forbidden:call.assert_not_called()
        return result

    async def test_normal_form_reaches_real_input_submit_and_result_parser(self):
        page=SyntheticPage();state={}
        result=await self.run_case(page,state)
        self.assertEqual(result['사건명'],'합성사건')
        self.assertEqual(result['재판부'],'합성부')
        self.assertEqual(result['진행_1내용'],'합성진행')
        self.assertEqual(result['사건번호'],CASE['case_no'])
        self.assertNotIn('security_reason',state)
        self.assertNotIn('structure_reason',state)
        self.assertEqual(page.calls.count('submit'),1)
        self.assertIn('fill-party',page.calls);self.assertIn('progress-tab',page.calls)

    async def test_protected_input_check_does_not_submit(self):
        page=SyntheticPage()
        with patch.dict(os.environ,{'COURT_FAIL_CLOSED':'true'}):
            result=await S.search_case_safely(page,CASE,prepare_only=True,connection_circuit={})
        self.assertEqual(result['사건명'],'입력점검 완료')
        self.assertIn('fill-party',page.calls)
        self.assertNotIn('submit',page.calls)

    async def test_late_response_preserves_success_and_input_error_but_disables_retry_rows(self):
        cases=[CASE]*4
        results=[{'사건명':'합성사건'}, {'사건명':'입력오류: synthetic'},
                 {'사건명':'조회실패: 법원 사이트 네트워크 연결 실패'}, {}]
        changed=S.preserve_late_security_stop(results,cases,{'security_reason':'RATE_LIMITED'})
        self.assertEqual(changed,[2,3])
        self.assertEqual(results[0],{'사건명':'합성사건'})
        self.assertEqual(results[1],{'사건명':'입력오류: synthetic'})
        self.assertTrue(all(results[i]['사건명']=='조회보류: 안전정지: RATE_LIMITED' for i in changed))

    async def test_normal_no_result_is_terminal_not_structure_failure(self):
        page=SyntheticPage(no_result=True)
        result=await self.run_case(page)
        self.assertEqual(result['사건명'],'사건없음')
        self.assertEqual(page.calls.count('submit'),1)
        self.assertNotIn('progress-tab',page.calls)

    async def test_late_security_signals_stop_navigation_input_submit_and_result_actions(self):
        for stage in ('navigate','select-year','fill-serial','fill-party','submit','read-tables','progress-tab'):
            for signal,wanted in [('CAPTCHA','CAPTCHA'),('ACCESS_DENIED','ACCESS_DENIED'),(403,'ACCESS_DENIED'),(429,'RATE_LIMITED')]:
                with self.subTest(stage=stage,signal=signal):
                    page=SyntheticPage(stage,signal);state={}
                    result=await self.run_case(page,state)
                    self.assertEqual(result['사건명'],'조회보류: 안전정지: '+wanted)
                    self.assertEqual(state['security_reason'],wanted)
                    self.assertEqual(page.actions_after_signal,[])
                    calls=list(page.calls)
                    # Re-entry covers primary, rescue and final retry's common boundary.
                    self.assertEqual((await self.run_case(page,state))['사건명'],result['사건명'])
                    self.assertEqual(page.calls,calls)
                    request=SimpleNamespace(request=SimpleNamespace(url='mock://fixture/next'),abort=AsyncMock(),continue_=AsyncMock())
                    await page.routes[0](request)
                    request.abort.assert_awaited_once();request.continue_.assert_not_awaited()
                    self.assertLessEqual(page.calls.count('submit'),1)

    async def test_ws_select_catch_cannot_attempt_label_after_block(self):
        page=SyntheticPage('select-year',403);state={}
        await P.install(page,state)
        guarded=P.Guarded(page,page,state)
        with self.assertRaises(P.PolicyStop):await S.ws_select(guarded,S.SEL_YEAR,'2026')
        self.assertEqual(page.calls.count('select-year'),1)
        self.assertEqual(page.actions_after_signal,[])

    async def test_progress_tab_catch_cannot_click_next_frame_after_block(self):
        page=SyntheticPage('progress-tab',429);state={}
        page.frames=[page,page]
        await P.install(page,state)
        await S.click_progress_tab(P.Guarded(page,page,state))
        self.assertEqual(page.calls.count('progress-tab'),1)
        self.assertEqual(page.actions_after_signal,[])
        with self.assertRaises(P.PolicyStop):await P.checkpoint(page,state)

    async def test_structure_unknown_is_distinct_and_does_not_retry_navigation(self):
        page=SyntheticPage();state={}
        original=page.evaluate
        async def evaluate(script,*args):
            if script==P.FORM_INSPECTION_JS:return {'formOk':False,'resolved':{}}
            return await original(script,*args)
        page.evaluate=evaluate
        with self.assertRaises(P.PolicyStop) as caught:await P.form_ready(page,state,timeout=0)
        self.assertEqual(caught.exception.code,'STRUCTURE_UNKNOWN')
        self.assertNotIn('security_reason',state)
        self.assertNotIn('navigate',page.calls)
        self.assertNotIn('submit',page.calls)

    async def test_transient_navigation_can_recover_to_normal_result(self):
        page=SyntheticPage();original=page.goto;attempts=[]
        async def goto(*args,**kwargs):
            attempts.append(1)
            if len(attempts)==1:raise OSError('temporary')
            return await original(*args,**kwargs)
        page.goto=goto
        with patch.object(P.asyncio,'sleep',new_callable=AsyncMock):result=await self.run_case(page)
        self.assertEqual(result['사건명'],'합성사건')
        self.assertEqual(len(attempts),2)
        self.assertEqual(page.calls.count('submit'),1)

    async def test_diagnostic_late_rate_limit_overrides_healthy_and_network_results(self):
        for network_failure in (False,True):
            with self.subTest(network_failure=network_failure):
                page=SyntheticPage()
                if network_failure:page.goto=AsyncMock(side_effect=OSError('temporary'))
                context=SimpleNamespace(new_page=AsyncMock(return_value=page))
                async def close():
                    for callback in page.listeners.get('response',[]):callback(SimpleNamespace(status=429))
                browser=SimpleNamespace(new_context=AsyncMock(return_value=context),close=close)
                manager=SimpleNamespace(chromium=SimpleNamespace(launch=AsyncMock(return_value=browser)))
                cm=Mock(__aenter__=AsyncMock(return_value=manager),__aexit__=AsyncMock())
                with patch('playwright.async_api.async_playwright',return_value=cm):
                    report=await P.diagnostic('mock://fixture',1,1,0)
                self.assertFalse(report['success']);self.assertFalse(report['retryable'])
                self.assertEqual(report['classification'],'RATE_LIMITED')
                self.assertEqual(report['message'],'안전정지: RATE_LIMITED')

    async def test_diagnostic_allows_normal_form_without_control_or_solver_calls(self):
        page=SyntheticPage()
        context=SimpleNamespace(new_page=AsyncMock(return_value=page))
        browser=SimpleNamespace(new_context=AsyncMock(return_value=context),close=AsyncMock())
        manager=SimpleNamespace(chromium=SimpleNamespace(launch=AsyncMock(return_value=browser)))
        cm=Mock(__aenter__=AsyncMock(return_value=manager),__aexit__=AsyncMock())
        with patch('playwright.async_api.async_playwright',return_value=cm):
            report=await P.diagnostic('mock://fixture',1,3,0)
        self.assertTrue(report['success']);self.assertFalse(report['retryable'])
        self.assertEqual(report['classification'],'NORMAL_FORM')
        self.assertNotIn('submit',page.calls)

class SyntheticDOMTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_dom_normal_form_and_late_challenge_without_network(self):
        from playwright.async_api import async_playwright
        from site_contract import FORM_SELECTOR_CANDIDATES
        fields={name:values[0][1:] for name,values in FORM_SELECTOR_CANDIDATES.items()}
        options=''.join(f'<option value="c{i}">{"합성법원" if i==0 else "합성"+str(i)}</option>' for i in range(12))
        result_html='<table><tr><td>사건명</td><td>합성사건</td><td>접수일</td><td>2026.10.01</td><td>재판부</td><td>합성부</td></tr></table>'
        html=(f'<select id="{fields["court"]}">{options}</select>'
              f'<select id="{fields["year"]}"><option>2025</option><option>2026</option></select>'
              f'<select id="{fields["case_type"]}"><option value="{S.CASE_TYPE_MAP["가단"]}">가단</option></select>'
              f'<input id="{fields["serial"]}"><input id="{fields["party"]}">'
              f'<button id="{fields["search"]}">검색</button>')
        async with async_playwright() as p:
            browser=await p.chromium.launch(headless=True,executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') or None,args=['--no-sandbox'])
            try:
                for challenge in (None,'CAPTCHA','접근이 차단되었습니다'):
                    with self.subTest(challenge=challenge):
                        context=await browser.new_context(service_workers='block')
                        page=await context.new_page();requests=[]
                        async def deny(route):
                            requests.append(route.request.url)
                            await route.abort()
                        # Highest-priority page route prevents any network escape.
                        await page.route('**/*',deny)
                        async def load(*args,**kwargs):
                            await page.set_content(html)
                            await page.evaluate('''({search,serial,result,challenge}) => {
                              window.submits=0;
                              document.getElementById(search).onclick=()=>{window.submits++;document.body.innerHTML=result;};
                              if(challenge) document.getElementById(serial).oninput=()=>{
                                const warning=document.createElement('div');warning.textContent=challenge;document.body.append(warning);
                              };
                            }''',{'search':fields['search'],'serial':fields['serial'],'result':result_html,'challenge':challenge})
                            return SimpleNamespace(status=200)
                        with patch.object(page,'goto',side_effect=load),patch.dict(os.environ,{'COURT_FAIL_CLOSED':'true'}):
                            result=await S.search_case_safely(page,CASE,connection_circuit={})
                        self.assertEqual(result['사건명'],'합성사건' if challenge is None else '조회보류: 안전정지: '+('CAPTCHA' if challenge=='CAPTCHA' else 'ACCESS_DENIED'))
                        self.assertEqual(await page.evaluate('window.submits'),1 if challenge is None else 0)
                        self.assertEqual(requests,[])
                        await context.close()
            finally:
                await browser.close()
