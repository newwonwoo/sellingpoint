"""
대법원 나의사건검색 캡차 풀이 모듈
- 기학습된 EasyOCR로 숫자 6자리 인식
- 브라우저 워커와 분리된 단일 OCR 실행부에서 모델을 한 번만 적재
- 참고: github.com/JWP9412/save_case_ing
"""

import io
import hashlib
import json
import os
import re
import threading
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance, ImageOps

# OCR는 전용 단일 스레드에서만 호출하므로 Reader를 한 번만 적재한다.
_reader = None
_runtime_ready = False
_learn_lock = threading.Lock()
_learned_templates = {str(digit): [] for digit in range(10)}
_accepted_captcha_count = 0
MIN_ACCEPTED_FOR_TEMPLATE = int(os.environ.get('CAPTCHA_LEARN_MIN', '20'))
MAX_TEMPLATES_PER_DIGIT = 200
FAST_PATH_ENABLED = os.environ.get('CAPTCHA_FAST_PATH', '').lower() in {
    '1', 'true', 'yes', 'on'
}
FAST_PATH_VARIANTS = max(2, int(os.environ.get('CAPTCHA_FAST_VARIANTS', '4')))
FAST_PATH_MIN_VOTES = max(2, int(os.environ.get('CAPTCHA_FAST_MIN_VOTES', '3')))
FAST_PATH_MIN_CONFIDENCE = float(
    os.environ.get('CAPTCHA_FAST_MIN_CONFIDENCE', '0.55')
)


