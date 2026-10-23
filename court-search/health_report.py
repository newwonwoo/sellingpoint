"""정기점검 보고서. 미확인 응답이나 조회 장애는 구조 변경의 증거가 아니다."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from connection_probe import MESSAGES, STRUCTURE_CLASSIFICATIONS, http_classification


def build_report(connection: dict, diagnosis: str, lookup: str,
                 result: dict, events: list[dict], run_url: str = "") -> dict:
    rows = result.get("results") or []
    rows = rows if isinstance(rows, list) else []
    row = rows[0] if rows and isinstance(rows[0], dict) else {}
    name = str(row.get("사건명") or "")
    valid = row.get("사건번호") == "2026타인3944" and "부동산인도명령" in name and not name.startswith(("조회실패", "조회보류"))
    classification = connection.get("classification") or "DIAGNOSIS_UNAVAILABLE"
    status = "unavailable"
    message = connection.get("message") or "접속 진단 결과 미확인"
    if diagnosis != "success" or not connection.get("success"):
        if classification in STRUCTURE_CLASSIFICATIONS:
            status = "structure_changed"
    elif lookup == "success" and valid:
        status, classification = "healthy", "HEALTHY"
        message = "법원 사이트 통신·화면·API 구조 정상"
    else:
        # HTTP 오류/전송 실패를 구조 이벤트보다 먼저 판별한다.
        protocols = [e for e in events if e.get("classification") == "API_PROTOCOL_ERROR"]
        structure = [e for e in events if e.get("classification") in {
            "API_CHANGED", "RESULT_CHANGED",
        }]
        # 조회기의 FORM/CAPTCHA 이벤트에는 리소스 로딩 상태가 없다.
        # 재접속 중 미완성 화면일 수도 있어 사전 진단의 화면 판정과 구분한다.
        if protocols:
            code = (protocols[-1].get("details") or {}).get("http_status")
            classification = http_classification(code) or (
                "NETWORK_ERROR" if code == 0 else "LOOKUP_UNAVAILABLE"
            )
        elif any(token in name for token in ("연결 실패", "접속 불가", "전체 접속 장애")):
            classification = "NETWORK_ERROR"
        elif "시간 초과" in name:
            classification = "LOOKUP_TIMEOUT"
        elif structure:
            status, classification = "structure_changed", structure[-1]["classification"]
        elif name and not name.startswith(("조회실패", "조회보류")):
            classification = "CANARY_MISMATCH"
        else:
            classification = "LOOKUP_UNAVAILABLE"
        message = MESSAGES.get(classification, {
            "API_CHANGED": "법원 사이트 API 응답 계약 변경 감지",
            "RESULT_CHANGED": "법원 사이트 결과 구조 변경 감지",
            "LOOKUP_TIMEOUT": "검증 조회 시간초과 — 구조 변경 판정 보류",
            "CANARY_MISMATCH": "검증 사건 결과 불일치 — 구조 변경 판정 보류",
            "LOOKUP_UNAVAILABLE": "검증 조회 미완료 — 구조 변경 판정 보류",
        }.get(classification, classification))
    return {
        "status": status, "classification": classification, "message": message,
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fingerprint": (connection.get("browser", {}).get("contract") or {}).get("fingerprint", ""),
        "runUrl": run_url,
        "diagnosisOutcome": diagnosis, "lookupOutcome": lookup,
        "connection": {
            "classification": connection.get("classification"),
            "failureStage": connection.get("failure_stage"),
            "attemptCount": connection.get("attempt_count"),
            "networkDiagnosis": connection.get("network_diagnosis"),
        },
        "canary": {"court": "서울남부지방법원", "caseNo": "2026타인3944", "caseNameMatched": valid},
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
    report = build_report(
        read_json(root / "connection.json"), os.getenv("DIAGNOSIS_OUTCOME", ""),
        os.getenv("LOOKUP_OUTCOME", ""), read_json(root / "canary-result.json"),
        events, os.getenv("RUN_URL", ""),
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
