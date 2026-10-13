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
from functools import partial
from pathlib import Path
from datetime import datetime

import openpyxl
from playwright.async_api import async_playwright, Page, TimeoutError as PlaywrightTimeout

sys.path.insert(0, os.path.dirname(__file__))
from captcha_solver import (
    learn_success,
    load_success_dataset,
    predict_captcha,
    warmup_captcha_solver,
)
from output_schema import OUTPUT_HEADERS, write_output
from site_contract import (
    CONTRACT_VERSION,
    FORM_INSPECTION_JS,
    fingerprint as contract_fingerprint,
    inspection_argument,
    json_schema_snapshot,
    selector_union,
    validate_direct_payloads,
)

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
# 서로 다른 브라우저 세션이 모두 첫 화면 초기화에 실패할 때만 사이트 전체
# 접속 장애로 본다. 한 세션의 연속 오류만으로 전체 배치를 중단하면 안 된다.
MAX_GLOBAL_CONNECTION_FAILURES = 3
# 서로 다른 사건에서 같은 API 계약 오류가 반복될 때 전체 워커가 즉시
# 화면 조회 방식으로 전환한다. 한 번의 일시 응답만으로 끄지는 않는다.
MAX_DIRECT_CONTRACT_FAILURES = 2
# API와 화면 방식이 모두 깨진 경우 수백 건을 같은 방식으로 반복하지 않는다.
MAX_GLOBAL_STRUCTURE_FAILURES = 2
HEADLESS = True


def env_enabled(name: str) -> bool:
    return os.environ.get(name, '').strip().lower() in {'1', 'true', 'yes', 'on'}


REUSE_SEARCH_SESSION = env_enabled('COURT_REUSE_SESSION')
FAST_CAPTCHA_PATH = env_enabled('CAPTCHA_FAST_PATH')
IMMEDIATE_RETRY_WORKER = env_enabled('COURT_IMMEDIATE_RETRY')
DIRECT_API_PATH = env_enabled('COURT_DIRECT_API')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_FILE = os.path.join(BASE_DIR, 'input.xlsx')
OUTPUT_FILE = os.path.join(BASE_DIR, 'output.xlsx')
CAPTCHA_DATA_DIR = os.environ.get(
    'CAPTCHA_DATA_DIR', os.path.join(BASE_DIR, 'captcha-success')
)
CAPTCHA_SEED_DIR = os.environ.get(
    'CAPTCHA_SEED_DIR', os.path.join(BASE_DIR, 'captcha-model')
)
CAPTCHA_SAMPLE_LOCK = threading.Lock()

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
SEL_COURT = selector_union('court')
SEL_YEAR = selector_union('year')
SEL_TYPE = selector_union('case_type')
SEL_SERIAL = selector_union('serial')
SEL_PARTY = selector_union('party')
SEL_CAPTCHA_INPUT = selector_union('captcha_input')
SEL_CAPTCHA_IMG = selector_union('captcha_image')
SEL_CAPTCHA_RELOAD = selector_union('captcha_reload')
SEL_SEARCH = selector_union('search')

# 일괄 조회는 검증된 3워커로 시작하고, 최근 처리 속도와 성공률이 안정적인
# 경우에만 네 번째 워커를 연다. 법원 사이트에 같은 실행기에서 5개 이상의
# 동시 연결을 만들지 않도록 코드에서도 상한을 고정한다.
MAX_BATCH_WORKERS = 4
SCALE_SAMPLE_SIZE = 15
SCALE_MAX_AVERAGE_SECONDS = 25.0
RETIRE_SAMPLE_SIZE = 10
RETIRE_MIN_CONNECTION_FAILURES = 2
RETIRE_MAX_AVERAGE_SECONDS = 35.0

# WebSquare 사건유형별 상세조회 API 경로. 현재 실사용 입력인 타인 사건은
# GJ(/ssgo10a/)이며, 다른 유형도 사이트의 공개 화면 매핑을 그대로 따른다.
TASK_API_PATHS = {
    'CV': '101', 'KS': '102', 'HS': '103', 'PT': '104',
    'KA': '105', 'ET': '106', 'HP': '107', 'HJ': '108',
    'JH': '109', 'GJ': '10a', 'DJ': '10b', 'DC': '10c',
    'GW': '10d', 'GO': '10e', 'JJ': '10f', 'HG': '10g',
    'SB': '10h', 'GB': '10i', 'HY': '10j', 'EY': '10k',
    'IB': '10m', 'GS': '10p',
}


# ──────────────────────────────────────────────
# 입력 읽기 (일괄=xlsx, 단건=json)
# ──────────────────────────────────────────────
def read_input(path: str) -> list[dict]:
    if Path(path).suffix.lower() == '.json':
        payload = json.loads(Path(path).read_text(encoding='utf-8'))
        items = payload.get('cases', [payload]) if isinstance(payload, dict) else payload
        rows = []
        for index, item in enumerate(items, start=1):
            court = str(item.get('court') or '').strip()
            case_no = str(item.get('case_no') or item.get('caseNo') or '').strip()
            party = str(item.get('party_name') or item.get('party') or '주택').strip()
            if not court or not case_no:
                raise ValueError(f"JSON {index}번: court와 case_no가 필요합니다.")
            rows.append({
                'row': index,
                'court': court,
                'case_no': case_no,
                'party_name': party or '주택',
            })
        return rows

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


class SiteContractChanged(RuntimeError):
    """페이지는 열렸지만 필수 화면 요소의 의미 계약이 달라진 경우."""

    def __init__(self, classification: str, report: dict):
        self.classification = classification
        self.report = report
        missing = (
            report.get('missingForm', [])
            if classification == 'FORM_CHANGED'
            else report.get('missingCaptcha', [])
        )
        super().__init__(f"{classification}: {', '.join(missing) or 'unknown'}")


async def ensure_site_contract(page: Page, timeout_ms: int = 15000) -> dict:
    """정확한 ID와 의미 기반 후보를 이용해 현재 검색 폼 계약을 확인한다."""
    deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
    report = {}
    while asyncio.get_running_loop().time() < deadline:
        try:
            report = await page.evaluate(
                FORM_INSPECTION_JS, inspection_argument()
            )
        except Exception:
            report = {}
        if report.get('formOk') and report.get('captchaOk'):
            contract_view = {
                'version': CONTRACT_VERSION,
                'resolved': report.get('resolved') or {},
            }
            report['fingerprint'] = contract_fingerprint(contract_view)
            page._court_contract = report
            return report
        await page.wait_for_timeout(250)

    page._court_contract = report
    if not report.get('formOk'):
        raise SiteContractChanged('FORM_CHANGED', report)
    raise SiteContractChanged('CAPTCHA_CHANGED', report)


def register_shared_failure(
    circuit: dict,
    bucket_name: str,
    event_name: str,
    case_no: str,
    threshold: int,
) -> tuple[int, bool]:
    """서로 다른 사건의 동일 계열 실패를 세어 전역 차단기를 연다."""
    failures = circuit.setdefault(bucket_name, set())
    failures.add(case_no)
    event = circuit.setdefault(event_name, asyncio.Event())
    opened = len(failures) >= threshold
    if opened:
        event.set()
    return len(failures), opened


# ──────────────────────────────────────────────
# 신규 사이트 캡차 처리 (blob URL → 요소 screenshot)
# ──────────────────────────────────────────────
async def run_captcha_ocr(
    img_bytes: bytes,
    executor: ThreadPoolExecutor | None,
    fast_path: bool = False,
) -> str | None:
    """CPU OCR를 전용 스레드에서 실행해 다른 브라우저 워커를 막지 않는다."""
    loop = asyncio.get_running_loop()
    task = partial(predict_captcha, img_bytes, fast_path=fast_path)
    return await loop.run_in_executor(executor, task)


