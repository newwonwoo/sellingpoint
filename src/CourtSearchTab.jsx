/**
 * 사건검색 조회 탭
 * - input.xlsx 업로드 → GitHub Actions 트리거 → 상태 폴링 → 결과 다운로드
 */
import { useRef, useState, useEffect, useCallback } from "react";

const STATUS_LABEL = {
  none: "대기",
  queued: "대기 중…",
  in_progress: "조회 중…",
  completed: "완료",
};
const CONCLUSION_LABEL = {
  success: "✅ 성공",
  failure: "❌ 실패",
  cancelled: "⛔ 취소됨",
};

export default function CourtSearchTab() {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [runStatus, setRunStatus] = useState(null); // { status, conclusion, runId, startedAt }
  const [polling, setPolling] = useState(false);
  const [resultFile, setResultFile] = useState(null); // { filename, content(base64) }
  const [error, setError] = useState("");
  const pollRef = useRef(null);

  // 상태 폴링
  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/court-search-status");
      const data = await res.json();
      setRunStatus(data);

      if (data.status === "completed") {
        setPolling(false);
        clearInterval(pollRef.current);
        // 성공이면 결과 파일 자동 조회
        if (data.conclusion === "success") {
          await fetchResult();
        }
      }
    } catch {
      // 네트워크 오류는 무시하고 계속 폴링
    }
  }, []);

  useEffect(() => {
    if (polling) {
      pollRef.current = setInterval(checkStatus, 8000);
      checkStatus(); // 즉시 1회
    }
    return () => clearInterval(pollRef.current);
  }, [polling, checkStatus]);

  // 최초 진입 시 현재 상태 1회 확인
  useEffect(() => {
    checkStatus();
  }, []);

  const fetchResult = async () => {
    try {
      const res = await fetch("/api/court-search-result");
      if (res.ok) {
        const data = await res.json();
        setResultFile(data);
      }
    } catch {
      // 무시
    }
  };

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!f.name.endsWith(".xlsx")) {
      setError("xlsx 파일만 업로드 가능합니다.");
      return;
    }
    setFile(f);
    setError("");
  };

  const handleUploadAndRun = async () => {
    if (!file) {
      setError("input.xlsx 파일을 선택하세요.");
      return;
    }
    setError("");
    setUploading(true);
    setResultFile(null);

    try {
      const buffer = await file.arrayBuffer();
      const res = await fetch("/api/court-search-trigger", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "실행 실패");
        return;
      }
      // 폴링 시작
      setPolling(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = () => {
    if (!resultFile) return;
    const bytes = Uint8Array.from(atob(resultFile.content), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resultFile.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadTemplate = () => {
    // input.xlsx 템플릿 다운로드 (GitHub raw)
    window.open(
      "https://raw.githubusercontent.com/newwonwoo/sellingpoint/main/court-search/input.xlsx",
      "_blank"
    );
  };

  const isRunning =
    runStatus?.status === "queued" || runStatus?.status === "in_progress";

  return (
    <div className="court-search-tab">
      <div className="section-div">대법원 나의사건검색 일괄조회</div>

      {/* Step 1: 파일 업로드 */}
      <section className="panel controls">
        <div className="cs-step">
          <span className="cs-badge">1</span>
          <span className="cs-label">input.xlsx 준비</span>
          <button className="cs-link" onClick={handleDownloadTemplate}>
            양식 다운로드
          </button>
        </div>
        <p className="cs-hint">
          법원명(서울중앙지방법원 등)과 사건번호(2025타인12345 형식)를 A·B열에 입력하세요.
        </p>
      </section>

      <section className="panel controls">
        <div className="cs-step">
          <span className="cs-badge">2</span>
          <span className="cs-label">파일 업로드 후 조회 시작</span>
        </div>
        <div className="cs-upload-row">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <button
            className="cs-upload-btn"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || isRunning}
          >
            {file ? `📄 ${file.name}` : "파일 선택"}
          </button>
          <button
            className="go"
            onClick={handleUploadAndRun}
            disabled={!file || uploading || isRunning}
          >
            {uploading ? "업로드 중…" : isRunning ? "조회 중…" : "조회 시작"}
          </button>
        </div>
        {error && <div className="status err">{error}</div>}
      </section>

      {/* Step 3: 실행 상태 */}
      {runStatus && runStatus.status !== "none" && (
        <section className="panel">
          <div className="cs-step">
            <span className="cs-badge">3</span>
            <span className="cs-label">실행 상태</span>
          </div>
          <div className="cs-status-row">
            <span className={`badge ${runStatus.status === "completed" ? (runStatus.conclusion === "success" ? "ok" : "warn") : "info"}`}>
              {runStatus.status === "completed"
                ? CONCLUSION_LABEL[runStatus.conclusion] || runStatus.conclusion
                : STATUS_LABEL[runStatus.status] || runStatus.status}
            </span>
            {runStatus.startedAt && (
              <span className="cs-time">
                시작: {new Date(runStatus.startedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
              </span>
            )}
            {runStatus.runUrl && (
              <a className="cs-link" href={runStatus.runUrl} target="_blank" rel="noreferrer">
                GitHub 로그 보기 →
              </a>
            )}
          </div>
          {isRunning && (
            <div className="cs-progress">
              <div className="cs-spinner" />
              <span>자동 조회 진행 중… (최대 30분 소요)</span>
            </div>
          )}
        </section>
      )}

      {/* Step 4: 결과 다운로드 */}
      {resultFile && (
        <section className="panel">
          <div className="cs-step">
            <span className="cs-badge">4</span>
            <span className="cs-label">결과 다운로드</span>
          </div>
          <div className="cs-upload-row">
            <span className="badge ok">결과 준비 완료</span>
            <span className="cs-time">{resultFile.filename}</span>
            <button className="go" onClick={handleDownload}>
              📥 다운로드
            </button>
          </div>
          <p className="cs-hint">22개 컬럼 · 진행내용 최근 3줄 포함</p>
        </section>
      )}

      {/* 이전 결과 조회 버튼 */}
      {!resultFile && runStatus?.status === "completed" && runStatus?.conclusion === "success" && (
        <section className="panel">
          <button className="go" onClick={fetchResult}>이전 결과 불러오기</button>
        </section>
      )}

      <style>{`
        .court-search-tab { }
        .cs-step { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .cs-badge {
          display: inline-flex; align-items: center; justify-content: center;
          width: 22px; height: 22px; border-radius: 50%;
          background: #1F4E79; color: #fff; font-size: 12px; font-weight: bold; flex-shrink: 0;
        }
        .cs-label { font-weight: 600; font-size: 14px; }
        .cs-link { background: none; border: none; color: #2563eb; cursor: pointer; font-size: 13px; text-decoration: underline; padding: 0; }
        .cs-hint { font-size: 12px; color: #666; margin: 4px 0 0; }
        .cs-upload-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .cs-upload-btn {
          padding: 6px 14px; border: 1.5px dashed #999; border-radius: 6px;
          background: #f8f9fa; cursor: pointer; font-size: 13px;
          max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .cs-upload-btn:hover { border-color: #1F4E79; }
        .cs-status-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .cs-time { font-size: 12px; color: #666; }
        .cs-progress { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 13px; color: #444; }
        .cs-spinner {
          width: 18px; height: 18px; border: 2px solid #ddd;
          border-top-color: #1F4E79; border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .badge.info { background: #e8f0fe; color: #1a56db; }
      `}</style>
    </div>
  );
}
