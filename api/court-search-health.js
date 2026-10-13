import JSZip from 'jszip';

/** GET /api/court-search-health — 최근 정기 구조 점검 결과 */
export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';
  const BRANCH = process.env.GITHUB_BRANCH || 'main';
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });

  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    const params = new URLSearchParams({ branch: BRANCH, per_page: '10' });
    const runsResponse = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/court_structure_canary.yml/runs?${params}`,
      { headers },
    );
    if (runsResponse.status === 404) {
      return res.status(200).json({
        status: 'unknown',
        message: '정기 구조 점검이 아직 준비되지 않았습니다.',
      });
    }
    if (!runsResponse.ok) {
      return res.status(502).json({ error: '정기 구조 점검 실행 목록 조회 실패' });
    }

    const runs = (await runsResponse.json()).workflow_runs || [];
    const latest = runs[0];
    const completed = runs.find((run) => run.status === 'completed');
    if (!completed) {
      return res.status(200).json({
        status: latest ? 'checking' : 'unknown',
        message: latest ? '정기 구조 점검이 진행 중입니다.' : '정기 구조 점검 이력이 없습니다.',
        runUrl: latest?.html_url || null,
        checkedAt: latest?.run_started_at || null,
      });
    }

    const artifactsResponse = await fetch(
      `https://api.github.com/repos/${REPO}/actions/runs/${completed.id}/artifacts?per_page=100`,
      { headers },
    );
    if (artifactsResponse.ok) {
      const artifacts = (await artifactsResponse.json()).artifacts || [];
      const artifact = artifacts.find((item) => (
        item.name === 'court-structure-health' && !item.expired
      ));
      if (artifact) {
        const zipResponse = await fetch(
          `https://api.github.com/repos/${REPO}/actions/artifacts/${artifact.id}/zip`,
          { headers },
        );
        if (zipResponse.ok) {
          const zip = await JSZip.loadAsync(await zipResponse.arrayBuffer());
          const reportFile = Object.values(zip.files).find((file) => (
            !file.dir && file.name.endsWith('health-report.json')
          ));
          if (reportFile) {
            const report = JSON.parse(await reportFile.async('text'));
            res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
            return res.status(200).json({
              ...report,
              checking: latest?.status !== 'completed',
              runId: completed.id,
              runUrl: report.runUrl || completed.html_url,
            });
          }
        }
      }
    }

    return res.status(200).json({
      status: completed.conclusion === 'success' ? 'healthy' : 'unknown',
      message: completed.conclusion === 'success'
        ? '최근 정기 구조 점검이 정상 완료되었습니다.'
        : '최근 정기 구조 점검이 실패했습니다. 실행 로그를 확인하세요.',
      checkedAt: completed.updated_at,
      runId: completed.id,
      runUrl: completed.html_url,
      checking: latest?.status !== 'completed',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