async def get_captcha_answer(
    page: Page,
    executor: ThreadPoolExecutor | None,
    fast_path: bool = False,
) -> tuple[str | None, bytes | None, str]:
    """캡차 요소를 우선 읽고, 실패하면 렌더링 화면 영역을 저배율로 재캡처한다."""
    try:
        captcha_el = page.locator(SEL_CAPTCHA_IMG)
        await captcha_el.wait_for(timeout=5000)
        img_bytes = await captcha_el.screenshot(animations='disabled')
        answer = await run_captcha_ocr(img_bytes, executor, fast_path)
        if answer:
            return answer, img_bytes, 'element'

        # 일부 WebSquare 화면은 img 요소 캡처와 실제 표시 화면의 픽셀이
        # 다르게 합성된다. 이때 CSS 배율의 화면 캡처를 OCR에 재시도한다.
        box = await captcha_el.bounding_box()
        if box:
            rendered_bytes = await page.screenshot(clip=box, scale='css')
            answer = await run_captcha_ocr(rendered_bytes, executor, fast_path)
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


async def search_form_ready(page: Page) -> bool:
    """현재 WebSquare 검색 폼을 즉시 사용할 수 있는지 확인한다."""
    try:
        court = page.locator(SEL_COURT)
        return await court.count() > 0 and await court.first.is_visible()
    except Exception:
        return False


async def click_search_form_button(page: Page) -> bool:
    """WebSquare 구현 방식과 무관하게 결과 화면의 검색화면 버튼을 누른다."""
    for frame in page.frames:
        locators = (
            frame.get_by_role('button', name=re.compile(r'^\s*검색화면\s*$')),
            frame.locator('input[value="검색화면"]'),
            frame.locator('[title="검색화면"], [aria-label="검색화면"]'),
            frame.get_by_text('검색화면', exact=True),
        )
        for locator in locators:
            try:
                count = min(await locator.count(), 5)
                for index in range(count):
                    candidate = locator.nth(index)
                    if not await candidate.is_visible():
                        continue
                    descriptor = await candidate.evaluate("""
                        element => ({
                          tag: element.tagName,
                          id: element.id || '',
                          className: String(element.className || '').slice(0, 120),
                          text: (element.textContent || '').replace(/\\s+/g, ' ').trim(),
                          value: element.value || '',
                        })
                    """)
                    print(
                        '  ♻ 검색화면 버튼 클릭 시도: '
                        + json.dumps(descriptor, ensure_ascii=False)
                    )
                    await candidate.click(timeout=2000, force=True)
                    return True
            except Exception:
                continue

        # 일부 WebSquare 트리거는 span/div에만 글자가 있고 실제 클릭 핸들러는
        # 상위 요소에 붙는다. 텍스트 노드에서 가장 가까운 클릭 가능한 조상을
        # 찾아 마지막으로 시도한다.
        try:
            clicked = await frame.evaluate("""
                () => {
                  const visible = element => !!(
                    element.offsetWidth || element.offsetHeight ||
                    element.getClientRects().length
                  );
                  const nodes = [...document.querySelectorAll('body *')];
                  const label = nodes.find(element => {
                    const text = (element.textContent || '')
                      .replace(/\\s+/g, ' ').trim();
                    return visible(element) && text === '검색화면';
                  });
                  if (!label) return null;
                  const target = label.closest(
                    'button, a, input, [role="button"], [onclick], .w2trigger'
                  ) || label;
                  target.click();
                  return {
                    tag: target.tagName,
                    id: target.id || '',
                    className: String(target.className || '').slice(0, 120),
                    text: (target.textContent || '').replace(/\\s+/g, ' ').trim(),
                    value: target.value || '',
                  };
                }
            """)
            if clicked:
                print(
                    '  ♻ 검색화면 버튼 클릭 시도(JS): '
                    + json.dumps(clicked, ensure_ascii=False)
                )
                return True
        except Exception:
            continue
    return False


async def return_to_search_form(
    page: Page,
    timeout_ms: int = 6000,
    debug_label: str = '',
) -> bool:
    """결과 화면에서 전체 앱을 다시 열지 않고 검색 폼으로 돌아간다."""
    if await search_form_ready(page):
        return True

    clicked = await click_search_form_button(page)
    if not clicked:
        return False

    try:
        await page.wait_for_function(
            '(selector) => {'
            ' const element = document.querySelector(selector);'
            ' return !!element && !!(element.offsetWidth || element.offsetHeight ||'
            ' element.getClientRects().length);'
            '}',
            arg=SEL_COURT,
            timeout=timeout_ms,
        )
        return True
    except Exception:
        try:
            court = page.locator(SEL_COURT)
            state = {
                'url': page.url,
                'court_count': await court.count(),
                'court_visible': (
                    await court.first.is_visible() if await court.count() else False
                ),
                'context_pages': len(page.context.pages),
            }
            print(
                '  ♻ 검색화면 복귀 진단: '
                + json.dumps(state, ensure_ascii=False)
            )
            if debug_label:
                await save_result_debug(page, f'{debug_label}_return')
        except Exception:
            pass
        return False


async def settle_failed_navigation(page: Page, attempt: int):
    """Chrome 오류 페이지의 후속 이동이 다음 goto를 가로채지 않게 정리한다."""
    try:
        await page.wait_for_timeout(min(750 * attempt, 2000))
        await page.goto('about:blank', wait_until='commit', timeout=5000)
        await page.wait_for_timeout(250)
    except Exception:
        # 다음 TARGET_URL 이동 자체가 최종 복구 수단이므로 정리 실패는 무시한다.
        pass


# ──────────────────────────────────────────────
# WebSquare select 선택 (일반 select_option 미작동 시 JS 폴백)
# ──────────────────────────────────────────────
async def ws_select(page: Page, selector: str, value: str):
    """WebSquare select 요소를 실제 옵션 값 또는 표시명으로 선택"""
    try:
        if await page.locator(selector).input_value() == value:
            return False
    except Exception:
        pass
    try:
        await page.select_option(selector, value=value)
    except Exception:
        await page.select_option(selector, label=value)
    await page.wait_for_timeout(300)
    return True


async def ws_bound_value(page: Page, selector: str) -> tuple[str, dict]:
    """렌더링용 DOM 값이 아닌 WebSquare 데이터 바인딩 값을 읽는다."""
    diagnostic = await page.evaluate("""
        selector => {
          const element = document.querySelector(selector);
          if (!element) return {dom: '', component: '', scoped: ''};
          let component = '';
          let scoped = '';
          try {
            const object = window.WebSquare?.util?.getComponentById?.(element.id);
            component = object?.getValue?.() ?? '';
          } catch (_) {}
          try {
            const object = window.$p?.getComponentById?.(element.id);
            scoped = object?.getValue?.() ?? '';
          } catch (_) {}
          return {
            id: element.id || '',
            dom: element.value || '',
            component: String(component || ''),
            scoped: String(scoped || ''),
            dataValue: element.getAttribute('data-value') || '',
          };
        }
    """, selector)
    value = (
        diagnostic.get('component')
        or diagnostic.get('scoped')
        or diagnostic.get('dataValue')
        or diagnostic.get('dom')
        or ''
    )
    return str(value), diagnostic


