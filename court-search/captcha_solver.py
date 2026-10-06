"""
대법원 나의사건검색 캡차 풀이 모듈
- 캡차 이미지(120x40px, 숫자 6자리)를 Scikit-learn SVM으로 예측
- 모델 파일이 없으면 샘플 이미지 수집 후 학습 필요
"""

import numpy as np
import pickle
import io
import os
from PIL import Image, ImageFilter, ImageEnhance


MODEL_PATH = os.path.join(os.path.dirname(__file__), 'captcha_model.pkl')

# 캡차 이미지 고정 크기: 120 x 40, 6자리 숫자
CAPTCHA_WIDTH = 120
CAPTCHA_HEIGHT = 40
DIGIT_COUNT = 6


def preprocess_image(img: Image.Image) -> Image.Image:
    """캡차 이미지 전처리 (그레이스케일 + 이진화)"""
    img = img.convert('L')  # 그레이스케일
    img = img.resize((CAPTCHA_WIDTH, CAPTCHA_HEIGHT))
    return img


def split_digits(img: Image.Image) -> list:
    """이미지를 6개 숫자로 분할"""
    edges = np.linspace(0, CAPTCHA_WIDTH, DIGIT_COUNT + 1)
    digits = []
    for start, end in zip(edges[:-1], edges[1:]):
        box = (start, 0, end, CAPTCHA_HEIGHT)
        cropped = img.crop(box)
        cropped.load()
        arr = np.array(cropped)
        digits.append(arr.flatten())
    return digits


def predict_captcha(img_bytes: bytes) -> str:
    """
    캡차 이미지 바이트를 받아 숫자 문자열(6자리) 반환
    모델이 없으면 None 반환
    """
    if not os.path.exists(MODEL_PATH):
        return None

    model = pickle.load(open(MODEL_PATH, 'rb'))
    img = Image.open(io.BytesIO(img_bytes))
    img = preprocess_image(img)
    digits = split_digits(img)
    pred = model.predict(digits)
    return ''.join(str(p) for p in pred)


def train_model(image_dir: str, output_path: str = MODEL_PATH):
    """
    학습 데이터로 모델 훈련
    image_dir: '0/' ~ '9/' 폴더에 각 숫자 이미지가 있어야 함
    """
    from sklearn.svm import SVC
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    X, y = [], []
    for digit in range(10):
        folder = os.path.join(image_dir, str(digit))
        if not os.path.exists(folder):
            continue
        for fname in os.listdir(folder):
            fpath = os.path.join(folder, fname)
            try:
                img = Image.open(fpath)
                img = preprocess_image(img)
                arr = np.array(img).flatten()
                X.append(arr)
                y.append(str(digit))
            except Exception:
                continue

    if not X:
        print("학습 데이터 없음. image_dir 구조: 0/, 1/, ... 9/ 폴더에 이미지 저장")
        return None

    clf = make_pipeline(StandardScaler(), SVC(kernel='rbf', C=10, gamma='scale'))
    clf.fit(X, y)
    pickle.dump(clf, open(output_path, 'wb'))
    print(f"모델 저장 완료: {output_path} (샘플 {len(X)}개)")
    return clf


def save_captcha_sample(img_bytes: bytes, label: str, save_dir: str):
    """
    캡차 이미지 + 정답 레이블 저장 (학습 데이터 수집용)
    save_dir/digit/ 폴더에 각 숫자 이미지 저장
    """
    img = Image.open(io.BytesIO(img_bytes))
    img = preprocess_image(img)
    edges = np.linspace(0, CAPTCHA_WIDTH, DIGIT_COUNT + 1)

    for i, (start, end) in enumerate(zip(edges[:-1], edges[1:])):
        if i >= len(label):
            break
        digit = label[i]
        folder = os.path.join(save_dir, digit)
        os.makedirs(folder, exist_ok=True)
        box = (start, 0, end, CAPTCHA_HEIGHT)
        cropped = img.crop(box)
        count = len(os.listdir(folder))
        cropped.save(os.path.join(folder, f"{count:04d}.png"))
