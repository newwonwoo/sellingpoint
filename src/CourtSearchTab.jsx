/**
 * 대법원 나의사건검색 탭
 * - 단일 사건: 입력 → Actions 조회 → 캡처 화면과 같은 결과 카드
 * - 일괄 조회: input.xlsx 업로드 → Actions 조회 → 결과 엑셀 다운로드
 */
import { useRef, useState, useEffect, useCallback } from "react";
import * as XLSX from "xlsx-js-style";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ACTIVE_RUN_STORAGE_KEY = "sellingpoint:court-search-active-run";

const STATUS_LABEL = {
  none: "대기",
  waiting: "실행 등록 중…",
  queued: "실행 대기 중…",
  in_progress: "조회 중…",
  completed: "완료",
};
const CONCLUSION_LABEL = {
  success: "✅ 성공",
  failure: "❌ 실패",
  cancelled: "⛔ 취소됨",
};
const STATUS_MESSAGE = {
  waiting: "업로드한 사건번호를 GitHub Actions 실행에 등록하고 있습니다.",
  queued: "실행 대기열에 등록되었습니다. 조회 작업이 시작되기를 기다리고 있습니다.",
  in_progress: "법원 선택 → 사건번호 입력 → 캡차 처리 → 결과 표 파싱을 진행하고 있습니다.",
};

const SINGLE_FIELDS = [
  ["사건번호", "사건번호"],
  ["사건명", "사건명"],
  ["재판부", "재판부"],
  ["접수일", "접수일"],
  ["종국결과", "종국결과"],
  ["결정문송달일", "결정문송달일"],
  ["확정일", "확정일"],
];

