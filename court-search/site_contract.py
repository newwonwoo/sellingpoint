"""법원 사건검색 사이트의 화면·JSON 계약과 변경 감지 도구.

사이트 구현 세부사항은 이 파일에 모은다. 검색 로직은 여기서 확인한
셀렉터와 검증 결과만 사용해, 단순 ID 변경은 복구하고 의미가 달라진
응답은 성공으로 저장하지 않는다.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


CONTRACT_VERSION = "2026-10-13.1"

# 첫 번째 항목은 현재 사이트의 정확한 ID다. 뒤 항목은 WebSquare가 화면
# prefix만 바꾼 경우에도 같은 의미의 컨트롤을 찾기 위한 안전한 대안이다.
FORM_SELECTOR_CANDIDATES: dict[str, tuple[str, ...]] = {
    "court": (
        "#mf_ssgoTopMainTab_contents_content1_body_sbx_cortCd",
        'select[id$="_sbx_cortCd"]',
        '[id$="_sbx_cortCd"]',
        'select[name$="cortCd"]',
    ),
    "year": (
        "#mf_ssgoTopMainTab_contents_content1_body_sbx_csYr",
        'select[id$="_sbx_csYr"]',
        '[id$="_sbx_csYr"]',
        'select[name$="csYr"]',
    ),
    "case_type": (
        "#mf_ssgoTopMainTab_contents_content1_body_sbx_csDvsCd",
        'select[id$="_sbx_csDvsCd"]',
        '[id$="_sbx_csDvsCd"]',
        'select[name$="csDvsCd"]',
    ),
    "serial": (
        "#mf_ssgoTopMainTab_contents_content1_body_ibx_csSerial",
        'input[id$="_ibx_csSerial"]',
        '[id$="_ibx_csSerial"]',
        'input[name$="csSerial"]',
    ),
    "party": (
        "#mf_ssgoTopMainTab_contents_content1_body_ibx_btprNm",
        'input[id$="_ibx_btprNm"]',
        '[id$="_ibx_btprNm"]',
        'input[name$="btprNm"]',
    ),
    "captcha_input": (
        "#mf_ssgoTopMainTab_contents_content1_body_ibx_answer",
        'input[id$="_ibx_answer"]',
        '[id$="_ibx_answer"]',
        'input[name$="answer"]',
    ),
    "captcha_image": (
        "#mf_ssgoTopMainTab_contents_content1_body_img_captcha",
        '[id$="_img_captcha"]',
        'img[id*="captcha" i]',
        'img[alt*="자동입력"]',
    ),
    "captcha_reload": (
        "#mf_ssgoTopMainTab_contents_content1_body_btn_reloadCaptcha",
        '[id$="_btn_reloadCaptcha"]',
        '[title*="새로고침"]',
        '[aria-label*="새로고침"]',
    ),
    "search": (
        "#mf_ssgoTopMainTab_contents_content1_body_btn_srchCs",
        '[id$="_btn_srchCs"]',
        'button[title="검색"]',
        'input[value="검색"]',
    ),
}

FORM_REQUIRED_FIELDS = (
    "court", "year", "case_type", "serial", "party", "search",
)
CAPTCHA_REQUIRED_FIELDS = ("captcha_input", "captcha_image")


def selector_union(field: str) -> str:
    """검사기가 붙인 의미 표식과 알려진 셀렉터를 하나의 CSS로 만든다."""
    selectors = (f'[data-court-search-role="{field}"]',) + (
        FORM_SELECTOR_CANDIDATES[field]
    )
    return ", ".join(selectors)


# Sync/async Playwright 양쪽에서 같은 page.evaluate 코드로 사용한다. 정확한
# ID 후보를 먼저 사용하고, 없으면 옵션·문구·역할을 이용해 의미상 같은
# 컨트롤을 찾는다. 찾은 요소에는 실행 중에만 쓰는 data 속성을 붙인다.
FORM_INSPECTION_JS = r"""
({ candidates, requiredForm, requiredCaptcha, version }) => {
  const visible = (element) => !!(
    element && (element.offsetWidth || element.offsetHeight ||
      element.getClientRects().length)
  );
  const all = (selector) => {
    try { return [...document.querySelectorAll(selector)]; }
    catch (_) { return []; }
  };
  const text = (element) => String(
    element?.innerText || element?.textContent || element?.value || ''
  ).replace(/\s+/g, ' ').trim();
  const firstVisible = (selectors) => {
    for (const selector of selectors || []) {
      const found = all(selector).find(visible);
      if (found) return found;
    }
    return null;
  };
  const optionTexts = (select) => [...(select?.options || [])]
    .map((option) => text(option));
  const selects = all('select').filter(visible);
  const inputs = all('input').filter(visible);
  const controls = all('button, input[type="button"], input[type="submit"], a, [role="button"]')
    .filter(visible);
  const nearbyText = (element) => text(
    element?.closest('tr, td, li, fieldset, div, section, form')
  );

  const semantic = {
    court: () => selects.find((element) => {
      const options = optionTexts(element);
      return options.length > 10 && options.some((value) => value.includes('서울중앙지방법원'));
    }),
    year: () => selects.find((element) => {
      const values = optionTexts(element).filter((value) => /^20\d{2}$/.test(value));
      return values.length >= 3;
    }),
    case_type: () => selects.find((element) => {
      const options = optionTexts(element);
      return options.some((value) => /^(타인|타경|가단|가합)$/.test(value));
    }),
    serial: () => inputs.find((element) =>
      /csSerial/i.test(`${element.id} ${element.name}`) ||
      /일련번호/.test(nearbyText(element))
    ),
    party: () => inputs.find((element) =>
      /btprNm/i.test(`${element.id} ${element.name}`) ||
      /당사자명/.test(nearbyText(element))
    ),
    captcha_input: () => inputs.find((element) =>
      /answer|captcha/i.test(`${element.id} ${element.name}`) ||
      /자동입력|방지문자/.test(nearbyText(element))
    ),
    captcha_image: () => all('img, canvas').filter(visible).find((element) =>
      /captcha|자동입력|방지문자/i.test(
        `${element.id} ${element.getAttribute('alt') || ''} ${element.getAttribute('title') || ''}`
      ) || String(element.getAttribute('src') || '').startsWith('blob:')
    ),
    captcha_reload: () => controls.find((element) =>
      /reloadCaptcha|새로고침|새문자/i.test(
        `${element.id} ${element.getAttribute('title') || ''} ${element.getAttribute('aria-label') || ''} ${text(element)}`
      )
    ),
    search: () => controls.find((element) => {
      const label = text(element);
      return label === '검색' || /srchCs/i.test(element.id || '');
    }),
  };

  const resolved = {};
  for (const field of Object.keys(candidates)) {
    const element = firstVisible(candidates[field]) || semantic[field]?.() || null;
    if (!element) continue;
    element.setAttribute('data-court-search-role', field);
    resolved[field] = {
      selector: `[data-court-search-role="${field}"]`,
      id: element.id || '',
      name: element.getAttribute('name') || '',
      tag: element.tagName || '',
      optionCount: element.options?.length || 0,
    };
  }
  const missingForm = requiredForm.filter((field) => !resolved[field]);
  const missingCaptcha = requiredCaptcha.filter((field) => !resolved[field]);
  return {
    version,
    url: location.href,
    title: document.title,
    appMarker: /사건검색|사건번호|나의 사건/.test(text(document.body)),
    resolved,
    missingForm,
    missingCaptcha,
    formOk: missingForm.length === 0,
    captchaOk: missingCaptcha.length === 0,
  };
}
"""


def inspection_argument() -> dict[str, Any]:
    return {
        "candidates": {
            field: list(selectors)
            for field, selectors in FORM_SELECTOR_CANDIDATES.items()
        },
        "requiredForm": list(FORM_REQUIRED_FIELDS),
        "requiredCaptcha": list(CAPTCHA_REQUIRED_FIELDS),
        "version": CONTRACT_VERSION,
    }

def json_schema_snapshot(value: Any, depth: int = 0) -> Any:
    """값이나 당사자명을 저장하지 않고 JSON의 키와 자료형만 남긴다."""
    if depth >= 5:
        return type(value).__name__
    if isinstance(value, dict):
        return {
            str(key): json_schema_snapshot(child, depth + 1)
            for key, child in sorted(value.items(), key=lambda item: str(item[0]))
        }
    if isinstance(value, list):
        return {
            "type": "list",
            "length": len(value),
            "item": json_schema_snapshot(value[0], depth + 1) if value else None,
        }
    return type(value).__name__


def fingerprint(value: Any) -> str:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:16]


KNOWN_BASIC_KEYS = {
    "csNm", "userCsNo", "lwstDvsCd", "jdbnNm", "ultmtJdbnNm", "telNo",
    "csPrsrvYn", "csRcptYmd", "csUltmtYmd", "csUltmtDvsNm",
    "dcsnstDlvrYmd", "csCfmtnYmd",
}
KNOWN_PROGRESS_KEYS = {
    "progYmd", "progCtt", "progRslt", "progCttDvs", "pntcImg",
}


def _valid_date(value: Any) -> bool:
    digits = re.sub(r"[^0-9]", "", str(value or ""))
    return not digits or len(digits) == 8


def validate_direct_payloads(
    basic_payload: Any,
    progress_payload: Any,
    requested_case_no: str,
) -> dict[str, Any]:
    """직접조회 응답이 알려진 의미를 유지하는지 검증한다.

    빈 값 자체는 정상일 수 있으므로 값 개수가 아니라 키·자료형·사건 식별을
    검사한다. 오류가 하나라도 있으면 화면 조회로 전환해야 한다.
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(basic_payload, dict):
        errors.append("basic_payload_not_object")
        basic_payload = {}
    if not isinstance(progress_payload, dict):
        errors.append("progress_payload_not_object")
        progress_payload = {}

    basic_data = basic_payload.get("data")
    progress_data = progress_payload.get("data")
    if not isinstance(basic_data, dict):
        errors.append("basic_data_missing")
        basic_data = {}
    if not isinstance(progress_data, dict):
        errors.append("progress_data_missing")
        progress_data = {}

    basic = basic_data.get("dma_csBasCtt")
    if not isinstance(basic, dict):
        errors.append("basic_case_block_missing")
        basic = {}
    if not str(basic.get("csNm") or "").strip():
        errors.append("case_name_missing")

    known_basic = KNOWN_BASIC_KEYS.intersection(basic.keys())
    if len(known_basic) < 4:
        errors.append("basic_schema_changed")

    returned_case = re.sub(r"\s+", "", str(basic.get("userCsNo") or ""))
    requested = re.sub(r"\s+", "", requested_case_no)
    if returned_case and returned_case != requested:
        errors.append("case_number_mismatch")
    elif not returned_case:
        warnings.append("response_case_number_absent")

    for key in ("csRcptYmd", "csUltmtYmd", "dcsnstDlvrYmd", "csCfmtnYmd"):
        if not _valid_date(basic.get(key)):
            errors.append(f"invalid_date:{key}")

    if "dlt_csProgCtt" not in progress_data:
        errors.append("progress_list_missing")
        progress_rows = []
    else:
        progress_rows = progress_data.get("dlt_csProgCtt")
        if not isinstance(progress_rows, list):
            errors.append("progress_list_not_array")
            progress_rows = []
    for row in progress_rows[:3]:
        if not isinstance(row, dict):
            errors.append("progress_row_not_object")
            break
        if len(KNOWN_PROGRESS_KEYS.intersection(row.keys())) < 2:
            errors.append("progress_schema_changed")
            break
        if not _valid_date(row.get("progYmd")):
            errors.append("invalid_date:progYmd")
            break

    for key in ("dlt_reltCsLst", "dlt_btprtCttLst"):
        value = basic_data.get(key)
        if value is not None and not isinstance(value, list):
            errors.append(f"invalid_list:{key}")

    schema = {
        "basic": json_schema_snapshot(basic_payload),
        "progress": json_schema_snapshot(progress_payload),
    }
    return {
        "ok": not errors,
        "errors": sorted(set(errors)),
        "warnings": sorted(set(warnings)),
        "schema": schema,
        "fingerprint": fingerprint(schema),
        "knownBasicKeys": sorted(known_basic),
    }
