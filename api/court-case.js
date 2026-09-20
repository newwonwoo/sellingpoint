// 사건번호로 그 사건의 경매물건을 가져온다.
// [무엇] searchControllerMain.on 에 csNo(사건번호)만 넣으면 그 사건의 물건 목록이 온다.
//        법원코드(cortOfcCd)는 없어도 되고, "2024타경115858" 형식 그대로 받는다.
// [왜]   실익분석은 '그 재산'이 대상이다. 감정가·최저가·유찰횟수·면적이 여기서 다 나오므로
//        시세 API 없이도 예상낙찰가를 낼 수 있다. (감정가 × 그 시군구·용도 낙찰가율)
// [한계] 모든 사건이 조회되지는 않는다. 기일이 취소·변경된 사건은 0건으로 오는 경우가 있다.

const BASE = "https://www.courtauction.go.kr";
const SEARCH_PATH = "/pgj/pgjsearch/searchControllerMain.on";
const SEED_PATH = "/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml";

// 검색 본문 템플릿(필드 ~60개). 부분만 보내면 서버가 거절하므로 전체를 보낸다.
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

// "2024 타경 115858", "2024타경115858", "2024-115858" → "2024타경115858"
export function normalizeCaseNo(raw) {
  const s = String(raw || "").replace(/\s/g, "");
  const m = /^(\d{4})(?:타경|-)?(\d{1,6})$/.exec(s);
  return m ? `${m[1]}타경${m[2]}` : null;
}

const n = (v) => { const k = Number(v); return Number.isFinite(k) ? k : 0; };

// ⚠ 응답 한 줄 = '목적물' 이지 경매 단위가 아니다.
//   감정가·최저가·유찰횟수는 '매물(maemulSer)' 단위라 목적물마다 같은 값이 반복된다.
//   그대로 더하면 2018타경6939는 34줄 × 77.88억 = 2,647억이 나온다(실제 77.88억).
//   그래서 매물로 묶고, 금액은 매물에서 한 번만, 면적은 목적물 합으로 만든다.
function groupByLot(rows) {
  const lots = new Map();
  for (const x of rows) {
    const key = String(x.maemulSer ?? "1");
    let lot = lots.get(key);
    if (!lot) {
      lot = {
        lotNo: key,
        usageCount: {},
        sido: x.hjguSido || "", sigungu: x.hjguSigu || "", dong: x.hjguDong || "",
        sidoCode: x.daepyoSidoCd || "", sigunguCode: x.daepyoSiguCd || "",
        appraisal: n(x.gamevalAmt),        // 감정가 (매물 단위)
        minPrice: n(x.minmaePrice),        // 최저매각가격 (매물 단위)
        minRate: n(x.notifyMinmaePriceRate1),
        failCount: n(x.yuchalCnt),         // 유찰횟수 (매물 단위)
        saleDate: x.maeGiil || "",
        place: x.maePlace || "",
        specialCond: x.spJogCd || "",
        note: x.mulBigo || "",
        areaSum: 0,
        objects: [],
      };
      lots.set(key, lot);
    }
    const usage = x.dspslUsgNm || "";
    if (usage) lot.usageCount[usage] = (lot.usageCount[usage] || 0) + 1;
    const area = n(x.maxArea);
    lot.areaSum += area;
    lot.objects.push({
      seq: String(x.mokmulSer ?? ""),
      jibun: x.maejibun || x.daepyoLotno || "",
      building: x.buldNm || "",
      unit: x.buldList || "",
      usage, area,
    });
  }
  // 대표 용도: 목적물이 여러 종류면 가장 많은 것 (낙찰가율 매칭에 쓴다)
  return [...lots.values()].map((lot) => {
    const ranked = Object.entries(lot.usageCount).sort((a, b) => b[1] - a[1]);
    const { usageCount, ...rest } = lot;
    return { ...rest, usage: ranked[0]?.[0] || "", usageMix: ranked.map(([k, v]) => `${k}(${v})`) };
  });
}

export default async function handler(req, res) {
  try {
    const raw = req.method === "POST" ? req.body : req.query;
    const body = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    const csNo = normalizeCaseNo(body.caseNo);
    if (!csNo) {
      return res.status(400).json({ error: "사건번호를 확인해주세요 (예: 2024타경115858)." });
    }

    // 1) 세션 시드 — 검색 화면을 먼저 열어 쿠키 확보(WAF 통과 확률↑)
    const seed = await fetch(BASE + SEED_PATH, { headers: browserHeaders() });
    const setCookies = typeof seed.headers.getSetCookie === "function" ? seed.headers.getSetCookie() : [];
    const cookie = ["mapGuide=Y", "pageCnt=40", "globalDebug=false",
      ...setCookies.map((c) => c.split(";")[0])].join("; ");

    const r = await fetch(BASE + SEARCH_PATH, {
      method: "POST",
      headers: {
        ...browserHeaders(),
        "Content-Type": "application/json;charset=UTF-8",
        Referer: BASE + SEED_PATH,
        submissionid: "mf_wfm_mainFrame_sbm_selectGdsDtlSrch",
        "SC-Userid": "SYSTEM",
        Cookie: cookie,
      },
      body: JSON.stringify({
        dma_pageInfo: {
          pageNo: 1, pageSize: "40", bfPageNo: "", startRowNo: 1,
          totalCnt: "0", totalYn: "N", groupTotalCount: 0,
        },
        dma_srchGdsDtlSrchInfo: { ...SEARCH_INFO_TEMPLATE, csNo },
      }),
    });

    const text = await r.text();
    if (r.status !== 200) {
      return res.status(502).json({
        error: `법원 서버 응답 ${r.status}`,
        hint: "WAF/IP 차단일 수 있습니다. vercel dev(로컬) 또는 서울 IP에서 시도해보세요.",
        sample: text.slice(0, 300),
      });
    }
    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(502).json({ error: "응답이 JSON이 아닙니다(차단 가능성).", sample: text.slice(0, 300) }); }

    const rows = data?.data?.dlt_srchResult || [];
    // 같은 줄이 중복으로 오는 경우가 있어 docid로 먼저 정리한다
    const seen = new Set();
    const uniq = [];
    for (const x of rows) {
      const key = x.docid || JSON.stringify([x.srnSaNo, x.maemulSer, x.mokmulSer]);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(x);
    }
    const head = uniq[0] || {};
    return res.status(200).json({
      caseNo: csNo,
      court: head.jiwonNm || "",
      dept: head.jpDeptNm || "",
      tel: head.tel || "",
      objectCount: uniq.length,
      lots: groupByLot(uniq),
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
