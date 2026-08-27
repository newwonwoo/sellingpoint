// Vercel 서버리스 프록시 — 법원 '매각통계'(낙찰가율) 엔드포인트를 대신 호출한다.
// [무엇] courtauction.go.kr 의 selectRletCortDspslStats.on 은 소재지(시도·시군구)×기간으로
//        용도별 매각가율(=낙찰가율)을 "이미 집계해서" 한 번에 돌려준다. 페이지네이션 없음.
// [왜 프록시] 브라우저에서 직접 부르면 CORS/WAF로 막히므로 서버가 대신 호출(서버↔서버).
// [코드 여러 개] 한 시군구의 데이터가 법원 내부 코드 2개에 나뉘어 있는 경우가 있어
//        sigunguCodes(배열)를 받으면 세션 하나로 전부 조회해 합산한 뒤 돌려준다. (src/courtCodes.js 참고)

import { mergeStatRows, pickStatRows } from "../src/courtCodes.js";

const BASE = "https://www.courtauction.go.kr";
const STATS_PATH = "/pgj/pgj164/selectRletCortDspslStats.on";
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
    const sidoCode = body.sidoCode || "";       // 시도 2자리 (11=서울). 빈값=전국
    // 시군구: 법원은 자체 3자리 코드를 받는다. sigunguCodes(배열) 우선, 없으면 기존 단일 필드.
    // 단일 필드는 법정동 5자리가 들어올 수 있어 뒤 3자리로 자른다. (11680 강남구 → "680")
    const sigunguCodes = Array.isArray(body.sigunguCodes)
      ? body.sigunguCodes.map((c) => String(c ?? "").trim()).filter(Boolean)
      : [String(body.sigunguCode || "").slice(-3)].filter(Boolean);
    const startYM = String(body.startYM || "").replace(/-/g, ""); // YYYYMM
    const endYM = String(body.endYM || "").replace(/-/g, "");

    if (!/^\d{6}$/.test(startYM) || !/^\d{6}$/.test(endYM)) {
      return res.status(400).json({ error: "기간(YYYY-MM)을 확인해주세요." });
    }

    // 1) 세션 시드 — 매각통계 화면을 먼저 열어 쿠키 확보
    const seed = await fetch(BASE + SEED_PATH, { headers: browserHeaders() });
    const setCookies = typeof seed.headers.getSetCookie === "function" ? seed.headers.getSetCookie() : [];
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

    // 2) 매각통계 요청 (캡처된 본문 구조 그대로). 코드가 여러 개면 같은 세션으로 순차 조회.
    const fetchOne = async (sggCd) => {
      const payload = {
        dma_search: {
          searchType: "02",   // 02 = 소재지(지역) 기준 / 01 = 법원 기준
          cortOfcCd: "",      // 소재지 모드에서는 미사용
          adongSdCd: sidoCode, // 시도 2자리
          adongSggCd: sggCd,   // 시군구 (빈값=전체)
          startDate: startYM,  // YYYYMM
          endDate: endYM,
        },
      };
      const r = await fetch(BASE + STATS_PATH, {
        method: "POST",
        headers: {
          ...browserHeaders(),
          "Content-Type": "application/json;charset=UTF-8",
          Referer: BASE + "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ164M01.xml",
          "SC-Pgmid": "PGJ164M01",
          "SC-Userid": "SYSTEM",
          submissionid: "mf_sbm_selectRletCortDspslStats",
          Cookie: cookie,
        },
        body: JSON.stringify(payload),
      });
      return { status: r.status, text: await r.text() };
    };

    const codes = sigunguCodes.length ? sigunguCodes : [""]; // 빈 배열 = 시도 전체
    const results = [];
    for (const c of codes) {
      const { status, text } = await fetchOne(c);
      if (status !== 200) {
        return res.status(502).json({
          error: `법원 서버 응답 ${status}`,
          hint: "WAF/IP 차단이거나 파라미터 문제. vercel dev(로컬) 또는 EC2(서울 IP)에서 시도.",
          sample: text.slice(0, 300),
        });
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return res.status(502).json({ error: "응답이 JSON이 아닙니다(차단 가능성).", sample: text.slice(0, 300) });
      }
      results.push({ code: c, data });
    }

    // 코드 1개면 원본 그대로(디버그용 원본 응답 패널이 진짜 응답을 보여주도록).
    if (results.length === 1) return res.status(200).json(results[0].data);

    // 2개 이상이면 합산해서 법원 응답과 같은 모양으로 돌려준다.
    const rows = mergeStatRows(results.map((x) => pickStatRows(x.data)));
    return res.status(200).json({
      status: 200,
      message: "정상",
      data: { rletCortDspslStats: rows },
      // 어느 코드가 실제로 데이터를 갖고 있었는지(문자열 배열이라 행 탐색에 걸리지 않음)
      meta: {
        sggCodes: results.map((x) => x.code),
        sggCodesUsed: results.filter((x) => pickStatRows(x.data).length).map((x) => x.code),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
