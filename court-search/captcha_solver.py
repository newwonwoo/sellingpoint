"""
대법원 나의사건검색 캡차 풀이 모듈
- 기학습된 EasyOCR로 숫자 6자리 인식
- 병렬 조회 워커마다 독립 Reader를 사용해 OCR가 이벤트 루프를 막지 않게 함
- 참고: github.com/JWP9412/save_case_ing
"""

import io
import os
import re
import threading
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance, ImageOps

# EasyOCR은 첫 실행 시 모델 다운로드(약 100MB) 후 캐시한다. Reader 자체는
# 추론 상태를 가지므로 스레드 간 공유하지 않고 OCR 실행 스레드마다 둔다.
_reader_state = threading.local()
_model_init_lock = threading.Lock()
_model_ready = False
_runtime_ready = False
_learn_lock = threading.Lock()
_learned_templates = {str(digit): [] for digit in range(10)}
_accepted_captcha_count = 0
MIN_ACCEPTED_FOR_TEMPLATE = int(os.environ.get('CAPTCHA_LEARN_MIN', '20'))
MAX_TEMPLATES_PER_DIGIT = 200


def _configure_runtime():
    """여러 OCR가 CPU 스레드를 중첩 생성하지 않도록 제한한다."""
    global _runtime_ready
    if _runtime_ready:
        return
    with _model_init_lock:
        if _runtime_ready:
            return
        import torch
        torch_threads = max(1, int(os.environ.get('OCR_TORCH_THREADS', '1')))
        torch.set_num_threads(torch_threads)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            # 이미 병렬 작업이 시작된 뒤에는 변경할 수 없다.
            pass
        _runtime_ready = True

def _get_reader():
    global _model_ready
    reader = getattr(_reader_state, 'reader', None)
    if reader is not None:
        return reader

    _configure_runtime()
    import easyocr

    # 첫 Reader만 잠금 안에서 만들어 모델 다운로드 경쟁을 막는다. 모델
    # 파일이 준비된 뒤에는 각 OCR 스레드가 독립 Reader를 병렬로 로드한다.
    if not _model_ready:
        with _model_init_lock:
            if not _model_ready:
                reader = easyocr.Reader(['en'], gpu=False, verbose=False)
                _model_ready = True
    if reader is None:
        reader = easyocr.Reader(['en'], gpu=False, verbose=False, download_enabled=False)
    _reader_state.reader = reader
    return reader


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


def predict_captcha(img_bytes: bytes) -> str:
    """
    캡차 이미지 바이트 → 숫자 6자리 문자열 반환
    인식 실패 시 None 반환
    """
    try:
        reader = _get_reader()
        original = Image.open(io.BytesIO(img_bytes))
        candidates = []
        for variant in preprocess_variants(original):
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
