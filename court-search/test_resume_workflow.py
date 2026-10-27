"""Exercise local guard and inspect bodies; never dispatch a GitHub workflow."""
from contextlib import ExitStack, redirect_stdout
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
                        GITHUB_SHA='a'*40, EXPECTED_SHA='a'*40, RESUME='true', INPUT_FILE='input.xlsx', PREPARE_ONLY='false')
            for changes, expected in [({},0),({'EXPECTED_SHA':'b'*40},1),({'ACTUAL_SHA':'b'*40},1),
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
