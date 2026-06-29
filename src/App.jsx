import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import regions from "./regions.json";

const YEARS = Array.from({ length: 12 }, (_, i) => 2026 - i);
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

// 매각통계 응답 스키마 (확인된 컬럼명 → 한글 라벨 + 단위는 헤더에)
const SCHEMA = [
  { key: "lclDspslGdsLstUsgNm", label: "물건용도", unit: "", type: "text", w: "19%" },
  { key: "auctnNum", label: "경매건수", unit: "건", type: "int", w: "11%" },
  { key: "dspslNum", label: "매각건수", unit: "건", type: "int", w: "11%" },
  { key: "aeeEvlGrsAmt", label: "감정가", unit: "억원", type: "eok", w: "13%" },
  { key: "dspslGrsAmt", label: "매각가", unit: "억원", type: "eok", w: "13%" },
  { key: "dspslRate", label: "매각율", unit: "%", type: "rate", w: "10%" },
  { key: "dspslAmtRate", label: "매각가율", unit: "%", type: "rate", emph: true, w: "23%" },
];

function findRows(obj) {
  let best = [];
  const visit = (o) => {
    if (Array.isArray(o)) {
      if (o.length && o[0] && typeof o[0] === "object" && !Array.isArray(o[0])) {
        if (o.length > best.length) best = o;
      }
      o.forEach(visit);
    } else if (o && typeof o === "object") Object.values(o).forEach(visit);
  };
  visit(obj);
  return best;
}
function toOptions(data) {
  return findRows(data)
    .map((r) => {
      const e = Object.entries(r);
      const code = e.find(([k, v]) => /cd|code/i.test(k) && v != null && String(v).length <= 7)?.[1] ??
        e.find(([, v]) => /^\d{2,7}$/.test(String(v)))?.[1];
      const name = e.find(([k, v]) => /nm|name/i.test(k) && /[가-힣]/.test(String(v)))?.[1] ??
        e.find(([, v]) => /[가-힣]/.test(String(v)))?.[1];
      return { code: String(code ?? ""), name: String(name ?? "") };
    })
    .filter((o) => o.code && o.name && o.name !== "전체");
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmtInt = (v) => num(v).toLocaleString();
const fmtEok = (v) => { const n = num(v) / 1e8; return (n >= 100 ? Math.round(n) : Number(n.toFixed(1))).toLocaleString(); };
const fmtRate = (v) => (num(v) ? num(v).toFixed(1) : "-");
function fmtCell(type, v) {
  if (type === "int") return fmtInt(v);
  if (type === "eok") return fmtEok(v);
  if (type === "rate") return fmtRate(v);
  return v ?? "";
}
// 매각가율 셀: 숫자 + 감정가회수 100% 기준선이 있는 미니 막대 (실익분석 핵심 시각화)
function RateBar({ v, bad }) {
  const val = num(v);
  const band = val >= 100 ? "hi" : val >= 80 ? "mid" : val > 0 ? "lo" : "na";
  const w = Math.max(0, Math.min(val, 120)) / 120 * 100;
  return (
    <div className={`ratecell ${band}`}>
      <span className="ratev">{val ? val.toFixed(1) : "-"}{bad ? " ⚠" : ""}</span>
      <span className="ratebar"><i style={{ width: `${w}%` }} /></span>
    </div>
  );
}
// 행 정합성: 매각건수≤경매건수, 매각율=매각/경매, 매각가율=매각가/감정가
function checkRow(r) {
  const auctn = num(r.auctnNum), dspsl = num(r.dspslNum);
  const aee = num(r.aeeEvlGrsAmt), amt = num(r.dspslGrsAmt);
  const cntOk = dspsl <= auctn;
  const dOk = auctn === 0 ? dspsl === 0 : Math.abs(dspsl / auctn * 100 - num(r.dspslRate)) < 1;
  const aOk = aee === 0 ? true : Math.abs(amt / aee * 100 - num(r.dspslAmtRate)) < 1;
  return cntOk && dOk && aOk;
}
const isSubtotal = (name) => name === "소계" || name === "전체";

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
  const [sgList, setSgList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [resp, setResp] = useState(null);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlMsg, setDlMsg] = useState("");

  useEffect(() => {
    setSigungu(""); setSgList(null);
    if (!sido) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/court-adong", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ty: "2", sidoCode: sido }),
        });
        const data = await r.json();
        const opts = toOptions(data);
        if (alive) setSgList(opts.length ? opts : regions.sigungu[sido] || []);
      } catch { if (alive) setSgList(regions.sigungu[sido] || []); }
    })();
    return () => { alive = false; };
  }, [sido]);

  const sigunguOptions = sgList ?? (sido ? regions.sigungu[sido] || [] : []);
  const rawRows = useMemo(() => (resp ? findRows(resp) : []), [resp]);
  // 확인된 스키마면 그 컬럼만, 아니면 원본 키 전체(폴백)
  const known = rawRows.length && "lclDspslGdsLstUsgNm" in rawRows[0];
  const integ = useMemo(() => {
    if (!known) return null;
    const bad = rawRows.filter((r) => !checkRow(r)).length;
    return { total: rawRows.length, bad };
  }, [rawRows, known]);

  // 요약: '전체' 행 우선, 없으면 소계/전체 제외 합산으로 산출
  const summary = useMemo(() => {
    if (!known) return null;
    const tot = rawRows.find((r) => r.lclDspslGdsLstUsgNm === "전체");
    if (tot) return { amtRate: num(tot.dspslAmtRate), rate: num(tot.dspslRate), auctn: num(tot.auctnNum), dspsl: num(tot.dspslNum) };
    const base = rawRows.filter((r) => !isSubtotal(r.lclDspslGdsLstUsgNm));
    const s = base.reduce((a, r) => ({
      auctn: a.auctn + num(r.auctnNum), dspsl: a.dspsl + num(r.dspslNum),
      aee: a.aee + num(r.aeeEvlGrsAmt), amt: a.amt + num(r.dspslGrsAmt),
    }), { auctn: 0, dspsl: 0, aee: 0, amt: 0 });
    return { amtRate: s.aee ? s.amt / s.aee * 100 : 0, rate: s.auctn ? s.dspsl / s.auctn * 100 : 0, auctn: s.auctn, dspsl: s.dspsl };
  }, [rawRows, known]);

  const regionLabel = useMemo(() => {
    if (!sido) return "전국";
    const sn = regions.sido.find((s) => s.code === sido)?.name || sido;
    const gn = sigungu ? sigunguOptions.find((g) => g.code === sigungu)?.name : "";
    return gn ? `${sn} ${gn}` : sn;
  }, [sido, sigungu, sigunguOptions]);

  function presetMonths(n) {
    const e = new Date(curY, now.getMonth(), 1);
    const s = new Date(curY, now.getMonth() - (n - 1), 1);
    setStartY(String(s.getFullYear())); setStartM(String(s.getMonth() + 1).padStart(2, "0"));
    setEndY(String(e.getFullYear())); setEndM(String(e.getMonth() + 1).padStart(2, "0"));
  }
  const presetThisYear = () => { setStartY(String(curY)); setStartM("01"); setEndY(String(curY)); setEndM(curM); };

  async function run() {
    setBusy(true); setError(""); setResp(null); setStatus("조회 중…");
    try {
      const r = await fetch("/api/court-stats", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidoCode: sido, sigunguCode: sigungu, startYM: `${startY}${startM}`, endYM: `${endY}${endM}` }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error([data.error, data.hint].filter(Boolean).join(" — "));
      setResp(data);
      const n = findRows(data).length;
      setStatus(n ? `완료 · ${n}개 행 (${startY}.${startM} ~ ${endY}.${endM})` : "응답은 받았지만 표 행이 없습니다(아래 원본 확인).");
    } catch (e) { setError(String(e.message || e)); setStatus(""); }
    finally { setBusy(false); }
  }

  // --- 엑셀 수집 공통 헬퍼 ---
  const periodTag = () => `${startY}${startM}_${endY}${endM}`;
  async function fetchStatsRows(sdCode, sggCode) {
    const r = await fetch("/api/court-stats", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sidoCode: sdCode, sigunguCode: sggCode, startYM: `${startY}${startM}`, endYM: `${endY}${endM}` }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    return findRows(data);
  }
  // 강원(42)/전북(45)은 법원이 신코드(51/52)를 쓸 수 있어 둘 다 시도해 맞는 코드 반환
  async function resolveSido(code) {
    const cands = code === "42" ? ["42", "51"] : code === "45" ? ["45", "52"] : [code];
    if (cands.length === 1) return code;
    for (const c of cands) { try { if ((await fetchStatsRows(c, "")).length) return c; } catch {} }
    return code;
  }
  const mapRow = (sidoName, ggName, row) => ({
    시도: sidoName, 시군구: ggName || "(전체)", 물건용도: row.lclDspslGdsLstUsgNm,
    경매건수: num(row.auctnNum), 매각건수: num(row.dspslNum),
    "감정가(원)": num(row.aeeEvlGrsAmt), "매각가(원)": num(row.dspslGrsAmt),
    "매각율(%)": num(row.dspslRate), "매각가율(%)": num(row.dspslAmtRate),
  });
  // 한 시도의 구 전체 수집
  async function collectSido(sd, onProg) {
    const eff = await resolveSido(sd.code);
    const list = regions.sigungu[sd.code] || [];
    const targets = list.length ? list : [{ code: "", name: "(전체)" }];
    const rows = []; let fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      onProg && onProg(i + 1, targets.length, g.name || "(전체)");
      try {
        for (const row of await fetchStatsRows(eff, g.code ? String(g.code).slice(-3) : ""))
          rows.push(mapRow(sd.name, g.name, row));
      } catch { fail++; }
      await new Promise((res) => setTimeout(res, 120));
    }
    return { rows, fail };
  }
  function toWorkbook(rows, sheetName) {
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 9 }, { wch: 9 }, { wch: 16 }, { wch: 16 }, { wch: 9 }, { wch: 11 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 28));
    return wb;
  }

  // 버튼: 시도 선택 시 그 시도(또는 특정 구) xlsx 1개 / 미선택 시 전국 zip
  async function downloadExcel() {
    if (!sido) return downloadAllSido();
    setError(""); setDlBusy(true); setDlMsg("준비 중…");
    const sd = regions.sido.find((s) => s.code === sido) || { code: sido, name: sido };
    let rows = [], fail = 0;
    if (sigungu) {
      const name = sigunguOptions.find((g) => g.code === sigungu)?.name || "";
      setDlMsg(`수집 중 · ${name}`);
      try {
        const eff = await resolveSido(sd.code);
        for (const row of await fetchStatsRows(eff, String(sigungu).slice(-3))) rows.push(mapRow(sd.name, name, row));
      } catch { fail++; }
    } else {
      const res = await collectSido(sd, (i, t, nm) => setDlMsg(`수집 중 ${i}/${t} · ${nm}`));
      rows = res.rows; fail = res.fail;
    }
    if (!rows.length) { setError("수집된 데이터가 없습니다 (WAF/IP 차단 또는 해당 기간 데이터 없음)."); setDlBusy(false); setDlMsg(""); return; }
    XLSX.writeFile(toWorkbook(rows, sd.name), `매각통계_${sd.name}_${periodTag()}.xlsx`);
    setDlMsg(`완료 · ${rows.length}행${fail ? ` (실패 ${fail})` : ""}`);
    setDlBusy(false);
  }

  // 전국 17개 시도 → 시도별 xlsx를 zip 하나로
  async function downloadAllSido() {
    setError(""); setDlBusy(true);
    const zip = new JSZip();
    let totalRows = 0, totalFail = 0;
    for (let s = 0; s < regions.sido.length; s++) {
      const sd = regions.sido[s];
      const { rows, fail } = await collectSido(sd, (i, t, nm) =>
        setDlMsg(`[${s + 1}/${regions.sido.length}] ${sd.name} · 구 ${i}/${t} ${nm}`));
      totalFail += fail;
      if (rows.length) {
        zip.file(`매각통계_${sd.name}_${periodTag()}.xlsx`, XLSX.write(toWorkbook(rows, sd.name), { type: "array", bookType: "xlsx" }));
        totalRows += rows.length;
      }
    }
    if (!totalRows) { setError("전국 수집 결과가 비었습니다 (WAF/IP 차단 가능)."); setDlBusy(false); setDlMsg(""); return; }
    setDlMsg("zip 생성 중…");
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `매각통계_전국_${periodTag()}.zip`; a.click();
    URL.revokeObjectURL(url);
    setDlMsg(`완료 · 전국 ${totalRows}행 · ${regions.sido.length}개 시도 파일${totalFail ? ` (구 실패 ${totalFail})` : ""}`);
    setDlBusy(false);
  }

  function download() {
    if (!rawRows.length) return;
    let head, lines;
    if (known) {
      head = ["물건용도", "경매건수", "매각건수", "감정가(원)", "매각가(원)", "매각율", "매각가율"];
      lines = rawRows.map((r) => [r.lclDspslGdsLstUsgNm, num(r.auctnNum), num(r.dspslNum), num(r.aeeEvlGrsAmt), num(r.dspslGrsAmt), num(r.dspslRate), num(r.dspslAmtRate)]);
    } else {
      head = Object.keys(rawRows[0]);
      lines = rawRows.map((r) => head.map((k) => r[k]));
    }
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = "\uFEFF" + [head.map(esc).join(","), ...lines.map((l) => l.map(esc).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const tag = sido ? regions.sido.find((s) => s.code === sido)?.name : "전국";
    a.href = url; a.download = `매각통계_${tag}_${startY}${startM}_${endY}${endM}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const fbCols = !known && rawRows.length ? Object.keys(rawRows[0]) : [];

  return (
    <div className="wrap">
      <header className="head">
        <div className="kicker">채권관리 · 실익분석</div>
        <h1>법원경매 낙찰가율 조회</h1>
        <p className="sub">소재지·기간을 고르면 법원 매각통계의 용도별 매각가율(=낙찰가율)을 가져옵니다.</p>
      </header>

      <section className="panel controls">
        <label><span>기간 시작</span>
          <div className="ym">
            <select value={startY} onChange={(e) => setStartY(e.target.value)}>{YEARS.map((y) => <option key={y}>{y}</option>)}</select>
            <select value={startM} onChange={(e) => setStartM(e.target.value)}>{MONTHS.map((m) => <option key={m}>{m}</option>)}</select>
          </div>
        </label>
        <label><span>기간 종료</span>
          <div className="ym">
            <select value={endY} onChange={(e) => setEndY(e.target.value)}>{YEARS.map((y) => <option key={y}>{y}</option>)}</select>
            <select value={endM} onChange={(e) => setEndM(e.target.value)}>{MONTHS.map((m) => <option key={m}>{m}</option>)}</select>
          </div>
        </label>
        <label><span>시도(소재지)</span>
          <select value={sido} onChange={(e) => setSido(e.target.value)}>
            <option value="">전국</option>
            {regions.sido.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label><span>시군구</span>
          <select value={sigungu} onChange={(e) => setSigungu(e.target.value)} disabled={!sido}>
            <option value="">{sido ? (sgList === null ? "불러오는 중…" : "전체") : "—"}</option>
            {sigunguOptions.map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
          </select>
        </label>
        <button className="go" onClick={run} disabled={busy}>{busy ? "조회 중…" : "조회"}</button>
        <button className="go alt" onClick={downloadExcel} disabled={dlBusy || busy}>{dlBusy ? "수집 중…" : (sido ? "엑셀 받기(구별)" : "전국 엑셀(zip)")}</button>
      </section>

      <div className="presets">
        <span>기간 빠른 선택</span>
        <button onClick={() => presetMonths(3)}>최근 3개월</button>
        <button onClick={() => presetMonths(6)}>최근 6개월</button>
        <button onClick={() => presetMonths(12)}>최근 12개월</button>
        <button onClick={presetThisYear}>올해</button>
      </div>

      {dlMsg && <div className="status">{dlMsg}</div>}

      {(status || error) && <div className={`status ${error ? "err" : ""}`}>{error ? `오류: ${error}` : status}</div>}

      {rawRows.length > 0 && (
        <>
          {summary && (
            <section className="stats">
              <div className="stat hero">
                <div className="sl">전체 매각가율</div>
                <div className="sv">{summary.amtRate.toFixed(1)}<small>%</small></div>
                <div className="sc">{regionLabel} · {startY}.{startM}–{endY}.{endM}</div>
              </div>
              <div className="stat"><div className="sl">매각율</div><div className="sv">{summary.rate.toFixed(1)}<small>%</small></div></div>
              <div className="stat"><div className="sl">경매건수</div><div className="sv">{summary.auctn.toLocaleString()}<small>건</small></div></div>
              <div className="stat"><div className="sl">매각건수</div><div className="sv">{summary.dspsl.toLocaleString()}<small>건</small></div></div>
            </section>
          )}

          <div className="toolbar">
            {integ && (
              <span className={`badge ${integ.bad ? "warn" : "ok"}`}>
                정합성 {integ.total - integ.bad}/{integ.total}행 일치{integ.bad ? ` · ${integ.bad}행 불일치` : ""}
              </span>
            )}
            <button className="csv" onClick={download}>CSV 내려받기</button>
          </div>

          <section className="panel tablewrap">
            {known ? (
              <table className="fixed">
                <colgroup>{SCHEMA.map((c) => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
                <thead><tr>{SCHEMA.map((c) => (
                  <th key={c.key} className={`${c.type === "text" ? "left" : "num"} ${c.emph ? "on" : ""}`}>
                    {c.label}{c.unit ? <i>({c.unit})</i> : ""}
                  </th>
                ))}</tr></thead>
                <tbody>
                  {rawRows.map((r, i) => {
                    const sub = isSubtotal(r.lclDspslGdsLstUsgNm);
                    const ok = checkRow(r);
                    return (
                      <tr key={i} className={`${sub ? "subtot" : ""} ${ok ? "" : "bad"}`}>
                        {SCHEMA.map((c) => (
                          <td key={c.key} className={`${c.type === "text" ? "left" : "num"} ${c.emph ? "ratecol" : ""}`}>
                            {c.emph ? <RateBar v={r[c.key]} bad={!ok} /> : fmtCell(c.type, r[c.key])}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table><thead><tr>{fbCols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{rawRows.map((r, i) => <tr key={i}>{fbCols.map((c) => <td key={c} className="num">{String(r[c] ?? "")}</td>)}</tr>)}</tbody>
              </table>
            )}
          </section>
          <p className="foot">감정가·매각가는 억원 단위(원 단위는 CSV에 그대로). 매각가율=매각가÷감정가, 매각율=매각건수÷경매건수. 막대의 세로선은 감정가 회수 100% 기준. ⚠는 원본 합계와 1%p 이상 어긋난 행.</p>
        </>
      )}

      {resp && !rawRows.length && !error && (
        <section className="panel"><div className="status">표 행이 없습니다. 응답 원본:</div>
          <pre className="raw">{JSON.stringify(resp, null, 2).slice(0, 2000)}</pre></section>
      )}

      <footer className="foot">출처: 대한민국 법원 법원경매정보 · 매각통계(selectRletCortDspslStats)</footer>
    </div>
  );
}
