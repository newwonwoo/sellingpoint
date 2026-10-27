"""Exactly one pinned, unfinished input row. No batch recovery or retry runner."""
import argparse
import asyncio
from contextlib import redirect_stdout, redirect_stderr
import hashlib
import json
import os
from pathlib import Path
import sys
import zipfile
import io
import traceback

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / 'court-search'))
from resume_batch import table, INPUT_BLOB, INPUT_SHA256, SOURCE_RUN, ARTIFACTS, validate_result
from case_number import parse_case_no
from output_schema import OUTPUT_HEADERS
import openpyxl

CODE_SHA = 'd1fbbee0d2c0447871fd35a0a3379bc0183ff2b2'
INDEX = 121


def prepare(root, source=None, preserved=None):
    source = source or REPO_ROOT / 'court-search/input.xlsx'
    raw = Path(source).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == INPUT_SHA256
    assert hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == INPUT_BLOB
    # The pinned workbook has two trailing empty rows; retain physical row numbers.
    physical = [(i, row) for i, row in enumerate(table(raw), 1) if any(v is not None for v in row)]
    assert len(physical) == 321
    rows = [row for _, row in physical]
    columns = {v:i for i,v in enumerate(rows[0]) if v is not None}
    cases = [{'index': i, 'excel_row': excel, 'court': row[columns['법원']],
              'case_no': row[columns['사건번호']], 'party': row[columns['당사자명']]}
             for i, (excel, row) in enumerate(physical[1:], 1)]
    assert cases[INDEX-1]['excel_row'] == 122
    if preserved:
        # Offline proof that only rows 1..120 have reusable completed artifacts.
        seen = []
        for _, start, end, digest in ARTIFACTS:
            raw = (Path(preserved) / f'court-search-partial-{start:04d}-{end:04d}.zip').read_bytes()
            assert hashlib.sha256(raw).hexdigest() == digest
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                assert archive.testzip() is None and len(archive.namelist()) == 1
                validate_result(table(archive.read(archive.namelist()[0])), cases[start-1:end], seed=True)
            seen.extend(range(start, end + 1))
        assert seen == list(range(1, INDEX))
    case = cases[INDEX-1]
    parse_case_no(case['case_no'])
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    public = root / 'public'; public.mkdir(mode=0o700)
    workbook = openpyxl.Workbook(); sheet = workbook.active
    sheet.append(list(rows[0])); sheet.append(list(rows[INDEX]))
    workbook.save(root / 'single-input.xlsx'); workbook.close()
    assert table((root / 'single-input.xlsx').read_bytes())[1:] == [rows[INDEX]]
    manifest = {'source_run': SOURCE_RUN, 'input_blob': INPUT_BLOB,
                'input_sha256': INPUT_SHA256, 'original_index': INDEX,
                'original_excel_row': INDEX + 1, 'selected_rows': 1,
                'reusable_completed_range': [1, INDEX-1], 'protected_code_sha': CODE_SHA,
                'execution_sha': os.environ.get('GITHUB_SHA'), 'status': 'prepared'}
    (public / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return case


def verify(root, case):
    output = root / 'private-result.xlsx'
    data = output.read_bytes()
    rows = table(data)
    assert list(rows[0]) == OUTPUT_HEADERS and len(rows) == 2
    result = validate_result(rows, [case])[0]
    manifest_path = root / 'public/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    status = result['사건명']
    manifest.update(status='held' if status.startswith('조회보류') else
                    'failed' if status.startswith(('조회실패', '조회오류', '입력오류')) else 'completed',
                    result_rows=1, result_sha256=hashlib.sha256(data).hexdigest(), result_bytes=len(data))
    if manifest['status'] != 'completed':
        # Only fixed classifications, not raw case data or exception strings.
        manifest['reason'] = next((key for key in ('CAPTCHA','ACCESS_DENIED','RATE_LIMITED','구조변경','네트워크') if key in status), 'OTHER')
    assert not (root / 'public/result.xlsx').exists()
    output.replace(root / 'public/result.xlsx')
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(manifest, ensure_ascii=False))
    return manifest


def run(root):
    case = prepare(root)
    os.environ.update(COURT_FAIL_CLOSED='true', COURT_WORKERS='1', COURT_MAX_WORKERS='1',
                      COURT_IMMEDIATE_RETRY='false', COURT_TRACE_NETWORK='false',
                      DEBUG_TABLES='0', CAPTCHA_FAST_PATH='false', COURT_DIRECT_API='false',
                      COURT_REUSE_SESSION='false')
    for key in ('COURT_RESUME_DIR','COURT_ARTIFACT_QUEUE_DIR','COURT_PARTIAL_DIR'):
        os.environ.pop(key, None)
    # Preserve private diagnostics locally only; never upload raw logs/input.
    with (root / 'private-execution.log').open('x', encoding='utf-8') as log, redirect_stdout(log), redirect_stderr(log):
        import search
        assert len(search.read_input(str(root / 'single-input.xlsx'))) == 1
        sys.argv = ['search.py', str(root / 'single-input.xlsx'), str(root / 'private-result.xlsx')]
        try:
            asyncio.run(search.main())
        except Exception:
            traceback.print_exc()
            raise SystemExit('Single protected execution failed; private diagnostics retained.') from None
    return verify(root, case)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['prepare', 'run'])
    parser.add_argument('root', type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--preserved', type=Path)
    args = parser.parse_args()
    if args.mode == 'prepare':
        prepare(args.root, args.source, args.preserved)
        print('Prepared exactly one valid input: original index 121 / Excel row 122.')
    else:
        if args.source or args.preserved:
            raise SystemExit('Runtime source overrides are forbidden')
        run(args.root)
