import { useEffect, useMemo, useState } from "react";
import regions from "./regions.json";

const YEARS = Array.from({ length: 12 }, (_, i) => 2026 - i); // 2026..2015
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

// 응답 어딘가의 '행 배열'(객체들의 배열) 중 가장 큰 걸 자동 탐색.
function findRows(obj) {
  let best = [];
  const visit = (o) => {
    if (Array.isArray(o)) {
      if (o.length && o[0] && typeof o[0] === "object" && !Array.isArray(o[0])) {
        if (o.length > best.length) best = o;
      }
      o.forEach(visit);
    } else if (o && typeof o === "object") {
      Object.values(o).forEach(visit);
    }
  };
  visit(obj);
  return best;
}

// selectAdong 응답을 {code,name} 목록으로 변환(필드명 모름 → 추정).
function toOptions(data) {
  return findRows(data)
    .map((r) => {
      const e = Object.entries(r);
      const code =
        e.find(([k, v]) => /cd|code/i.test(k) && v != null && String(v).length <= 7)?.[1] ??
        e.find(([, v]) => /^\d{2,7}$/.test(String(v)))?.[1];
      const name =
        e.find(([k, v]) => /nm|name/i.test(k) && /[가-힣]/.test(String(v)))?.[1] ??
        e.find(([, v]) => /[가-힣]/.test(String(v)))?.[1];
      return { code: String(code ?? ""), name: String(name ?? "") };
    })
    .filter((o) => o.code && o.name && o.name !== "전체");
}

function fmt(v) {
  if (v == null) return "";
  const s = String(v);
  if (/^\d{4,}$/.test(s)) return Number(s).toLocaleString();
  return s;
}
const isRateCol = (k) => /가율|율|rate|rt/i.test(k);

