/**
 * GET /api/court-search-status
 * GitHub Actions 실행 상태 반환.
 * headSha가 있으면 해당 입력 커밋에서 시작한 실행만 찾는다.
 */

export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';
  const BRANCH = process.env.GITHUB_BRANCH || 'main';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });
  }

  try {
    const querySha = String(req.query?.headSha || '').trim();
    const params = new URLSearchParams({ branch: BRANCH, event: 'workflow_dispatch', per_page: '20' });
    const runsRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/court_search.yml/runs?${params}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!runsRes.ok) {
      return res.status(500).json({ error: '실행 목록 조회 실패' });
    }

    const data = await runsRes.json();
    const runs = data.workflow_runs || [];
    const run = querySha
      ? runs.find((candidate) => candidate.head_sha === querySha)
      : runs[0];

    if (!run) {
      return res.status(200).json({
        status: querySha ? 'waiting' : 'none',
        conclusion: null,
        headSha: querySha || null,
        message: querySha ? 'Actions 실행을 기다리는 중' : '실행 이력 없음',
      });
    }

    // status: queued | in_progress | completed
    // conclusion: success | failure | cancelled | null
    return res.status(200).json({
      status: run.status,
      conclusion: run.conclusion,
      runId: run.id,
      runUrl: run.html_url,
      headSha: run.head_sha,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
