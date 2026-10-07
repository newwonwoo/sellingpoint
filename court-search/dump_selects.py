"""
신규 대법원 사이트의 select option 목록 수집 스크립트
실행: python dump_selects.py
목적: 법원코드·사건구분 코드 확인
"""
import asyncio
from playwright.async_api import async_playwright

TARGET_URL = 'https://ssgo.scourt.go.kr/ssgo/index.on?cortId=www'

SEL_COURT = '#mf_ssgoTopMainTab_contents_content1_body_sbx_cortCd'
SEL_YEAR  = '#mf_ssgoTopMainTab_contents_content1_body_sbx_csYr'
SEL_TYPE  = '#mf_ssgoTopMainTab_contents_content1_body_sbx_csDvsCd'


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage']
        )
        page = await browser.new_page(
            locale='ko-KR',
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        )
        print(f"페이지 접속: {TARGET_URL}")
        await page.goto(TARGET_URL, wait_until='networkidle', timeout=40000)
        await page.wait_for_selector(SEL_COURT, timeout=15000)
        print("페이지 로드 완료\n")

        for label, sel in [('법원(cortCd)', SEL_COURT), ('연도(csYr)', SEL_YEAR), ('사건구분(csDvsCd)', SEL_TYPE)]:
            print(f"=== {label} ===")
            options = await page.eval_on_selector(
                sel,
                "el => Array.from(el.options).map(o => ({v: o.value, t: o.text.trim()}))"
            )
            for opt in options:
                print(f"  '{opt['t']}': '{opt['v']}',")
            print()

        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
