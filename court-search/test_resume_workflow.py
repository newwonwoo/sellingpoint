"""Exercise local guard and inspect bodies; never dispatch a GitHub workflow."""
from contextlib import ExitStack, redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

import resume_batch as R
from test_resume_batch import SyntheticEvidence, workbook_bytes

WORKFLOW = Path(__file__).parents[1] / '.github/workflows/court_search.yml'
TEXT = WORKFLOW.read_text()


def section(name):
    return TEXT.split(f'      - name: {name}\n', 1)[1].split('\n      - name:', 1)[0]


class RecoveryWorkflowTests(unittest.TestCase):
    def test_sha_guard_runs_before_diagnostics_in_all_jobs(self):
        for job in ('prepare', 'search', 'search_fallback'):
            body = TEXT.split(f'  {job}:\n', 1)[1].split('\n  search', 1)[0]
            self.assertIn('ref: ${{ github.sha }}', body)
            self.assertIn('승인 SHA 및 복구 옵션 확인', body)
            if job != 'prepare':
                self.assertLess(body.index('승인 SHA 및 복구 옵션 확인'), body.index('법원 사이트 연결 진단'))
                self.assertLess(body.index('고정 복구 근거 검증'), body.index('법원 사이트 연결 진단'))
        guard = textwrap.dedent(section('승인 SHA 및 복구 옵션 확인').split('        run: |\n', 1)[1])
        with tempfile.TemporaryDirectory() as tmp:
            fake_git = Path(tmp) / 'git'
            fake_git.write_text('#!/bin/sh\nprintf "%s\\n" "$ACTUAL_SHA"\n')
            fake_git.chmod(0o700)
            base = dict(os.environ, PATH=tmp+os.pathsep+os.environ['PATH'], ACTUAL_SHA='a'*40,
                        GITHUB_SHA='a'*40, EXPECTED_SHA='a'*40, RESUME='true', FAIL_CLOSED='true', INPUT_FILE='input.xlsx', PREPARE_ONLY='false')
            for changes, expected in [({},0),({'FAIL_CLOSED':'false'},1),({'EXPECTED_SHA':'b'*40},1),({'ACTUAL_SHA':'b'*40},1),
                                      ({'EXPECTED_SHA':''},1),({'PREPARE_ONLY':'true'},1),
                                      ({'INPUT_FILE':'test_input.xlsx'},1),
                                      ({'RESUME':'false','EXPECTED_SHA':'','INPUT_FILE':'test_input.xlsx','PREPARE_ONLY':'true'},0)]:
                result = subprocess.run(['bash','-e','-o','pipefail','-c',guard],env=base|changes,capture_output=True)
                with self.subTest(changes=changes):self.assertEqual(result.returncode,expected)

    def test_concurrency_permissions_allowlist_and_all_input_routes(self):
        group = TEXT.split('concurrency:\n',1)[1].split('\npermissions:',1)[0]
        self.assertIn("inputs.resume_40456047554 && 'court-resume-40456047554'",group)
        self.assertNotIn('github.ref',group)
        self.assertIn('cancel-in-progress: false',group)
        self.assertEqual(TEXT.split('permissions:\n',1)[1].split('\nenv:',1)[0].strip(), 'contents: read\n  actions: write')
        self.assertNotIn('secrets.',TEXT)
        self.assertIn('input.xlsx|test_input.xlsx|test_input_20.xlsx|sample_input.xlsx|test_input_single.xlsx|test_input_user_cases.xlsx)',TEXT)
        for job in ('search','search_fallback'):
            body=TEXT.split(f'  {job}:\n',1)[1].split('\n  search_fallback:',1)[0]
            self.assertIn('resume_dir="$RUNNER_TEMP/court-resume-40456047554"',body)
            self.assertIn('COURT_QUERY_INPUT=$resume_dir/remaining.xlsx',body)
            self.assertEqual(body.count('"$COURT_QUERY_INPUT" "$COURT_QUERY_OUTPUT"'),2)
            self.assertNotIn('"court-search/$INPUT_FILE" court-search/output.xlsx',body)
            self.assertIn('resume_batch.py finalize',body)
            self.assertIn('path: ${{ env.COURT_FINAL_OUTPUT }}',body)

    def test_public_manifests_and_new_logs_exclude_private_canaries(self):
        with ExitStack() as stack:
            tmp=Path(stack.enter_context(tempfile.TemporaryDirectory()))
            fixture=SyntheticEvidence()
            party_canary='PRIVATE_PARTY_CANARY_7429'
            court_canary='PRIVATE_COURT_CANARY_5183'
            fixture.source=[fixture.source[0]]+[(court_canary,r[1],party_canary) for r in fixture.source[1:]]
            fixture.blob=workbook_bytes(fixture.source)
            for artifact_id,start,end,_ in list(fixture.pins):
                fixture.set_archive(artifact_id,start,end,fixture.results(start,end))
            fixture.patches(stack)
            root=tmp/'evidence';logs=io.StringIO();errors=io.StringIO()
            pending=tmp/'pending.xlsx'
            pending.write_bytes(workbook_bytes(fixture.results(121,320)))
            with redirect_stdout(logs),redirect_stderr(errors):
                R.prepare(root,fixture.fetch)
                report=R.finalize(root,pending,tmp/'final.xlsx')
                again=tmp/'second-evidence';R.prepare(again,fixture.fetch)
            self.assertEqual(root.stat().st_mode & 0o777,0o700)
            # Private source/remaining retain exact identities for runtime validation.
            self.assertEqual(R.table((root/'source.xlsx').read_bytes())[1][2],party_canary)
            self.assertEqual(R.table((root/'remaining.xlsx').read_bytes())[1][2],party_canary)
            final=R.table((tmp/'final.xlsx').read_bytes())
            self.assertEqual(len(final),321)
            self.assertEqual([(r[0],r[1]) for r in final[1:]],[(r[0],r[1]) for r in fixture.source[1:]])
            self.assertEqual(report['queryable'],199)
            manifest=json.loads((root/'manifest.json').read_text())
            self.assertEqual(manifest,json.loads((again/'manifest.json').read_text()))
            self.assertEqual(len(manifest['rows']),320)
            for index,row in enumerate(manifest['rows'],1):
                self.assertEqual(set(row),{'index','excel_row','row_id'})
                self.assertEqual((row['index'],row['excel_row']),(index,index+1))
                expected=R.sha256(f'court-resume-row-v1:{R.SOURCE_RUN}:{R.SOURCE_SHA}:{R.INPUT_SHA256}:{index}:{index+1}'.encode())
                self.assertEqual(row['row_id'],expected)
            # Check both actual workflow upload stanzas, not an invented path list.
            uploads=TEXT.split('      - name: 복구 원행 매니페스트 보관\n')[1:]
            self.assertEqual(len(uploads),2)
            public=[]
            for upload in uploads:
                stanza=upload.split('\n      - name:',1)[0]
                paths=stanza.split('          path: |\n',1)[1].split('          if-no-files-found:',1)[0]
                selected=[line.strip().replace('${{ env.COURT_RESUME_DIR }}',str(root)) for line in paths.splitlines() if line.strip()]
                self.assertEqual(selected,[str(root/'manifest.json'),str(root/'final-report.json')])
                public.extend(Path(path).read_text() for path in selected)
            public.extend([logs.getvalue(),errors.getvalue()])
            for text in public:
                for forbidden in (party_canary,court_canary,R.sha256(party_canary.encode()),R.sha256(court_canary.encode())):
                    self.assertNotIn(forbidden,text)
                for row in fixture.source[1:]:self.assertNotIn(row[1],text)
            self.assertNotIn('"party"',public[0])
            self.assertNotIn('"court"',public[0])
            self.assertNotIn('"case_no"',public[0])

    def test_actual_primary_inspect_keeps_199_connection_denominator_after_merge(self):
        with ExitStack() as stack:
            tmp=Path(stack.enter_context(tempfile.TemporaryDirectory()))
            fixture=SyntheticEvidence();fixture.patches(stack)
            root=tmp/'evidence';R.prepare(root,fixture.fetch)
            new=tmp/'new.xlsx';new.write_bytes(workbook_bytes(fixture.results(121,320,failure='조회보류: 법원 사이트 접속 불가')))
            full=tmp/'full.xlsx';R.finalize(root,new,full)
            code=textwrap.dedent(section('결과 파일 생성 확인').split("<<'PY'\n",1)[1].split('\n          PY',1)[0])
            env={'COURT_FINAL_OUTPUT':str(full),'COURT_RESUME_DIR':str(root),'EXPECTED_TOTAL':'320','GITHUB_OUTPUT':str(tmp/'github-output')}
            with patch.dict(os.environ,env),redirect_stdout(io.StringIO()):
                values={};exec(compile(code,str(WORKFLOW),'exec'),values)
            self.assertTrue(values['global_connection_failure'])
            self.assertEqual(values['actual'],320)
            self.assertEqual(len(values['failed']),200)
            self.assertIn('global_connection_failure=true',(tmp/'github-output').read_text())


if __name__=='__main__':unittest.main()
