"""
대법원 나의사건검색 자동조회 스크립트
- input.xlsx: 법원, 사건번호 → output.xlsx: 22개 칼럼 결과
- 하루 1회 배치 실행 용도
- 캡차 실패시 최대 20회 재시도
"""

import asyncio
import sys
import os
import io
import time
import re
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from playwright.async_api import async_playwright, Page, TimeoutError as PlaywrightTimeout

# 캡차 솔버 임포트
sys.path.insert(0, os.path.dirname(__file__))
from captcha_solver import predict_captcha, MODEL_PATH

# ──────────────────────────────────────────────
# 설정
# ──────────────────────────────────────────────
TARGET_URL = 'https://safind.scourt.go.kr/sf/mysafind.jsp'
MAX_CAPTCHA_RETRY = 20
HEADLESS = True          # False 로 바꾸면 브라우저 화면 보임

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

# 법원명 → select value 매핑 (대법원 홈 기준)
COURT_NAME_MAP = {
    '서울중앙지방법원': '101010',
    '서울동부지방법원': '101020',
    '서울남부지방법원': '101030',
    '서울북부지방법원': '101040',
    '서울서부지방법원': '101050',
    '서울가정법원':     '101060',
    '서울행정법원':     '101070',
    '서울회생법원':     '101080',
    '의정부지방법원':   '102010',
    '인천지방법원':     '102020',
    '인천가정법원':     '102030',
    '수원지방법원':     '102040',
    '수원가정법원':     '102050',
    '수원회생법원':     '102060',
    '춘천지방법원':     '103010',
    '대전지방법원':     '104010',
    '대전가정법원':     '104020',
    '대전회생법원':     '104030',
    '청주지방법원':     '104040',
    '대구지방법원':     '105010',
    '대구가정법원':     '105020',
    '대구회생법원':     '105030',
    '부산지방법원':     '106010',
    '부산가정법원':     '106020',
    '부산회생법원':     '106030',
    '울산지방법원':     '106040',
    '울산가정법원':     '106050',
    '창원지방법원':     '106060',
    '광주지방법원':     '107010',
    '광주가정법원':     '107020',
    '광주회생법원':     '107030',
    '전주지방법원':     '107040',
    '제주지방법원':     '108010',
}

# 사건구분 한글 → value
CASE_TYPE_MAP = {
    '가': '1', '나': '2', '다': '3', '라': '4', '마': '5',
    '바': '6', '사': '7', '아': '8', '자': '9', '차': '10',
    '카': '11', '타': '12', '파': '13', '하': '14',
    '가단': '15', '가합': '16', '나': '17', '노': '18',
    '고': '19', '고합': '20', '초기': '21', '기': '22',
}


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
# 캡차 처리
# ──────────────────────────────────────────────
async def get_captcha_answer(page: Page) -> str | None:
    """캡차 이미지를 가져와 ML로 예측"""
    if not os.path.exists(MODEL_PATH):
        print("  ⚠ 캡차 모델 없음 → 수동 입력 모드 (콘솔에 6자리 입력)")
        return None

    # 캡차 이미지 URL에서 바이트 가져오기
    captcha_img = page.locator('#captcha img')
    src = await captcha_img.get_attribute('src')
    base_url = TARGET_URL.rsplit('/', 2)[0]
    img_url = base_url + '/' + src.lstrip('/')

    # 페이지 컨텍스트로 이미지 요청
    response = await page.request.get(img_url)
    img_bytes = await response.body()
    return predict_captcha(img_bytes)


# ──────────────────────────────────────────────
# 결과 파싱
# ──────────────────────────────────────────────
def safe_text(el) -> str:
    if el is None:
        return ''
    return el.strip() if isinstance(el, str) else ''