def _configure_runtime():
    """OCR가 브라우저 워커의 CPU까지 독점하지 않도록 제한한다."""
    global _runtime_ready
    if _runtime_ready:
        return
    import torch
    torch_threads = max(1, int(os.environ.get('OCR_TORCH_THREADS', '2')))
    torch.set_num_threads(torch_threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    _runtime_ready = True

def _get_reader():
    global _reader
    if _reader is None:
        _configure_runtime()
        import easyocr
        model_dir = os.environ.get('EASYOCR_MODEL_DIR', '').strip()
        options = {}
        if model_dir:
            options = {
                'model_storage_directory': model_dir,
                # 고속 런타임 캐시에 모델이 없으면 조용히 다시 내려받지 않고
                # 준비 단계에서 즉시 실패시켜 캐시를 재생성한다.
                'download_enabled': False,
            }
        _reader = easyocr.Reader(['en'], gpu=False, verbose=False, **options)
    return _reader


def warmup_captcha_solver():
    """첫 사건 전에 OCR 모델을 적재해 동시 워커의 초기 대기를 없앤다."""
    _get_reader()


def preprocess_variants(img: Image.Image) -> list[Image.Image]:
    """선·배경 노이즈가 다른 캡차를 위해 여러 입력을 만든다."""
    gray = img.convert('L').resize((360, 120), Image.Resampling.LANCZOS)
    contrast = ImageOps.autocontrast(gray)
    sharp = ImageEnhance.Sharpness(ImageEnhance.Contrast(contrast).enhance(2.5)).enhance(2.0)
    median = sharp.filter(ImageFilter.MedianFilter(3))
    variants = [gray, contrast, sharp, median]
    for threshold in (130, 165, 200):
        variants.append(sharp.point(lambda p, t=threshold: 255 if p > t else 0))
    return variants


def _digit_slices(img_bytes: bytes) -> list[np.ndarray]:
    """통과 캡차를 6개 숫자 템플릿으로 정규화한다."""
    img = Image.open(io.BytesIO(img_bytes)).convert('L')
    img = ImageOps.autocontrast(img).filter(ImageFilter.MedianFilter(3))
    img = img.resize((180, 60), Image.Resampling.LANCZOS)
    slices = []
    for idx in range(6):
        digit = img.crop((idx * 30, 0, (idx + 1) * 30, 60))
        digit = digit.resize((16, 32), Image.Resampling.LANCZOS)
        slices.append(np.asarray(digit, dtype=np.float32) / 255.0)
    return slices


def learn_success(img_bytes: bytes, answer: str) -> int:
    """사이트가 통과시킨 이미지/정답만 온라인 템플릿에 학습한다."""
    global _accepted_captcha_count
    if not img_bytes or not re.fullmatch(r'\d{6}', answer or ''):
        return _accepted_captcha_count
    try:
        digits = _digit_slices(img_bytes)
    except Exception:
        return _accepted_captcha_count
    with _learn_lock:
        for label, template in zip(answer, digits):
            bank = _learned_templates[label]
            bank.append(template)
            if len(bank) > MAX_TEMPLATES_PER_DIGIT:
                del bank[0]
        _accepted_captcha_count += 1
        return _accepted_captcha_count


def load_success_dataset(root: str | os.PathLike) -> dict:
    """이전 실행에서 확정한 통과 샘플을 온라인 템플릿에 적재한다."""
    dataset = Path(root)
    metadata = dataset / 'labels.jsonl'
    stats = {'loaded': 0, 'skipped': 0}
    if not metadata.exists():
        return stats

    seen = set()
    for raw in metadata.read_text(encoding='utf-8').splitlines():
        try:
            record = json.loads(raw)
            answer = str(record['answer'])
            digest = str(record['sha256'])
            image_path = dataset / str(record['image'])
            image = image_path.read_bytes()
            if digest in seen or not re.fullmatch(r'\d{6}', answer):
                raise ValueError('invalid or duplicate sample')
            if hashlib.sha256(image).hexdigest() != digest:
                raise ValueError('sample checksum mismatch')
            before = _accepted_captcha_count
            after = learn_success(image, answer)
            if after == before:
                raise ValueError('sample could not be learned')
            seen.add(digest)
            stats['loaded'] += 1
        except (KeyError, OSError, ValueError, json.JSONDecodeError):
            stats['skipped'] += 1
    return stats


def _predict_learned(img_bytes: bytes) -> tuple[str | None, float]:
    """충분한 통과 샘플이 있을 때만 보조 템플릿 판독을 반환한다."""
    with _learn_lock:
        if _accepted_captcha_count < MIN_ACCEPTED_FOR_TEMPLATE:
            return None, 0.0
        if any(len(_learned_templates[str(digit)]) < 5 for digit in range(10)):
            return None, 0.0
        banks = {
            label: np.stack(templates[-MAX_TEMPLATES_PER_DIGIT:])
            for label, templates in _learned_templates.items()
        }
    try:
        slices = _digit_slices(img_bytes)
    except Exception:
        return None, 0.0

    answer = []
    margins = []
    for digit_img in slices:
        scores = []
        for label, templates in banks.items():
            distances = np.mean((templates - digit_img) ** 2, axis=(1, 2))
            nearest = np.partition(distances, min(2, len(distances) - 1))[:3]
            scores.append((float(np.mean(nearest)), label))
        scores.sort()
        best, label = scores[0]
        second = scores[1][0]
        margin = (second - best) / max(second, 1e-6)
        if best > 0.18 or margin < 0.08:
            return None, 0.0
        answer.append(label)
        margins.append(margin)
    return ''.join(answer), min(margins)


def _result_digits(results) -> tuple[str | None, float]:
    """EasyOCR 결과에서 6자리 답과 가장 높은 신뢰도를 꺼낸다."""
    candidates = []
    for item in results or []:
        if len(item) < 3:
            continue
        digits = re.sub(r'\D', '', str(item[1]))
        if len(digits) >= 6:
            candidates.append((digits[:6], float(item[2])))
    if not candidates:
        return None, 0.0
    return max(candidates, key=lambda candidate: candidate[1])


def _predict_fast(reader, variants: list[Image.Image]) -> str | None:
    """고정 크기 한 줄 캡차는 문자영역 탐지를 생략하고 바로 판독한다."""
    votes: dict[str, tuple[int, float]] = {}
    checked = 0
    for variant in variants[:FAST_PATH_VARIANTS]:
        checked += 1
        # 캡차 전체가 이미 하나의 고정된 문자영역이다. readtext가 매번
        # 수행하는 CRAFT 문자영역 탐지를 생략하면 CPU 비용이 크게 줄어든다.
        results = reader.recognize(
            np.asarray(variant),
            allowlist='0123456789',
            detail=1,
            paragraph=False,
            decoder='greedy',
            batch_size=1,
            workers=0,
        )
        digits, confidence = _result_digits(results)
        if not digits:
            continue
        count, best = votes.get(digits, (0, 0.0))
        votes[digits] = (count + 1, max(best, confidence))
        count, best = votes[digits]
        if count >= FAST_PATH_MIN_VOTES and best >= FAST_PATH_MIN_CONFIDENCE:
            print(
                f"  ⚡ 캡차 고속 인식: {digits} "
                f"({count}/{checked}, 신뢰도 {best:.2f})"
            )
            return digits
    return None


def predict_captcha(img_bytes: bytes, fast_path: bool | None = None) -> str:
    """
    캡차 이미지 바이트 → 숫자 6자리 문자열 반환
    인식 실패 시 None 반환
    """
    try:
        reader = _get_reader()
        original = Image.open(io.BytesIO(img_bytes))
        variants = preprocess_variants(original)
        use_fast_path = FAST_PATH_ENABLED if fast_path is None else fast_path
        if use_fast_path:
            fast_answer = _predict_fast(reader, variants)
            if fast_answer:
                return fast_answer
            print('  캡차 고속 인식 불확실 — 정밀 인식으로 전환')

        candidates = []
        for variant in variants:
            buf = io.BytesIO()
            variant.save(buf, format='PNG')
            results = reader.readtext(
                buf.getvalue(), allowlist='0123456789', detail=1,
                paragraph=False, decoder='beamsearch', mag_ratio=1.0)
            text = ''.join(item[1] for item in results)
            digits = re.sub(r'\D', '', text)
            if len(digits) >= 6:
                confidence = sum(float(item[2]) for item in results)
                candidates.append((digits[:6], confidence))
        if candidates:
            # 여러 전처리에서 같은 답이 나오면 우선하고, 아니면 신뢰도 합이 큰 답을 쓴다.
            counts = {}
            for digits, confidence in candidates:
                total, best = counts.get(digits, (0, 0.0))
                counts[digits] = (total + 1, max(best, confidence))
            learned, learned_confidence = _predict_learned(img_bytes)
            if learned:
                total, best = counts.get(learned, (0, 0.0))
                counts[learned] = (
                    total + 2,
                    max(best, learned_confidence),
                )
                print(f"  통과 샘플 보조 판독: {learned}")
            answer = max(counts, key=lambda d: (counts[d][0], counts[d][1]))
            print(f"  캡차 후보: {', '.join(f'{d}:{n}' for d,(n,_) in counts.items())}")
            return answer
        learned, _ = _predict_learned(img_bytes)
        if learned:
            print(f"  EasyOCR 실패 후 통과 샘플 판독: {learned}")
            return learned
        return None
    except Exception as e:
        print(f"캡차 OCR 실패: {e}")
        return None
