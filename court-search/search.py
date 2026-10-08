"""
대법원 나의사건검색 자동조회 스크립트
- 대상: https://ssgo.scourt.go.kr/ssgo/index.on?cortId=www (신규 WebSquare 기반)
- input.xlsx: 법원, 사건번호 → output.xlsx: 25개 칼럼 결과
- 캡차: blob URL → 요소 screenshot → EasyOCR (숫자 6자리)
- 캡차 최대 5회 재시도, 사이트 접속 최대 3회 재시도
"""

import asyncio
import hashlib
import json
import sys
import os
import io
import re
import socket
import threading
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from playwright.async_api import async_playwright, Page, TimeoutError as PlaywrightTimeout

sys.path.insert(0, os.path.dirname(__file__))
from captcha_solver import learn_success, predict_captcha

# ──────────────────────────────────────────────
# 설정
# ──────────────────────────────────────────────
TARGET_URL = 'https://ssgo.scourt.go.kr/ssgo/index.on?cortId=www'
# 캡차가 계속 틀릴 때 한 사건이 지나치게 오래 붙잡히지 않도록 제한한다.
# 정상 환경의 실제 단건 실행은 첫 시도에 통과했다.
MAX_CAPTCHA_RETRY = 5
# 접속 자체가 되지 않는 경우에는 캡차 재시도와 분리한다. 법원 사이트가
# 내려가 있거나 러너에서 연결이 막힌 상태로 20회까지 기다리면 한 건도
# 오래 멈추므로, 짧게 재시도한 뒤 해당 사건을 실패 처리한다.
MAX_CONNECTION_RETRY = 3
# 서로 다른 워커에서도 첫 화면 초기화가 연속으로 실패하면 사이트 전체
# 접속 장애로 본다. 남은 수백 건을 같은 방식으로 소진하지 않기 위한 값이다.
MAX_GLOBAL_CONNECTION_FAILURES = 3
HEADLESS = True

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_FILE = os.path.join(BASE_DIR, 'input.xlsx')
OUTPUT_FILE = os.path.join(BASE_DIR, 'output.xlsx')
CAPTCHA_DATA_DIR = os.environ.get(
    'CAPTCHA_DATA_DIR', os.path.join(BASE_DIR, 'captcha-success')
)
CAPTCHA_SAMPLE_LOCK = threading.Lock()

OUTPUT_HEADERS = [
    '법원', '사건번호', '사건명', '재판부',
    '접수일', '종국결과', '결정문송달일', '확정일',
    '진행_1일자', '진행_1내용', '진행_1결과', '진행_1공시문',
    '진행_2일자', '진행_2내용', '진행_2결과', '진행_2공시문',
    '진행_3일자', '진행_3내용', '진행_3결과', '진행_3공시문',
    '관련사건_법원', '관련사건_번호',
    '신청인', '피신청인', '조회일시',
]

# ── 신규 사이트 법원코드 매핑 ──────────────────
# select#mf_ssgoTopMainTab_contents_content1_body_sbx_cortCd 의 option value
COURT_NAME_MAP = {
    '대법원': '대법원',
    '서울고등법원': '서울고등법원',
    '서울중앙지방법원': '서울중앙지방법원',
    '서울동부지방법원': '서울동부지방법원',
    '서울남부지방법원': '서울남부지방법원',
    '서울북부지방법원': '서울북부지방법원',
    '서울서부지방법원': '서울서부지방법원',
    '서울가정법원': '서울가정법원',
    '서울행정법원': '서울행정법원',
    '서울회생법원': '서울회생법원',
    '의정부지방법원': '의정부지방법원',
    '인천지방법원': '인천지방법원',
    '인천가정법원': '인천가정법원',
    '수원지방법원': '수원지방법원',
    '수원가정법원': '수원가정법원',
    '수원회생법원': '수원회생법원',
    '수원고등법원': '수원고등법원',
    '춘천지방법원': '춘천지방법원',
    '부산고등법원': '부산고등법원',
    '부산지방법원': '부산지방법원',
    '부산가정법원': '부산가정법원',
    '부산회생법원': '부산회생법원',
    '울산지방법원': '울산지방법원',
    '울산가정법원': '울산가정법원',
    '창원지방법원': '창원지방법원',
    '대구고등법원': '대구고등법원',
    '대구지방법원': '대구지방법원',
    '대구가정법원': '대구가정법원',
    '대구회생법원': '대구회생법원',
    '광주고등법원': '광주고등법원',
    '광주지방법원': '광주지방법원',
    '광주가정법원': '광주가정법원',
    '광주회생법원': '광주회생법원',
    '전주지방법원': '전주지방법원',
    '대전고등법원': '대전고등법원',
    '대전지방법원': '대전지방법원',
    '대전가정법원': '대전가정법원',
    '대전회생법원': '대전회생법원',
    '청주지방법원': '청주지방법원',
    '제주지방법원': '제주지방법원',
}

