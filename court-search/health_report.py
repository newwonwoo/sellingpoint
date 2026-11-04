"""정기점검 보고서. 미확인 응답이나 조회 장애는 구조 변경의 증거가 아니다."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from connection_probe import MESSAGES, STRUCTURE_CLASSIFICATIONS, http_classification


DEFAULT_CASES = [{
    "court": "서울남부지방법원",
    "case_no": "2026타인3944",
    "expected_name": "부동산인도명령",
}]


def build_report(connection: dict, diagnosis: str, lookup: str,
                 result: dict, events: list[dict], run_url: str = "",
                 expected_cases: list[dict] | None = None) -> dict:
    expected = expected_cases or DEFAULT_CASES
    raw_rows = result.get("results") or []
    rows = raw_rows if isinstance(raw_rows, list) else []
    matched_count = 0
    baseline_case_name_matched = False
    mismatch_detected = False
    names = []

    for index, expected_case in enumerate(expected):
        row = rows[index] if index < len(rows) and isinstance(rows[index], dict) else {}
        case_no = str(expected_case.get("case_no") or expected_case.get("caseNo") or "")
        returned_case_no = str(row.get("사건번호") or "")
        name = str(row.get("사건명") or "").strip()
        names.append(name)
        expected_name = str(expected_case.get("expected_name") or "").strip()
        if not expected_name and case_no == "2026타인3944":
            expected_name = "부동산인도명령"
        is_error = not name or name.startswith(("조회실패", "조회보류"))
        case_matches = bool(case_no) and returned_case_no == case_no
        name_matches = not is_error and name != "사건없음"
        if expected_name:
            name_matches = name_matches and expected_name in name
            if case_no == "2026타인3944":
                baseline_case_name_matched = name_matches and case_matches
        if case_matches and name_matches:
            matched_count += 1
        elif name and not is_error and (
            not case_matches or name == "사건없음" or (expected_name and expected_name not in name)
        ):
            mismatch_detected = True

    not_attempted_count = sum(
        index >= len(rows)
        or not isinstance(rows[index], dict)
        or str(rows[index].get("사건명") or "").strip().startswith("조회보류")
        for index in range(len(expected))
    )
    attempted_count = max(0, len(expected) - not_attempted_count)
    all_cases_valid = (
        bool(expected)
        and len(rows) == len(expected)
        and matched_count == len(expected)
    )
    classification = connection.get("classification") or "DIAGNOSIS_UNAVAILABLE"
    status = "unavailable"
    message = connection.get("message") or "접속 진단 결과 미확인"

    if diagnosis != "success" or not connection.get("success"):
        if classification in STRUCTURE_CLASSIFICATIONS:
            status = "structure_changed"
    elif lookup == "success" and all_cases_valid:
        status, classification = "healthy", "HEALTHY"
        message = f"법원 사이트 통신·화면·검증 조회 {len(expected)}건 정상"
    else:
        # HTTP 오류/전송 실패를 구조 이벤트보다 먼저 판별한다.
        protocols = [e for e in events if e.get("classification") == "API_PROTOCOL_ERROR"]
        structure = [e for e in events if e.get("classification") in {
            "API_CHANGED", "RESULT_CHANGED",
        }]
        # 조회기의 FORM/CAPTCHA 이벤트에는 리소스 로딩 상태가 없다.
        # 재접속 중 미완성 화면일 수도 있어 사전 진단의 화면 판정과 구분한다.
        case_not_found = [
            event for event in events
            if event.get("classification") == "API_CASE_NOT_FOUND"
            or (event.get("details") or {}).get("error_code") == "I_0002"
        ]
        if case_not_found:
            classification = "CANARY_CASE_NOT_FOUND"
        elif protocols:
            code = (protocols[-1].get("details") or {}).get("http_status")
            classification = http_classification(code) or (
                "NETWORK_ERROR" if code == 0 else "LOOKUP_UNAVAILABLE"
            )
        elif any(token in name for name in names for token in (
            "연결 실패", "접속 불가", "전체 접속 장애",
        )):
            classification = "NETWORK_ERROR"
        elif any("시간 초과" in name for name in names):
            classification = "LOOKUP_TIMEOUT"
        elif structure:
            status, classification = "structure_changed", structure[-1]["classification"]
        elif mismatch_detected:
            classification = "CANARY_MISMATCH"
        else:
            classification = "LOOKUP_UNAVAILABLE"
        message = MESSAGES.get(classification, {
            "API_CHANGED": "법원 사이트 API 응답 계약 변경 감지",
            "RESULT_CHANGED": "법원 사이트 결과 구조 변경 감지",
            "LOOKUP_TIMEOUT": "검증 조회 시간초과 — 구조 변경 판정 보류",
            "CANARY_MISMATCH": "검증 사건 결과 불일치 — 구조 변경 판정 보류",
            "LOOKUP_UNAVAILABLE": "검증 조회 미완료 — 구조 변경 판정 보류",
            "CANARY_CASE_NOT_FOUND": "검증 사건 없음 응답 — 법원·사건번호 확인 필요",
        }.get(classification, classification))

    return {
        "status": status,
        "classification": classification,
        "message": message,
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fingerprint": (connection.get("browser", {}).get("contract") or {}).get("fingerprint", ""),
        "runUrl": run_url,
        "diagnosisOutcome": diagnosis,
        "lookupOutcome": lookup,
        "connection": {
            "classification": connection.get("classification"),
            "failureStage": connection.get("failure_stage"),
            "attemptCount": connection.get("attempt_count"),
            "networkDiagnosis": connection.get("network_diagnosis"),
        },
        "canary": {
            "expectedCount": len(expected),
            "returnedCount": len(rows),
            "matchedCount": matched_count,
            "attemptedCount": attempted_count,
            "notAttemptedCount": not_attempted_count,
            "failedCount": max(0, attempted_count - matched_count),
            "notReturnedCount": max(0, len(expected) - len(rows)),
            "baselineCaseNameMatched": baseline_case_name_matched,
        },
    }


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def main() -> None:
    root = Path("court-search/health")
    events = []
    path = root / "debug/contract-events.jsonl"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
                if isinstance(event, dict):
                    events.append(event)
            except ValueError:
                continue
    canary_input = read_json(root / "canary-input.json")
    expected_cases = canary_input.get("cases")
    if not isinstance(expected_cases, list) or not expected_cases:
        expected_cases = DEFAULT_CASES
    report = build_report(
        read_json(root / "connection.json"), os.getenv("DIAGNOSIS_OUTCOME", ""),
        os.getenv("LOOKUP_OUTCOME", ""), read_json(root / "canary-result.json"),
        events, os.getenv("RUN_URL", ""), expected_cases,
    )
    root.mkdir(parents=True, exist_ok=True)
    (root / "health-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a", encoding="utf-8") as stream:
            stream.write(f"법원 정기점검: **{report['status']} / {report['classification']}**\n\n{report['message']}\n")


if __name__ == "__main__":
    main()
