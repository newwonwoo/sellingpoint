"""
대법원 캡차 샘플 수집 스크립트
- 실행하면 브라우저에 캡차 이미지가 뜨고, 숫자 6자리 입력 후 Enter
- samples/ 폴더에 0~9 폴더별로 숫자 이미지 저장
- 200~300장 모으면 train_model() 실행

사용법:
  pip install playwright pillow
  playwright install chromium
  python collect_captcha.py
"""

import asyncio
import os
import io
from PIL import Image
import numpy as np
from playwright.async_api import async_playwright

TARGET_URL = 'https://safind.scourt.go.kr/sf/mysafind.jsp'
CAPTCHA_SEL = 'img#captchaImg'   # 실제 셀렉터 — 안 맞으면 아래 주석 참고
SAVE_DIR = os.path.join(os.path.dirname(__file__), 'samples')
CAPTCHA_WIDTH = 120
CAPTCHA_HEIGHT = 40
DIGIT_COUNT = 6


def save_sample(img_bytes: bytes, label: str):
    """캡차 이미지를 6개 숫자 이미지로 분할해 폴더별 저장"""
    img = Image.open(io.BytesIO(img_bytes)).convert('L')
    img = img.resize((CAPTCHA_WIDTH, CAPTCHA_HEIGHT))
    edges = np.linspace(0, CAPTCHA_WIDTH, DIGIT_COUNT + 1)

    for i, (start, end) in enumerate(zip(edges[:-1], edges[1:])):
        if i >= len(label):
            break
        digit = label[i]
        folder = os.path.join(SAVE_DIR, digit)
        os.makedirs(folder, exist_ok=True)
        cropped = img.crop((start, 0, end, CAPTCHA_HEIGHT))
        count = len([f for f in os.listdir(folder) if f.endswith('.png')])
        cropped.save(os.path.join(folder, f"{count:04d}.png"))


def count_samples():
    total = 0
    for d in '0123456789':
        folder = os.path.join(SAVE_DIR, d)
        if os.path.exists(folder):
            total += len([f for f in os.listdir(folder) if f.endswith('.png')])
    return total


async def main():
    print("=== 대법원 캡차 샘플 수집기 ===")
    print(f"저장 위치: {SAVE_DIR}")
    print("캡차 보고 6자리 숫자 입력 → Enter | 틀렸으면 그냥 Enter(건너뜀) | q → 종료\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()

        collected = 0
        while True:
            try:
                await page.goto(TARGET_URL, timeout=15000)
                await page.wait_for_selector(CAPTCHA_SEL, timeout=10000)
            except Exception as e:
                print(f"페이지 로드 실패: {e}")
                input("Enter 치면 재시도...")
                continue

            # 캡차 이미지 스크린샷
            try:
                el = page.locator(CAPTCHA_SEL)
                img_bytes = await el.screenshot()
            except Exception as e:
                print(f"캡차 이미지 캡처 실패: {e}")
                # 셀렉터가 틀렸을 수 있음 — 페이지 전체 스크린샷으로 확인
                await page.screenshot(path="debug_page.png")
                print("debug_page.png 저장됨 — 셀렉터 확인 후 CAPTCHA_SEL 수정하세요")
                break

            # 이미지 미리보기 (터미널에서는 파일로 저장)
            preview_path = os.path.join(os.path.dirname(__file__), '_captcha_preview.png')
            with open(preview_path, 'wb') as f:
                f.write(img_bytes)
            print(f"[샘플 {count_samples()}장] 캡차 이미지 → {preview_path} 저장됨")

            label = input("6자리 숫자 입력 (틀리면 Enter, q=종료): ").strip()
            if label.lower() == 'q':
                break
            if len(label) != 6 or not label.isdigit():
                print("건너뜀\n")
                continue

            save_sample(img_bytes, label)
            collected += 1
            print(f"저장 완료! 누적: {count_samples()}장\n")

        await browser.close()

    total = count_samples()
    print(f"\n=== 수집 완료: 총 {total}장 ===")
    if total >= 600:  # 숫자당 60장 이상
        print("충분한 샘플이 모였습니다. 이제 train_model.py 실행하세요.")
    else:
        print(f"권장 샘플: 600장 이상 (현재 {total}장, {600-total}장 더 필요)")


if __name__ == '__main__':
    asyncio.run(main())
