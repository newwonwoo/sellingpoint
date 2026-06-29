// 시도/시군구 목록 프록시 — 법원의 selectAdong.on 을 대신 호출한다.
// [무엇] ty="1" → 시도 목록 / ty="2" + adongSdCd → 그 시도의 시군구 목록.
// [왜] 법원이 실제로 쓰는 시군구 코드(adongSggCd)를 그대로 받아와야 통계조회 시 코드가 맞는다.

const BASE = "https://www.courtauction.go.kr";
const ADONG_PATH = "/pgj/pgjComm/selectAdong.on";
const SEED_PATH = "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ164M01.xml";

function browserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    Origin: BASE,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

export default async function handler(req, res) {
  try {
    const raw = req.method === "POST" ? req.body : req.query;
    const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    const ty = body.ty === "1" ? "1" : "2";
    const adongSdCd = body.sidoCode || "";

    const seed = await fetch(BASE + SEED_PATH, { headers: browserHeaders() });
    const setCookies = typeof seed.headers.getSetCookie === "function" ? seed.headers.getSetCookie() : [];
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

    const r = await fetch(BASE + ADONG_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ164M01.xml",
        "SC-Pgmid": "PGJ164M01",
        "SC-Userid": "SYSTEM",
        submissionid: "mf_sbm_selectAdong",
        Cookie: cookie,
      },
      body: JSON.stringify({ dma_aDong_search: { ty, adongSdCd } }),
    });
    const text = await r.text();
    if (r.status !== 200) return res.status(502).json({ error: `법원 서버 ${r.status}`, sample: text.slice(0, 200) });
    let data;
    try { data = JSON.parse(text); } catch { return res.status(502).json({ error: "JSON 아님", sample: text.slice(0, 200) }); }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
