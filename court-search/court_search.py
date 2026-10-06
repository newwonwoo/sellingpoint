"""
대법원 나의사건검색 자동조회 스크립트
- 대상: https://ssgo.scourt.go.kr/ssgo/index.on?cortId=www (신규 WebSquare 기반)
- input.xlsx: 법원, 사건번호 → output.xlsx: 22개 칼럼 결과
- 캡차: blob URL → 요소 screenshot → EasyOCR (숫자 6자리)
- 최대 20회 캡차 재시도
"""

import asyncio
import sys
import os
import io
import re
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from playwright.async_api import async_playwright, Page, TimeoutError as PlaywrightTimeout

sys.path.insert(0, os.path.dirname(__file__))
from captcha_solver import predict_captcha

# ──────────────────────────────────────────────
# 설정
# ──────────────────────────────────────────────
TARGET_URL = 'https://ssgo.scourt.go.kr/ssgo/index.on?cortId=www'
MAX_CAPTCHA_RETRY = 20
HEADLESS = True

INPUT_FILE  = 'input.xlsx'
OUTPUT_FILE = 'output.xlsx'

OUTPUT_HEADERS = [
    '법원', '사건번호', '사건명', '재판부',
    '접수일', '종국결과', '결정문송달일', '확정일',
    '진행_1일자', '진행_1내용', '진행_1결과',
    '진행_2일자', '진행_2내용', '진행_2결과',
    '진행_3일자', '진행_3내용', '진행_3결과',
    '관련사건_법원', '관련사건_번호',
    '신청인', '피신청인', '조회일시',
]

# ── 신규 사이트 법원코드 매핑 ──────────────────
# select#mf_ssgoTopMainTab_contents_content1_body_sbx_cortCd 의 option value
COURT_NAME_MAP = {
    '대법원':           '100000',
    '서울고등법원':     '200000',
    '서울중앙지방법원': '201000',
    '서울동부지방법원': '201010',
    '서울남부지방법원': '201020',
    '서울북부지방법원': '201030',
    '서울서부지방법원': '201040',
    '서울가정법원':     '201050',
    '서울행정법원':     '201060',
    '서울회생법원':     '201070',
    '의정부지방법원':   '202000',
    '인천지방법원':     '203000',
    '인천가정법원':     '203010',
    '수원지방법원':     '204000',
    '수원가정법원':     '204010',
    '수원회생법원':     '204020',
    '수원고등법원':     '204500',
    '춘천지방법원':     '205000',
    '부산고등법원':     '300000',
    '부산지방법원':     '301000',
    '부산가정법원':     '301010',
    '부산회생법원':     '301020',
    '울산지방법원':     '302000',
    '울산가정법원':     '302010',
    '창원지방법원':     '303000',
    '대구고등법원':     '400000',
    '대구지방법원':     '401000',
    '대구가정법원':     '401010',
    '대구회생법원':     '401020',
    '광주고등법원':     '500000',
    '광주지방법원':     '501000',
    '광주가정법원':     '501010',
    '광주회생법원':     '501020',
    '전주지방법원':     '502000',
    '대전고등법원':     '600000',
    '대전지방법원':     '601000',
    '대전가정법원':     '601010',
    '대전회생법원':     '601020',
    '청주지방법원':     '602000',
    '제주지방법원':     '700000',
}

# ── 신규 사이트 사건구분 매핑 ──────────────────
# select#mf_ssgoTopMainTab_contents_content1_body_sbx_csDvsCd 의 option value
# (실제 option 값은 사이트마다 다를 수 있음 — 숫자 대신 한글 코드)
CASE_TYPE_MAP = {
    '가':   'A',  '나':   'B',  '다':   'C',  '라':   'D',
    '마':   'E',  '바':   'F',  '사':   'G',  '아':   'H',
    '자':   'I',  '차':   'J',  '카':   'K',  '타':   'L',
    '파':   'M',  '하':   'N',  '거':   'O',  '너':   'P',
    '더':   'Q',  '러':   'R',  '머':   'S',  '버':   'T',
    '서':   'U',  '어':   'V',  '저':   'W',  '처':   'X',
    '커':   'Y',  '터':   'Z',
    '가단': 'GA', '가합': 'GB', '고':   'GO', '고합': 'GH',
    '노':   'NO', '초기': 'CK', '기':   'KI',
}