# ── 신규 사이트 사건구분 매핑 ──────────────────
# select#mf_ssgoTopMainTab_contents_content1_body_sbx_csDvsCd 의 option value
# (실제 option 값은 사이트마다 다를 수 있음 — 숫자 대신 한글 코드)
CASE_TYPE_MAP = {
    '가': '가',  '나':   'B',  '다':   'C',  '라':   'D',
    '마': '마',  '바':   'F',  '사':   'G',  '아':   'H',
    '자': '자',  '차':   'J',  '카':   'K',  '타':   'L',
    '파': '파',  '하':   'N',  '거':   'O',  '너':   'P',
    '더': '더',  '러':   'R',  '머':   'S',  '버':   'T',
    '서': '서',  '어':   'V',  '저':   'W',  '처':   'X',
    '커': '커',  '터':   'Z',
    '가단': '가단', '가합': 'GB', '고':   'GO', '고합': 'GH',
    '노': '노', '초기': 'CK', '기':   'KI',
}

# ── WebSquare 셀렉터 (신규 사이트) ────────────
SEL_COURT   = '#mf_ssgoTopMainTab_contents_content1_body_sbx_cortCd'
SEL_YEAR    = '#mf_ssgoTopMainTab_contents_content1_body_sbx_csYr'
SEL_TYPE    = '#mf_ssgoTopMainTab_contents_content1_body_sbx_csDvsCd'
SEL_SERIAL  = '#mf_ssgoTopMainTab_contents_content1_body_ibx_csSerial'
SEL_PARTY   = '#mf_ssgoTopMainTab_contents_content1_body_ibx_btprNm'
SEL_CAPTCHA_INPUT  = '#mf_ssgoTopMainTab_contents_content1_body_ibx_answer'
SEL_CAPTCHA_IMG    = '#mf_ssgoTopMainTab_contents_content1_body_img_captcha'
SEL_CAPTCHA_RELOAD = '#mf_ssgoTopMainTab_contents_content1_body_btn_reloadCaptcha'
SEL_SEARCH  = '#mf_ssgoTopMainTab_contents_content1_body_btn_srchCs'


