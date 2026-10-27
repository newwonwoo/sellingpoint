"""Pinned, opt-in recovery. GitHub downloads happen only in the explicit prepare command."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import zipfile

import openpyxl
from case_number import parse_case_no
from output_schema import OUTPUT_HEADERS, write_output

REPO = 'newwonwoo/sellingpoint'
SOURCE_RUN = 40456047554
SOURCE_SHA = 'd2cf2cd004f4a6fa9a1fbfc742369342031042cb'
OFFSET = 120
TOTAL = 320
INPUT_BLOB = '44b3582b8fc2c2418aaaca6355d7426bc54a9c47'
INPUT_SHA256 = 'fdcc81c168473417ba7ddd2f870d6b05a0285ce9a07530e8760e9864d6f210b3'
# IDs and ZIP digests are immutable evidence, never dispatch-controlled.
ARTIFACTS = [
    (12712765328, 1, 20, 'e30756a384b51d7813acc11cfc2bedc21ac7e81fe6f6390c007742a21b945fed'),
    (12712471621, 21, 40, '535b081412f5ddcb63dfd8103655af4fe59731a38c6ab6fc8ae2147e9e498914'),
    (12711514894, 41, 60, '14e127205188681e4e10e9a451051d6239cce9fa2dce12cd38a1860db31d72e9'),
    (12712397652, 61, 80, '7824fb95cccee37a5a83fd1f5a9125789cd5bc65b0e6eaf4a024fa52eaccef3d'),
    (12712427596, 81, 100, '51116f13691eaa0c415b559e721ac1ba91177cda1b3e225c4a51cfcaf319af8f'),
    (12713165202, 101, 120, '4eb33c81d1fbb266a73f093496020459cf14e7a399c5895977ffcfdfe142761d'),
]
ERROR_PREFIXES = ('조회실패', '조회보류', '조회오류', '입력오류')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def table(data):
    book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        return list(book.active.values)
    finally:
        book.close()


def source_rows(data):
    require(sha256(data) == INPUT_SHA256, 'input SHA-256 mismatch')
    blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    require(blob == INPUT_BLOB, 'input git blob mismatch')
    rows = table(data)
    columns = {value: i for i, value in enumerate(rows[0]) if value is not None}
    require(all(k in columns for k in ('법원', '사건번호', '당사자명')), 'input schema mismatch')
    require(len(rows) == TOTAL + 1, 'input row count mismatch')
    cases = []
    invalid = []
    for index, row in enumerate(rows[1:], 1):
        court, number, party = (row[columns[k]] for k in ('법원', '사건번호', '당사자명'))
        require(bool(court), 'missing court')
        try:
            parse_case_no(number)
        except ValueError:
            invalid.append(index)
        cases.append({'index': index, 'excel_row': index + 1, 'court': court,
                      'case_no': number, 'party': party})
    require(invalid == [157], 'unexpected invalid input rows')
    require(len({(c['court'], c['case_no']) for c in cases}) == TOTAL, 'duplicate identities')
    return rows, cases


def validate_result(rows, cases, *, seed=False):
    require(bool(rows) and list(rows[0]) == OUTPUT_HEADERS, 'result schema mismatch')
    require(len(rows) - 1 == len(cases), 'result row count mismatch')
    results = []
    for row, case in zip(rows[1:], cases):
        result = dict(zip(OUTPUT_HEADERS, row))
        require((result['법원'], result['사건번호']) == (case['court'], case['case_no']),
                f"result identity/order mismatch: {case['index']}")
        name = result['사건명']
        require(isinstance(name, str) and bool(name), 'missing result status')
        if case['index'] == 157:
            require(name.startswith('입력오류'), 'invalid input must remain an input error')
        else:
            require(not name.startswith('입력오류'), 'unexpected input error')
        if not seed and name == '사건없음':
            require(bool(result['조회일시']), 'missing no-case timestamp')
        elif seed or not name.startswith(ERROR_PREFIXES):
            require(not name.startswith(ERROR_PREFIXES) and all(result[k] for k in ('재판부', '접수일', '조회일시')),
                    'incomplete successful result')
        results.append(result)
    return results


def validate_bundle(root):
    root = Path(root)
    rows, cases = source_rows((root / 'source.xlsx').read_bytes())
    seeds, seed_paths = [], []
    for artifact_id, start, end, digest in ARTIFACTS:
        data = (root / f'{artifact_id}.zip').read_bytes()
        require(sha256(data) == digest, 'artifact SHA-256 mismatch')
        member = f'court-search-{start:04d}-{end:04d}.xlsx'
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            require(archive.namelist() == [member] and archive.testzip() is None, 'artifact ZIP mismatch')
            content = archive.read(member)
        seeds.extend(validate_result(table(content), cases[start-1:end], seed=True))
        path = root / member
        require(path.read_bytes() == content, 'extracted artifact mismatch')
        seed_paths.append((start, end, path))
    require(len(seeds) == OFFSET, 'seed coverage mismatch')
    return rows, cases, seeds, seed_paths


def verify_remaining(path, root):
    rows, cases, seeds, paths = validate_bundle(root)
    require(table(Path(path).read_bytes()) == [rows[0]] + rows[OFFSET+1:], 'remaining input mismatch')
    return cases, seeds, paths


def api(path, *, binary=False):
    data = subprocess.check_output(['gh', 'api', f'repos/{REPO}/{path}'])
    return data if binary else json.loads(data)


def prepare(root, fetch=api):
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=False)  # refuses stale/reused evidence directories
    run = fetch(f'actions/runs/{SOURCE_RUN}')
    require(run['id'] == SOURCE_RUN and run['head_sha'] == SOURCE_SHA, 'source run mismatch')
    payload = fetch(f'contents/court-search/input.xlsx?ref={SOURCE_SHA}')
    require(payload['sha'] == INPUT_BLOB and payload['encoding'] == 'base64', 'source blob metadata mismatch')
    data = base64.b64decode(payload['content'])
    rows, cases = source_rows(data)
    (root / 'source.xlsx').write_bytes(data)
    for artifact_id, start, end, digest in ARTIFACTS:
        meta = fetch(f'actions/artifacts/{artifact_id}')
        require(meta['id'] == artifact_id and meta['name'] == f'court-search-partial-{start:04d}-{end:04d}'
                and not meta['expired'] and meta['digest'] == 'sha256:' + digest
                and meta['workflow_run']['id'] == SOURCE_RUN and meta['workflow_run']['head_sha'] == SOURCE_SHA,
                'artifact provenance mismatch')
        data = fetch(f'actions/artifacts/{artifact_id}/zip', binary=True)
        require(sha256(data) == digest and len(data) == meta['size_in_bytes'], 'artifact bytes mismatch')
        (root / f'{artifact_id}.zip').write_bytes(data)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            member = f'court-search-{start:04d}-{end:04d}.xlsx'
            require(archive.namelist() == [member] and archive.testzip() is None, 'artifact ZIP mismatch')
            (root / member).write_bytes(archive.read(member))
    validate_bundle(root)  # no subset/output is released until all evidence validates
    book = openpyxl.Workbook()
    book.active.append(list(rows[0]))
    for row in rows[OFFSET+1:]:
        book.active.append(list(row))
    book.save(root / 'remaining.xlsx')
    book.close()
    verify_remaining(root / 'remaining.xlsx', root)
    # Public row references use only existing provenance and row positions.
    # Never hash/encode party, court or case-number values into public identifiers.
    public_rows = [
        {'index': c['index'], 'excel_row': c['excel_row'],
         'row_id': sha256(f"court-resume-row-v1:{SOURCE_RUN}:{SOURCE_SHA}:{INPUT_SHA256}:"
                          f"{c['index']}:{c['excel_row']}".encode())}
        for c in cases
    ]
    manifest = {'source_run': SOURCE_RUN, 'source_sha': SOURCE_SHA, 'input_blob': INPUT_BLOB,
                'input_sha256': INPUT_SHA256, 'offset': OFFSET, 'total': TOTAL,
                'artifacts': ARTIFACTS, 'rows': public_rows}
    (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')


def finalize(root, remaining, target):
    root, target = Path(root), Path(target)
    require(not target.exists(), 'refusing to replace final output')
    _, cases, seeds, _ = validate_bundle(root)
    new = validate_result(table(Path(remaining).read_bytes()), cases[OFFSET:])
    queryable = [r for r in new if not r['사건명'].startswith('입력오류')]
    require(len(queryable) == 199, 'expected 199 queryable rows')
    connection = [r for r in queryable if r['사건명'].startswith(('조회실패: 법원 사이트', '조회보류: 법원 사이트'))
                  and '구조변경' not in r['사건명']]
    report = {'global_connection_failure': len(connection) == len(queryable),
              'reused': OFFSET, 'new_rows': len(new), 'queryable': len(queryable),
              'input_errors': 1, 'total': TOTAL,
              'new_failures': sum(r['사건명'].startswith(ERROR_PREFIXES) for r in new)}
    write_output(seeds + new, str(target))
    (root / 'final-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'finalize'])
    parser.add_argument('root', type=Path)
    parser.add_argument('--remaining', type=Path)
    parser.add_argument('--target', type=Path)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.root)
    else:
        require(args.remaining is not None and args.target is not None, 'remaining and target required')
        finalize(args.root, args.remaining, args.target)


if __name__ == '__main__':
    main()