# ── WebSquare 셀렉터 (신규 사이트) ────────────
SEL_COURT   = '#mf_ssgoTopMainTab_contents_content1_body_sbx_cortCd'
SEL_YEAR    = '#mf_ssgoTopMainTab_contents_content1_body_sbx_csYr'
SEL_TYPE    = '#mf_ssgoTopMainTab_contents_content1_body_sbx_csDvsCd'
SEL_SERIAL  = '#mf_ssgoTopMainTab_contents_content1_body_ibx_csSerial'
SEL_CAPTCHA_INPUT  = '#mf_ssgoTopMainTab_contents_content1_body_ibx_answer'
SEL_CAPTCHA_IMG    = '#mf_ssgoTopMainTab_contents_content1_body_img_captcha'
SEL_CAPTCHA_RELOAD = '#mf_ssgoTopMainTab_contents_content1_body_btn_reloadCaptcha'
SEL_SEARCH  = '#mf_ssgoTopMainTab_contents_content1_body_btn_srchCs'


# ──────────────────────────────────────────────
# 엑셀 입력 읽기
# ──────────────────────────────────────────────
def read_input(path: str) -> list[dict]:
    wb = openpyxl.load_workbook(path)
    ws = wb.active
    rows = []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if not row[0] and not row[1]:
            continue
        rows.append({'row': i, 'court': str(row[0]).strip(), 'case_no': str(row[1]).strip()})
    return rows


# ──────────────────────────────────────────────
# 사건번호 파싱: "2026타인3944" → (year, type_str, serial)
# ──────────────────────────────────────────────
def parse_case_no(case_no: str):
    m = re.match(r'(\d{4})([가-힣]+)(\d+)', case_no)
    if not m:
        raise ValueError(f"사건번호 형식 오류: {case_no}")
    return m.group(1), m.group(2), m.group(3)


# ──────────────────────────────────────────────
# 신규 사이트 캡차 처리 (blob URL → 요소 screenshot)
# ──────────────────────────────────────────────
async def get_captcha_answer(page: Page) -> str | None:
    """캡차 img 요소를 직접 screenshot해서 ML 예측"""
    try:
        captcha_el = page.locator(SEL_CAPTCHA_IMG)
        await captcha_el.wait_for(timeout=5000)
        img_bytes = await captcha_el.screenshot()
        return predict_captcha(img_bytes)
    except Exception as e:
        print(f"  캡차 이미지 캡처 실패: {e}")
        return None


# ──────────────────────────────────────────────
# WebSquare select 선택 (일반 select_option 미작동 시 JS 폴백)
# ──────────────────────────────────────────────
async def ws_select(page: Page, selector: str, value: str):
    """WebSquare select 요소 값 설정"""
    try:
        await page.select_option(selector, value=value)
        await page.wait_for_timeout(300)
    except Exception:
        # WebSquare는 커스텀 컴포넌트일 수 있어 JS로 폴백
        await page.eval_on_selector(
            selector,
            f"(el, v) => {{ el.value = v; el.dispatchEvent(new Event('change', {{bubbles:true}})); }}",
            value
        )
        await page.wait_for_timeout(300)


