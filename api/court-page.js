// Vercel 서버리스 함수 — 법원경매 '매각기일별 검색' 결과를 한 페이지씩 받아오는 프록시.
// [왜 필요한가] 브라우저(프론트)에서 courtauction.go.kr 을 직접 부르면 CORS와 WAF로 막힌다.
// 그래서 이 서버 함수가 대신 호출한다(서버↔서버라 CORS 없음). 한 호출 = 한 페이지라
// Vercel 함수 실행시간 제한도 넘기지 않는다. 페이지 넘기기/집계는 프론트가 담당.

const BASE = "https://www.courtauction.go.kr";
const SEARCH_PATH = "/pgj/pgjsearch/searchControllerMain.on";
const SEED_PATH = "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml";
const PAGE_SIZE = 40;

// 사이트가 쓰는 검색 본문 템플릿(필드 ~60개). 부분만 보내면 서버가 거절하므로 전체를 보낸다.
// bidBgngYmd/bidEndYmd = 매각기일 범위, cortAuctnSrchCondCd=0004601 = '매각기일별 검색'.
const SEARCH_INFO_TEMPLATE = {
  rletDspslSpcCondCd: "", bidDvsCd: "000331", mvprpRletDvsCd: "00031R",
  cortAuctnSrchCondCd: "0004601", rprsAdongSdCd: "", rprsAdongSggCd: "",
  rprsAdongEmdCd: "", rdnmSdCd: "", rdnmSggCd: "", rdnmNo: "",
  mvprpDspslPlcAdongSdCd: "", mvprpDspslPlcAdongSggCd: "", mvprpDspslPlcAdongEmdCd: "",
  rdDspslPlcAdongSdCd: "", rdDspslPlcAdongSggCd: "", rdDspslPlcAdongEmdCd: "",
  cortOfcCd: "", jdbnCd: "", execrOfcDvsCd: "",
  lclDspslGdsLstUsgCd: "", mclDspslGdsLstUsgCd: "", sclDspslGdsLstUsgCd: "",
  cortAuctnMbrsId: "", aeeEvlAmtMin: "", aeeEvlAmtMax: "",
  lwsDspslPrcRateMin: "", lwsDspslPrcRateMax: "", flbdNcntMin: "", flbdNcntMax: "",
  objctArDtsMin: "", objctArDtsMax: "", mvprpArtclKndCd: "", mvprpArtclNm: "",
  mvprpAtchmPlcTypCd: "", notifyLoc: "off", lafjOrderBy: "", pgmId: "PGJ151F01",
  csNo: "", cortStDvs: "1", statNum: 1, bidBgngYmd: "", bidEndYmd: "",
  dspslDxdyYmd: "", fstDspslHm: "", scndDspslHm: "", thrdDspslHm: "", fothDspslHm: "",
  dspslPlcNm: "", lwsDspslPrcMin: "", lwsDspslPrcMax: "", grbxTypCd: "", gdsVendNm: "",
  fuelKndCd: "", carMdyrMax: "", carMdyrMin: "", carMdlNm: "", sideDvsCd: "",
};

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

function buildBody(startYmd, endYmd, courtCode, pageNo, totalCnt) {
  const info = { ...SEARCH_INFO_TEMPLATE, cortOfcCd: courtCode || "", bidBgngYmd: startYmd, bidEndYmd: endYmd };
  return {
    dma_pageInfo: {
      pageNo,
      pageSize: String(PAGE_SIZE),
      bfPageNo: "",
      startRowNo: (pageNo - 1) * PAGE_SIZE + 1,
      totalCnt: String(totalCnt),
      totalYn: totalCnt > 0 ? "Y" : "N",
      groupTotalCount: 0,
    },
    dma_srchGdsDtlSrchInfo: info,
  };
}

export default async function handler(req, res) {
  try {
    const raw = req.method === "POST" ? req.body : req.query;
    const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    const startYmd = String(body.startYmd || "").replace(/-/g, "");
    const endYmd = String(body.endYmd || "").replace(/-/g, "");
    const courtCode = body.courtCode || "";
    const pageNo = parseInt(body.pageNo || "1", 10) || 1;
    const totalCnt = parseInt(body.totalCnt || "0", 10) || 0;

    if (!/^\d{8}$/.test(startYmd) || !/^\d{8}$/.test(endYmd)) {
      return res.status(400).json({ error: "매각기일(startYmd, endYmd)을 YYYY-MM-DD 형식으로 보내주세요." });
    }

    // 1) 세션 시드 — 검색 화면을 먼저 열어 쿠키를 받는다(WAF 통과 확률↑)
    const seed = await fetch(BASE + SEED_PATH, { headers: browserHeaders() });
    const setCookies = typeof seed.headers.getSetCookie === "function" ? seed.headers.getSetCookie() : [];
    const cookiePairs = setCookies.map((c) => c.split(";")[0]);
    const cookie = ["mapGuide=Y", "pageCnt=40", "globalDebug=false", ...cookiePairs].join("; ");

    // 2) 페이지 1건 POST
    const r = await fetch(BASE + SEARCH_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml",
        submissionid: "mf_wfm_mainFrame_sbm_selectGdsDtlSrch",
        "SC-Userid": "SYSTEM",
        Cookie: cookie,
      },
      body: JSON.stringify(buildBody(startYmd, endYmd, courtCode, pageNo, totalCnt)),
    });

    const text = await r.text();
    if (r.status !== 200) {
      return res.status(502).json({
        error: `법원 서버 응답 ${r.status}`,
        hint: "WAF 차단 또는 데이터센터 IP 문제일 수 있습니다. vercel dev(로컬) 또는 EC2(서울 IP)에서 시도해보세요.",
        sample: text.slice(0, 200),
      });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "응답이 JSON이 아닙니다(차단 가능성).", sample: text.slice(0, 200) });
    }

    const d = data.data || {};
    const items = d.dlt_srchResult || [];
    const tc = parseInt(d?.dma_pageInfo?.totalCnt ?? totalCnt, 10) || totalCnt || 0;
    return res.status(200).json({ items, totalCnt: tc, pageSize: PAGE_SIZE, pageNo });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