async def select_court(page: Page, court: str):
    """실제 사이트 옵션에서 법원명을 찾아 선택; 지원 약칭은 유일할 때만 허용."""
    await page.wait_for_function(
        '(selector) => document.querySelector(selector)?.options.length > 10',
        arg=SEL_COURT, timeout=20000)
    options = await page.locator(SEL_COURT).locator('option').evaluate_all(
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
    try:
        if await page.locator(SEL_COURT).input_value() == matches[0]['value']:
            print(f"  법원 선택 유지: {matches[0]['label']}")
            return False
    except Exception:
        pass
    await page.select_option(SEL_COURT, value=matches[0]['value'])
    print(f"  법원 선택 확인: {matches[0]['label']}")
    await page.wait_for_timeout(300)
    return True


def format_court_date(value) -> str:
    """법원 API의 YYYYMMDD 값을 기존 화면과 같은 YYYY.MM.DD로 바꾼다."""
    text = re.sub(r'[^0-9]', '', str(value or ''))
    if len(text) == 8:
        return f'{text[:4]}.{text[4:6]}.{text[6:8]}'
    return str(value or '')


def parse_direct_api_result(
    basic_payload: dict,
    progress_payload: dict,
    court: str,
    case_no: str,
) -> dict:
    """화면 표를 만들기 전의 구조화 JSON을 기존 25개 결과 열로 변환한다."""
    data = {header: '' for header in OUTPUT_HEADERS}
    data.update({
        '법원': court,
        '사건번호': case_no,
        '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    })
    basic_data = (basic_payload or {}).get('data') or {}
    progress_data = (progress_payload or {}).get('data') or {}
    basic = basic_data.get('dma_csBasCtt') or {}

    case_name = str(basic.get('csNm') or '').strip()
    if case_name and str(basic.get('lwstDvsCd') or '') == '2':
        case_name = '[전자]' + case_name
    data['사건명'] = case_name

    department = str(basic.get('jdbnNm') or '').strip()
    if basic.get('csUltmtYmd') and basic.get('ultmtJdbnNm'):
        department = str(basic['ultmtJdbnNm']).strip()
    telephone = str(basic.get('telNo') or '').strip()
    if department and telephone and str(basic.get('csPrsrvYn') or '') != 'Y':
        department += f' (전화:{telephone})'
    data['재판부'] = department
    data['접수일'] = format_court_date(basic.get('csRcptYmd'))

    final_date = format_court_date(basic.get('csUltmtYmd'))
    final_name = str(basic.get('csUltmtDvsNm') or '').strip()
    data['종국결과'] = ' '.join(part for part in (final_date, final_name) if part)
    data['결정문송달일'] = format_court_date(basic.get('dcsnstDlvrYmd'))
    data['확정일'] = format_court_date(basic.get('csCfmtnYmd'))

    related = basic_data.get('dlt_reltCsLst') or []
    if related:
        first = related[0] or {}
        data['관련사건_법원'] = str(first.get('reltCsCortNm') or '')
        data['관련사건_번호'] = str(first.get('userCsNo') or '')

    applicants, respondents = [], []
    for party in basic_data.get('dlt_btprtCttLst') or []:
        division = str((party or {}).get('btprtDvsNm') or '')
        name = str((party or {}).get('btprtNm') or '').strip()
        if not name:
            continue
        if '신청인' in division and '피' not in division:
            applicants.append(name)
        elif '피신청인' in division:
            respondents.append(name)
    data['신청인'] = ', '.join(applicants)
    data['피신청인'] = ', '.join(respondents)

    progress_rows = progress_data.get('dlt_csProgCtt') or []
    for slot, row in enumerate(progress_rows[-3:][::-1], 1):
        row = row or {}
        data[f'진행_{slot}일자'] = format_court_date(row.get('progYmd'))
        data[f'진행_{slot}내용'] = str(row.get('progCtt') or '')
        progress_result = str(row.get('progRslt') or '')
        # 법원 화면은 송달(구분 4)의 실제 도달일을 기본으로 숨기고,
        # 사용자가 '확인'을 체크하도록 안내한다. 기존 DOM 파서와
        # 같은 출력을 유지해 실험 경로에서 데이터가 바뀌지 않게 한다.
        if str(row.get('progCttDvs') or '') == '4' and progress_result:
            progress_result = "위의 '확인' 항목 체크"
        data[f'진행_{slot}결과'] = progress_result
        notice = row.get('pntcImg')
        # API는 화면용 아이콘 경로를 내려준다. 내부 경로를
        # 엑셀과 웹에 노출하지 말고 공시문 존재 여부만 표시한다.
        data[f'진행_{slot}공시문'] = '있음' if notice not in (None, '', 'N', 0) else ''
    return data


async def wait_for_captcha_info(
    page: Page,
    after_generation: int = -1,
    timeout_ms: int = 8000,
) -> dict | None:
    """페이지가 받은 캡차 이미지와 암호화 answer를 응답 훅에서 가져온다."""
    deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
    while asyncio.get_running_loop().time() < deadline:
        generation = int(getattr(page, '_captcha_generation', 0))
        info = getattr(page, '_captcha_info', None)
        if info and generation > after_generation:
            return info
        await page.wait_for_timeout(100)
    return None


async def refresh_captcha_info(page: Page) -> dict | None:
    """새 캡차를 요청하고 이전 응답과 다른 세대가 도착할 때까지 기다린다."""
    previous = int(getattr(page, '_captcha_generation', 0))
    reload_button = page.locator(SEL_CAPTCHA_RELOAD)
    if await reload_button.count() == 0:
        return None
    await reload_button.click()
    info = await wait_for_captcha_info(page, previous)
    if not info:
        return None
    # response 이벤트는 WebSquare submitdone이 blob URL을 img에 반영하기
    # 직전에 도착한다. 기존 화면 방식에서 검증된 800ms 안정화 시간을 둔다.
    await page.wait_for_timeout(800)
    return info


async def post_court_json(page: Page, endpoint: str, search_data: dict) -> dict:
    """현재 브라우저 쿠키를 유지한 채 WebSquare 상세조회 JSON을 직접 호출한다."""
    return await page.evaluate("""
        async ({endpoint, searchData}) => {
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json;charset=UTF-8',
                'Submissionid': 'sbm_search'
              },
              body: JSON.stringify({dma_search: searchData})
            });
            const text = await response.text();
            let payload = null;
            try { payload = JSON.parse(text); } catch (_) {}
            return {
              http_status: response.status,
              payload,
              preview: text.slice(0, 500)
            };
          } catch (error) {
            return {
              http_status: 0,
              payload: null,
              preview: String(error)
            };
          }
        }
    """, {'endpoint': endpoint, 'searchData': search_data})


async def save_contract_debug(
    page: Page,
    case_no: str,
    classification: str,
    details: dict | None = None,
):
    """구조변경 증거를 값 없이 저장하고 화면 자료를 함께 남긴다."""
    root = Path(os.environ.get('DEBUG_DIR', '/tmp/court-search-debug'))
    root.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r'[^0-9A-Za-z가-힣_-]', '_', case_no)
    event = {
        'detected_at': datetime.now().isoformat(timespec='seconds'),
        'contract_version': CONTRACT_VERSION,
        'classification': classification,
        'case_no': case_no,
        'details': details or {},
    }
    event['fingerprint'] = contract_fingerprint(event['details'])
    (root / f'{safe}-contract.json').write_text(
        json.dumps(event, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    with (root / 'contract-events.jsonl').open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(event, ensure_ascii=False) + '\n')
    try:
        await page.screenshot(
            path=str(root / f'{safe}-contract.png'), full_page=True
        )
    except Exception as error:
        print(f'  구조 진단 화면 캡처 실패: {error}')
    try:
        (root / f'{safe}-contract.html').write_text(
            await page.content(), encoding='utf-8'
        )
    except Exception as error:
        print(f'  구조 진단 DOM 저장 실패: {error}')
    print(f'  구조변경 진단 저장: {root / (safe + "-contract.json")}')


async def direct_api_result(
    page: Page,
    court: str,
    case_no: str,
    case_type: str,
    year: str,
    serial: str,
    party_name: str,
    captcha_answer: str,
) -> tuple[str, dict | None]:
    """결과 화면 전환 없이 기본내용·진행내용 JSON을 받아 파싱한다."""
    captcha_info = await wait_for_captcha_info(page)
    encrypted_answer = str((captcha_info or {}).get('answer') or '')
    if not encrypted_answer:
        print('  ⚠ 직접조회용 캡차 토큰 미확인 — 기존 화면 조회로 전환')
        return 'unsupported', None

    try:
        court_code, court_diagnostic = await ws_bound_value(page, SEL_COURT)
        case_type_code, type_diagnostic = await ws_bound_value(page, SEL_TYPE)
        task_code = await page.evaluate(
            "name => window.properties?.['ctt.csDvsNm.' + name] || ''",
            case_type,
        )
    except Exception as error:
        print(f'  ⚠ 직접조회 코드 확인 실패: {str(error)[:180]}')
        return 'unsupported', None
    api_path = TASK_API_PATHS.get(str(task_code or ''))
    if not court_code or not case_type_code or not api_path:
        print(
            f'  ⚠ 직접조회 미지원 유형: court={court_code}, '
            f'type={case_type_code}, task={task_code}'
        )
        return 'unsupported', None

    search_data = {
        'cortCd': court_code,
        'csNo': '',
        'encCsNo': '',
        'csYear': year,
        'csDvsCd': case_type_code,
        'csSerial': serial,
        'btprtNm': party_name,
        'captchaAnswer': captcha_answer + encrypted_answer,
        'callDomain': '',
        'csDvsNm': case_type,
        'prwlKey': '',
        'preProgYn': '',
        'typ': '',
        'atho': '',
        'dcRgstNoIndctYn': '',
        'myCslistLinkYn': '',
        'mode': '',
        'mcsDomain': '',
        'callTyp': '',
        'ckiStrgYn': '',
        'link': '',
        'linkValue': '',
        'srchDvs': '',
        'nrlnmDvsCd': '',
        'inqScop': '',
        'inUseCallDomain': '',
        'etc1': '',
        'etc2': '',
        'etc3': '',
    }
    print('  단계 결과 데이터 조회')
    if env_enabled('COURT_TRACE_NETWORK'):
        print(
            f'  🔬 JSON 요청 코드: court={court_code}, year={year}, '
            f'type={case_type_code}, serial={serial}, task={task_code}; '
            f'bindings={json.dumps({"court": court_diagnostic, "type": type_diagnostic}, ensure_ascii=False)}'
        )
    base_url = f'/ssgo/ssgo{api_path}'
    basic_response = await post_court_json(
        page,
        f'{base_url}/selectHmpgEtexecCsGnrlCtt.on',
        search_data,
    )
    http_status = int(basic_response.get('http_status') or 0)
    payload = basic_response.get('payload') or {}
    message = str(payload.get('message') or basic_response.get('preview') or '')
    errors = payload.get('errors') or {}
    error_message = str(errors.get('errorMessage') or '')
    combined_message = f'{message} {error_message}'
    if '캡챠' in combined_message or '방지문자' in combined_message:
        print('  캡차 불일치 → 새 문자로 재시도')
        return 'captcha_mismatch', None
    if http_status != 200 or int(payload.get('status') or 0) != 200:
        print(
            f"  ⚠ JSON 기본내용 조회 실패: HTTP {http_status}, "
            f"{combined_message[:180]} — 기존 화면 조회로 전환"
        )
        await save_contract_debug(
            page,
            case_no,
            'API_PROTOCOL_ERROR',
            {
                'http_status': http_status,
                'payload_status': payload.get('status'),
                'schema': json_schema_snapshot(payload),
                'basic_endpoint': f'{base_url}/selectHmpgEtexecCsGnrlCtt.on',
            },
        )
        return 'protocol_error', None
    basic = (payload.get('data') or {}).get('dma_csBasCtt') or {}
    if not basic.get('csNm'):
        print('  🧩 JSON 기본내용 구조변경 감지: 사건명 없음 — 기존 화면 조회로 전환')
        await save_contract_debug(
            page,
            case_no,
            'API_CHANGED',
            {
                'errors': ['case_name_missing'],
                'schema': json_schema_snapshot(payload),
                'basic_endpoint': f'{base_url}/selectHmpgEtexecCsGnrlCtt.on',
            },
        )
        return 'contract_changed', None
    returned_case = re.sub(r'\s+', '', str(basic.get('userCsNo') or ''))
    if returned_case and returned_case != re.sub(r'\s+', '', case_no):
        print(
            f'  ⚠ JSON 사건번호 불일치: 요청 {case_no}, 응답 {returned_case}'
        )
        await save_contract_debug(
            page,
            case_no,
            'API_CHANGED',
            {
                'errors': ['case_number_mismatch'],
                'schema': json_schema_snapshot(payload),
                'basic_endpoint': f'{base_url}/selectHmpgEtexecCsGnrlCtt.on',
            },
        )
        return 'contract_changed', None

    progress_data = dict(search_data)
    progress_data['progCttDvs'] = '0'
    progress_response = await post_court_json(
        page,
        f'{base_url}/selectHmpgEtexecCsProgCtt.on',
        progress_data,
    )
    progress_payload = progress_response.get('payload') or {}
    if (
        int(progress_response.get('http_status') or 0) != 200
        or int(progress_payload.get('status') or 0) != 200
    ):
        print('  ⚠ JSON 진행내용 조회 실패 — 기존 화면 조회로 전환')
        await save_contract_debug(
            page,
            case_no,
            'API_PROTOCOL_ERROR',
            {
                'http_status': progress_response.get('http_status'),
                'payload_status': progress_payload.get('status'),
                'schema': json_schema_snapshot(progress_payload),
                'progress_endpoint': f'{base_url}/selectHmpgEtexecCsProgCtt.on',
            },
        )
        return 'protocol_error', None

    validation = validate_direct_payloads(payload, progress_payload, case_no)
    if not validation['ok']:
        print(
            '  🧩 JSON 구조변경 감지: '
            + ', '.join(validation['errors'])
            + ' — 기존 화면 조회로 전환'
        )
        await save_contract_debug(
            page,
            case_no,
            'API_CHANGED',
            {
                'errors': validation['errors'],
                'warnings': validation['warnings'],
                'schema': validation['schema'],
                'schema_fingerprint': validation['fingerprint'],
                'basic_endpoint': f'{base_url}/selectHmpgEtexecCsGnrlCtt.on',
                'progress_endpoint': f'{base_url}/selectHmpgEtexecCsProgCtt.on',
            },
        )
        return 'contract_changed', None

    result = parse_direct_api_result(
        payload, progress_payload, court, case_no
    )
    print(f"  ✅ 조회 완료: 사건명={result['사건명']}")
    return 'success', result


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


async def wait_for_result_page(page: Page, timeout_ms: int = 12000) -> bool:
    """검색 후 비동기로 렌더링되는 기본내용 표를 기다린다."""
    deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
    while asyncio.get_running_loop().time() < deadline:
        for frame in page.frames:
            try:
                text = await frame.locator('body').inner_text(timeout=1000)
                if all(label in text for label in ('사건명', '재판부', '접수일')):
                    return True
            except Exception:
                continue
        await page.wait_for_timeout(300)
    return False


def adaptive_scale_allowed(samples: list[dict]) -> bool:
    """최근 사건 처리 결과가 네 번째 워커를 열 만큼 안정적인지 판단한다."""
    if len(samples) < SCALE_SAMPLE_SIZE:
        return False
    recent = samples[-SCALE_SAMPLE_SIZE:]
    connection_failures = sum(sample['connection_failure'] for sample in recent)
    completed = sum(sample['success'] for sample in recent)
    average = sum(sample['duration'] for sample in recent) / len(recent)
    return (
        connection_failures == 0
        and completed >= SCALE_SAMPLE_SIZE - 2
        and average <= SCALE_MAX_AVERAGE_SECONDS
    )


def adaptive_retire_required(samples: list[dict]) -> bool:
    """증설 뒤 접속이나 전체 처리 속도가 나빠지면 네 번째 워커를 회수한다."""
    if len(samples) < RETIRE_SAMPLE_SIZE:
        return False
    recent = samples[-RETIRE_SAMPLE_SIZE:]
    connection_failures = sum(sample['connection_failure'] for sample in recent)
    average = sum(sample['duration'] for sample in recent) / len(recent)
    return (
        connection_failures >= RETIRE_MIN_CONNECTION_FAILURES
        or average > RETIRE_MAX_AVERAGE_SECONDS
    )


def record_adaptive_health(state: dict, result: dict, duration: float):
    """사건 단위 상태를 기록하고 최대 네 번째 워커만 활성화한다."""
    if not state['enabled']:
        return
    name = str(result.get('사건명', ''))
    connection_failure = (
        name.startswith((
            '조회실패: 법원 사이트', '조회보류: 법원 사이트'
        ))
        and '구조변경' not in name
    )
    state['samples'].append({
        'success': bool(name) and not name.startswith(('조회실패', '조회보류')),
        'connection_failure': connection_failure,
        'duration': duration,
    })
    # 판단에는 최근 구간만 필요하다. 장시간 실행에서도 목록이 커지지 않는다.
    del state['samples'][:-30]

    if (
        not state['scale_event'].is_set()
        and not state['extra_worker_retired']
        and adaptive_scale_allowed(state['samples'])
    ):
        state['scale_event'].set()
        recent = state['samples'][-SCALE_SAMPLE_SIZE:]
        average = sum(sample['duration'] for sample in recent) / len(recent)
        print(
            f"\n⚡ 최근 {SCALE_SAMPLE_SIZE}건 평균 {average:.1f}초, 접속 안정 확인 — "
            "4번째 워커를 투입합니다."
        )
    elif (
        state['scale_event'].is_set()
        and not state['extra_worker_retired']
        and adaptive_retire_required(state['samples'])
    ):
        state['extra_worker_retired'] = True
        print('\n↘ 접속 또는 처리 속도 저하 감지 — 4번째 워커를 회수합니다.')


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


async def mark_session_connection_failure(
    page: Page,
    connection_circuit: dict,
    session_state: dict,
):
    """한 세션이 재시도를 소진했음을 기록하고 여러 세션 실패 때만 차단한다."""
    session_key = session_state.get('worker_id', id(page))
    failed_sessions = connection_circuit.setdefault('failed_sessions', set())
    failed_sessions.add(session_key)
    required = int(connection_circuit.get(
        'required_failed_sessions', MAX_GLOBAL_CONNECTION_FAILURES
    ))
    if len(failed_sessions) < required or connection_circuit['event'].is_set():
        return

    connection_circuit['event'].set()
    print(
        f"  ⛔ 서로 다른 검색 세션 {len(failed_sessions)}개가 모두 "
        "첫 화면 초기화에 실패했습니다. 남은 사건 조회를 중단합니다."
    )
    if not connection_circuit['diagnosed']:
        connection_circuit['diagnosed'] = True
        await diagnose_site_connection(page)


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
    session_state: dict | None = None,
) -> dict:
    print(f"  조회: {court} / {case_no}")

    year, case_type, serial = parse_case_no(case_no)
    page_ready = False
    stage = '사이트 접속'
    failure_reason = '재시도 한도 초과'
    connection_failures = 0
    if session_state is None:
        session_state = {}
    reuse_enabled = REUSE_SEARCH_SESSION and not prepare_only

    async def finish(data: dict, result_page: bool = False) -> dict:
        """결과를 반환하기 전에 다음 사건이 같은 앱 세션을 쓰도록 준비한다."""
        if not reuse_enabled:
            return data
        if result_page:
            # JSON 고속 경로가 실패해 기존 화면으로 폴백한 경우 결과 화면의
            # '검색화면' 버튼은 빈 /index.on으로 이동한다. 이미 검증된 실패
            # 경로를 다시 기다리지 말고 다음 사건에서 정상 URL을 연다.
            if DIRECT_API_PATH:
                session_state['form_ready'] = False
                return data
            ready = await return_to_search_form(page, debug_label=case_no)
            session_state['form_ready'] = ready
            if ready:
                session_state['reuse_prepared'] = (
                    int(session_state.get('reuse_prepared', 0)) + 1
                )
                print('  ♻ 검색 세션 유지 — 다음 사건은 첫 화면 재접속 생략')
            else:
                session_state['reuse_fallbacks'] = (
                    int(session_state.get('reuse_fallbacks', 0)) + 1
                )
                print('  ↪ 검색화면 복귀 실패 — 다음 사건은 첫 화면에서 재시작')
        else:
            session_state['form_ready'] = await search_form_ready(page)
        return data

    if connection_circuit is None:
        connection_circuit = {
            'failed_sessions': set(),
            'required_failed_sessions': MAX_GLOBAL_CONNECTION_FAILURES,
            'event': asyncio.Event(),
            'diagnosed': False,
            'direct_contract_failures': set(),
            'direct_event': asyncio.Event(),
            'structure_failures': set(),
            'structure_event': asyncio.Event(),
        }
    circuit_event = connection_circuit['event']
    direct_event = connection_circuit.setdefault(
        'direct_event', asyncio.Event()
    )
    structure_event = connection_circuit.setdefault(
        'structure_event', asyncio.Event()
    )

    if reuse_enabled and await search_form_ready(page):
        page_ready = True
        session_state['form_ready'] = True
        session_state['reuse_hits'] = int(session_state.get('reuse_hits', 0)) + 1
        print('  ♻ 기존 검색 세션 재사용')

    for attempt in range(1, (1 if prepare_only else MAX_CAPTCHA_RETRY) + 1):
        try:
            if structure_event.is_set():
                failure_reason = '법원 사이트 구조변경 감지'
                break
            # 페이지 이동. 캡차 불일치 재시도는 현재 화면을 유지하지만,
            # 접속/렌더링 오류 뒤에는 빈 페이지를 재사용하지 않는다.
            if not page_ready:
                stage = '사이트 접속'
                if circuit_event.is_set():
                    failure_reason = '법원 사이트 전체 접속 장애'
                    break
                print(f"  단계 {stage} (시도 {attempt})")
                try:
                    session_state['form_ready'] = False
                    session_state['navigations'] = (
                        int(session_state.get('navigations', 0)) + 1
                    )
                    await page.goto(
                        TARGET_URL,
                        wait_until='domcontentloaded',
                        timeout=40000,
                    )
                    # WebSquare 초기화와 필수 입력·캡차 계약을 함께 확인한다.
                    contract = await ensure_site_contract(page, timeout_ms=15000)
                    session_state['contract_fingerprint'] = contract.get(
                        'fingerprint', ''
                    )
                except Exception:
                    raise
                else:
                    # 어느 세션이든 정상 접속했다면 현재 사이트 전체 장애가
                    # 아님이 확인된 것이므로 이전 세션 실패 표식을 지운다.
                    connection_circuit.setdefault('failed_sessions', set()).clear()
                    session_state['form_ready'] = True
                page_ready = True
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
            direct_active = (
                DIRECT_API_PATH
                and not session_state.get('direct_api_disabled', False)
                and not direct_event.is_set()
            )
            needs_new_captcha = attempt > 1 or (
                direct_active and session_state.get('captcha_consumed', False)
            )
            if needs_new_captcha:
                if direct_active:
                    refreshed = await refresh_captcha_info(page)
                    if not refreshed:
                        print('  ⚠ 새 캡차 응답을 확인하지 못했습니다.')
                    session_state['captcha_consumed'] = False
                else:
                    reload_btn = page.locator(SEL_CAPTCHA_RELOAD)
                    if await reload_btn.count() > 0:
                        await reload_btn.click()
                        await page.wait_for_timeout(800)

            captcha_answer, captcha_image, captcha_source = await get_captcha_answer(
                page,
                ocr_executor,
                fast_path=FAST_CAPTCHA_PATH and attempt == 1,
            )
            if captcha_answer:
                print(f"  캡차 예측: {captcha_answer} (시도 {attempt})")
            else:
                print(f"  캡차 OCR 실패 — 재시도 {attempt}")
                await page.wait_for_timeout(500)
                continue

            if direct_active:
                stage = 'JSON 직접조회'
                direct_status, direct_result = await direct_api_result(
                    page,
                    court,
                    case_no,
                    case_type,
                    year,
                    serial,
                    party_name,
                    captcha_answer,
                )
                if direct_status == 'success':
                    session_state['captcha_consumed'] = True
                    session_state['direct_api_successes'] = (
                        int(session_state.get('direct_api_successes', 0)) + 1
                    )
                    save_success_captcha(
                        captcha_image, captcha_answer, captcha_source
                    )
                    return await finish(direct_result, result_page=False)
                if direct_status == 'captcha_mismatch':
                    session_state['captcha_consumed'] = True
                    continue
                if direct_status in {'protocol_error', 'contract_changed'}:
                    session_state['captcha_consumed'] = True
                    session_state['direct_api_disabled'] = True
                    session_state['direct_api_fallbacks'] = (
                        int(session_state.get('direct_api_fallbacks', 0)) + 1
                    )
                    count, opened = register_shared_failure(
                        connection_circuit,
                        'direct_contract_failures',
                        'direct_event',
                        case_no,
                        MAX_DIRECT_CONTRACT_FAILURES,
                    )
                    if opened:
                        print(
                            '  🛡 서로 다른 사건 '
                            f'{count}건에서 API 계약 오류 감지 — '
                            '전체 워커를 화면 조회 방식으로 전환합니다.'
                        )
                    continue
                # 아직 API 호출 전인 미지원 유형이면 현재 캡차를 그대로
                # 기존 화면 제출에 사용한다.
                session_state['direct_api_disabled'] = True
                session_state['direct_api_fallbacks'] = (
                    int(session_state.get('direct_api_fallbacks', 0)) + 1
                )

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
            if not await wait_for_result_page(page):
                stage = '결과 화면 대기'
                content = await page.content()
                if any(k in content for k in ['인증번호가 일치하지', '자동입력방지문자가 틀', '자동 입력 방지 문자가 틀']):
                    print("  캡차 불일치 → 재시도")
                    continue
                print("  결과 화면 로딩 실패 — 검색 응답을 확인할 수 없음")
                await save_result_debug(page, case_no)
                await save_contract_debug(
                    page,
                    case_no,
                    'RESULT_PAGE_UNRECOGNIZED',
                    {
                        'errors': ['known_result_labels_not_found'],
                        'expected_labels': ['사건명', '재판부', '접수일'],
                    },
                )
                count, opened = register_shared_failure(
                    connection_circuit,
                    'structure_failures',
                    'structure_event',
                    case_no,
                    MAX_GLOBAL_STRUCTURE_FAILURES,
                )
                session_state['form_ready'] = False
                return {h: '' for h in OUTPUT_HEADERS} | {
                    '법원': court, '사건번호': case_no,
                    '사건명': (
                        '조회실패: 결과 화면 구조변경 감지'
                        if opened
                        else '조회실패: 결과 화면 미확인'
                    ),
                    '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                }

            # 결과 화면의 기본 필드가 확인된 시점에만 OCR 답을 정답으로
            # 확정한다. 캡차 불일치와 응답 미확인 이미지는 저장하지 않는다.
            save_success_captcha(captcha_image, captcha_answer, captcha_source)

            content = await page.content()
            if any(k in content for k in ['사건이 존재하지 않습니다', '조회된 사건이 없습니다', '검색결과가 없습니다']):
                print(f"  ℹ 사건 없음")
                return await finish({h: '' for h in OUTPUT_HEADERS} | {
                    '법원': court, '사건번호': case_no,
                    '사건명': '사건없음', '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                }, result_page=True)

            # 성공 → 결과 파싱
            stage = '결과 파싱'
            result = await parse_result(page, court, case_no)
            if not result.get('사건명'):
                await save_result_debug(page, case_no)
                await save_contract_debug(
                    page,
                    case_no,
                    'RESULT_CHANGED',
                    {
                        'errors': ['case_name_not_found_in_result_tables'],
                        'table_schema': 'semantic-label-parser-v1',
                    },
                )
                count, opened = register_shared_failure(
                    connection_circuit,
                    'structure_failures',
                    'structure_event',
                    case_no,
                    MAX_GLOBAL_STRUCTURE_FAILURES,
                )
                result['사건명'] = '조회실패: 결과 화면 구조변경 감지'
                print("  🧩 결과 화면은 열렸지만 사건명 구조가 변경되었습니다.")
                if opened:
                    print(
                        f'  ⛔ 서로 다른 사건 {count}건에서 결과 구조변경 감지 — '
                        '남은 사건 조회를 안전하게 중단합니다.'
                    )
            else:
                print(f"  ✅ 결과 파싱 완료: 사건명={result['사건명']}")
            return await finish(result, result_page=True)

        except SiteContractChanged as error:
            page_ready = False
            session_state['form_ready'] = False
            classification = error.classification
            label = (
                '입력 화면 구조변경'
                if classification == 'FORM_CHANGED'
                else '캡차 구조변경'
            )
            await save_contract_debug(
                page,
                case_no,
                classification,
                {
                    'missing_form': error.report.get('missingForm') or [],
                    'missing_captcha': error.report.get('missingCaptcha') or [],
                    'resolved': error.report.get('resolved') or {},
                },
            )
            count, opened = register_shared_failure(
                connection_circuit,
                'structure_failures',
                'structure_event',
                case_no,
                MAX_GLOBAL_STRUCTURE_FAILURES,
            )
            print(f'  🧩 법원 사이트 {label} 감지 ({count}건)')
            if opened:
                print('  ⛔ 구조변경 차단기 작동 — 남은 사건 조회를 중단합니다.')
            return {h: '' for h in OUTPUT_HEADERS} | {
                '법원': court,
                '사건번호': case_no,
                '사건명': f'조회실패: 법원 사이트 {label} 감지',
                '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            }
        except ValueError as e:
            print(f"  입력 오류: {e}")
            break
        except PlaywrightTimeout as e:
            page_ready = False
            session_state['form_ready'] = False
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
            await settle_failed_navigation(page, attempt)
            continue
        except Exception as e:
            page_ready = False if any(token in str(e) for token in ('ERR_CONNECTION', 'net::', 'Target closed')) else page_ready
            if not page_ready:
                session_state['form_ready'] = False
            detail = str(e).replace('\n', ' ')[:220]
            if stage == '사이트 접속' or any(
                token in detail
                for token in ('ERR_CONNECTION', 'net::', 'Connection timed out')
            ):
                page_ready = False
                session_state['form_ready'] = False
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
            if not page_ready:
                await settle_failed_navigation(page, attempt)
            continue

    session_state['form_ready'] = False
    if (
        connection_failures >= MAX_CONNECTION_RETRY
        and failure_reason == '법원 사이트 연결 실패'
    ):
        await mark_session_connection_failure(
            page, connection_circuit, session_state
        )
    return {h: '' for h in OUTPUT_HEADERS} | {
        '법원': court, '사건번호': case_no,
        '사건명': f'조회실패: {failure_reason}',
        '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }


class PartialResultPublisher:
    """완료된 입력 순서 구간을 검색과 별도인 업로드 큐에서 공개한다."""

    def __init__(self, results: list[dict]):
        self.results = results
        self.total = len(results)
        output_dir = os.environ.get('COURT_PARTIAL_DIR', '').strip()
        self.output_dir = Path(output_dir) if output_dir else None
        queue_dir = os.environ.get('COURT_ARTIFACT_QUEUE_DIR', '').strip()
        self.artifact_queue_dir = Path(queue_dir) if queue_dir else None
        try:
            self.chunk_size = max(1, int(os.environ.get('COURT_PARTIAL_SIZE', '20')))
        except ValueError:
            self.chunk_size = 20
        try:
            self.revision_base = max(0, int(os.environ.get('COURT_PARTIAL_REVISION', '0')))
        except ValueError:
            self.revision_base = 0
        self.enabled = bool(self.output_dir and self.artifact_queue_dir)
        self.next_start = 0
        self.queue = asyncio.Queue()
        self.lock = asyncio.Lock()
        self.worker_task = None
        self.failures = []

    async def start(self):
        if not self.enabled:
            return
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.artifact_queue_dir.mkdir(parents=True, exist_ok=True)
        self.worker_task = asyncio.create_task(self._upload_worker())
        print(f"중간 결과: {self.chunk_size}건 단위로 다운로드 파일을 공개합니다.")

    async def publish_ready(self):
        """앞쪽 입력 구간이 모두 끝난 경우에만 순서가 보장된 파일을 만든다."""
        if not self.enabled:
            return
        async with self.lock:
            while self.next_start < self.total:
                end = min(self.next_start + self.chunk_size, self.total)
                chunk = self.results[self.next_start:end]
                if not all(chunk):
                    return
                await self._write_and_enqueue(
                    self.next_start, end, chunk, revision=self.revision_base
                )
                self.next_start = end

    async def publish_revisions(self, changed_indices: list[int]):
        """마지막 재조회로 바뀐 구간을 새 artifact 이름으로 다시 공개한다."""
        if not self.enabled or not changed_indices:
            return
        starts = sorted({(index // self.chunk_size) * self.chunk_size for index in changed_indices})
        async with self.lock:
            for start in starts:
                end = min(start + self.chunk_size, self.total)
                chunk = self.results[start:end]
                if all(chunk):
                    await self._write_and_enqueue(
                        start, end, chunk, revision=self.revision_base + 1
                    )

    async def _write_and_enqueue(self, start, end, chunk, revision):
        tag = f"{start + 1:04d}-{end:04d}"
        suffix = f"-r{revision}" if revision else ''
        path = self.output_dir / f"court-search-{tag}{suffix}.xlsx"
        await asyncio.to_thread(write_output, [dict(row) for row in chunk], str(path))
        revision_tag = f"r{revision}-" if revision else ''
        artifact_name = f"court-search-partial-{revision_tag}{tag}"
        self.queue.put_nowait((artifact_name, path))

    async def _upload_worker(self):
        while True:
            item = await self.queue.get()
            try:
                if item is None:
                    return
                artifact_name, path = item
                try:
                    request = self.artifact_queue_dir / f'{artifact_name}.request.json'
                    done = self.artifact_queue_dir / f'{artifact_name}.done.json'
                    failed = self.artifact_queue_dir / f'{artifact_name}.error.json'
                    temporary = request.with_suffix('.tmp')
                    temporary.write_text(json.dumps({
                        'artifact_name': artifact_name,
                        'path': str(path.resolve()),
                    }, ensure_ascii=False), encoding='utf-8')
                    temporary.replace(request)

                    for _ in range(240):
                        if done.exists():
                            payload = json.loads(done.read_text(encoding='utf-8'))
                            print(
                                f"✅ 중간 결과 공개: {artifact_name} "
                                f"(artifact {payload.get('id')}, {payload.get('size')} bytes)"
                            )
                            break
                        if failed.exists():
                            payload = json.loads(failed.read_text(encoding='utf-8'))
                            print(f"❌ 중간 결과 업로드 실패: {payload.get('error', '알 수 없는 오류')}")
                            self.failures.append(artifact_name)
                            break
                        await asyncio.sleep(0.5)
                    else:
                        print(f"❌ 중간 결과 업로드 시간 초과: {artifact_name}")
                        self.failures.append(artifact_name)
                except Exception as error:
                    print(f"❌ 중간 결과 업로드 실행 실패: {artifact_name}: {error}")
                    self.failures.append(artifact_name)
            finally:
                self.queue.task_done()

    async def close(self):
        if not self.enabled:
            return
        await self.publish_ready()
        await self.queue.join()
        self.queue.put_nowait(None)
        await self.worker_task
        (self.artifact_queue_dir / 'STOP').touch()
        if self.failures:
            print(
                "⚠ 중간 다운로드 공개 실패: " + ', '.join(self.failures)
                + " — 최종 결과 파일 생성은 계속합니다."
            )


# ──────────────────────────────────────────────
# 메인
# ──────────────────────────────────────────────
async def main():
    run_started_at = asyncio.get_running_loop().time()
    cli_args = [arg for arg in sys.argv[1:] if arg != '--prepare-only']
    prepare_only = '--prepare-only' in sys.argv[1:]
    input_path = cli_args[0] if cli_args else INPUT_FILE
    output_path = cli_args[1] if len(cli_args) > 1 else OUTPUT_FILE

    if not os.path.exists(input_path):
        print(f"입력 파일 없음: {input_path}")
        sys.exit(1)

    cases = read_input(input_path)
    print(f"총 {len(cases)}건 조회 시작\n")

    if not prepare_only:
        seed_stats = load_success_dataset(CAPTCHA_SEED_DIR)
        print(
            f"누적 캡차 모델 적재: {seed_stats['loaded']}건"
            f" (제외 {seed_stats['skipped']}건)"
        )

    # 입력 건수를 먼저 확인하고 기본 3개 워커가 공용 큐에서 한 건씩
    # 가져간다. 상태가 안정적일 때만 네 번째 워커를 추가한다.
    try:
        worker_count = int(os.environ.get('COURT_WORKERS', '3'))
    except ValueError:
        worker_count = 3
    worker_count = max(1, min(worker_count, len(cases))) if cases else 1
    try:
        requested_max_workers = int(
            os.environ.get('COURT_MAX_WORKERS', str(worker_count))
        )
    except ValueError:
        requested_max_workers = worker_count
    max_worker_count = max(
        worker_count,
        min(MAX_BATCH_WORKERS, requested_max_workers, len(cases))
    ) if cases else worker_count
    if prepare_only:
        worker_count = 1
        max_worker_count = 1
    rescue_enabled = (
        IMMEDIATE_RETRY_WORKER
        and not prepare_only
        and max_worker_count > worker_count
    )
    if rescue_enabled:
        print(
            f"조회 워커 {worker_count}개와 실패 사건 전용 구조대 워커 1개로 "
            "실행합니다."
        )
    elif max_worker_count > worker_count:
        print(
            f"조회 워커 {worker_count}개로 시작하며 접속 상태가 안정적이면 "
            f"최대 {max_worker_count}개로 확대합니다."
        )
    else:
        print(f"조회 워커 {worker_count}개로 실행합니다.")

    results = [{} for _ in cases]
    partial_publisher = PartialResultPublisher(results)
    await partial_publisher.start()
    connection_circuit = {
        'failed_sessions': set(),
        'required_failed_sessions': min(
            MAX_GLOBAL_CONNECTION_FAILURES, worker_count
        ),
        'event': asyncio.Event(),
        'diagnosed': False,
        'direct_contract_failures': set(),
        'direct_event': asyncio.Event(),
        'structure_failures': set(),
        'structure_event': asyncio.Event(),
    }
    adaptive_state = {
        'enabled': max_worker_count > worker_count and not rescue_enabled,
        'samples': [],
        'scale_event': asyncio.Event(),
        'extra_worker_retired': False,
    }
    # EasyOCR 모델은 하나만 메모리에 올린다. 캡차 요청은 이 전용 실행부에
    # 순서대로 들어가며 브라우저 워커는 네트워크/결과 대기를 병렬 수행한다.
    ocr_executor = ThreadPoolExecutor(
        max_workers=1, thread_name_prefix='captcha-ocr'
    )
    if FAST_CAPTCHA_PATH and not prepare_only:
        print('⚡ 캡차 고속 경로 준비: 고정 문자영역 인식기를 미리 적재합니다.')
        await asyncio.get_running_loop().run_in_executor(
            ocr_executor, warmup_captcha_solver
        )
    if REUSE_SEARCH_SESSION and not prepare_only:
        print('♻ 검색 세션 재사용 활성화')
    if DIRECT_API_PATH and not prepare_only:
        print('⚡ 결과 화면을 생략하는 JSON 고속조회 활성화')
    async with async_playwright() as p:
        launch_options = {
            'headless': HEADLESS,
            'args': ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
        }
        chromium_path = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', '').strip()
        if chromium_path:
            if not Path(chromium_path).is_file():
                raise RuntimeError(f'지정한 Chromium 실행파일 없음: {chromium_path}')
            launch_options['executable_path'] = chromium_path
            print(f'사전 설치 Chromium 사용: {chromium_path}')
        browser = await p.chromium.launch(**launch_options)

        async def make_page(worker_id: int):
            context = await browser.new_context(
                locale='ko-KR',
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            page = await context.new_page()
            page._last_dialog_message = ''
            page._captcha_info = None
            page._captcha_generation = 0

            async def handle_dialog(dialog):
                page._last_dialog_message = dialog.message
                print(f"  워커 {worker_id} 사이트 알림: {dialog.message[:300]}")
                await dialog.dismiss()

            page.on('dialog', handle_dialog)

            async def capture_captcha_response(response):
                if not response.url.endswith('/ssgo10l/getCaptchaInf.on'):
                    return
                try:
                    payload = await response.json()
                    info = ((payload or {}).get('data') or {}).get(
                        'dma_captchaInf'
                    ) or {}
                    if info.get('image') and info.get('answer'):
                        page._captcha_info = info
                        page._captcha_generation += 1
                except Exception as error:
                    print(
                        '  ⚠ 캡차 응답 포착 실패: '
                        + str(error).replace('\n', ' ')[:160]
                    )

            page.on('response', capture_captcha_response)
            if env_enabled('COURT_TRACE_NETWORK'):
                trace_host = urlparse(TARGET_URL).hostname

                def trace_request(request):
                    if (
                        request.resource_type not in {'xhr', 'fetch'}
                        or urlparse(request.url).hostname != trace_host
                    ):
                        return
                    body = (request.post_data or '').replace('\n', ' ')[:1200]
                    print(
                        f"  🔬 NET 요청 워커 {worker_id + 1}: "
                        f"{request.method} {request.url} body={body}"
                    )

                async def trace_response(response):
                    request = response.request
                    if (
                        request.resource_type not in {'xhr', 'fetch'}
                        or urlparse(request.url).hostname != trace_host
                    ):
                        return
                    try:
                        body = (await response.text()).replace('\n', ' ')[:1200]
                    except Exception:
                        body = '<body unavailable>'
                    print(
                        f"  🔬 NET 응답 워커 {worker_id + 1}: "
                        f"{response.status} {request.method} {response.url} "
                        f"body={body}"
                    )

                page.on('request', trace_request)
                page.on('response', trace_response)
            return context, page

        pages = [await make_page(worker_id) for worker_id in range(max_worker_count)]
        session_states = [
            {'worker_id': worker_id + 1}
            for worker_id in range(max_worker_count)
        ]
        immediate_retry_queue = asyncio.Queue()
        retry_scheduled: set[int] = set()
        retried_indices: set[int] = set()

        async def rescue_worker(worker_id: int, page: Page):
            """일반 조회와 겹쳐 실패 사건을 새 브라우저 세션에서 재조회한다."""
            while True:
                idx = await immediate_retry_queue.get()
                try:
                    if (
                        connection_circuit['event'].is_set()
                        or connection_circuit['structure_event'].is_set()
                    ):
                        retried_indices.add(idx)
                        continue
                    case = cases[idx]
                    print(
                        f"[구조대 {idx + 1}/{len(cases)} 워커 {worker_id + 1}]",
                        end=' ',
                    )
                    try:
                        results[idx] = await search_one(
                            page,
                            case['court'],
                            case['case_no'],
                            case['party_name'],
                            prepare_only,
                            ocr_executor,
                            connection_circuit,
                            session_states[worker_id],
                        )
                    except Exception as error:
                        print(
                            '  ❌ 구조대 재조회 오류: '
                            + str(error).replace('\n', ' ')[:220]
                        )
                    finally:
                        retried_indices.add(idx)
                finally:
                    immediate_retry_queue.task_done()

        async def run_batch(indices, retry=False):
            """인덱스 목록을 워커에 나눠 실행하고 결과 순서는 원본을 유지한다."""
            queue = asyncio.Queue()
            retry_positions = {idx: pos + 1 for pos, idx in enumerate(indices)}
            retry_total = len(indices)
            for idx in indices:
                queue.put_nowait(idx)

            async def worker(worker_id, page):
                while True:
                    if (
                        connection_circuit['event'].is_set()
                        or connection_circuit['structure_event'].is_set()
                    ):
                        return
                    if worker_id >= worker_count and adaptive_state['extra_worker_retired']:
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
                    started_at = asyncio.get_running_loop().time()
                    try:
                        results[idx] = await search_one(
                            page,
                            case['court'],
                            case['case_no'],
                            case['party_name'],
                            prepare_only,
                            ocr_executor,
                            connection_circuit,
                            session_states[worker_id],
                        )
                        record_adaptive_health(
                            adaptive_state,
                            results[idx],
                            asyncio.get_running_loop().time() - started_at,
                        )
                        if (
                            rescue_enabled
                            and not retry
                            and idx not in retry_scheduled
                            and str(results[idx].get('사건명', '')).startswith('조회실패')
                        ):
                            retry_scheduled.add(idx)
                            immediate_retry_queue.put_nowait(idx)
                            print(
                                f"  🚑 실패 사건 즉시 구조대 대기열 등록: "
                                f"{idx + 1}/{len(cases)}"
                            )
                        if not retry:
                            await partial_publisher.publish_ready()
                    finally:
                        queue.task_done()

            primary_tasks = [
                asyncio.create_task(worker(worker_id, pages[worker_id][1]))
                for worker_id in range(worker_count)
            ]
            batch_finished = asyncio.Event()

            async def adaptive_worker(worker_id, page):
                scale_wait = asyncio.create_task(adaptive_state['scale_event'].wait())
                finish_wait = asyncio.create_task(batch_finished.wait())
                _, pending = await asyncio.wait(
                    (scale_wait, finish_wait),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                if (
                    batch_finished.is_set()
                    or adaptive_state['extra_worker_retired']
                    or queue.empty()
                ):
                    return
                await worker(worker_id, page)

            extra_tasks = [] if rescue_enabled else [
                asyncio.create_task(adaptive_worker(worker_id, pages[worker_id][1]))
                for worker_id in range(worker_count, max_worker_count)
            ]
            await asyncio.gather(*primary_tasks)
            batch_finished.set()
            await asyncio.gather(*extra_tasks)

        rescue_tasks = []
        if rescue_enabled:
            rescue_tasks.append(asyncio.create_task(
                rescue_worker(worker_count, pages[worker_count][1])
            ))

        await run_batch(range(len(cases)))

        if rescue_enabled:
            # 1차 큐가 끝난 뒤 유휴 상태가 된 세 워커도 남은 구조대 큐를
            # 함께 비워 마지막 재조회 꼬리가 전체 완료를 늦추지 않게 한다.
            rescue_tasks.extend(
                asyncio.create_task(rescue_worker(worker_id, pages[worker_id][1]))
                for worker_id in range(worker_count)
            )
            await immediate_retry_queue.join()
            for task in rescue_tasks:
                task.cancel()
            await asyncio.gather(*rescue_tasks, return_exceptions=True)
            if retried_indices:
                await partial_publisher.publish_revisions(
                    sorted(retried_indices)
                )
            print(
                f"🚑 구조대 재조회 완료: {len(retried_indices)}건 "
                f"(1차 조회와 병행)"
            )

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
            await partial_publisher.publish_ready()
            print(
                f"\n⛔ 서로 다른 검색 세션 "
                f"{connection_circuit['required_failed_sessions']}개가 첫 화면을 "
                f"열지 못해 남은 {deferred}건을 조회보류로 저장합니다."
            )

        if connection_circuit['structure_event'].is_set():
            deferred = 0
            for idx, data in enumerate(results):
                if data:
                    continue
                deferred += 1
                results[idx] = {h: '' for h in OUTPUT_HEADERS} | {
                    '법원': cases[idx]['court'],
                    '사건번호': cases[idx]['case_no'],
                    '사건명': '조회보류: 법원 사이트 구조변경 감지',
                    '조회일시': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                }
            await partial_publisher.publish_ready()
            print(
                f"\n⛔ 서로 다른 사건 {MAX_GLOBAL_STRUCTURE_FAILURES}건에서 "
                f"구조변경이 확인되어 남은 {deferred}건을 조회보류로 저장합니다."
            )

        # 1차 조회에서 접속 장애·캡차 오류 등으로 실패한 사건만 마지막에
        # 한 번 더 시도한다. 성공한 행은 그대로 보존하고, 재시도 결과가
        # 실패해도 최신 실패 사유를 결과 파일에 남긴다.
        if (
            not prepare_only
            and not connection_circuit['event'].is_set()
            and not connection_circuit['structure_event'].is_set()
        ):
            failed = [
                idx for idx, data in enumerate(results)
                if str(data.get('사건명', '')).startswith('조회실패')
                and idx not in retried_indices
            ]
            if failed:
                print(f"\n실패 사건 재조회 시작: {len(failed)}건 (각 사건 1회)")
                await run_batch(failed, retry=True)
                await partial_publisher.publish_revisions(failed)

        session_metrics = {
            'cases': len(cases),
            'navigations': sum(
                int(state.get('navigations', 0)) for state in session_states
            ),
            'reuse_hits': sum(
                int(state.get('reuse_hits', 0)) for state in session_states
            ),
            'reuse_prepared': sum(
                int(state.get('reuse_prepared', 0)) for state in session_states
            ),
            'reuse_fallbacks': sum(
                int(state.get('reuse_fallbacks', 0)) for state in session_states
            ),
            'direct_api_successes': sum(
                int(state.get('direct_api_successes', 0))
                for state in session_states
            ),
            'direct_api_fallbacks': sum(
                int(state.get('direct_api_fallbacks', 0))
                for state in session_states
            ),
            'direct_api_circuit_open': connection_circuit[
                'direct_event'
            ].is_set(),
            'direct_api_contract_failures': len(
                connection_circuit['direct_contract_failures']
            ),
            'structure_circuit_open': connection_circuit[
                'structure_event'
            ].is_set(),
            'structure_failures': len(
                connection_circuit['structure_failures']
            ),
            'immediate_retries': len(retried_indices),
            'elapsed_seconds_before_output': round(
                asyncio.get_running_loop().time() - run_started_at, 2
            ),
        }
        print(
            '성능 계측: '
            + json.dumps(session_metrics, ensure_ascii=False, sort_keys=True)
        )
        await browser.close()
    ocr_executor.shutdown(wait=True)

    write_output(results, output_path)
    await partial_publisher.close()


if __name__ == '__main__':
    asyncio.run(main())
