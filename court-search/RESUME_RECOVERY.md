# 고정 run 복구 구현 — 로컬 검증 기록

기준 수정: `978f1e40101c234db7ff7c6cc3a41bb7b9ed7cbb` 위의 후속 변경.
실제 push/CI/dispatch/main 병합/배포/법원 접속은 별도 GO 전 금지이며 수행하지 않았다.

## 실행 계약

기존 `court_search.yml`에 opt-in boolean `resume_40456047554`와 승인 코드 전체 SHA인 `expected_sha`만 추가했다. 기본값은 복구 비활성이다. input_file choice/셸 allowlist, contents:read/actions:write, 기존 secret 정책은 유지한다. 새 secret 없이 기존 github.token으로만 근거를 읽는다.

복구 옵션은 input_file=input.xlsx, prepare_only=false, expected_sha=실제 github.sha=checkout HEAD일 때만 허용한다. prepare_only는 오프라인 모드가 아니므로 복구 검증에 사용하지 않는다. 모든 job이 github.sha로 checkout하고 연결 진단 전에 guard한다. 동일 원 run의 복구는 branch와 무관한 concurrency group을 사용하며 진행 중 실행을 취소하지 않는다. GitHub가 대기 실행을 나중에 수행할 수 있으므로 별도 반복 dispatch까지 영구 방지하는 기능은 아니다.

`resume_batch.py prepare`는 고정 repository/run 40456047554/head SHA/입력 blob 및 SHA-256, 6개 artifact ID·digest를 검증한다. GitHub metadata의 run/head/이름/만료/크기, 실제 ZIP hash·CRC·멤버, XLSX schema·행수·순서·identity 및 seed 완료상태를 확인한다. 모든 검증이 끝난 후에만 RUNNER_TEMP의 새 디렉터리에 잔여 200행과 원 320행 identity manifest를 만든다. 원 입력이나 보존 부분 결과를 덮어쓰지 않는다. 기존 임시 디렉터리 재사용도 거부한다.

primary와 fallback은 각 runner에서 독립적으로 근거를 재검증한다. 검색·blocked-output·fallback 모두 임시 잔여 200행만 사용한다. 검색 직전에도 잔여 입력을 원본 slice와 비교한다. 원순번 157의 형식 오류는 원 값을 유지하고 오류 결과에만 남아 유효 199건 조회/재시도 큐에서 제외된다. 로그/오류 행 번호와 부분 artifact 구간에 +120을 적용한다. 예: 지역 순번37/엑셀38행은 원순번157/엑셀158행. 원 1–120 seed는 primary r0/fallback r2로 재공개하고 신규 부분은 121–320 구간을 사용한다.

`finalize`는 seed 근거를 다시 검사하고 새 200행의 schema·순서·identity·오류 표기 검증을 완료한 뒤에만 120+200=320행을 새 최종 파일로 저장한다. seed는 엄격한 완료 필드 검증을 유지한다. 신규 결과의 정상 terminal `사건없음`은 조회시각과 함께 허용하며, 임의 정상 이름의 미완성 결과는 거부한다. 일반 조회실패/보류/조회오류도 명시적인 행으로 유지한다.

전역 연결실패 판단은 병합 전에 새 유효 199건만 대상으로 계산하여 final-report.json에 남긴다. workflow inspect는 이 값을 사용하므로 보존 성공 120행 때문에 fallback 판단이 가려지지 않는다. 최종 행수는 기존 API의 job명 계약을 유지해 320으로 검사한다. 원행 manifest와 finalize report도 별도 artifact로 보관한다.

## 검증 및 독립 검토

신규 테스트는 합성 XLSX/ZIP와 mock만 사용하며 실제 사건 원문/입력/결과를 git에 포함하지 않는다. 외부 소켓 접속은 mock에서 금지한다. 기존 전체 회귀의 브라우저 테스트는 로컬 HTTP fixture만 사용한다.

작업 경로 `/workspace/sellingpoint`:

```bash
/workspace/.sellingpoint-venv/bin/python -m unittest discover -s court-search -p 'test_resume*.py' -v
PLAYWRIGHT_BROWSERS_PATH=/workspace/.sellingpoint-browsers PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/workspace/.sellingpoint-browsers/chromium-1148/chrome-linux/chrome /workspace/.sellingpoint-venv/bin/python -m unittest discover -s court-search -p 'test_*.py' -v
git diff --check
```

신규 복구 15 PASS. 전체 **80 PASS, 22.429초, skip 없음**. YAML은 로컬 시스템 Python의 PyYAML 6.0.3으로 parse하고 permissions도 확인했다. 런타임/CI dependency는 추가하지 않았다. 전체 로그 `/tmp/sellingpoint-resume-full-tests-final.log`.

검증 범위: 정상 복구, 입력 hash/blob 불일치, run/artifact provenance/만료/hash 불일치, seed/신규 결과의 행수·순서·schema 불일치, 잔여 입력 변조, 기존 결과 덮어쓰기 거부, 부분 실패, 입력오류+199건 연결차단, 사건없음 terminal, 실제 main의 primary/fallback 각각 199건만 조회, 원행 로그 및 r0/r2 부분 offset, 실제 workflow inspect의 199 분모, SHA guard의 실제 bash 실행, non-resume guard/기존 65개 회귀, concurrency/permissions/allowlist/routing 검증.

