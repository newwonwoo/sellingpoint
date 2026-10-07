/**
 * POST /api/court-search-trigger
 * - input.xlsx 를 받아 GitHub에 커밋
 * - 실제 조회 모드의 GitHub Actions workflow_dispatch 트리거
 * - 커밋 SHA를 반환해 프론트가 다른 실행 결과와 섞이지 않게 한다.
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';
  const BRANCH = process.env.GITHUB_BRANCH || 'main';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN 환경변수 없음' });
  }

  try {
    // Vercel 런타임 설정에 따라 req.body가 Buffer로 들어오거나 스트림으로 남는다.
    // 둘 다 input.xlsx 원문 바이트로 취급한다.
    let body;
    if (Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (req.body instanceof Uint8Array) {
      body = Buffer.from(req.body);
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
    if (!body.length) return res.status(400).json({ error: '업로드된 xlsx 파일이 비어 있습니다.' });

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
    const commitData = await commitRes.json();
    const headSha = commitData.commit?.sha || commitData.content?.sha || '';
    if (!headSha) {
      return res.status(500).json({ error: '입력 파일 커밋 SHA를 확인할 수 없습니다.' });
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
        body: JSON.stringify({
          ref: BRANCH,
          // 웹앱 제출은 사용자가 올린 input.xlsx를 실제 조회한다.
          inputs: { input_file: 'input.xlsx', prepare_only: 'false' },
        }),
      }
    );

    if (!dispatchRes.ok) {
      const err = await dispatchRes.text();
      return res.status(500).json({ error: `Actions 트리거 실패: ${err}` });
    }

    return res.status(200).json({
      ok: true,
      message: '조회 시작됨',
      branch: BRANCH,
      headSha,
      queuedAt: new Date().toISOString(),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
