import { useMemo, useState } from "react";
import { aggregate, summarize, toCsv } from "./aggregate.js";

const PAGE_DELAY = 1200; // 페이지 호출 간격(ms) — 서버 예의상
const MAX_PAGES = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eok = (won) => (won / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 });

export default function App() {
  const [start, setStart] = useState("2026-04-01");
  const [end, setEnd] = useState("2026-04-30");
  const [court, setCourt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [collected, setCollected] = useState(0);
  const [sortKey, setSortKey] = useState("mae");

  const rows = useMemo(() => {
    const r = aggregate(items);
    const dir = sortKey === "rate" || sortKey === "mae" || sortKey === "cnt" ? -1 : 1;
    return [...r].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === "string") return va.localeCompare(vb) * (sortKey === "sido" ? 1 : 1);
      return ((va ?? -1) - (vb ?? -1)) * dir;
    });
  }, [items, sortKey]);
  const sum = useMemo(() => summarize(rows), [rows]);

  async function run() {
    setBusy(true);
    setError("");
    setItems([]);
    setCollected(0);
    setStatus("조회 시작…");
    const all = [];
    let pageNo = 1;
    let totalCnt = 0;
    try {
      while (pageNo <= MAX_PAGES) {
        const resp = await fetch("/api/court-page", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startYmd: start, endYmd: end, courtCode: court.trim(), pageNo, totalCnt }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error([data.error, data.hint].filter(Boolean).join(" — "));
        if (pageNo === 1) totalCnt = data.totalCnt || 0;
        const batch = data.items || [];
        all.push(...batch);
        setItems([...all]); // 진행 중에도 부분 결과 렌더
        setCollected(all.length);
        const totalPages = Math.max(1, Math.ceil((totalCnt || all.length) / (data.pageSize || 40)));
        setStatus(`수집 중… ${all.length.toLocaleString()}건 (페이지 ${pageNo}/${totalPages})`);
        if (!batch.length || (totalCnt && all.length >= totalCnt)) break;
        pageNo += 1;
        await sleep(PAGE_DELAY);
      }
      const sold = aggregate(all).reduce((s, r) => s + r.cnt, 0);
      setStatus(`완료 · 수집 ${all.length.toLocaleString()}건 / 매각완료(집계대상) ${sold.toLocaleString()}건`);
    } catch (e) {
      setError(String(e.message || e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `court_rate_${start}_${end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="wrap">
      <header className="head">
        <div className="kicker">채권관리 · 실익분석</div>
        <h1>법원경매 낙찰가율 조회</h1>
        <p className="sub">매각기일 기간을 넣으면 행정구역 × 용도별 낙찰가율(매각가합 ÷ 감정가합)을 집계합니다.</p>
      </header>

      <section className="panel controls">
        <label>
          <span>매각기일 시작</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          <span>매각기일 종료</span>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label>
          <span>법원코드 (선택 · 비우면 전국)</span>
          <input type="text" placeholder="예: B000210" value={court} onChange={(e) => setCourt(e.target.value)} />
        </label>
        <button className="go" onClick={run} disabled={busy}>
          {busy ? "조회 중…" : "조회"}
        </button>
      </section>

      {(status || error) && (
        <div className={`status ${error ? "err" : ""}`}>
          {error ? `오류: ${error}` : status}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <section className="summary">
            <div className="card">
              <div className="cl">전체 낙찰가율</div>
              <div className="cv accent">{sum.rate ?? "-"}<small>%</small></div>
            </div>
            <div className="card">
              <div className="cl">매각건수</div>
              <div className="cv">{sum.cnt.toLocaleString()}<small>건</small></div>
            </div>
            <div className="card">
              <div className="cl">감정가 합</div>
              <div className="cv">{eok(sum.gam)}<small>억</small></div>
            </div>
            <div className="card">
              <div className="cl">매각가 합</div>
              <div className="cv">{eok(sum.mae)}<small>억</small></div>
            </div>
            <button className="csv" onClick={download}>CSV 내려받기</button>
          </section>

          <section className="panel">
            <table>
              <thead>
                <tr>
                  <Th k="sido" sk={sortKey} set={setSortKey}>시도</Th>
                  <Th k="sigu" sk={sortKey} set={setSortKey}>시군구</Th>
                  <Th k="usg" sk={sortKey} set={setSortKey}>용도</Th>
                  <Th k="cnt" sk={sortKey} set={setSortKey} num>매각건수</Th>
                  <Th k="gam" sk={sortKey} set={setSortKey} num>감정가합(억)</Th>
                  <Th k="mae" sk={sortKey} set={setSortKey} num>매각가합(억)</Th>
                  <Th k="rate" sk={sortKey} set={setSortKey} num>낙찰가율</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.sido}</td>
                    <td>{r.sigu}</td>
                    <td>{r.usg}</td>
                    <td className="num">{r.cnt.toLocaleString()}</td>
                    <td className="num">{eok(r.gam)}</td>
                    <td className="num">{eok(r.mae)}</td>
                    <td className="num rate">{r.rate ?? "-"}<small>%</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {!busy && !rows.length && collected > 0 && !error && (
        <div className="status">
          수집된 {collected.toLocaleString()}건 중 매각완료 건이 없습니다. (기간이 미래이거나 유찰·취하 위주)
        </div>
      )}

      <footer className="foot">
        출처: 대한민국 법원 법원경매정보 · 낙찰가율 = 매각가 ÷ 감정가 (금액가중)
      </footer>
    </div>
  );
}

function Th({ k, sk, set, children, num }) {
  return (
    <th className={`${num ? "num" : ""} ${sk === k ? "on" : ""}`} onClick={() => set(k)}>
      {children}
      <i>{sk === k ? "▾" : ""}</i>
    </th>
  );
}