export default function App() {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = String(now.getMonth() + 1).padStart(2, "0");
  const [startY, setStartY] = useState(String(curY - 1));
  const [startM, setStartM] = useState(curM);
  const [endY, setEndY] = useState(String(curY));
  const [endM, setEndM] = useState(curM);
  const [sido, setSido] = useState("");
  const [sigungu, setSigungu] = useState("");
  const [sgList, setSgList] = useState(null); // 라이브 시군구 (null=미로딩)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [resp, setResp] = useState(null);

  // 시도 바뀌면 법원 시군구 목록 라이브 로딩 (실패 시 regions.json 폴백)
  useEffect(() => {
    setSigungu("");
    setSgList(null);
    if (!sido) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/court-adong", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ty: "2", sidoCode: sido }),
        });
        const data = await r.json();
        const opts = toOptions(data);
        if (alive) setSgList(opts.length ? opts : regions.sigungu[sido] || []);
      } catch {
        if (alive) setSgList(regions.sigungu[sido] || []);
      }
    })();
    return () => { alive = false; };
  }, [sido]);

  const sigunguOptions = sgList ?? (sido ? regions.sigungu[sido] || [] : []);
  const rows = useMemo(() => (resp ? findRows(resp) : []), [resp]);
  const cols = rows.length ? Object.keys(rows[0]) : [];

  // 기간 프리셋: 최근 N개월 / 올해
  function presetMonths(n) {
    const e = new Date(curY, now.getMonth(), 1);
    const s = new Date(curY, now.getMonth() - (n - 1), 1);
    setStartY(String(s.getFullYear())); setStartM(String(s.getMonth() + 1).padStart(2, "0"));
    setEndY(String(e.getFullYear())); setEndM(String(e.getMonth() + 1).padStart(2, "0"));
  }
  function presetThisYear() {
    setStartY(String(curY)); setStartM("01"); setEndY(String(curY)); setEndM(curM);
  }

  async function run() {
    setBusy(true); setError(""); setResp(null); setStatus("조회 중…");
    try {
      const r = await fetch("/api/court-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sidoCode: sido, sigunguCode: sigungu,
          startYM: `${startY}${startM}`, endYM: `${endY}${endM}`,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error([data.error, data.hint].filter(Boolean).join(" — "));
      setResp(data);
      const n = findRows(data).length;
      setStatus(n ? `완료 · ${n}개 행 (${startY}.${startM} ~ ${endY}.${endM})` : "응답은 받았지만 표로 인식된 행이 없습니다(아래 원본 확인).");
    } catch (e) {
      setError(String(e.message || e)); setStatus("");
    } finally { setBusy(false); }
  }

  function download() {
    if (!rows.length) return;
    const head = cols.join(",");
    const lines = rows.map((row) => cols.map((c) => `"${String(row[c] ?? "").replace(/"/g, '""')}"`).join(","));
    const csv = "\uFEFF" + [head, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const tag = sido ? regions.sido.find((s) => s.code === sido)?.name : "전국";
    a.href = url;
    a.download = `매각통계_${tag}_${startY}${startM}_${endY}${endM}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="wrap">
      <header className="head">
        <div className="kicker">채권관리 · 실익분석</div>
        <h1>법원경매 낙찰가율 조회</h1>
        <p className="sub">소재지(시도·시군구)와 기간을 고르면 법원 매각통계의 용도별 매각가율(=낙찰가율)을 가져옵니다.</p>
      </header>

      <section className="panel controls">
        <label>
          <span>기간 시작</span>
          <div className="ym">
            <select value={startY} onChange={(e) => setStartY(e.target.value)}>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={startM} onChange={(e) => setStartM(e.target.value)}>
              {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </label>
        <label>
          <span>기간 종료</span>
          <div className="ym">
            <select value={endY} onChange={(e) => setEndY(e.target.value)}>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={endM} onChange={(e) => setEndM(e.target.value)}>
              {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </label>
        <label>
          <span>시도(소재지)</span>
          <select value={sido} onChange={(e) => setSido(e.target.value)}>
            <option value="">전국</option>
            {regions.sido.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label>
          <span>시군구</span>
          <select value={sigungu} onChange={(e) => setSigungu(e.target.value)} disabled={!sido}>
            <option value="">{sido ? (sgList === null ? "불러오는 중…" : "전체") : "—"}</option>
            {sigunguOptions.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
          </select>
        </label>
        <button className="go" onClick={run} disabled={busy}>{busy ? "조회 중…" : "조회"}</button>
      </section>

      <div className="presets">
        <span>기간 빠른 선택</span>
        <button onClick={() => presetMonths(3)}>최근 3개월</button>
        <button onClick={() => presetMonths(6)}>최근 6개월</button>
        <button onClick={() => presetMonths(12)}>최근 12개월</button>
        <button onClick={presetThisYear}>올해</button>
      </div>

      {(status || error) && <div className={`status ${error ? "err" : ""}`}>{error ? `오류: ${error}` : status}</div>}

      {rows.length > 0 && (
        <>
          <div className="summary"><button className="csv" onClick={download}>CSV 내려받기</button></div>
          <section className="panel">
            <table>
              <thead>
                <tr>{cols.map((c) => <th key={c} className={isRateCol(c) ? "on num" : "num"}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>{cols.map((c) => <td key={c} className={`num ${isRateCol(c) ? "rate" : ""}`}>{fmt(row[c])}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="foot">컬럼명은 법원 응답 원본입니다. 어떤 게 매각가율인지 알려주면 한글 라벨·정렬로 다듬습니다.</p>
        </>
      )}

      {resp && !rows.length && !error && (
        <section className="panel">
          <div className="status">표로 인식된 행이 없습니다. 응답 원본(처음 부분):</div>
          <pre className="raw">{JSON.stringify(resp, null, 2).slice(0, 2000)}</pre>
        </section>
      )}

      <footer className="foot">출처: 대한민국 법원 법원경매정보 · 매각통계(selectRletCortDspslStats)</footer>
    </div>
  );
}
