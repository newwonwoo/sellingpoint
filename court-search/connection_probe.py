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


def probe(url: str, timeout: float) -> tuple[dict, bool]:
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
        "public_ip": discover_public_ip(),
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
        report["dns"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        print(f"  ❌ DNS 실패: {report['dns']['error']}")
        return report, False

    try:
        started = time.monotonic()
        with socket.create_connection((host, port), timeout=timeout):
            report["tcp"] = {"ok": True, "elapsed_ms": elapsed_ms(started)}
        print(f"  TCP 443 성공 ({report['tcp']['elapsed_ms']}ms)")
    except Exception as error:
        report["tcp"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
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
        report["tls"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
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
        response.read(4096)
        ok = 200 <= response.status < 400
        report["http"] = {
            "ok": ok,
            "status": response.status,
            "elapsed_ms": elapsed_ms(started),
        }
        marker = "성공" if ok else "실패"
        print(
            f"  HTTP {marker}: 상태 {response.status} "
            f"({report['http']['elapsed_ms']}ms)"
        )
        return report, ok
    except Exception as error:
        report["http"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
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
) -> str:
    """브라우저가 실제 페이지를 읽었다면 화면 구조 판정을 우선한다."""
    if browser_success:
        return "HEALTHY"
    browser_classification = browser_report.get(
        "classification", "BROWSER_CONNECTION_ERROR"
    )
    if (
        browser_report.get("page_loaded")
        and browser_classification in STRUCTURE_CLASSIFICATIONS
    ):
        return browser_classification
    if not transport_success:
        return "NETWORK_ERROR"
    return browser_classification


def probe_browser(
    url: str,
    timeout: float,
    artifacts_dir: Path | None = None,
) -> tuple[dict, bool]:
    """Chromium 접속과 화면 계약을 분리해서 확인한다."""
    from playwright.sync_api import sync_playwright

    started = time.monotonic()
    browser = None
    context = None
    try:
        with sync_playwright() as playwright:
            launch_options = {
                "headless": True,
                "args": [
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled",
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
                    timeout_ms = max(1_000, round(timeout * 1_000))
                    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
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
                    if not contract.get("formOk"):
                        evidence = save_browser_evidence(
                            page, artifacts_dir, "form-structure-changed"
                        )
                        result = {
                            "ok": False,
                            "page_loaded": True,
                            "classification": "FORM_CHANGED",
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
            "page_loaded": False,
            "classification": "BROWSER_CONNECTION_ERROR",
            "elapsed_ms": elapsed_ms(started),
            "error": f"{type(error).__name__}: {str(error).replace(chr(10), ' ')[:500]}",
        }
        print(f"  ❌ Chromium 첫 화면 실패: {result['error']}")
        return result, False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--browser-timeout", type=float, default=30.0)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--artifacts-dir", type=Path)
    args = parser.parse_args()

    print("법원 사이트 연결 진단 시작")
    report, transport_success = probe(args.url, max(1.0, args.timeout))
    browser_report, browser_success = probe_browser(
        args.url,
        max(1.0, args.browser_timeout),
        args.artifacts_dir,
    )
    report["browser"] = browser_report
    report["transport_success"] = transport_success
    # 실제 조회도 Chromium을 사용하므로 최종 통과 여부는 브라우저 결과로 정한다.
    report["success"] = browser_success
    report["classification"] = classify_probe(
        transport_success, browser_report, browser_success
    )
    classification = report["classification"]
    messages = {
        "HEALTHY": "법원 사이트 통신·화면 구조 정상",
        "NETWORK_ERROR": "법원 사이트 네트워크 연결 실패",
        "BROWSER_CONNECTION_ERROR": "법원 사이트 브라우저 연결 실패",
        "FORM_CHANGED": "법원 사이트 입력 화면 구조변경 감지",
        "CAPTCHA_CHANGED": "법원 사이트 캡차 구조변경 감지",
    }
    report["message"] = messages.get(classification, classification)
    report["retryable"] = classification in {
        "NETWORK_ERROR", "BROWSER_CONNECTION_ERROR"
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  실행환경 공인 IP: {report['public_ip']}")
    if browser_success:
        print("✅ 통신·화면 구조 진단 통과 — 같은 실행환경에서 조회를 시작합니다.")
    elif report["retryable"]:
        print("❌ 접속 진단 실패 — 새 실행환경 재시도가 가능합니다.")
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
