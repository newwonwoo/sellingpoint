import { randomUUID } from 'node:crypto';

/** POST /api/court-search-single-trigger — 엑셀 없이 단건 전용 workflow 실행 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';
  const BRANCH = process.env.GITHUB_BRANCH || 'main';
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN 환경변수 없음' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const court = String(body.court || '').trim();
    const caseNo = String(body.caseNo || '').trim();
    const party = String(body.party || '주택').trim() || '주택';
    if (!court || !/^\d{4}[가-힣]+\d+$/.test(caseNo)) {
      return res.status(400).json({ error: '법원과 올바른 사건번호가 필요합니다.' });
    }

    const requestId = randomUUID();
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/court_search_single.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: BRANCH,
          inputs: {
            request_id: requestId,
            court,
            case_no: caseNo,
            party,
          },
        }),
      },
    );
    if (!dispatchRes.ok) {
      return res.status(502).json({ error: `단건 Actions 실행 실패 (${dispatchRes.status})` });
    }
    return res.status(200).json({
      ok: true,
      requestId,
      queuedAt: new Date().toISOString(),
      message: '단건 조회 시작됨',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
