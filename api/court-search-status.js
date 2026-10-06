/**
 * GET /api/court-search-status
 * 가장 최근 GitHub Actions 실행 상태 반환
 */

export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = 'newwonwoo/sellingpoint';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });
  }

  try {
    const runsRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/court_search.yml/runs?per_page=1`,
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
    const run = data.workflow_runs?.[0];

    if (!run) {
      return res.status(200).json({ status: 'none', message: '실행 이력 없음' });
    }

    // status: queued | in_progress | completed
    // conclusion: success | failure | cancelled | null
    return res.status(200).json({
      status: run.status,
      conclusion: run.conclusion,
      runId: run.id,
      runUrl: run.html_url,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
