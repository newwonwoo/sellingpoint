"""
대법원 나의사건검색 캡차 풀이 모듈
- EasyOCR로 숫자 6자리 인식 (모델 학습 불필요)
- 참고: github.com/JWP9412/save_case_ing
"""

import io
import re
from PIL import Image, ImageFilter, ImageEnhance

# EasyOCR은 첫 실행 시 모델 다운로드 (약 100MB, 이후 캐시)
_reader = None

def _get_reader():
    global _reader
    if _reader is None:
        import easyocr
        _reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    return _reader


def preprocess_image(img: Image.Image) -> Image.Image:
    """캡차 이미지 전처리 — 대비 강화 + 샤프닝"""
    img = img.convert('L')                        # 그레이스케일
    img = img.resize((240, 80), Image.LANCZOS)    # 2배 확대 (OCR 정확도 향상)
    img = ImageEnhance.Contrast(img).enhance(2.5) # 대비 강화
    img = img.filter(ImageFilter.SHARPEN)         # 샤프닝
    return img


def predict_captcha(img_bytes: bytes) -> str:
    """
    캡차 이미지 바이트 → 숫자 6자리 문자열 반환
    인식 실패 시 None 반환
    """
    try:
        reader = _get_reader()
        img = Image.open(io.BytesIO(img_bytes))
        img = preprocess_image(img)

        # 바이트로 변환해서 EasyOCR에 전달
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        buf.seek(0)

        results = reader.readtext(buf.read(), allowlist='0123456789', detail=0)
        text = ''.join(results)
        digits = re.sub(r'\D', '', text)  # 숫자만 추출

        if len(digits) >= 6:
            return digits[:6]
        return None
    except Exception as e:
        print(f"캡차 OCR 실패: {e}")
        return None