function decodeBase64(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function countInputCases(bytes) {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  return rows.slice(1).filter((row) => String(row[0] || "").trim() && String(row[1] || "").trim()).length;
}

function downloadBase64File(file) {
  const blob = new Blob([decodeBase64(file.content)], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readSavedRun() {
  try {
    const value = JSON.parse(window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY) || "null");
    if (value?.mode === "single" && value.requestId) return value;
    if (value?.mode === "batch" && value.headSha) return value;
    return null;
  } catch {
    return null;
  }
}

function saveRun(value) {
  try {
    window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 저장소 사용이 막힌 브라우저에서도 현재 탭의 조회는 계속 진행한다.
  }
}

function valueOf(row, key) {
  const value = row?.[key];
  return value == null || String(value).trim() === "" ? "—" : String(value);
}

function ProgressTable({ row }) {
  const items = [1, 2, 3]
    .map((i) => ({
      date: row?.[`진행_${i}일자`],
      content: row?.[`진행_${i}내용`],
      result: row?.[`진행_${i}결과`],
      notice: row?.[`진행_${i}공시문`],
    }))
    .filter((item) => item.date || item.content || item.result || item.notice);
  return (
    <div className="cs-result-section">
      <div className="cs-result-title">진행내용</div>
      <div className="cs-result-table-wrap">
        <table className="cs-result-table">
          <thead><tr><th>일자</th><th>내용</th><th>결과</th><th>공시문</th></tr></thead>
          <tbody>
            {items.length ? items.map((item, i) => (
              <tr key={`${item.date}-${i}`}>
                <td>{item.date || "—"}</td>
                <td className="cs-long-cell">{item.content || "—"}</td>
                <td>{item.result || "—"}</td>
                <td>{item.notice || "—"}</td>
              </tr>
            )) : <tr><td colSpan="4" className="cs-empty-cell">진행내용이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SingleResultView({ row }) {
  if (!row) return null;
  return (
    <section className="panel cs-result-panel">
      <div className="cs-result-heading">조회 결과</div>
      <div className="cs-result-section">
        <div className="cs-result-title">기본내용 ({valueOf(row, "법원")})</div>
        <div className="cs-basic-grid">
          {SINGLE_FIELDS.map(([label, key]) => (
            <div className="cs-basic-cell" key={key}>
              <span>{label}</span><strong>{valueOf(row, key)}</strong>
            </div>
          ))}
        </div>
      </div>
      <ProgressTable row={row} />
      <div className="cs-result-section">
        <div className="cs-result-title">관련사건내용</div>
        <div className="cs-result-table-wrap">
          <table className="cs-result-table"><thead><tr><th>법원</th><th>사건번호</th></tr></thead>
            <tbody><tr><td>{valueOf(row, "관련사건_법원")}</td><td>{valueOf(row, "관련사건_번호")}</td></tr></tbody>
          </table>
        </div>
      </div>
      <div className="cs-result-section">
        <div className="cs-result-title">당사자내용</div>
        <div className="cs-result-table-wrap">
          <table className="cs-result-table"><thead><tr><th>구분</th><th>이름</th></tr></thead>
            <tbody>
              <tr><td>신청인</td><td>{valueOf(row, "신청인")}</td></tr>
              <tr><td>피신청인</td><td>{valueOf(row, "피신청인")}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export default function CourtSearchTab() {
  const fileRef = useRef(null);
  const pollRef = useRef(null);
  const headShaRef = useRef("");
  const singleRequestRef = useRef("");
  const pollModeRef = useRef("single");
  const singleResultLoadedRef = useRef(false);
  const [mode, setMode] = useState("single");
  const [file, setFile] = useState(null);
  const [singleCase, setSingleCase] = useState({ court: "", caseNo: "", party: "주택" });
  const [uploading, setUploading] = useState(false);
  const [runStatus, setRunStatus] = useState(null);
  const [polling, setPolling] = useState(false);
  const [resultFile, setResultFile] = useState(null);
  const [singleResult, setSingleResult] = useState(null);
  const [expectedTotal, setExpectedTotal] = useState(0);
  const [partialDownloading, setPartialDownloading] = useState("");
  const [error, setError] = useState("");

  const downloadResult = useCallback(async (runId, artifactId = "") => {
    if (!runId) return false;
    const params = new URLSearchParams({ runId: String(runId), download: "1" });
    if (artifactId) params.set("artifactId", String(artifactId));
    try {
      const res = await fetch(`/api/court-search-result?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "결과 파일을 불러오지 못했습니다.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const matched = disposition.match(/filename="([^"]+)"/);
      const filename = matched?.[1] || `court-search-${runId}.xlsx`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError("");
      return true;
    } catch (e) {
      setError(e.message || "결과 파일을 불러오지 못했습니다.");
      return false;
    }
  }, []);

  const fetchBatchResult = useCallback(async (runId) => {
    if (!runId) return false;
    try {
      const res = await fetch(`/api/court-search-result?runId=${encodeURIComponent(runId)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "결과 파일을 불러오지 못했습니다.");
        return false;
      }
      setResultFile(data);
      setError("");
      return true;
    } catch (e) {
      setError(e.message || "결과 파일을 불러오지 못했습니다.");
      return false;
    }
  }, []);

  const fetchSingleResult = useCallback(async (runId) => {
    if (!runId) return false;
    try {
      const res = await fetch(`/api/court-search-single-result?runId=${encodeURIComponent(runId)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "단건 결과를 불러오지 못했습니다.");
        return false;
      }
      setSingleResult(data.row);
      singleResultLoadedRef.current = true;
      setError("");
      return true;
    } catch (e) {
      setError(e.message || "단건 결과를 불러오지 못했습니다.");
      return false;
    }
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const activeMode = pollModeRef.current;
      const requestId = singleRequestRef.current;
      const sha = headShaRef.current;
      if (activeMode === "single" && !requestId) return;
      if (activeMode === "batch" && !sha) return;
      const endpoint = activeMode === "single"
        ? `/api/court-search-single-status?requestId=${encodeURIComponent(requestId)}`
        : `/api/court-search-status?headSha=${encodeURIComponent(sha)}`;
      const res = await fetch(endpoint);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "실행 상태를 불러오지 못했습니다.");
      setRunStatus(data);
      if (data.runId) {
        saveRun({
          ...readSavedRun(),
          mode: activeMode,
          ...(activeMode === "single" ? { requestId } : { headSha: sha }),
          runId: data.runId,
        });
      }
      if (activeMode === "single" && data.resultReady && data.runId && !singleResultLoadedRef.current) {
        await fetchSingleResult(data.runId);
      }
      if (data.status === "completed") {
        setPolling(false);
        clearInterval(pollRef.current);
        if (data.conclusion === "success") {
          if (activeMode === "single" && !singleResultLoadedRef.current) await fetchSingleResult(data.runId);
          if (activeMode === "batch") await fetchBatchResult(data.runId);
        }
      }
    } catch (e) {
      setError(e.message || "실행 상태를 불러오지 못했습니다.");
    }
  }, [fetchBatchResult, fetchSingleResult]);

  useEffect(() => {
    if (!polling) return undefined;
    pollRef.current = setInterval(checkStatus, 8000);
    checkStatus();
    return () => clearInterval(pollRef.current);
  }, [polling, checkStatus]);

  useEffect(() => {
    const saved = readSavedRun();
    if (saved?.mode === "single" && saved.requestId) {
      pollModeRef.current = "single";
      singleRequestRef.current = saved.requestId;
      setMode("single");
      setExpectedTotal(1);
      setPolling(true);
      checkStatus();
    } else if (saved?.mode === "batch" && saved.headSha) {
      pollModeRef.current = "batch";
      headShaRef.current = saved.headSha;
      if (saved.expectedTotal) setExpectedTotal(saved.expectedTotal);
      setMode("batch");
      setPolling(true);
      checkStatus();
    }
    return () => clearInterval(pollRef.current);
    // 최초 진입 때만 브라우저에 저장된 마지막 실행을 복구한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startWithFile = async (inputFile) => {
    if (!inputFile) {
      setError("조회할 xlsx 파일을 선택하세요.");
      return;
    }
    setError("");
    setUploading(true);
    setResultFile(null);
    setSingleResult(null);
    try {
      const inputBytes = await inputFile.arrayBuffer();
      const total = countInputCases(inputBytes);
      if (!total) {
        setError("조회할 사건번호가 없습니다.");
        return;
      }
      setExpectedTotal(total);
      const res = await fetch("/api/court-search-trigger", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: inputBytes,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "실행 실패");
        return;
      }
      if (!data.headSha) {
        setError("Actions 실행 식별자를 받지 못했습니다.");
        return;
      }
      headShaRef.current = data.headSha;
      singleRequestRef.current = "";
      pollModeRef.current = "batch";
      saveRun({ headSha: data.headSha, expectedTotal: total, mode: "batch" });
      setRunStatus({ status: "waiting", conclusion: null, headSha: data.headSha, queuedAt: data.queuedAt });
      setPolling(true);
    } catch (e) {
      setError(e.message || "실행 실패");
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith(".xlsx")) {
      setError("xlsx 파일만 업로드 가능합니다.");
      return;
    }
    setFile(selected);
    setError("");
  };

  const handleSingleRun = async () => {
    if (!singleCase.court.trim() || !singleCase.caseNo.trim()) {
      setError("법원과 사건번호를 입력하세요.");
      return;
    }
    setError("");
    setUploading(true);
    setResultFile(null);
    setSingleResult(null);
    singleResultLoadedRef.current = false;
    try {
      const res = await fetch("/api/court-search-single-trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          court: singleCase.court.trim(),
          caseNo: singleCase.caseNo.trim(),
          party: singleCase.party.trim() || "주택",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "단건 조회 실행 실패");
      if (!data.requestId) throw new Error("단건 조회 식별자를 받지 못했습니다.");
      headShaRef.current = "";
      singleRequestRef.current = data.requestId;
      pollModeRef.current = "single";
      setExpectedTotal(1);
      saveRun({ mode: "single", requestId: data.requestId, expectedTotal: 1 });
      setRunStatus({ status: "waiting", conclusion: null, requestId: data.requestId, queuedAt: data.queuedAt });
      setPolling(true);
    } catch (e) {
      setError(e.message || "단건 조회 실행 실패");
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = () => {
    if (resultFile) downloadBase64File(resultFile);
    else if (runStatus?.runId) downloadResult(runStatus.runId);
  };

  const handlePartialDownload = async (partial) => {
    if (!runStatus?.runId || !partial?.artifactId) return;
    setPartialDownloading(partial.artifactId);
    try {
      await downloadResult(runStatus.runId, partial.artifactId);
    } catch (e) {
      setError(e.message || "중간 결과를 불러오지 못했습니다.");
    } finally {
      setPartialDownloading("");
    }
  };

  const handleDownloadTemplate = () => {
    window.open("https://raw.githubusercontent.com/newwonwoo/sellingpoint/main/court-search/template.xlsx", "_blank");
  };

  const handleDownloadUserSamples = () => {
    window.open("https://raw.githubusercontent.com/newwonwoo/sellingpoint/main/court-search/test_input_user_cases.xlsx", "_blank");
  };

  const isRunning = ["waiting", "queued", "in_progress"].includes(runStatus?.status);
  const partialResults = runStatus?.partialResults || [];
  const completedCases = runStatus?.completedCases || 0;
  const activeRanges = (runStatus?.activeJobs || [])
    .filter((name) => mode === "single" || name.startsWith("사건 ") || name.startsWith("새 러너 재조회 "))
    .join(", ");
  const statusMessage = runStatus?.status === "completed"
    ? (runStatus.conclusion === "success"
      ? (mode === "single" ? "단건 조회가 끝났습니다. 아래 결과 화면을 확인하세요." : "일괄조회가 끝났습니다. 아래 결과 엑셀을 확인하세요.")
      : "조회가 끝나지 않았습니다. GitHub 로그에서 실패 원인을 확인하세요.")
    : runStatus?.stageMessage || runStatus?.message || STATUS_MESSAGE[runStatus?.status] || "";

  return (
    <div className="court-search-tab">
      <div className="section-div">대법원 나의사건검색</div>
      <div className="cs-mode-tabs" role="tablist" aria-label="조회 방식">
        <button className={mode === "single" ? "on" : ""} onClick={() => setMode("single")} role="tab" aria-selected={mode === "single"}>단일 사건 조회</button>
        <button className={mode === "batch" ? "on" : ""} onClick={() => setMode("batch")} role="tab" aria-selected={mode === "batch"}>엑셀 일괄조회</button>
      </div>

      {mode === "single" ? (
        <section className="panel controls">
          <div className="cs-step"><span className="cs-badge">1</span><span className="cs-label">사건번호 입력</span></div>
          <div className="cs-single-grid">
            <label><span>법원</span><input value={singleCase.court} placeholder="예: 서울남부지방법원" onChange={(e) => setSingleCase((v) => ({ ...v, court: e.target.value }))} /></label>
            <label><span>사건번호</span><input value={singleCase.caseNo} placeholder="예: 2026타인3944" onChange={(e) => setSingleCase((v) => ({ ...v, caseNo: e.target.value }))} /></label>
            <label><span>당사자명</span><input value={singleCase.party} placeholder="예: 주택" onChange={(e) => setSingleCase((v) => ({ ...v, party: e.target.value }))} /></label>
          </div>
          <div className="cs-upload-row cs-single-actions">
            <button className="go" onClick={handleSingleRun} disabled={uploading || isRunning}>{uploading ? "등록 중…" : isRunning ? "조회 중…" : "조회 시작"}</button>
            <span className="cs-hint">결과는 캡처 화면과 같은 기본내용·진행내용·관련사건·당사자 영역으로 표시됩니다.</span>
          </div>
        </section>
      ) : (
        <>
          <section className="panel controls">
            <div className="cs-step"><span className="cs-badge">1</span><span className="cs-label">input.xlsx 준비</span><button className="cs-link" onClick={handleDownloadTemplate}>양식 다운로드</button><button className="cs-link" onClick={handleDownloadUserSamples}>사용자 테스트 파일</button></div>
            <p className="cs-hint">법원명·사건번호·당사자명을 입력한 xlsx를 올리세요. 테스트 파일에는 지금까지 전달한 사건번호가 들어 있습니다.</p>
          </section>
          <section className="panel controls">
            <div className="cs-step"><span className="cs-badge">2</span><span className="cs-label">파일 업로드 후 조회 시작</span></div>
            <div className="cs-upload-row">
              <input ref={fileRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={handleFileChange} />
              <button className="cs-upload-btn" onClick={() => fileRef.current?.click()} disabled={uploading || isRunning}>{file ? `📄 ${file.name}` : "파일 선택"}</button>
              <button className="go" onClick={() => startWithFile(file)} disabled={!file || uploading || isRunning}>{uploading ? "업로드 중…" : isRunning ? "조회 중…" : "조회 시작"}</button>
            </div>
          </section>
        </>
      )}

      {error && <div className="status err">{error}</div>}

      {runStatus && runStatus.status !== "none" && (
        <section className="panel">
          <div className="cs-step"><span className="cs-badge">2</span><span className="cs-label">진행 상태</span></div>
          <div className="cs-status-row">
            <span className={`badge ${runStatus.status === "completed" ? (runStatus.conclusion === "success" ? "ok" : "warn") : "info"}`}>
              {runStatus.status === "completed" ? CONCLUSION_LABEL[runStatus.conclusion] || runStatus.conclusion : STATUS_LABEL[runStatus.status] || runStatus.status}
            </span>
            {(runStatus.startedAt || runStatus.queuedAt) && <span className="cs-time">시작: {new Date(runStatus.startedAt || runStatus.queuedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</span>}
            {runStatus.currentStep && <span className="cs-time">현재 단계: {runStatus.currentStep}</span>}
            {runStatus.runUrl && <a className="cs-link" href={runStatus.runUrl} target="_blank" rel="noreferrer">GitHub 로그 보기 →</a>}
          </div>
          {statusMessage && <div className="cs-stage-message">{statusMessage}</div>}
          {isRunning && <div className="cs-progress"><div className="cs-spinner" /><span>
            {mode === "single"
              ? (activeRanges ? `현재 ${activeRanges}` : "단건 조회 실행을 준비하고 있습니다.")
              : <>{expectedTotal ? `완료 파일 ${completedCases}/${expectedTotal}건` : `완료 파일 ${completedCases}건`}
                {activeRanges ? ` · 현재 ${activeRanges}` : " · 다음 작업을 준비하고 있습니다."}</>}
          </span></div>}

          {mode === "batch" && partialResults.length > 0 && (
            <div className="cs-partial-results">
              <div className="cs-partial-title">지금 다운로드 가능한 완료 결과</div>
              {partialResults.map((partial) => (
                <div className="cs-upload-row cs-partial-row" key={partial.artifactId}>
                  <span className="badge ok">{partial.start}–{partial.end}번 완료</span>
                  <span className="cs-time">{partial.count}건 · {partial.filename}</span>
                  <button className="go" onClick={() => handlePartialDownload(partial)} disabled={partialDownloading === partial.artifactId}>
                    {partialDownloading === partial.artifactId ? "받는 중…" : "📥 바로 다운로드"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {mode === "single" && singleResult && <SingleResultView row={singleResult} />}

      {mode === "batch" && resultFile && (
        <section className="panel">
          <div className="cs-step"><span className="cs-badge">3</span><span className="cs-label">결과 엑셀</span></div>
          <div className="cs-upload-row"><span className="badge ok">결과 준비 완료</span><span className="cs-time">{resultFile.filename}</span><button className="go" onClick={handleDownload}>📥 다운로드</button></div>
          <p className="cs-hint">완료된 일괄조회 결과 파일입니다.</p>
        </section>
      )}

      {mode === "batch" && !resultFile && runStatus?.status === "completed" && runStatus?.conclusion === "success" && (
        <section className="panel">
          <div className="cs-step"><span className="cs-badge">3</span><span className="cs-label">결과 엑셀</span></div>
          <div className="cs-upload-row">
            <span className="badge ok">결과 준비 완료</span>
            <button className="go" onClick={() => downloadResult(runStatus.runId)}>📥 전체 결과 다운로드</button>
          </div>
        </section>
      )}

      {mode === "single" && !singleResult && runStatus?.status === "completed" && runStatus?.conclusion === "success" && (
        <section className="panel">
          <div className="cs-step"><span className="cs-badge">3</span><span className="cs-label">화면 결과</span></div>
          <div className="cs-upload-row">
            <span className="badge ok">조회 완료</span>
            <button className="go" onClick={() => fetchSingleResult(runStatus.runId)}>화면 결과 다시 불러오기</button>
          </div>
        </section>
      )}

      <style>{`
        .court-search-tab { }
        .cs-mode-tabs { display:flex; gap:8px; margin:0 0 14px; }
        .cs-mode-tabs button { padding:8px 14px; border:1px solid #cbd5e1; border-radius:7px; background:#fff; cursor:pointer; color:#475569; }
        .cs-mode-tabs button.on { background:#1F4E79; color:#fff; border-color:#1F4E79; }
        .cs-step { display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap; }
        .cs-badge { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:#1F4E79; color:#fff; font-size:12px; font-weight:bold; flex-shrink:0; }
        .cs-label { font-weight:600; font-size:14px; }
        .cs-link { background:none; border:none; color:#2563eb; cursor:pointer; font-size:13px; text-decoration:underline; padding:0; }
        .cs-hint { font-size:12px; color:#666; margin:4px 0 0; }
        .cs-single-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
        .cs-single-grid label { display:flex; flex-direction:column; gap:5px; font-size:12px; color:#475569; }
        .cs-single-grid input { min-height:36px; border:1px solid #cbd5e1; border-radius:6px; padding:0 10px; font:inherit; color:#111827; }
        .cs-single-actions { margin-top:12px; }
        .cs-upload-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .cs-upload-btn { padding:6px 14px; border:1.5px dashed #999; border-radius:6px; background:#f8f9fa; cursor:pointer; font-size:13px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cs-upload-btn:hover { border-color:#1F4E79; }
        .cs-status-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        .cs-time { font-size:12px; color:#666; }
        .cs-stage-message { margin-top:10px; color:#1e3a5f; font-size:13px; }
        .cs-progress { display:flex; align-items:center; gap:10px; margin-top:10px; font-size:13px; color:#444; }
        .cs-partial-results { margin-top:14px; padding-top:12px; border-top:1px solid #e2e8f0; display:grid; gap:8px; }
        .cs-partial-title { font-size:13px; font-weight:700; color:#1f2937; }
        .cs-partial-row { padding:8px 10px; border:1px solid #dbe5ef; border-radius:7px; background:#f8fbff; }
        .cs-spinner { width:18px; height:18px; border:2px solid #ddd; border-top-color:#1F4E79; border-radius:50%; animation:spin .8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .badge.info { background:#e8f0fe; color:#1a56db; }
        .cs-result-panel { border-top:3px solid #1F4E79; }
        .cs-result-heading { font-size:17px; font-weight:700; margin-bottom:14px; color:#1f2937; }
        .cs-result-section { margin-top:16px; }
        .cs-result-title { border-bottom:2px solid #1f2937; padding:0 0 7px; font-size:14px; font-weight:700; color:#1f2937; }
        .cs-basic-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border-top:1px solid #d8dee8; }
        .cs-basic-cell { display:grid; grid-template-columns:110px minmax(0,1fr); min-height:36px; border-bottom:1px solid #e5e7eb; }
        .cs-basic-cell span { background:#f3f4f6; padding:9px 8px; font-size:12px; color:#475569; }
        .cs-basic-cell strong { padding:9px 8px; font-size:13px; font-weight:500; overflow-wrap:anywhere; }
        .cs-result-table-wrap { overflow:auto; }
        .cs-result-table { width:100%; border-collapse:collapse; font-size:12px; }
        .cs-result-table th, .cs-result-table td { border:1px solid #d8dee8; padding:8px; text-align:left; vertical-align:top; }
        .cs-result-table th { background:#f3f4f6; font-weight:600; white-space:nowrap; }
        .cs-long-cell { min-width:260px; }
        .cs-empty-cell { text-align:center !important; color:#64748b; }
        @media (max-width:700px) { .cs-single-grid, .cs-basic-grid { grid-template-columns:1fr; } .cs-basic-cell { grid-template-columns:100px minmax(0,1fr); } }
      `}</style>
    </div>
  );
}
