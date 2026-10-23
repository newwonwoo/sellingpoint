#!/usr/bin/env python3
"""법원 사이트 조회 전에 현재 실행환경의 통신 경로를 짧게 검증한다."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import socket
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from site_contract import (
    CONTRACT_VERSION,
    FORM_INSPECTION_JS,
    fingerprint,
    inspection_argument,
)


DEFAULT_URL = "https://ssgo.scourt.go.kr/ssgo/index.on?cortId=www"
STRUCTURE_CLASSIFICATIONS = {"FORM_CHANGED", "CAPTCHA_CHANGED"}
RETRYABLE_CLASSIFICATIONS = {
    "NETWORK_ERROR", "BROWSER_CONNECTION_ERROR", "SERVER_ERROR", "PAGE_UNAVAILABLE",
}
MESSAGES = {
    "HEALTHY": "법원 사이트 통신·화면 구조 정상",
    "NETWORK_ERROR": "법원 사이트 네트워크 연결 실패",
    "BROWSER_CONNECTION_ERROR": "법원 사이트 브라우저 연결 실패",
    "BROWSER_ENVIRONMENT_ERROR": "점검 브라우저 실행환경 오류",
    "ACCESS_DENIED": "법원 사이트 HTTP 접근 거부",
    "RATE_LIMITED": "법원 사이트 요청 제한 — 자동 재시도 중단",
    "SERVER_ERROR": "법원 사이트 서버 오류",
    "HTTP_ERROR": "법원 사이트 HTTP 응답 오류",
    "PAGE_UNAVAILABLE": "법원 검색 화면 초기화 미확인 — 구조 변경 판정 보류",
    "FORM_CHANGED": "법원 사이트 입력 화면 구조변경 감지",
    "CAPTCHA_CHANGED": "법원 사이트 캡차 구조변경 감지",
}
COURT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


def elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


def discover_public_ip(timeout: float = 3.0) -> str:
    """진단용 공개 IP 확인 실패는 법원 연결 판정을 막지 않는다."""
    request = urllib.request.Request(
        "https://api.ipify.org?format=json",
        headers={"User-Agent": "court-search-connection-probe/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return str(json.loads(response.read().decode("utf-8"))["ip"])
    except Exception as error:  # 외부 진단 서비스는 선택 사항이다.
        return f"확인 실패: {type(error).__name__}"


def error_details(error: Exception, started: float) -> dict:
    return {
        "ok": False,
        "error": f"{type(error).__name__}: {error}",
        "error_type": type(error).__name__,
        "errno": getattr(error, "errno", None),
        "elapsed_ms": elapsed_ms(started),
    }


def http_classification(status: int | None) -> str | None:
    if status in {401, 403}:
        return "ACCESS_DENIED"
    if status == 429:
        return "RATE_LIMITED"
    if status and status >= 500:
        return "SERVER_ERROR"
    if status and status >= 400:
        return "HTTP_ERROR"
    return None


def classify_page(contract: dict, resource_errors: list[dict]) -> str:
    if contract.get("formOk") and contract.get("captchaOk"):
        return "HEALTHY"
    if resource_errors:
        # JS/초기화 API를 받지 못한 화면은 구조 비교의 전제조건을 충족하지 않는다.
        for item in resource_errors:
            code = http_classification(item.get("status"))
            if code in {"ACCESS_DENIED", "RATE_LIMITED"}:
                return code
        return "PAGE_UNAVAILABLE"
    if not contract.get("formOk") and (
        not contract.get("appMarker") or not contract.get("resolved")
    ):
        return "PAGE_UNAVAILABLE"
    return "FORM_CHANGED" if not contract.get("formOk") else "CAPTCHA_CHANGED"


def probe(url: str, timeout: float, *, include_public_ip: bool = True) -> tuple[dict, bool]:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    port = parsed.port or 443
    path = parsed.path or "/"
    if parsed.query:
        path += f"?{parsed.query}"

    report = {
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target": url,
        "runner": {
            "name": os.environ.get("RUNNER_NAME", ""),
            "os": os.environ.get("RUNNER_OS", ""),
            "arch": os.environ.get("RUNNER_ARCH", ""),
            "image_os": os.environ.get("ImageOS", ""),
            "image_version": os.environ.get("ImageVersion", ""),
        },
        "public_ip": discover_public_ip() if include_public_ip else "",
        "dns": {},
        "tcp": {},
        "tls": {},
        "http": {},
    }

    try:
        started = time.monotonic()
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        ips = sorted({item[4][0] for item in addresses})
        report["dns"] = {"ok": True, "ips": ips, "elapsed_ms": elapsed_ms(started)}
        print(f"  DNS 성공: {host} -> {', '.join(ips)} ({report['dns']['elapsed_ms']}ms)")
    except Exception as error:
        report["dns"] = error_details(error, started)
        print(f"  ❌ DNS 실패: {report['dns']['error']}")
        return report, False

    try:
        started = time.monotonic()
        with socket.create_connection((host, port), timeout=timeout):
            report["tcp"] = {"ok": True, "elapsed_ms": elapsed_ms(started)}
        print(f"  TCP 443 성공 ({report['tcp']['elapsed_ms']}ms)")
    except Exception as error:
        report["tcp"] = error_details(error, started)
        print(f"  ❌ TCP 443 실패: {report['tcp']['error']}")
        return report, False

    try:
        started = time.monotonic()
        context = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=timeout) as raw_socket:
            with context.wrap_socket(raw_socket, server_hostname=host) as tls_socket:
                report["tls"] = {
                    "ok": True,
                    "version": tls_socket.version(),
                    "elapsed_ms": elapsed_ms(started),
                }
        print(
            f"  TLS 성공: {report['tls']['version']} "
            f"({report['tls']['elapsed_ms']}ms)"
        )
    except Exception as error:
        report["tls"] = error_details(error, started)
        print(f"  ❌ TLS 실패: {report['tls']['error']}")
        return report, False

    connection = None
    try:
        started = time.monotonic()
        connection = http.client.HTTPSConnection(host, port, timeout=timeout)
        connection.request(
            "GET",
            path,
            headers={
                "User-Agent": (
                    COURT_USER_AGENT
                ),
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        response = connection.getresponse()
        # 상태코드 진단에는 본문이 필요 없다. 제한 응답의 본문 대기가
        # 시간초과하여 403/429를 NETWORK_ERROR로 덮지 않도록 한다.
        ok = 200 <= response.status < 400
        report["http"] = {
            "ok": ok,
            "status": response.status,
            "elapsed_ms": elapsed_ms(started),
            "retry_after": response.getheader("Retry-After"),
        }
        marker = "성공" if ok else "실패"
        print(
            f"  HTTP {marker}: 상태 {response.status} "
            f"({report['http']['elapsed_ms']}ms)"
        )
        return report, ok
    except Exception as error:
        report["http"] = error_details(error, started)
        print(f"  ❌ HTTP 실패: {report['http']['error']}")
        return report, False
    finally:
        if connection is not None:
            connection.close()


def save_browser_evidence(page, artifacts_dir: Path | None, label: str) -> dict:
    """구조 진단에 필요한 화면만 저장하고 입력값은 수집하지 않는다."""
    if artifacts_dir is None:
        return {}
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    saved = {}
    try:
        screenshot = artifacts_dir / f"{label}.png"
        page.screenshot(path=str(screenshot), full_page=True)
        saved["screenshot"] = str(screenshot)
    except Exception as error:
        saved["screenshot_error"] = f"{type(error).__name__}: {error}"
    try:
        html = artifacts_dir / f"{label}.html"
        html.write_text(page.content(), encoding="utf-8")
        saved["html"] = str(html)
    except Exception as error:
        saved["html_error"] = f"{type(error).__name__}: {error}"
    return saved


def classify_probe(
    transport_success: bool,
    browser_report: dict,
    browser_success: bool,
    transport_report: dict | None = None,
) -> str:
    """브라우저가 실제 페이지를 읽었다면 화면 구조 판정을 우선한다."""
    if browser_success:
        return "HEALTHY"
    browser_classification = browser_report.get(
        "classification", "BROWSER_CONNECTION_ERROR"
    )
    if browser_classification in {
        "ACCESS_DENIED", "RATE_LIMITED", "SERVER_ERROR", "HTTP_ERROR",
        "BROWSER_ENVIRONMENT_ERROR", "PAGE_UNAVAILABLE",
    }:
        return browser_classification
    if (
        browser_report.get("page_loaded")
        and browser_classification in STRUCTURE_CLASSIFICATIONS
    ):
        return browser_classification
    if not transport_success:
        return http_classification((transport_report or {}).get("http", {}).get("status")) or "NETWORK_ERROR"
    return browser_classification


def probe_browser(
    url: str,
    timeout: float,
    artifacts_dir: Path | None = None,
) -> tuple[dict, bool]:
    """Chromium 접속과 화면 계약을 분리해서 확인한다."""
    started = time.monotonic()
    browser = None
    context = None
    phase = "launch"
    http_status = None
    resource_errors = []
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            launch_options = {
                "headless": True,
                "args": [
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ],
            }
            executable_path = os.environ.get(
                "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", ""
            ).strip()
            if executable_path:
                if not Path(executable_path).is_file():
                    raise RuntimeError(
                        f"지정한 Chromium 실행파일 없음: {executable_path}"
                    )
                launch_options["executable_path"] = executable_path

            browser = playwright.chromium.launch(**launch_options)
            try:
                context = browser.new_context(
                    locale="ko-KR",
                    user_agent=COURT_USER_AGENT,
                )
                try:
                    page = context.new_page()
                    origin = urlparse(url).netloc

                    def record_response(response):
                        if urlparse(response.url).netloc == origin and response.status >= 400:
                            resource_errors.append({"status": response.status, "type": response.request.resource_type})

                    def record_failure(request):
                        if urlparse(request.url).netloc == origin:
                            resource_errors.append({"error": request.failure, "type": request.resource_type})

                    page.on("response", record_response)
                    page.on("requestfailed", record_failure)
                    page.on("pageerror", lambda error: resource_errors.append({"error": str(error)[:300], "type": "script"}))
                    phase = "navigation"
                    timeout_ms = max(1_000, round(timeout * 1_000))
                    response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                    http_status = response.status if response else None
                    classification = http_classification(http_status)
                    if classification:
                        return {
                            "ok": False, "page_loaded": True,
                            "classification": classification,
                            "http_status": http_status,
                            "retry_after": response.headers.get("retry-after"),
                            "elapsed_ms": elapsed_ms(started),
                            "evidence": save_browser_evidence(page, artifacts_dir, "http-error"),
                        }, False
                    phase = "contract"
                    elapsed = time.monotonic() - started
                    remaining_ms = max(
                        1_000, round((timeout - elapsed) * 1_000)
                    )
                    deadline = time.monotonic() + remaining_ms / 1000
                    contract = {}
                    while time.monotonic() < deadline:
                        contract = page.evaluate(
                            FORM_INSPECTION_JS, inspection_argument()
                        )
                        if contract.get("formOk") and contract.get("captchaOk"):
                            break
                        page.wait_for_timeout(250)

                    contract_view = {
                        "version": CONTRACT_VERSION,
                        "app_marker": bool(contract.get("appMarker")),
                        "resolved": contract.get("resolved") or {},
                        "missing_form": contract.get("missingForm") or [],
                        "missing_captcha": contract.get("missingCaptcha") or [],
                    }
                    contract_view["fingerprint"] = fingerprint(contract_view)
                    classification = classify_page(contract, resource_errors)
                    if classification not in STRUCTURE_CLASSIFICATIONS | {"HEALTHY"}:
                        return {
                            "ok": False, "page_loaded": True,
                            "classification": classification,
                            "http_status": http_status,
                            "elapsed_ms": elapsed_ms(started),
                            "contract": contract_view,
                            "resource_errors": resource_errors[:20],
                            "evidence": save_browser_evidence(page, artifacts_dir, "page-unavailable"),
                        }, False
                    if not contract.get("formOk"):
                        evidence = save_browser_evidence(
                            page, artifacts_dir, "form-structure-changed"
                        )
                        result = {
                            "ok": False,
                            "page_loaded": True,
                            "classification": "FORM_CHANGED",
                            "http_status": http_status,
                            "elapsed_ms": elapsed_ms(started),
                            "final_url": page.url,
                            "title": page.title(),
                            "contract": contract_view,
                            "evidence": evidence,
                            "executable": executable_path or "playwright-default",
                        }
                        print(
                            "  ❌ 화면 구조 변경 감지: 필수 입력요소 없음 "
                            + ", ".join(contract_view["missing_form"])
                        )
                        return result, False
                    if not contract.get("captchaOk"):
                        evidence = save_browser_evidence(
                            page, artifacts_dir, "captcha-structure-changed"
                        )
                        result = {
                            "ok": False,
                            "page_loaded": True,
                            "classification": "CAPTCHA_CHANGED",
                            "http_status": http_status,
                            "elapsed_ms": elapsed_ms(started),
                            "final_url": page.url,
                            "title": page.title(),
                            "contract": contract_view,
                            "evidence": evidence,
                            "executable": executable_path or "playwright-default",
                        }
                        print(
                            "  ❌ 캡차 구조 변경 감지: 필수 요소 없음 "
                            + ", ".join(contract_view["missing_captcha"])
                        )
                        return result, False
                    result = {
                        "ok": True,
                        "page_loaded": True,
                        "classification": "HEALTHY",
                        "http_status": http_status,
                        "elapsed_ms": elapsed_ms(started),
                        "final_url": page.url,
                        "title": page.title(),
                        "contract": contract_view,
                        "executable": executable_path or "playwright-default",
                    }
                    print(
                        f"  Chromium 화면 계약 정상 ({result['elapsed_ms']}ms, "
                        f"지문 {contract_view['fingerprint']})"
                    )
                    return result, True
                finally:
                    context.close()
                    context = None
            finally:
                browser.close()
                browser = None
    except Exception as error:
        result = {
            "ok": False,
            "page_loaded": phase == "contract",
            "classification": "BROWSER_ENVIRONMENT_ERROR" if phase == "launch" else "BROWSER_CONNECTION_ERROR",
            "phase": phase,
            "http_status": http_status,
            "resource_errors": resource_errors[:20],
            "elapsed_ms": elapsed_ms(started),
            "error": f"{type(error).__name__}: {str(error).replace(chr(10), ' ')[:500]}",
        }
        print(f"  ❌ Chromium 첫 화면 실패: {result['error']}")
        return result, False


def diagnose(url: str, timeout: float, browser_timeout: float,
             artifacts_dir: Path | None = None, attempts: int = 1,
             retry_delay: float = 5.0) -> dict:
    """같은 실행환경에서 제한적으로 재시도한다. 차단 응답에는 재접속하지 않는다."""
    history = []
    public_ip = discover_public_ip()
    for attempt in range(1, attempts + 1):
        print(f"  접속 진단 {attempt}/{attempts}")
        report, transport_success = probe(url, timeout, include_public_ip=False)
        report["public_ip"] = public_ip
        transport_classification = http_classification(report.get("http", {}).get("status"))
        if transport_classification in {"ACCESS_DENIED", "RATE_LIMITED"}:
            # 제한 여부를 확인한 뒤 브라우저로 다시 요청하지 않는다.
            browser_report, browser_success = {
                "ok": False, "page_loaded": False, "skipped": True,
                "classification": transport_classification,
            }, False
        else:
            evidence_dir = artifacts_dir / f"attempt-{attempt}" if artifacts_dir else None
            browser_report, browser_success = probe_browser(url, browser_timeout, evidence_dir)
        report["browser"] = browser_report
        report["transport_success"] = transport_success
        report["success"] = browser_success
        report["classification"] = classify_probe(
            transport_success, browser_report, browser_success, report
        )
        report["failure_stage"] = next((
            stage for stage in ("dns", "tcp", "tls", "http")
            if report[stage].get("ok") is False
        ), None)
        report["retryable"] = report["classification"] in RETRYABLE_CLASSIFICATIONS
        retry_after = browser_report.get("retry_after") or report.get("http", {}).get("retry_after")
        if retry_after and report["classification"] == "SERVER_ERROR":
            # 서버가 지정한 대기시간을 짧은 재시도로 무시하지 않는다.
            report["retryable"] = False
            report["retry_suppressed"] = "server_retry_after"
        history.append(dict(report, attempt=attempt))
        if not report["retryable"] or attempt == attempts:
            break
        delay = min(30.0, retry_delay * (2 ** (attempt - 1)))
        print(f"  일시 장애 확인: 같은 실행환경에서 {delay:g}초 후 재시도")
        time.sleep(delay)

    report["attempts"] = history
    report["attempt_count"] = len(history)
    report["message"] = MESSAGES.get(report["classification"], report["classification"])
    report["network_diagnosis"] = {
        "cause_confirmed": False,
        "scope": "not_assessed",
    }
    if report["classification"] == "NETWORK_ERROR":
        # 대조 목적의 공개 HTTPS 연결 1회. 법원 접근 경로나 IP를 바꾸지 않는다.
        control, control_ok = probe("https://github.com/", timeout, include_public_ip=False)
        report["network_diagnosis"] = {
            "cause_confirmed": False,
            "scope": "target_path_failure" if control_ok else "runner_or_shared_path_failure",
            "control": control,
            "note": "대조 연결만으로 법원 차단·경로 장애·서버 장애를 확정할 수 없음",
        }
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--browser-timeout", type=float, default=30.0)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--artifacts-dir", type=Path)
    parser.add_argument("--attempts", type=int, choices=range(1, 4), default=1)
    parser.add_argument("--retry-delay", type=float, default=5.0)
    args = parser.parse_args()

    print("법원 사이트 연결 진단 시작")
    report = diagnose(
        args.url, max(1.0, args.timeout), max(1.0, args.browser_timeout),
        args.artifacts_dir, args.attempts, min(30.0, max(0.0, args.retry_delay)),
    )
    browser_report = report["browser"]
    browser_success = report["success"]
    classification = report["classification"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  실행환경 공인 IP: {report['public_ip']}")
    if browser_success:
        print("✅ 통신·화면 구조 진단 통과 — 같은 실행환경에서 조회를 시작합니다.")
    elif report["retryable"]:
        print("❌ 접속 진단 실패 — 원인을 단정하지 않고 진단자료를 보존합니다.")
    else:
        print(f"❌ {report['message']} — 같은 재시도를 중단하고 진단자료를 확인합니다.")

    github_output = os.environ.get("GITHUB_OUTPUT", "").strip()
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as output:
            print(f"classification={classification}", file=output)
            print(f"message={report['message']}", file=output)
            print(
                f"retryable={'true' if report['retryable'] else 'false'}",
                file=output,
            )
            contract = browser_report.get("contract") or {}
            print(f"fingerprint={contract.get('fingerprint', '')}", file=output)
    if browser_success:
        return 0
    return 2 if report["retryable"] else 3


if __name__ == "__main__":
    sys.exit(main())