# ──────────────────────────────────────────────
# 결과 파싱 (신규 사이트 구조 기준)
# ──────────────────────────────────────────────
async def parse_result(page: Page, court: str, case_no: str) -> dict:
    """검색 결과 화면에서 데이터 추출"""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    data = {h: '' for h in OUTPUT_HEADERS}
    data['법원'] = court
    data['사건번호'] = case_no
    data['조회일시'] = now

    try:
        # ── th 라벨로 값 추출 (테이블 기반) ──────
        async def get_by_label(label: str) -> str:
            try:
                # th 안에 label 텍스트가 포함된 요소 찾고 sibling td 추출
                loc = page.locator(f'th:has-text("{label}")')
                if await loc.count() == 0:
                    # WebSquare div/span 기반 시도
                    loc = page.locator(f'*:has-text("{label}")').filter(
                        has=page.locator('xpath=following-sibling::*[1]')
                    )
                    if await loc.count() == 0:
                        return ''
                    sib = loc.first.locator('xpath=following-sibling::*[1]')
                    return (await sib.inner_text()).strip()
                td = loc.first.locator('xpath=following-sibling::td[1]')
                return (await td.inner_text()).strip()
            except Exception:
                return ''

        data['사건명']       = await get_by_label('사건명')
        data['재판부']       = await get_by_label('재판부')
        data['접수일']       = await get_by_label('접수일')
        data['종국결과']     = await get_by_label('종국결과')
        data['결정문송달일'] = await get_by_label('결정문송달일')
        data['확정일']       = await get_by_label('확정일')

        # ── 진행내용 탭 ───────────────────────────
        try:
            # 신규 사이트의 진행내용 탭 버튼 (텍스트로 탐색)
            tab_btn = page.locator('button, a, div[role="tab"]').filter(has_text='진행내용')
            if await tab_btn.count() > 0:
                await tab_btn.first.click()
                await page.wait_for_timeout(1000)

            # 진행 행 추출 (날짜 + 내용 패턴)
            prog_rows = page.locator('table tbody tr').filter(
                has=page.locator('td')
            )
            cnt = await prog_rows.count()
            collected = []
            for i in range(cnt):
                tr = prog_rows.nth(i)
                tds = tr.locator('td')
                if await tds.count() >= 2:
                    d = (await tds.nth(0).inner_text()).strip()
                    # 날짜 패턴 확인 (YYYY.MM.DD 또는 YYYY-MM-DD)
                    if re.match(r'\d{4}[.\-]\d{2}[.\-]\d{2}', d):
                        content_text = (await tds.nth(1).inner_text()).strip()
                        result_text = (await tds.nth(2).inner_text()).strip() if await tds.count() > 2 else ''
                        collected.append((d, content_text, result_text))

            # 최신 3건 (뒤에서부터)
            for slot_idx, (d, c, r) in enumerate(collected[-3:][::-1], 1):
                data[f'진행_{slot_idx}일자'] = d
                data[f'진행_{slot_idx}내용'] = c
                data[f'진행_{slot_idx}결과'] = r
        except Exception as e:
            print(f"  진행내용 파싱 오류: {e}")

        # ── 관련사건 ──────────────────────────────
        try:
            rel_section = page.locator('table, div').filter(has_text='관련사건')
            if await rel_section.count() > 0:
                rel_rows = rel_section.first.locator('tbody tr')
                if await rel_rows.count() > 0:
                    tds = rel_rows.first.locator('td')
                    if await tds.count() >= 2:
                        data['관련사건_법원'] = (await tds.nth(0).inner_text()).strip()
                        data['관련사건_번호'] = (await tds.nth(1).inner_text()).strip()
        except Exception as e:
            print(f"  관련사건 파싱 오류: {e}")

        # ── 당사자 ────────────────────────────────
        try:
            party_section = page.locator('table, div').filter(has_text='신청인')
            if await party_section.count() > 0:
                p_rows = party_section.first.locator('tbody tr')
                p_cnt = await p_rows.count()
                applicants, respondents = [], []
                for i in range(p_cnt):
                    tr = p_rows.nth(i)
                    tds = tr.locator('td')
                    if await tds.count() < 2:
                        continue
                    role = (await tds.nth(0).inner_text()).strip()
                    name = (await tds.nth(1).inner_text()).strip()
                    if '신청인' in role and '피' not in role:
                        applicants.append(name)
                    elif '피신청인' in role:
                        respondents.append(name)
                data['신청인']   = ', '.join(applicants)
                data['피신청인'] = ', '.join(respondents)
        except Exception as e:
            print(f"  당사자 파싱 오류: {e}")

    except Exception as e:
        print(f"  결과 파싱 전체 오류: {e}")

    return data


