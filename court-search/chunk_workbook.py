"""20건 단위 조회 작업용 입력 분할과 결과 병합 도구."""

from __future__ import annotations

import argparse
import json
from copy import copy
from pathlib import Path

import openpyxl


CHUNK_SIZE = 20


def input_rows(path: Path) -> tuple[list, list[tuple]]:
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = workbook.active
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        raise ValueError("입력 엑셀이 비어 있습니다.")
    header = list(rows[0])
    data = [row for row in rows[1:] if row and row[0] and len(row) > 1 and row[1]]
    return header, data


def print_matrix(path: Path):
    _, rows = input_rows(path)
    if not rows:
        raise ValueError("조회할 사건이 없습니다.")
    chunks = []
    for start_zero in range(0, len(rows), CHUNK_SIZE):
        start = start_zero + 1
        end = min(start_zero + CHUNK_SIZE, len(rows))
        chunks.append({
            "chunk": len(chunks) + 1,
            "start": start,
            "end": end,
            "count": end - start + 1,
            "tag": f"{start:04d}-{end:04d}",
        })
    workers = 3 if len(chunks) == 1 else 1
    for chunk in chunks:
        chunk["workers"] = workers
    print(f"matrix={json.dumps({'include': chunks}, ensure_ascii=False, separators=(',', ':'))}")
    print(f"total={len(rows)}")
    print(f"chunk_count={len(chunks)}")


def write_slice(source: Path, target: Path, start: int, end: int):
    header, rows = input_rows(source)
    selected = rows[start - 1:end]
    if not selected:
        raise ValueError(f"입력 범위가 비어 있습니다: {start}-{end}")

    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "입력"
    sheet.append(header)
    for row in selected:
        sheet.append(list(row))
    target.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(target)
    print(f"✅ 입력 묶음 생성: {target} ({start}-{end}, {len(selected)}건)")


def combine_results(source_dir: Path, target: Path):
    files = sorted(source_dir.glob("court-search-*-*.xlsx"))
    if not files:
        raise ValueError("병합할 중간 결과 파일이 없습니다.")

    first = openpyxl.load_workbook(files[0])
    output = first
    output_sheet = output.active
    total = output_sheet.max_row - 1

    for path in files[1:]:
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        sheet = workbook.active
        for row in sheet.iter_rows(min_row=2, values_only=True):
            output_sheet.append(list(row))
            total += 1

    # 첫 파일의 열 너비·머리글 스타일을 유지하고 추가 행에는 기본 정렬만 적용한다.
    for cell in output_sheet[1]:
        cell.font = copy(cell.font)
        cell.fill = copy(cell.fill)
        cell.alignment = copy(cell.alignment)
    output_sheet.freeze_panes = "A2"
    target.parent.mkdir(parents=True, exist_ok=True)
    output.save(target)
    print(f"✅ 전체 결과 병합: {target} ({total}건, {len(files)}개 파일)")


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    matrix_parser = subparsers.add_parser("matrix")
    matrix_parser.add_argument("input", type=Path)

    slice_parser = subparsers.add_parser("slice")
    slice_parser.add_argument("input", type=Path)
    slice_parser.add_argument("output", type=Path)
    slice_parser.add_argument("start", type=int)
    slice_parser.add_argument("end", type=int)

    combine_parser = subparsers.add_parser("combine")
    combine_parser.add_argument("source_dir", type=Path)
    combine_parser.add_argument("output", type=Path)

    args = parser.parse_args()
    if args.command == "matrix":
        print_matrix(args.input)
    elif args.command == "slice":
        write_slice(args.input, args.output, args.start, args.end)
    else:
        combine_results(args.source_dir, args.output)


if __name__ == "__main__":
    main()