# ──────────────────────────────────────────────
# 엑셀 입력 읽기
# ──────────────────────────────────────────────
def read_input(path: str) -> list[dict]:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    headers = {str(c.value).strip(): c.column - 1 for c in ws[1] if c.value is not None}
    if '법원' not in headers or '사건번호' not in headers:
        raise ValueError("입력 파일에 '법원', '사건번호' 열이 필요합니다.")
    party_col = headers.get('당사자명', headers.get('당사자'))
    rows = []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        court = row[headers['법원']] if headers['법원'] < len(row) else None
        case_no = row[headers['사건번호']] if headers['사건번호'] < len(row) else None
        if not court and not case_no: continue
        if not court or not case_no: raise ValueError(f"{i}행: 법원과 사건번호를 모두 입력해야 합니다.")
        party = row[party_col] if party_col is not None and party_col < len(row) else None
        party = str(party).strip() if party is not None else ''
        rows.append({'row': i, 'court': str(court).strip(), 'case_no': str(case_no).strip(),
                     'party_name': party or '주택'})
    return rows


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
async def run_captcha_ocr(
    img_bytes: bytes, executor: ThreadPoolExecutor | None
) -> str | None:
    """CPU OCR를 전용 스레드에서 실행해 다른 브라우저 워커를 막지 않는다."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, predict_captcha, img_bytes)


async def get_captcha_answer(
    page: Page, executor: ThreadPoolExecutor | None
) -> tuple[str | None, bytes | None, str]:
    """캡차 요소를 우선 읽고, 실패하면 렌더링 화면 영역을 저배율로 재캡처한다."""
    try:
        captcha_el = page.locator(SEL_CAPTCHA_IMG)
        await captcha_el.wait_for(timeout=5000)
        img_bytes = await captcha_el.screenshot(animations='disabled')
        answer = await run_captcha_ocr(img_bytes, executor)
        if answer:
            return answer, img_bytes, 'element'

        # 일부 WebSquare 화면은 img 요소 캡처와 실제 표시 화면의 픽셀이
        # 다르게 합성된다. 이때 CSS 배율의 화면 캡처를 OCR에 재시도한다.
        box = await captcha_el.bounding_box()
        if box:
            rendered_bytes = await page.screenshot(clip=box, scale='css')
            answer = await run_captcha_ocr(rendered_bytes, executor)
            if answer:
                print('  캡차 화면 캡처 보조 인식 성공')
            return answer, rendered_bytes, 'rendered'
        return None, None, ''
    except Exception as e:
        print(f"  캡차 이미지 캡처 실패: {e}")
        return None, None, ''


def save_success_captcha(img_bytes: bytes, answer: str, source: str):
    """검색 결과 화면까지 통과한 캡차만 정답 데이터셋으로 저장한다."""
    if not img_bytes or not answer:
        return
    digest = hashlib.sha256(img_bytes).hexdigest()
    root = Path(CAPTCHA_DATA_DIR)
    image_path = root / 'images' / f'{digest}.png'
    metadata_path = root / 'labels.jsonl'
    record = {
        'image': f'images/{image_path.name}',
        'answer': answer,
        'source': source,
        'sha256': digest,
        'accepted_at': datetime.now().isoformat(timespec='seconds'),
    }
    with CAPTCHA_SAMPLE_LOCK:
        image_path.parent.mkdir(parents=True, exist_ok=True)
        if image_path.exists():
            return
        image_path.write_bytes(img_bytes)
        with metadata_path.open('a', encoding='utf-8') as fp:
            fp.write(json.dumps(record, ensure_ascii=False) + '\n')
    learned_count = learn_success(img_bytes, answer)
    print(
        f"  ✅ 통과 캡차 학습 반영: {answer} ({source}, 누적 {learned_count}건)"
    )


# ──────────────────────────────────────────────
# WebSquare select 선택 (일반 select_option 미작동 시 JS 폴백)
# ──────────────────────────────────────────────
async def ws_select(page: Page, selector: str, value: str):
    """WebSquare select 요소를 실제 옵션 값 또는 표시명으로 선택"""
    try:
        await page.select_option(selector, value=value)
    except Exception:
        await page.select_option(selector, label=value)
    await page.wait_for_timeout(300)


async def select_court(page: Page, court: str):
    """실제 사이트 옵션에서 법원명을 찾아 선택; 지원 약칭은 유일할 때만 허용."""
    await page.wait_for_function(
        '(selector) => document.querySelector(selector)?.options.length > 10',
        arg=SEL_COURT, timeout=20000)
    options = await page.locator(SEL_COURT + ' option').evaluate_all(
        '(options) => options.map(o => ({value: o.value, label: o.textContent.trim()}))'
    )
    name = re.sub(r'\s+', '', court)
    # 사이트는 수원지방법원 평택지원을 '평택지원'으로 표시한다.
    if name == '수원지방법원평택지원':
        name = '평택지원'
    exact = [o for o in options if re.sub(r'\s+', '', o['label']) == name]
    # 본원명을 포함한 입력(예: "인천지방법원 부천지원")은 사이트의
    # 표시명("부천지원")으로 끝나는 유일한 지원을 선택한다.
    matches = exact or [o for o in options
                        if name.endswith('지원')
                        and name.endswith(re.sub(r'\s+', '', o['label']))]
    matches = list({o['value']: o for o in matches}.values())
    if len(matches) != 1:
        raise ValueError(f'법원 선택 불가 또는 중복: {court} ({matches})')
    await page.select_option(SEL_COURT, value=matches[0]['value'])
    print(f"  법원 선택 확인: {matches[0]['label']}")
    await page.wait_for_timeout(300)


# ──────────────────────────────────────────────
# 결과 파싱 (신규 사이트 구조 기준)
# ──────────────────────────────────────────────
async def result_tables(page: Page) -> list[dict]:
    """WebSquare 표를 일반적인 행/셀 배열로 변환한다."""
    tables = []
    for frame in page.frames:
        try:
            rows = await frame.locator('table').evaluate_all("""
                tables => tables.map(table => ({
                  text: (table.innerText || '').trim(),
                  rows: Array.from(table.querySelectorAll('tr')).map(row =>
                    Array.from(row.querySelectorAll(':scope > th, :scope > td'))
                      .map(cell => (cell.innerText || '').replace(/\\s+/g, ' ').trim())
                      .filter(Boolean)
                  ).filter(row => row.length)
                })).filter(table => table.rows.length)
            """)
            tables.extend(rows)
        except Exception:
            continue
    return tables


def table_pairs(rows: list[list[str]]) -> dict[str, str]:
    """기본내용 표의 [라벨, 값, 라벨, 값] 구조를 평탄화한다."""
    pairs = {}
    for row in rows:
        for i in range(0, len(row) - 1, 2):
            label, value = row[i].strip(), row[i + 1].strip()
            if label and value and label not in pairs:
                pairs[label] = value
    return pairs


async def click_progress_tab(page: Page):
    """결과 화면의 진행내용 탭을 열어 진행 표를 렌더링한다."""
    for frame in page.frames:
        try:
            clicked = await frame.evaluate("""
                () => {
                  const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
                  const candidates = [...document.querySelectorAll('*')].filter(e => {
                    const text = (e.textContent || '').trim();
                    const value = (e.value || '').trim();
                    const role = e.getAttribute('role') || '';
                    const cls = String(e.className || '');
                    return visible(e) && (text === '진행내용' || value === '진행내용') &&
                      (['A','BUTTON','INPUT'].includes(e.tagName) || role === 'tab' || /tab|trigger|btn/i.test(cls));
                  });
                  if (!candidates.length) return false;
                  candidates[0].click();
                  return true;
                }
            """)
            if clicked:
                for _ in range(20):
                    text = await frame.locator('body').inner_text(timeout=1000)
                    if '공시문' in text or ('진행구분' in text and '내용' in text):
                        return
                    await page.wait_for_timeout(300)
                return
        except Exception:
            continue


async def parse_result(page: Page, court: str, case_no: str) -> dict:
    """기본내용·진행내용·관련사건·당사자 표를 각각 읽는다."""
    data = {h: '' for h in OUTPUT_HEADERS}
    data.update({'법원': court, '사건번호': case_no,
                 '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')})
    tables = await result_tables(page)

    # 기본내용: 사건명·접수일·재판부가 함께 있는 표
    basic = next((t for t in tables if '사건명' in t['text'] and '접수일' in t['text']
                  and '재판부' in t['text']), None)
    if basic:
        pairs = table_pairs(basic['rows'])
        for field in ('사건명', '재판부', '접수일', '종국결과', '결정문송달일', '확정일'):
            data[field] = pairs.get(field, '')

    # 진행내용은 별도 탭에 있으며, 일자/내용 헤더 표를 찾는다.
    await click_progress_tab(page)
    tables = await result_tables(page)
    if os.environ.get('DEBUG_TABLES') == '1':
        print('  결과 표 요약:', [t['text'][:180].replace('\n', '|') for t in tables])
    progress_candidates = [t for t in tables
                           if '일자' in t['text'] and '내용' in t['text']]
    # 최근기일내용 표도 '결과' 열을 포함하므로, 진행내용 표의 고유 열인
    # '공시문'을 먼저 찾고, 구형 화면의 '진행구분' 표기를 다음으로 본다.
    progress = next((t for t in progress_candidates if '공시문' in t['text']), None)
    if progress is None:
        progress = next((t for t in progress_candidates if '진행구분' in t['text']), None)
    if progress is None and progress_candidates:
        progress = progress_candidates[-1]
    collected = []
    if progress:
        for row in progress['rows']:
            if len(row) >= 2 and re.match(r'\d{4}[.\-]\d{2}[.\-]\d{2}', row[0]):
                collected.append((row[0], row[1], row[2] if len(row) > 2 else '', row[3] if len(row) > 3 else ''))
    for slot, (date, content, result, notice) in enumerate(collected[-3:][::-1], 1):
        data[f'진행_{slot}일자'] = date
        data[f'진행_{slot}내용'] = content
        data[f'진행_{slot}결과'] = result
        data[f'진행_{slot}공시문'] = notice

    related = next((t for t in tables if '법원' in t['text'] and '사건번호' in t['text']
                    and '구분' in t['text']), None)
    if related:
        rows = [r for r in related['rows'] if len(r) >= 2 and r[0] not in ('법원',)]
        if rows:
            data['관련사건_법원'], data['관련사건_번호'] = rows[0][0], rows[0][1]

    party = next((t for t in tables if '구분' in t['text'] and '이름' in t['text']), None)
    if party:
        applicants, respondents = [], []
        for row in party['rows']:
            if len(row) < 2 or row[0] == '구분':
                continue
            if '신청인' in row[0] and '피' not in row[0]:
                applicants.append(row[1])
            elif '피신청인' in row[0]:
                respondents.append(row[1])
        data['신청인'], data['피신청인'] = ', '.join(applicants), ', '.join(respondents)
    return data


async def save_result_debug(page: Page, case_no: str):
    """결과 파싱 실패 시 실제 DOM을 보존해 사이트 구조 변경을 진단한다."""
    root = Path(os.environ.get('DEBUG_DIR', '/tmp/court-search-debug'))
    root.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r'[^0-9A-Za-z가-힣_-]', '_', case_no)
    try:
        await page.screenshot(path=str(root / f'{safe}.png'), full_page=True)
    except Exception as e:
        print(f"  결과 화면 캡처 실패: {e}")
    try:
        (root / f'{safe}.html').write_text(await page.content(), encoding='utf-8')
    except Exception as e:
        print(f"  결과 DOM 저장 실패: {e}")
    print(f"  결과 진단 저장: {root / safe}")
    for frame in page.frames:
        try:
            body = (await frame.locator('body').inner_text(timeout=2000)).strip()
            labels = {label: await frame.get_by_text(label, exact=True).count()
                      for label in ('사건명', '재판부', '접수일', '진행내용', '신청인')}
            print(f"  결과 프레임: url={frame.url[:120]} tables={await frame.locator('table').count()} labels={labels} text={len(body)}")
        except Exception as e:
            print(f"  결과 프레임 진단 실패: {e}")


async def wait_for_result_page(
    page: Page,
    expected_case_no: str,
    timeout_ms: int = 12000,
) -> bool:
    """새 사건번호의 기본내용 표가 렌더링될 때까지 기다린다.

    워커 화면을 재사용하므로 직전 사건의 결과 프레임이 잠시 남아 있을 수
    있다. 제목만 확인하면 그 직전 결과를 새 결과로 오인하므로 사건번호도
    함께 확인한다.
    """
    deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
    normalized_case_no = re.sub(r'\s+', '', expected_case_no)
    while asyncio.get_running_loop().time() < deadline:
        for frame in page.frames:
            try:
                text = await frame.locator('body').inner_text(timeout=1000)
                normalized_text = re.sub(r'\s+', '', text)
                if (
                    all(label in text for label in ('사건명', '재판부', '접수일'))
                    and normalized_case_no in normalized_text
                ):
                    return True
            except Exception:
                continue
        await page.wait_for_timeout(300)
    return False


async def restore_search_form(page: Page) -> bool:
    """결과 화면에서 기존 검색 폼으로 돌아와 워커 페이지를 재사용한다."""
    try:
        if await page.locator(SEL_COURT).is_visible(timeout=1000):
            return True
    except Exception:
        pass

    selectors = (
        'input[value="검색화면"]',
        'button:has-text("검색화면")',
        'a:has-text("검색화면")',
    )
    for frame in page.frames:
        for selector in selectors:
            try:
                button = frame.locator(selector).first
                if await button.count() and await button.is_visible():
                    await button.click()
                    await page.wait_for_selector(SEL_COURT, state='visible', timeout=5000)
                    print("  워커 검색화면 재사용 준비 완료")
                    return True
            except Exception:
                continue
    return False


async def diagnose_site_connection(page: Page):
    """전체 접속 실패 시 DNS와 브라우저 밖 HTTP 경로를 한 번만 진단한다."""
    host = urlparse(TARGET_URL).hostname
    try:
        addresses = await asyncio.to_thread(
            socket.getaddrinfo, host, 443, type=socket.SOCK_STREAM
        )
        ips = sorted({entry[4][0] for entry in addresses})
        print(f"  진단 DNS: {host} -> {', '.join(ips)}")
    except Exception as e:
        print(f"  진단 DNS 실패: {type(e).__name__}: {str(e)[:180]}")

    try:
        response = await page.context.request.get(TARGET_URL, timeout=15000)
        print(f"  진단 직접 HTTP: 상태 {response.status}")
    except Exception as e:
        detail = str(e).replace('\n', ' ')[:220]
        print(f"  진단 직접 HTTP 실패: {type(e).__name__}: {detail}")


# ──────────────────────────────────────────────
# 단건 조회 (신규 사이트)
# ──────────────────────────────────────────────
async def search_one(
    page: Page,
    court: str,
    case_no: str,
    party_name: str = '주택',
    prepare_only: bool = False,
    ocr_executor: ThreadPoolExecutor | None = None,
    connection_circuit: dict | None = None,
) -> dict:
    print(f"  조회: {court} / {case_no}")

    year, case_type, serial = parse_case_no(case_no)
    # 워커별 브라우저 화면을 사건마다 새로 열지 않는다. 정상 상태라면 각
    # 워커가 처음 한 번 연 법원 검색 화면을 다음 사건에서도 계속 사용한다.
    page_ready = bool(getattr(page, '_court_search_ready', False))
    if page_ready:
        page_ready = await restore_search_form(page)
        page._court_search_ready = page_ready
    reused_page = page_ready
    stage = '사이트 접속'
    failure_reason = '재시도 한도 초과'
    connection_failures = 0
    if connection_circuit is None:
        connection_circuit = {
            'consecutive_failures': 0,
            'event': asyncio.Event(),
            'diagnosed': False,
        }
    circuit_event = connection_circuit['event']

    for attempt in range(1, (1 if prepare_only else MAX_CAPTCHA_RETRY) + 1):
        try:
            # 페이지 이동. 캡차 불일치 재시도는 현재 화면을 유지하지만,
            # 접속/렌더링 오류 뒤에는 빈 페이지를 재사용하지 않는다.
            if not page_ready:
                stage = '사이트 접속'
                if circuit_event.is_set():
                    failure_reason = '법원 사이트 전체 접속 장애'
                    break
                print(f"  단계 {stage} (시도 {attempt})")
                try:
                    await page.goto(
                        TARGET_URL,
                        wait_until='domcontentloaded',
                        timeout=40000,
                    )
                    # WebSquare 초기화 대기
                    await page.wait_for_selector(SEL_COURT, timeout=15000)
                except Exception:
                    connection_circuit['consecutive_failures'] += 1
                    global_failures = connection_circuit['consecutive_failures']
                    if (
                        global_failures >= MAX_GLOBAL_CONNECTION_FAILURES
                        and not circuit_event.is_set()
                    ):
                        circuit_event.set()
                        print(
                            f"  ⛔ 첫 화면 초기화가 {global_failures}회 연속 실패했습니다. "
                            "남은 사건 조회를 중단합니다."
                        )
                        if not connection_circuit['diagnosed']:
                            connection_circuit['diagnosed'] = True
                            await diagnose_site_connection(page)
                    raise
                else:
                    connection_circuit['consecutive_failures'] = 0
                page_ready = True
                page._court_search_ready = True
                connection_failures = 0

            # ── 법원 선택 ──
            stage = '법원 선택'
            print(f"  단계 {stage}")
            await select_court(page, court)

            # ── 연도 ──
            stage = '사건번호 입력'
            await ws_select(page, SEL_YEAR, year)

            # ── 사건구분 ──
            type_val = CASE_TYPE_MAP.get(case_type, case_type)
            if type_val:
                await ws_select(page, SEL_TYPE, type_val)
            else:
                print(f"  ⚠ 사건구분 매핑 없음: {case_type}")

            # ── 일련번호 ──
            await page.fill(SEL_SERIAL, serial)
            await page.fill(SEL_PARTY, party_name)

            if prepare_only:
                print("  ✅ 입력값 확인 완료 — 검색 제출 생략")
                return {h: '' for h in OUTPUT_HEADERS} | {
                    '법원': court, '사건번호': case_no,
                    '사건명': '입력점검 완료',
                    '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                }

            # ── 캡차 ──
            stage = '캡차 인식'
            if attempt > 1 or reused_page:
                # 캡차 새로고침 버튼 클릭
                reload_btn = page.locator(SEL_CAPTCHA_RELOAD)
                if await reload_btn.count() > 0:
                    await reload_btn.click()
                    await page.wait_for_timeout(800)

            captcha_answer, captcha_image, captcha_source = await get_captcha_answer(
                page, ocr_executor
            )
            if captcha_answer:
                print(f"  캡차 예측: {captcha_answer} (시도 {attempt})")
            else:
                print(f"  캡차 OCR 실패 — 재시도 {attempt}")
                await page.wait_for_timeout(500)
                continue

            await page.fill(SEL_CAPTCHA_INPUT, captcha_answer)

            # ── 검색 ──
            stage = '검색 제출'
            page._last_dialog_message = ''
            await page.click(SEL_SEARCH)

            # ── 결과 확인 ──
            dialog_message = getattr(page, '_last_dialog_message', '')
            if '자동입력 방지문자' in dialog_message and (
                '일치하지' in dialog_message or '다시 입력' in dialog_message
            ):
                print("  캡차 불일치 → 새 캡차로 재시도")
                continue
            if not await wait_for_result_page(page, case_no):
                stage = '결과 화면 대기'
                content = await page.content()
                if any(k in content for k in ['인증번호가 일치하지', '자동입력방지문자가 틀', '자동 입력 방지 문자가 틀']):
                    print("  캡차 불일치 → 재시도")
                    continue
                print("  결과 화면 로딩 실패 — 검색 응답을 확인할 수 없음")
                await save_result_debug(page, case_no)
                return {h: '' for h in OUTPUT_HEADERS} | {
                    '법원': court, '사건번호': case_no,
                    '사건명': '조회실패: 결과 화면 미확인',
                    '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                }

            # 결과 화면의 기본 필드가 확인된 시점에만 OCR 답을 정답으로
            # 확정한다. 캡차 불일치와 응답 미확인 이미지는 저장하지 않는다.
            save_success_captcha(captcha_image, captcha_answer, captcha_source)

            content = await page.content()
            if any(k in content for k in ['사건이 존재하지 않습니다', '조회된 사건이 없습니다', '검색결과가 없습니다']):
                print(f"  ℹ 사건 없음")
                return {h: '' for h in OUTPUT_HEADERS} | {
                    '법원': court, '사건번호': case_no,
                    '사건명': '사건없음', '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                }

            # 성공 → 결과 파싱
            stage = '결과 파싱'
            result = await parse_result(page, court, case_no)
            if not result.get('사건명'):
                await save_result_debug(page, case_no)
                result['사건명'] = '조회실패: 결과 파싱 실패'
                print("  결과 화면은 열렸지만 사건명 추출에 실패")
            else:
                print(f"  ✅ 결과 파싱 완료: 사건명={result['사건명']}")
            return result

        except ValueError as e:
            print(f"  입력 오류: {e}")
            break
        except PlaywrightTimeout as e:
            page_ready = False
            page._court_search_ready = False
            detail = str(e).replace('\n', ' ')[:180]
            # goto뿐 아니라 초기 WebSquare 셀렉터 대기도 사이트 접속 단계다.
            # HTML 일부만 내려오고 초기화가 끝나지 않는 경우도 같은 접속
            # 장애로 분류해야 무한히 재시도하지 않는다.
            if stage == '사이트 접속' or 'Page.goto' in detail or 'navigating to' in detail:
                failure_reason = '법원 사이트 연결 실패'
                connection_failures += 1
                print(f"  ❌ 접속 시간 초과: {TARGET_URL} (단계: {stage}, 시도 {attempt})")
                print(f"  안내: 법원 사이트가 응답하지 않아 새 연결로 재시도합니다 ({connection_failures}/{MAX_CONNECTION_RETRY}).")
            else:
                failure_reason = f'{stage} 단계 시간 초과'
                print(f"  ❌ {stage} 단계 시간 초과 (시도 {attempt}): {detail}")
            if prepare_only:
                break
            if circuit_event.is_set():
                failure_reason = '법원 사이트 전체 접속 장애'
                break
            if connection_failures >= MAX_CONNECTION_RETRY:
                print(f"  ⏹ 사이트 접속 {MAX_CONNECTION_RETRY}회 실패 — 이 사건을 중단하고 다음 사건으로 이동합니다.")
                break
            try:
                await page.wait_for_timeout(min(3000 * attempt, 15000))
            except Exception:
                pass
            continue
        except Exception as e:
            page_ready = False if any(token in str(e) for token in ('ERR_CONNECTION', 'net::', 'Target closed')) else page_ready
            page._court_search_ready = page_ready
            detail = str(e).replace('\n', ' ')[:220]
            if any(token in detail for token in ('ERR_CONNECTION', 'net::', 'Connection timed out')):
                failure_reason = '법원 사이트 연결 실패'
                connection_failures += 1
                print(f"  ❌ 법원 사이트 연결 실패 (단계: {stage}, 시도 {attempt}): {detail}")
                print(f"  안내: 새 연결로 재시도합니다 ({connection_failures}/{MAX_CONNECTION_RETRY}).")
                if circuit_event.is_set():
                    failure_reason = '법원 사이트 전체 접속 장애'
                    break
                if not prepare_only and connection_failures >= MAX_CONNECTION_RETRY:
                    print(f"  ⏹ 사이트 접속 {MAX_CONNECTION_RETRY}회 실패 — 이 사건을 중단하고 다음 사건으로 이동합니다.")
                    break
            else:
                failure_reason = f'{stage} 단계 오류'
                print(f"  ❌ {stage} 단계 오류 (시도 {attempt}): {detail}")
            continue

    return {h: '' for h in OUTPUT_HEADERS} | {
        '법원': court, '사건번호': case_no,
        '사건명': f'조회실패: {failure_reason}',
        '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
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
        9: 12, 10: 30, 11: 20, 12: 16,
        13: 12, 14: 30, 15: 20, 16: 16,
        17: 12, 18: 30, 19: 20, 20: 16,
        21: 18, 22: 16,
        23: 24, 24: 24, 25: 18,
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
    cli_args = [arg for arg in sys.argv[1:] if arg != '--prepare-only']
    prepare_only = '--prepare-only' in sys.argv[1:]
    input_path = cli_args[0] if cli_args else INPUT_FILE
    output_path = cli_args[1] if len(cli_args) > 1 else OUTPUT_FILE

    if not os.path.exists(input_path):
        print(f"입력 파일 없음: {input_path}")
        sys.exit(1)

    cases = read_input(input_path)
    print(f"총 {len(cases)}건 조회 시작\n")

    # 입력 건수를 먼저 확인하고 최대 3개 워커가 공용 큐에서 한 건씩
    # 가져간다. 먼저 끝난 워커가 다음 순번을 즉시 이어받는다.
    try:
        worker_count = int(os.environ.get('COURT_WORKERS', '3'))
    except ValueError:
        worker_count = 3
    worker_count = max(1, min(worker_count, len(cases))) if cases else 1
    if prepare_only:
        worker_count = 1
    print(f"조회 워커 {worker_count}개로 실행합니다.")

    results = [{} for _ in cases]
    connection_circuit = {
        'consecutive_failures': 0,
        'event': asyncio.Event(),
        'diagnosed': False,
    }
    # EasyOCR 모델은 하나만 메모리에 올린다. 캡차 요청은 이 전용 실행부에
    # 순서대로 들어가며 브라우저 3개는 네트워크/결과 대기를 계속 병렬 수행한다.
    ocr_executor = ThreadPoolExecutor(
        max_workers=1, thread_name_prefix='captcha-ocr'
    )
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=HEADLESS,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
        )

        async def make_page(worker_id: int):
            context = await browser.new_context(
                locale='ko-KR',
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            page = await context.new_page()
            page._last_dialog_message = ''

            async def handle_dialog(dialog):
                page._last_dialog_message = dialog.message
                print(f"  워커 {worker_id} 사이트 알림: {dialog.message[:300]}")
                await dialog.dismiss()

            page.on('dialog', handle_dialog)
            return context, page

        pages = [await make_page(worker_id) for worker_id in range(worker_count)]

        async def run_batch(indices, retry=False):
            """인덱스 목록을 워커에 나눠 실행하고 결과 순서는 원본을 유지한다."""
            queue = asyncio.Queue()
            retry_positions = {idx: pos + 1 for pos, idx in enumerate(indices)}
            retry_total = len(indices)
            for idx in indices:
                queue.put_nowait(idx)

            async def worker(worker_id, page):
                while True:
                    if connection_circuit['event'].is_set():
                        return
                    try:
                        idx = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        return
                    case = cases[idx]
                    if retry:
                        prefix = f"재시도 {retry_positions[idx]}/{retry_total}"
                    else:
                        prefix = f"{idx + 1}/{len(cases)}"
                    print(f"[{prefix} 워커 {worker_id + 1}]", end=' ')
                    try:
                        results[idx] = await search_one(
                            page,
                            case['court'],
                            case['case_no'],
                            case['party_name'],
                            prepare_only,
                            ocr_executor,
                            connection_circuit,
                        )
                    finally:
                        queue.task_done()

            await asyncio.gather(*[
                worker(worker_id, page) for worker_id, (_, page) in enumerate(pages)
            ])

        await run_batch(range(len(cases)))

        # 전역 접속 차단기가 열린 뒤 큐에서 시작하지 못한 사건도 결과 파일에
        # 반드시 남긴다. 이미 성공한 사건과 개별 실패 결과는 그대로 보존한다.
        if connection_circuit['event'].is_set():
            deferred = 0
            for idx, data in enumerate(results):
                if data:
                    continue
                deferred += 1
                results[idx] = {h: '' for h in OUTPUT_HEADERS} | {
                    '법원': cases[idx]['court'],
                    '사건번호': cases[idx]['case_no'],
                    '사건명': '조회보류: 법원 사이트 접속 불가',
                    '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                }
            print(
                f"\n⛔ 사이트 첫 화면이 {MAX_GLOBAL_CONNECTION_FAILURES}회 연속 "
                f"열리지 않아 남은 {deferred}건을 조회보류로 저장합니다."
            )

        # 1차 조회에서 접속 장애·캡차 오류 등으로 실패한 사건만 마지막에
        # 한 번 더 시도한다. 성공한 행은 그대로 보존하고, 재시도 결과가
        # 실패해도 최신 실패 사유를 결과 파일에 남긴다.
        if not prepare_only and not connection_circuit['event'].is_set():
            failed = [
                idx for idx, data in enumerate(results)
                if str(data.get('사건명', '')).startswith('조회실패')
            ]
            if failed:
                print(f"\n실패 사건 재조회 시작: {len(failed)}건 (각 사건 1회)")
                await run_batch(failed, retry=True)

        await browser.close()
    ocr_executor.shutdown(wait=True)

    write_output(results, output_path)


if __name__ == '__main__':
    asyncio.run(main())
