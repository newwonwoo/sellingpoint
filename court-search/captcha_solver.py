"""
대법원 나의사건검색 캡차 풀이 모듈
- EasyOCR로 숫자 6자리 인식 (모델 학습 불필요)
- 참고: github.com/JWP9412/save_case_ing
"""

import io
import re
from PIL import Image, ImageFilter, ImageEnhance, ImageOps

# EasyOCR은 첫 실행 시 모델 다운로드 (약 100MB, 이후 캐시)
_reader = None

def _get_reader():
    global _reader
    if _reader is None:
        import easyocr
        _reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    return _reader


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
            answer = max(counts, key=lambda d: (counts[d][0], counts[d][1]))
            print(f"  캡차 후보: {', '.join(f'{d}:{n}' for d,(n,_) in counts.items())}")
            return answer
        return None
    except Exception as e:
        print(f"캡차 OCR 실패: {e}")
        return None
