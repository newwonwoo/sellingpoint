"""통과가 확인된 캡차만 누적 학습 데이터셋으로 확정한다."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path


MAX_SAMPLES = 5000


def read_dataset(root: Path) -> tuple[list[dict], int]:
    records = []
    rejected = 0
    for metadata in sorted(root.rglob('labels.jsonl')) if root.exists() else []:
        dataset = metadata.parent
        for raw in metadata.read_text(encoding='utf-8').splitlines():
            try:
                record = json.loads(raw)
                answer = str(record['answer'])
                expected = str(record['sha256'])
                image = (dataset / str(record['image'])).read_bytes()
                actual = hashlib.sha256(image).hexdigest()
                if not re.fullmatch(r'\d{6}', answer) or actual != expected:
                    raise ValueError('invalid confirmed sample')
                records.append({
                    'image_bytes': image,
                    'answer': answer,
                    'source': str(record.get('source') or 'unknown'),
                    'sha256': actual,
                    'accepted_at': str(record.get('accepted_at') or ''),
                })
            except (KeyError, OSError, ValueError, json.JSONDecodeError):
                rejected += 1
    return records, rejected


def merge_datasets(baseline: Path, candidates: list[Path], output: Path) -> dict:
    baseline_records, baseline_rejected = read_dataset(baseline)
    candidate_records = []
    candidate_rejected = 0
    for candidate in candidates:
        records, rejected = read_dataset(candidate)
        candidate_records.extend(records)
        candidate_rejected += rejected

    ordered = {}
    for record in baseline_records + candidate_records:
        # 동일 이미지가 다시 통과해도 한 표본으로만 유지한다.
        ordered[record['sha256']] = record
    retained = list(ordered.values())[-MAX_SAMPLES:]
    baseline_hashes = {record['sha256'] for record in baseline_records}
    final_hashes = {record['sha256'] for record in retained}

    stage = output.with_name(f'{output.name}.staging')
    if stage.exists():
        shutil.rmtree(stage)
    images = stage / 'images'
    images.mkdir(parents=True)
    with (stage / 'labels.jsonl').open('w', encoding='utf-8') as labels:
        for record in retained:
            filename = f"{record['sha256']}.png"
            (images / filename).write_bytes(record['image_bytes'])
            labels.write(json.dumps({
                'image': f'images/{filename}',
                'answer': record['answer'],
                'source': record['source'],
                'sha256': record['sha256'],
                'accepted_at': record['accepted_at'],
            }, ensure_ascii=False) + '\n')

    report = {
        'baseline_valid': len(baseline_records),
        'candidate_valid': len(candidate_records),
        'added': len(final_hashes - baseline_hashes),
        'duplicates': len(baseline_records) + len(candidate_records) - len(ordered),
        'rejected': baseline_rejected + candidate_rejected,
        'pruned': max(0, len(ordered) - len(retained)),
        'final_count': len(retained),
    }
    (stage / 'training-report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    if output.exists():
        shutil.rmtree(output)
    stage.rename(output)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, action='append', default=[])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = merge_datasets(args.baseline, args.candidate, args.output)
    print('✅ 공식 캡차 학습 완료: ' + ', '.join(
        f'{key}={value}' for key, value in report.items()
    ))


if __name__ == '__main__':
    main()
