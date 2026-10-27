"""Synthetic XLSX/ZIP fixtures only; no historical case data or network."""
import asyncio
import base64
from contextlib import ExitStack, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import zipfile

import openpyxl
import resume_batch as R
from test_search_scheduler import SEARCH
from output_schema import OUTPUT_HEADERS, write_output
from chunk_workbook import write_blocked_output


def workbook_bytes(rows):
    book = openpyxl.Workbook()
    for row in rows:
        book.active.append(row)
    stream = io.BytesIO(); book.save(stream); book.close()
    return stream.getvalue()


class SyntheticEvidence:
    def __init__(self):
        self.source = [('법원', '사건번호', '당사자명')]
        for i in range(1, 321):
            self.source.append(('합성법원', f'2026가단{i}' if i != 157 else '202가단157', '합성당사자'))
        self.blob = workbook_bytes(self.source)
        self.archives = {}
        self.pins = []
        for artifact_id, start, end, _ in R.ARTIFACTS:
            self.set_archive(artifact_id, start, end, self.results(start, end))

    def results(self, start, end, *, failure=None):
        out = [OUTPUT_HEADERS]
        for i in range(start, end+1):
            status = '입력오류: synthetic invalid' if i == 157 else (failure or '합성사건')
            row = {h: '' for h in OUTPUT_HEADERS}
            row.update({'법원': self.source[i][0], '사건번호': self.source[i][1], '사건명': status,
                        '재판부': '합성재판부', '접수일': '2026.01.01', '조회일시': '2026-01-02 00:00:00'})
            out.append([row[h] for h in OUTPUT_HEADERS])
        return out

    def set_archive(self, artifact_id, start, end, rows):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f'court-search-{start:04d}-{end:04d}.xlsx', workbook_bytes(rows))
        self.archives[artifact_id] = stream.getvalue()
        self.pins = [x for x in self.pins if x[0] != artifact_id]
        self.pins.append((artifact_id, start, end, R.sha256(stream.getvalue())))
        self.pins.sort(key=lambda x: x[1])

    def patches(self, stack):
        stack.enter_context(patch.object(R, 'INPUT_SHA256', R.sha256(self.blob)))
        blob = hashlib.sha1(b'blob '+str(len(self.blob)).encode()+b'\0'+self.blob).hexdigest()
        stack.enter_context(patch.object(R, 'INPUT_BLOB', blob))
        stack.enter_context(patch.object(R, 'ARTIFACTS', self.pins))
        stack.enter_context(patch('socket.socket.connect', side_effect=AssertionError('network forbidden')))

    def fetch(self, route, *, binary=False):
        if route == f'actions/runs/{R.SOURCE_RUN}':
            return {'id': R.SOURCE_RUN, 'head_sha': R.SOURCE_SHA}
        if route == f'contents/court-search/input.xlsx?ref={R.SOURCE_SHA}':
            return {'sha': R.INPUT_BLOB, 'encoding': 'base64', 'content': base64.b64encode(self.blob).decode()}
        artifact_id = int(route.split('/')[2])
        if binary:
            assert route.endswith('/zip')
            return self.archives[artifact_id]
        pin = next(p for p in self.pins if p[0] == artifact_id)
        return {'id': artifact_id, 'name': f'court-search-partial-{pin[1]:04d}-{pin[2]:04d}',
                'expired': False, 'digest': 'sha256:'+pin[3], 'size_in_bytes': len(self.archives[artifact_id]),
                'workflow_run': {'id': R.SOURCE_RUN, 'head_sha': R.SOURCE_SHA}}


class RecoveryValidationTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.tmp = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.root = self.tmp / 'evidence'
        self.fixture = SyntheticEvidence(); self.fixture.patches(self.stack)
        self.stack.enter_context(redirect_stdout(io.StringIO()))

    def test_normal_recovery_and_immutable_source_seed(self):
        R.prepare(self.root, self.fixture.fetch)
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        pending = self.tmp/'pending.xlsx'; pending.write_bytes(workbook_bytes(self.fixture.results(121, 320)))
        target = self.tmp/'final.xlsx'
        report = R.finalize(self.root, pending, target)
        self.assertEqual(report['queryable'], 199)
        self.assertFalse(report['global_connection_failure'])
        self.assertEqual(len(R.table(target.read_bytes())), 321)
        self.assertEqual(R.table(target.read_bytes())[157][1], '202가단157')
        for name, content in before.items():self.assertEqual((self.root/name).read_bytes(), content)
        with self.assertRaisesRegex(ValueError, 'replace'):R.finalize(self.root,pending,target)
        with self.assertRaises(FileExistsError):R.prepare(self.root,self.fixture.fetch)

    def test_input_hash_mismatch_stops_before_subset(self):
        def fetch(route, **kw):
            data = self.fixture.fetch(route, **kw)
            if route.startswith('contents/'):
                data['content'] = base64.b64encode(b'bad').decode()
            return data
        with self.assertRaisesRegex(ValueError, 'SHA-256'):R.prepare(self.root,fetch)
        self.assertFalse((self.root/'remaining.xlsx').exists())

    def test_blob_mismatch_independent_of_sha256(self):
        with patch.object(R,'INPUT_BLOB','0'*40):
            with self.assertRaisesRegex(ValueError,'git blob'):R.source_rows(self.fixture.blob)

    def test_run_or_artifact_provenance_mismatch(self):
        for field in ('run','artifact','expired'):
            root=self.tmp/field
            def fetch(route, **kw):
                data=self.fixture.fetch(route,**kw)
                if route.startswith('actions/runs/') and field=='run':data['head_sha']='wrong'
                if route.startswith('actions/artifacts/') and not kw.get('binary'):
                    if field=='artifact':data['workflow_run']['id']=0
                    if field=='expired':data['expired']=True
                return data
            with self.subTest(field=field),self.assertRaises(ValueError):R.prepare(root,fetch)
            self.assertFalse((root/'remaining.xlsx').exists())

    def test_artifact_hash_mismatch(self):
        def fetch(route, **kw):
            data=self.fixture.fetch(route,**kw)
            return data+b'bad' if kw.get('binary') else data
        with self.assertRaisesRegex(ValueError,'bytes mismatch'):R.prepare(self.root,fetch)
        self.assertFalse((self.root/'remaining.xlsx').exists())

    def test_seed_order_schema_count_mismatch(self):
        artifact_id,start,end,_=self.fixture.pins[0]
        for kind in ('order','schema','count'):
            rows=self.fixture.results(start,end)
            if kind=='order':rows[1],rows[2]=rows[2],rows[1]
            elif kind=='schema':rows[0]=['wrong']+rows[0][1:]
            else:rows.pop()
            self.fixture.set_archive(artifact_id,start,end,rows)
            with patch.object(R,'ARTIFACTS',self.fixture.pins),self.subTest(kind=kind),self.assertRaises(ValueError):
                R.prepare(self.tmp/kind,self.fixture.fetch)
            self.assertFalse((self.tmp/kind/'remaining.xlsx').exists())

    def test_remaining_tampering_rejected(self):
        R.prepare(self.root,self.fixture.fetch)
        path=self.root/'remaining.xlsx'
        rows=R.table(path.read_bytes());rows[1],rows[2]=rows[2],rows[1]
        path.write_bytes(workbook_bytes(rows))
        with self.assertRaisesRegex(ValueError,'remaining input'):R.verify_remaining(path,self.root)

    def test_new_result_order_schema_count_and_invalid_status_rejected(self):
        R.prepare(self.root,self.fixture.fetch)
        for kind in ('order','schema','count','invalid'):
            rows=self.fixture.results(121,320)
            if kind=='order':rows[1],rows[2]=rows[2],rows[1]
            elif kind=='schema':rows[0]=['wrong']+rows[0][1:]
            elif kind=='count':rows.pop()
            else:rows[37][2]='합성사건'
            pending=self.tmp/f'{kind}.xlsx';pending.write_bytes(workbook_bytes(rows))
            target=self.tmp/f'{kind}-final.xlsx'
            with self.subTest(kind=kind),self.assertRaises(ValueError):R.finalize(self.root,pending,target)
            self.assertFalse(target.exists())

    def test_connection_block_mixed_with_input_error_uses_199_denominator(self):
        R.prepare(self.root,self.fixture.fetch)
        output=self.tmp/'blocked.xlsx'
        with patch.dict(os.environ,{'COURT_RESUME_DIR':str(self.root)}):
            write_blocked_output(self.root/'remaining.xlsx',output,'법원 사이트 접속 불가')
        report=R.finalize(self.root,output,self.tmp/'final.xlsx')
        self.assertTrue(report['global_connection_failure'])
        self.assertEqual(report['input_errors'],1)
        self.assertEqual(report['new_failures'],200)

    def test_no_case_terminal_result_allowed_but_incomplete_unknown_rejected(self):
        R.prepare(self.root,self.fixture.fetch)
        for name, allowed in [('사건없음',True),('임의성공',False)]:
            rows=self.fixture.results(121,320)
            rows[1][2]=name
            rows[1][OUTPUT_HEADERS.index('재판부')]=''
            rows[1][OUTPUT_HEADERS.index('접수일')]=''
            pending=self.tmp/f'{name}.xlsx';pending.write_bytes(workbook_bytes(rows))
            target=self.tmp/f'{name}-final.xlsx'
            if allowed:
                report=R.finalize(self.root,pending,target)
                self.assertFalse(report['global_connection_failure'])
                self.assertEqual(R.table(target.read_bytes())[121][2],'사건없음')
            else:
                with self.assertRaisesRegex(ValueError,'incomplete'):R.finalize(self.root,pending,target)
                self.assertFalse(target.exists())

    def test_partial_failure_does_not_trigger_full_fallback(self):
        R.prepare(self.root,self.fixture.fetch)
        rows=self.fixture.results(121,320)
        rows[1][2]='조회실패: 법원 사이트 연결 실패'
        pending=self.tmp/'mixed.xlsx';pending.write_bytes(workbook_bytes(rows))
        report=R.finalize(self.root,pending,self.tmp/'final.xlsx')
        self.assertFalse(report['global_connection_failure'])
        self.assertEqual(report['new_failures'],2)


class RecoverySchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_primary_and_fallback_only_query_199_and_publish_original_numbers(self):
        with ExitStack() as stack:
            tmp=Path(stack.enter_context(tempfile.TemporaryDirectory()))
            fixture=SyntheticEvidence();fixture.patches(stack)
            root=tmp/'evidence';R.prepare(root,fixture.fetch)
            for revision in (0,2):
                calls=[];published=[]
                async def lookup(page,court,case_no,*args):
                    calls.append(case_no)
                    return dict(zip(OUTPUT_HEADERS,fixture.results(int(case_no[6:]),int(case_no[6:]))[1]))
                async def upload(publisher):
                    while True:
                        item=await publisher.queue.get();publisher.queue.task_done()
                        if item is None:return
                        published.append(item)
                page=MagicMock()
                context=MagicMock(new_page=AsyncMock(return_value=page))
                browser=MagicMock(new_context=AsyncMock(return_value=context),close=AsyncMock())
                playwright=MagicMock();playwright.chromium.launch=AsyncMock(return_value=browser)
                manager=MagicMock(__aenter__=AsyncMock(return_value=playwright),__aexit__=AsyncMock())
                output=tmp/f'new-{revision}.xlsx';logs=io.StringIO()
                env={'COURT_RESUME_DIR':str(root),'COURT_WORKERS':'1','COURT_MAX_WORKERS':'1',
                     'COURT_PARTIAL_DIR':str(tmp/f'parts{revision}'),'COURT_ARTIFACT_QUEUE_DIR':str(tmp/f'queue{revision}'),
                     'COURT_PARTIAL_REVISION':str(revision)}
                with ExitStack() as run:
                    run.enter_context(patch.dict(os.environ,env,clear=True))
                    run.enter_context(patch.object(SEARCH.sys,'argv',['search.py',str(root/'remaining.xlsx'),str(output)]))
                    run.enter_context(patch.object(SEARCH,'async_playwright',return_value=manager))
                    run.enter_context(patch.object(SEARCH,'search_one',side_effect=lookup))
                    run.enter_context(patch.object(SEARCH,'load_success_dataset',return_value={'loaded':0,'skipped':0}))
                    run.enter_context(patch.object(SEARCH,'FAST_CAPTCHA_PATH',False))
                    run.enter_context(patch.object(SEARCH.PartialResultPublisher,'_upload_worker',upload))
                    run.enter_context(redirect_stdout(logs))
                    await SEARCH.main()
                self.assertEqual(calls,[r[1] for r in fixture.source[121:] if r[1]!='202가단157'])
                self.assertEqual(len(calls),199)
                self.assertIn('입력 158행',logs.getvalue())
                self.assertIn('[121/320 워커',logs.getvalue())
                self.assertEqual(len(published),16)
                tag='r2-' if revision else ''
                self.assertEqual(published[0][0],f'court-search-partial-{tag}0001-0020')
                self.assertEqual(published[6][0],f'court-search-partial-{tag}0121-0140')
                self.assertEqual(published[-1][0],f'court-search-partial-{tag}0301-0320')
                report=R.finalize(root,output,tmp/f'full-{revision}.xlsx')
                self.assertFalse(report['global_connection_failure'])


if __name__=='__main__':unittest.main()