# ──────────────────────────────────────────────
# 단건 조회 (신규 사이트)
# ──────────────────────────────────────────────
async def search_one(page: Page, court: str, case_no: str) -> dict:
    print(f"  조회: {court} / {case_no}")

    year, case_type, serial = parse_case_no(case_no)
    court_val = COURT_NAME_MAP.get(court, '')
    if not court_val:
        print(f"  ⚠ 법원명 매핑 없음: {court} — 빈값으로 진행")

    for attempt in range(1, MAX_CAPTCHA_RETRY + 1):
        try:
            # 페이지 이동 (첫 시도만 full load, 이후는 캡차 새로고침만)
            if attempt == 1:
                await page.goto(TARGET_URL, wait_until='networkidle', timeout=40000)
                # WebSquare 초기화 대기
                await page.wait_for_selector(SEL_COURT, timeout=15000)

            # ── 법원 선택 ──
            if court_val:
                await ws_select(page, SEL_COURT, court_val)

            # ── 연도 ──
            await ws_select(page, SEL_YEAR, year)

            # ── 사건구분 ──
            type_val = CASE_TYPE_MAP.get(case_type, '')
            if type_val:
                await ws_select(page, SEL_TYPE, type_val)
            else:
                print(f"  ⚠ 사건구분 매핑 없음: {case_type}")

            # ── 일련번호 ──
            await page.fill(SEL_SERIAL, serial)

            # ── 캡차 ──
            if attempt > 1:
                # 캡차 새로고침 버튼 클릭
                reload_btn = page.locator(SEL_CAPTCHA_RELOAD)
                if await reload_btn.count() > 0:
                    await reload_btn.click()
                    await page.wait_for_timeout(800)

            captcha_answer = await get_captcha_answer(page)
            if captcha_answer:
                print(f"  캡차 예측: {captcha_answer} (시도 {attempt})")
            else:
                print(f"  캡차 OCR 실패 — 재시도 {attempt}")
                await page.wait_for_timeout(500)
                continue

            await page.fill(SEL_CAPTCHA_INPUT, captcha_answer)

            # ── 검색 ──
            await page.click(SEL_SEARCH)
            await page.wait_for_timeout(2000)

            # ── 결과 확인 ──
            content = await page.content()

            # 캡차 오류 패턴
            if any(k in content for k in ['자동입력방지', '캡차', 'captcha', '인증번호가 일치하지']):
                print(f"  캡차 불일치 → 재시도")
                continue

            # 사건 없음
            if any(k in content for k in ['사건이 존재하지 않습니다', '조회된 사건이 없습니다', '검색결과가 없습니다']):
                print(f"  ℹ 사건 없음")
                return {h: '' for h in OUTPUT_HEADERS} | {
                    '법원': court, '사건번호': case_no,
                    '사건명': '사건없음', '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                }

            # 성공 → 결과 파싱
            return await parse_result(page, court, case_no)

        except PlaywrightTimeout:
            print(f"  타임아웃 (시도 {attempt}) — 페이지 재로드")
            try:
                await page.goto(TARGET_URL, wait_until='networkidle', timeout=40000)
                await page.wait_for_selector(SEL_COURT, timeout=15000)
            except Exception:
                pass
            continue
        except Exception as e:
            print(f"  오류 (시도 {attempt}): {e}")
            continue

    return {h: '' for h in OUTPUT_HEADERS} | {
        '법원': court, '사건번호': case_no,
        '사건명': '조회실패', '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }


# ──────────────────────────────────────────────
# 엑셀 출력
# ──────────────────────────────────────────────
def write_output(results: list[dict], path: str):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '조회결과'

    header_fill = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid')
    header_font = Font(bold=True, color='FFFFFF', size=10)

    for col, header in enumerate(OUTPUT_HEADERS, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal='center', vertical='center')

    for row_idx, data in enumerate(results, 2):
        for col, header in enumerate(OUTPUT_HEADERS, 1):
            ws.cell(row=row_idx, column=col, value=data.get(header, ''))

    col_widths = {
        1: 20, 2: 16, 3: 24, 4: 20,
        5: 12, 6: 20, 7: 14, 8: 12,
        9: 12, 10: 30, 11: 20,
        12: 12, 13: 30, 14: 20,
        15: 12, 16: 30, 17: 20,
        18: 18, 19: 16,
        20: 24, 21: 24, 22: 18,
    }
    for col, width in col_widths.items():
        ws.column_dimensions[openpyxl.utils.get_column_letter(col)].width = width

    ws.freeze_panes = 'A2'
    wb.save(path)
    print(f"\n✅ 결과 저장: {path} ({len(results)}건)")


# ──────────────────────────────────────────────
# 메인
# ──────────────────────────────────────────────
async def main():
    input_path  = sys.argv[1] if len(sys.argv) > 1 else INPUT_FILE
    output_path = sys.argv[2] if len(sys.argv) > 2 else OUTPUT_FILE

    if not os.path.exists(input_path):
        print(f"입력 파일 없음: {input_path}")
        sys.exit(1)

    cases = read_input(input_path)
    print(f"총 {len(cases)}건 조회 시작\n")

    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=HEADLESS,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
        )
        context = await browser.new_context(
            locale='ko-KR',
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )
        page = await context.new_page()

        for i, case in enumerate(cases, 1):
            print(f"[{i}/{len(cases)}]", end=' ')
            data = await search_one(page, case['court'], case['case_no'])
            results.append(data)
            await asyncio.sleep(2)  # 서버 부하 방지

        await browser.close()

    write_output(results, output_path)


if __name__ == '__main__':
    asyncio.run(main())