async def parse_result(page: Page, court: str, case_no: str) -> dict:
    """검색 결과 페이지에서 데이터 추출"""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    data = {h: '' for h in OUTPUT_HEADERS}
    data['법원'] = court
    data['사건번호'] = case_no
    data['조회일시'] = now

    try:
        # ── 기본내용 ──────────────────────────────
        async def get_cell(label: str) -> str:
            try:
                # 라벨 텍스트로 th 찾고 다음 td 값 추출
                th = page.locator(f'th:has-text("{label}")')
                count = await th.count()
                if count == 0:
                    return ''
                td = th.first.locator('xpath=following-sibling::td[1]')
                return (await td.inner_text()).strip()
            except Exception:
                return ''

        data['사건명']       = await get_cell('사건명')
        data['재판부']       = await get_cell('재판부')
        data['접수일']       = await get_cell('접수일')
        data['종국결과']     = await get_cell('종국결과')
        data['결정문송달일'] = await get_cell('결정문송달일')
        data['확정일']       = await get_cell('확정일')

        # ── 진행내용 탭 클릭 ──────────────────────
        try:
            tab = page.locator('li.subTab2, a:has-text("진행내용")')
            if await tab.count() > 0:
                await tab.first.click()
                await page.wait_for_timeout(800)

            rows = page.locator('#subTab2 .tableHor tbody tr, .tabCont2 table tbody tr')
            row_count = await rows.count()
            # 최신 3행 (마지막부터)
            targets = []
            for i in range(row_count - 1, max(row_count - 4, -1), -1):
                targets.append(i)
            targets.reverse()

            for idx, slot in enumerate(targets[:3], 1):
                row = rows.nth(slot)
                cols = row.locator('td')
                col_count = await cols.count()
                if col_count >= 2:
                    data[f'진행_{idx}일자'] = (await cols.nth(0).inner_text()).strip()
                    data[f'진행_{idx}내용'] = (await cols.nth(1).inner_text()).strip()
                    data[f'진행_{idx}결과'] = (await cols.nth(2).inner_text()).strip() if col_count > 2 else ''
        except Exception as e:
            print(f"  진행내용 파싱 오류: {e}")

        # ── 관련사건 ──────────────────────────────
        try:
            rel_rows = page.locator('td:has-text("관련사건") ~ td, .tableHor:has-text("관련사건") tbody tr')
            # 기본내용 화면의 관련사건 테이블
            rel_table = page.locator('table').filter(has_text='관련사건내용')
            if await rel_table.count() > 0:
                r = rel_table.first.locator('tbody tr').first
                tds = r.locator('td')
                if await tds.count() >= 2:
                    data['관련사건_법원'] = (await tds.nth(0).inner_text()).strip()
                    data['관련사건_번호'] = (await tds.nth(1).inner_text()).strip()
            else:
                # 일반 테이블에서 시도
                rows2 = page.locator('table tbody tr').filter(has_text='타경')
                if await rows2.count() > 0:
                    tds = rows2.first.locator('td')
                    if await tds.count() >= 2:
                        data['관련사건_법원'] = (await tds.nth(0).inner_text()).strip()
                        data['관련사건_번호'] = (await tds.nth(1).inner_text()).strip()
        except Exception as e:
            print(f"  관련사건 파싱 오류: {e}")

        # ── 당사자내용 ────────────────────────────
        try:
            party_rows = page.locator('table').filter(has_text='당사자내용')
            if await party_rows.count() == 0:
                party_rows = page.locator('table').filter(has_text='신청인')

            if await party_rows.count() > 0:
                trs = party_rows.first.locator('tbody tr')
                cnt = await trs.count()
                applicants, respondents = [], []
                for i in range(cnt):
                    tr = trs.nth(i)
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
# 단건 조회
# ──────────────────────────────────────────────
async def search_one(page: Page, court: str, case_no: str) -> dict:
    print(f"  조회: {court} / {case_no}")

    year, case_type, serial = parse_case_no(case_no)
    court_val = COURT_NAME_MAP.get(court, '')
    if not court_val:
        print(f"  ⚠ 법원명 매핑 없음: {court}")

    for attempt in range(1, MAX_CAPTCHA_RETRY + 1):
        try:
            await page.goto(TARGET_URL, wait_until='networkidle', timeout=30000)

            # 법원 선택
            if court_val:
                await page.select_option('#sch_bub_nm', value=court_val)
                await page.wait_for_timeout(300)

            # 연도
            await page.select_option('#sel_sa_year', value=year)

            # 사건구분
            type_val = CASE_TYPE_MAP.get(case_type, '')
            if type_val:
                await page.select_option('#sa_gubun', value=type_val)
                await page.wait_for_timeout(300)

            # 일련번호
            await page.fill('#sa_serial', serial)

            # 캡차
            captcha_answer = await get_captcha_answer(page)
            if captcha_answer is None:
                captcha_answer = input(f"  캡차 수동 입력 (시도 {attempt}): ").strip()
            else:
                print(f"  캡차 예측: {captcha_answer} (시도 {attempt})")

            await page.fill('#answer', captcha_answer)

            # 검색 버튼
            await page.click('.tableVer .redBtn, button[type=submit], input[type=submit]')
            await page.wait_for_timeout(1500)

            # 오류 알림 체크
            alert_triggered = False
            def handle_dialog(dialog):
                nonlocal alert_triggered
                alert_triggered = True
                asyncio.create_task(dialog.accept())

            page.on('dialog', handle_dialog)
            await page.wait_for_timeout(500)

            if alert_triggered:
                print(f"  캡차 오류 또는 사건 없음 → 재시도")
                continue

            # 결과 확인
            content = await page.content()
            if '사건이 존재하지 않습니다' in content:
                print(f"  ℹ 사건 없음")
                return {h: '' for h in OUTPUT_HEADERS} | {
                    '법원': court, '사건번호': case_no,
                    '사건명': '사건없음', '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                }

            if '자동입력방지' in content and attempt < MAX_CAPTCHA_RETRY:
                print(f"  캡차 불일치 → 재시도")
                continue

            # 성공 → 파싱
            return await parse_result(page, court, case_no)

        except PlaywrightTimeout:
            print(f"  타임아웃 (시도 {attempt})")
            continue
        except Exception as e:
            print(f"  오류 (시도 {attempt}): {e}")
            continue

    # 최대 재시도 초과
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

    # 헤더 스타일
    header_fill = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid')
    header_font = Font(bold=True, color='FFFFFF', size=10)

    for col, header in enumerate(OUTPUT_HEADERS, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal='center', vertical='center')

    # 데이터
    for row_idx, data in enumerate(results, 2):
        for col, header in enumerate(OUTPUT_HEADERS, 1):
            val = data.get(header, '')
            ws.cell(row=row_idx, column=col, value=val)

    # 열 너비 자동조정
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

    if not os.path.exists(MODEL_PATH):
        print("⚠ 캡차 모델(captcha_model.pkl)이 없습니다.")
        print("  → 수동 입력 모드로 실행하거나, 먼저 captcha_solver.py의 train_model()로 학습하세요.\n")

    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=HEADLESS,
            executable_path='/opt/pw-browsers/chromium',
            args=['--no-sandbox', '--disable-dev-shm-usage']
        )
        context = await browser.new_context(
            locale='ko-KR',
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        )
        page = await context.new_page()

        for i, case in enumerate(cases, 1):
            print(f"[{i}/{len(cases)}]", end=' ')
            data = await search_one(page, case['court'], case['case_no'])
            results.append(data)
            await asyncio.sleep(1)  # 서버 부하 방지

        await browser.close()

    write_output(results, output_path)


if __name__ == '__main__':
    asyncio.run(main())