독립 에이전트 `/root/resume_review`가 실제 diff·코드·두 테스트 파일을 읽고 신규 테스트를 별도 재실행했다. 최초 발견한 사건없음 terminal 병합 거부 문제를 수정한 뒤 **15 PASS(4.978초), diff 검사 통과, 로컬 구현 승인/blocking finding 없음**으로 판정했다. 실제 실행 승인은 포함되지 않는다. 독립 로그 `/tmp/sellingpoint-resume-independent-final.log`.

## 남는 제한

실제 GitHub 다운로드/Actions의 concurrency 및 environment 전달/artifact 업로드/법원 동작은 실행하지 않았다. 근거 artifact가 만료되거나 hash가 다르면 복구는 법원 요청 전에 실패한다. 원문 자료는 기존 별도 보존 디렉터리에만 있으며 이 구현이 현재 GitHub 아티팩트 만료를 우회하지 않는다.

보존된 120결과는 재조회하지 않지만, 원 121–156번은 이전 요청 이력이 있어 유효199건 중 일부는 재조회일 수 있다. 부분 artifact 이후의 자동 재개나 이후 반복 dispatch의 영구 중복 방지는 추가하지 않았다. 취소/runner 손실/저장 장치 장애까지 최종 완성을 보장하지 않는다.

과거 처리율에 따른 약8분은 동일 환경 가정의 추정이며 보장 시간/금액 상한이 아니다. 별도 GO 전에 승인된 최종 SHA, 활성 실행, 과금 스냅샷을 다시 확인해야 한다.

## 후속 manifest 개인정보 최소화

업로드 manifest의 행 필드는 `index`, `excel_row`, `row_id`만 남긴다. `row_id`는 기존 run/SHA/전체 입력 provenance hash와 원행 위치로 생성하며 당사자·법원·사건번호 값이나 그 단순 해시/인코딩을 사용하지 않는다. 기존 provenance와 원행에 대한 안정적인 참조이며 개인정보의 암호화나 재식별 불가능성을 주장하지 않는다. 원문 검증은 메모리와 mode0700인 런타임 임시 디렉터리의 입력에서 유지한다. 기존 최종 결과의 사건번호 보존은 그대로이며 신규 manifest로 복사하지 않는다.

합성 개인정보 canary 회귀는 실제 primary/fallback 신규 업로드 경로가 manifest.json/final-report.json 두 파일뿐인지 검사하고, 이 JSON과 prepare/finalize stdout/stderr에 원문 party/court/case 또는 party/court 단순 SHA-256이 없는지 검증한다. private 입력 원값 유지, 안정적 row_id, 320행 원순서 및 신규199 기준도 확인한다. workflow·permissions·secret 참조는 이번 수정에서 변경하지 않았다.

위와 동일한 명령으로 복구 **16 PASS**, 전체 **81 PASS(25.450초), skip 없음**, diff 검사 통과. 독립 검토자 `/root/resume_review`도 실제 diff를 읽고 복구16개를 재실행해 **16 PASS(6.149초)**를 확인했다. 로그는 `/tmp/sellingpoint-privacy-full-tests.log`, `/tmp/sellingpoint-privacy-independent.log`. 실제 외부 요청·업로드·Actions는 실행하지 않았다.

## Recovery fail-closed option

Recovery dispatch requires `fail_closed=true`; the workflow sets
`COURT_FAIL_CLOSED=true` for primary and fallback diagnostics/search. A verified
normal input form without CAPTCHA or access denial can proceed through the
existing court selection, field entry, submit and result parser. This path never
calls the CAPTCHA answer, refresh, image, direct API or learning functions.

The policy distinguishes `NORMAL_FORM`, explicit CAPTCHA/access denial, and
`STRUCTURE_UNKNOWN`. HTTP 401/403/429 and CAPTCHA resource requests latch a shared
security stop. Every async page/frame/locator operation checks before and after,
including helper fallback inputs and progress-tab JavaScript clicks. Once a stop
is latched, subsequent requests abort and other workers/retries cannot proceed.
A structural inspection failure is held separately, not retried as a transport
failure. Only navigation transport failures retain bounded retries. Existing
result ordering, input errors, atomic output and the 120-row seed are preserved.
Any explicit security hold prevents another-runner fallback, including a mixture
with network errors. No workflow permissions, secrets or input paths changed.

The previous `b5f1dc5` 89 PASS validated an incorrectly observation-only policy:
even normal forms were always held. Those passes were **not** evidence of normal
query completion. The correction adds positive synthetic form-to-result tests,
normal no-result handling, late CAPTCHA/403/429/access-denial counterexamples,
helper exception/fallback tests and a synthetic DOM browser test with networking
blocked. It does not assert that the real site ever offers a CAPTCHA-free form.
Actual court, API and Actions behavior remains unverified. Requests already sent
before detection cannot be recalled. External execution authorization is managed
by not executing until approved, not by suppressing valid normal code paths.
