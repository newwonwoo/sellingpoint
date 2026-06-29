// 집계 로직 (프론트와 테스트가 공용으로 사용)
// 매각완료(maeAmt>0) 물건만 골라 시도 × 시군구 × 용도로 묶고 낙찰가율을 계산한다.
// 낙찰가율 = 매각가합 ÷ 감정가합 × 100  (개별 비율 평균이 아니라 금액가중 평균)

function toInt(v) {
  const n = parseInt(v ?? 0, 10);
  return Number.isFinite(n) ? n : 0;
}

export function aggregate(items) {
  const map = new Map();
  for (const x of items) {
    const mae = toInt(x.maeAmt);
    if (mae <= 0) continue; // 미매각 · 유찰 · 취하 제외
    const gam = toInt(x.gamevalAmt);
    const sido = x.hjguSido || "";
    const sigu = x.hjguSigu || "";
    const usg = x.dspslUsgNm || "";
    const key = `${sido}|${sigu}|${usg}`;
    const cur = map.get(key) || { sido, sigu, usg, cnt: 0, gam: 0, mae: 0 };
    cur.cnt += 1;
    cur.gam += gam;
    cur.mae += mae;
    map.set(key, cur);
  }
  const rows = [...map.values()].map((r) => ({
    ...r,
    rate: r.gam ? +((r.mae / r.gam) * 100).toFixed(2) : null,
  }));
  rows.sort((a, b) => b.mae - a.mae); // 매각가합 큰 순
  return rows;
}

export function summarize(rows) {
  const cnt = rows.reduce((s, r) => s + r.cnt, 0);
  const gam = rows.reduce((s, r) => s + r.gam, 0);
  const mae = rows.reduce((s, r) => s + r.mae, 0);
  return { cnt, gam, mae, rate: gam ? +((mae / gam) * 100).toFixed(2) : null };
}

export function toCsv(rows) {
  const head = ["시도", "시군구", "용도", "매각건수", "감정가합", "매각가합", "낙찰가율(%)"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([r.sido, r.sigu, r.usg, r.cnt, r.gam, r.mae, r.rate ?? ""].join(","));
  }
  return "\uFEFF" + lines.join("\n"); // 엑셀 한글깨짐 방지용 BOM
}
