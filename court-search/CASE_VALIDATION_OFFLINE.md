# 사건번호 오류 격리 — 로컬 수정 및 독립 검토 기록

## 기준과 SHA 증거

- 작업 경로 `/workspace/sellingpoint`, 브랜치 `work`, HEAD `606a1aa399f310022f89bdd977e5331b62a5b955`. 최초 착수 시 변경 없음. commit/push 없음.
- README, requirements.txt, 기존 테스트 및 `court_monitor_tests.yml`의 unittest 실행 지침을 확인했다. checkout에 AGENTS.md와 `.agents/skills`는 없었다.
- 사용자가 허용한 읽기 전용 GitHub `compare_commits`로 HEAD와 장애 SHA `d2cf2cd004f4a6fa9a1fbfc742369342031042cb` 비교: ahead 2, behind 0, total 2 commits. 변경 파일은 `court-search/input.xlsx` 하나이며 코드 차이는 없다. 응답은 `CASE_VALIDATION_SHA_COMPARE.json`에 보존했다. 장애 입력 원문을 다운로드하거나 덮어쓰지 않았다.
- 현재 saved input.xlsx는 58건/형식 오류 0건이다(읽기만 수행). 장애 당시 320건 파일 대신 별도 임시 데이터로 `202타인4330`을 재현했다. 임의 연도 보정 없음.

## 최종 변경과 정책

- `case_number.py`: 브라우저 의존 없는 공유 검증. `[0-9]{4}` 연도와 한글 사건구분·ASCII 일련번호를 `fullmatch`로 확인. 앞뒤 공백은 파싱 시에만 제거하며 원 입력은 보존한다.
- `search.py`: 입력값/타입 보존, 사전 검증, `입력오류` 행 및 원 입력 행 번호가 있는 로그 안내. 유효 입력만 조회한다. 1차/구조대/마지막 재시도 모두 같은 행 경계에서 일반 예외를 `조회오류`로 기록한다. 입력오류는 재시도에 들어가지 않는다. 새 오류 상태는 워커 증설 판단에서 성공으로 세지 않는다.
- `asyncio.CancelledError`는 전파한다. `SiteContractChanged`는 일반 오류로 숨기지 않고 기존 구조변경 차단기에 등록한다. 진단 저장이 실패해도 감지한 구조변경 정책을 유지한다. 기존 접속 3회·캡차 5회 재시도 및 서로 다른 세션/사건에 대한 차단 임계값은 변경하지 않았다. 차단 후 미처리 유효 행은 조회보류, 기존 입력오류 행은 그대로 보존한다.
- `output_schema.py`: 중간/최종 JSON·XLSX를 같은 디렉터리 임시 파일에 완성한 뒤 `os.replace`. 쓰기/교체 실패 시 기존 대상 유지 및 임시 파일 정리. JSON 객체/배열 오류 입력은 XLSX에 JSON 문자열로 표현하고 문자열은 수식으로 실행되지 않게 저장한다.
- `chunk_workbook.py`: workflow 입력 건수와 blocked 출력도 완전 빈행만 제외하고 빈 사건번호 행을 유지한다. 법원/사건번호 헤더 이름을 사용하며 원 사건번호 및 입력오류를 보존한다.
- `.github/workflows/court_search.yml`: 새 오류 상태를 실패 요약에 포함. 전역 연결실패 여부는 조회 가능한 행만 분모로 삼아 입력오류 때문에 기존 fallback 정책이 무효화되지 않게 한다. workflow 파일만 로컬 수정했으며 CI 실행 없음.

## 독립 검토

독립 에이전트 `/root/independent_review`가 실제 diff와 신규 테스트 3개 파일을 직접 읽었다. 최초 발견한 워커 증설 오류 집계, workflow 빈 사건번호 건수 불일치, 구조진단 저장 실패에 의한 구조 신호 유실을 최소 수정한 뒤 재검토했다.

최종 판정: **현재 로컬 변경 승인, blocking finding 없음. 실제 실행/배포 승인 아님.**

검토자가 확인한 핵심 위치: `case_number.py:5`; `search.py:184,225,235,257,1600,1851,2041,2076,2242`; `output_schema.py:25`; `chunk_workbook.py:20,67`; workflow `214,222,450`.

독립 실행: 추가 회귀 17개 통과(0.666초), `git diff --check` 통과. 로그 `/tmp/sellingpoint-independent-review.log`.

## 정확한 검증 명령 및 결과

작업 디렉터리: `/workspace/sellingpoint`.

```bash
/workspace/.sellingpoint-venv/bin/python -m unittest discover -s court-search -p 'test_case_validation*.py' -v
PLAYWRIGHT_BROWSERS_PATH=/workspace/.sellingpoint-browsers PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/workspace/.sellingpoint-browsers/chromium-1148/chrome-linux/chrome /workspace/.sellingpoint-venv/bin/python -m unittest discover -s court-search -p 'test_*.py' -v
git diff --check
```

최종 추가 회귀 17개 통과(0.343초), 전체 **65개 통과(15.786초), skip 없음**, diff 검사 통과. 전체 로그 `/tmp/sellingpoint-reviewed-offline-tests.log`.

3/5자리·빈값/null·숫자/bool/배열/객체·비ASCII 숫자·정상 4자리·후행 문자, 원값 보존, 1차/구조대/재시도 예외 후 지속, 입력오류 재시도 제외, 연결/구조 차단과 보류, 최신 partial revision과 최종 결과의 원순서 일치, 취소 전파, 진단저장 실패, 원자적 쓰기/교체 실패를 검증했다. workflow inspect의 Python 코드도 임시 XLSX에서 직접 실행해 행수·오류 집계·fallback 판정을 확인했다(CI 실행 아님).

추가 테스트는 임시 데이터와 mock만 사용했다. 전체 기존 회귀는 mock 및 로컬 HTTP fixture를 사용한다. 실제 법원 요청/320건 재실행/Actions/push/PR/병합/배포 없음. 기존 입력/결과 파일 변경 없음.

## 남는 제한 및 실제 재실행 전 범위·비용

- 실제 법원, OCR 모델 적재, artifact 업로드는 이번 신규 검증에서 mock이다. 실제 320건 입력으로 실행하지 않았다.
- XLSX 빈문자/null은 재열람 시 모두 빈 셀로 표현된다. JSON은 원 타입을 유지한다. 법원 열 누락 등 파일 구조 오류는 기존처럼 입력 전체 오류이며 이번 범위는 사건번호 오류 격리이다.
- 취소/프로세스 강제종료/브라우저 시작 실패/저장 장치 장애까지 최종 파일 완성을 보장하지 않는다. 원자적 교체는 이전 파일 손상을 막으며 정전 내구성이나 자동 재개 기능은 아니다.
- 실제 재실행 전 적용 SHA 및 원 320건 입력 동일성, 보존된 1~120행 결과 활용 여부, 전체/잔여 범위 확인과 별도 승인이 필요하다. 이 수정은 artifact 재개 기능을 추가하지 않는다.
- 비용 근거는 checkout 설정: 기본 3개/최대 4개 워커, 검색 job 최대 180분, 전체 연결장애 fallback job 최대 180분. 예측 시간/확정 청구액이 아니며 준비·artifact 저장·계정 Actions 무료분/과금 조건을 별도 확인해야 한다. 이번에는 유료 서비스나 Actions를 사용하지 않았다.
