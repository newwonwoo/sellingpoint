/**
 * POST /api/court-search-trigger
 * - input.xlsx 를 받아 GitHub에 커밋
 * - GitHub Actions workflow_dispatch 트리거
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = 'newwonwoo/sellingpoint';
  const BRANCH = 'main';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN 환경변수 없음' });
  }

  try {
    // multipart/form-data로 받은 xlsx 파일을 base64로 GitHub에 커밋
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Content-Type: application/octet-stream 으로 직접 받거나
    // 헤더에서 파일 데이터 분리 (단순화: body 전체를 xlsx로 처리)
    const base64Content = body.toString('base64');

    // 현재 파일 SHA 조회 (업데이트용)
    const shaRes = await fetch(
      `https://api.github.com/repos/${REPO}/contents/court-search/input.xlsx?ref=${BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    const shaData = shaRes.ok ? await shaRes.json() : null;
    const currentSha = shaData?.sha;

    // input.xlsx 커밋
    const commitBody = {
      message: `사건조회 입력파일 업데이트 (${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })})`,
      content: base64Content,
      branch: BRANCH,
    };
    if (currentSha) commitBody.sha = currentSha;

    const commitRes = await fetch(
      `https://api.github.com/repos/${REPO}/contents/court-search/input.xlsx`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(commitBody),
      }
    );

    if (!commitRes.ok) {
      const err = await commitRes.text();
      return res.status(500).json({ error: `파일 커밋 실패: ${err}` });
    }

    // workflow_dispatch 트리거
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/court_search.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: BRANCH }),
      }
    );

    if (!dispatchRes.ok) {
      const err = await dispatchRes.text();
      return res.status(500).json({ error: `Actions 트리거 실패: ${err}` });
    }

    return res.status(200).json({ ok: true, message: '조회 시작됨' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
