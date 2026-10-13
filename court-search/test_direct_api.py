import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name('search.py')
SPEC = importlib.util.spec_from_file_location('court_search_direct_api', MODULE_PATH)
SEARCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SEARCH)


class DirectApiParserTests(unittest.TestCase):
    def test_structured_response_matches_existing_output_shape(self):
        basic = {
            'data': {
                'dma_csBasCtt': {
                    'csNm': '부동산인도명령',
                    'lwstDvsCd': '2',
                    'jdbnNm': '경매1계',
                    'ultmtJdbnNm': '경매4계',
                    'telNo': '02-2192-1334',
                    'csPrsrvYn': 'N',
                    'csRcptYmd': '20260821',
                    'csUltmtYmd': '20260825',
                    'csUltmtDvsNm': '인용',
                    'dcsnstDlvrYmd': '20260828',
                    'csCfmtnYmd': '',
                },
                'dlt_reltCsLst': [{
                    'reltCsCortNm': '서울남부지방법원',
                    'userCsNo': '2025타경11726',
                }],
                'dlt_btprtCttLst': [
                    {'btprtDvsNm': '신청인', 'btprtNm': '1. 주OOOO'},
                    {'btprtDvsNm': '피신청인', 'btprtNm': '1. 김OO'},
                ],
            }
        }
        progress = {
            'data': {
                'dlt_csProgCtt': [
                    {'progYmd': '20260821', 'progCtt': '신청서접수'},
                    {'progYmd': '20260825', 'progCtt': '결정'},
                    {
                        'progYmd': '20260828',
                        'progCtt': '결정정본 송달',
                        'progRslt': '2026.08.28 도달',
                        'progCttDvs': '4',
                        'pntcImg': '/ssgo/cm/images/common/ic_viewer.png',
                    },
                    {'progYmd': '20260829', 'progCtt': '확정'},
                ]
            }
        }

        result = SEARCH.parse_direct_api_result(
            basic,
            progress,
            '서울남부지방법원',
            '2026타인3944',
        )

        self.assertEqual(result['사건명'], '[전자]부동산인도명령')
        self.assertEqual(result['재판부'], '경매4계 (전화:02-2192-1334)')
        self.assertEqual(result['접수일'], '2026.08.21')
        self.assertEqual(result['종국결과'], '2026.08.25 인용')
        self.assertEqual(result['결정문송달일'], '2026.08.28')
        self.assertEqual(result['관련사건_번호'], '2025타경11726')
        self.assertEqual(result['신청인'], '1. 주OOOO')
        self.assertEqual(result['피신청인'], '1. 김OO')
        self.assertEqual(result['진행_1내용'], '확정')
        self.assertEqual(result['진행_2내용'], '결정정본 송달')
        self.assertEqual(result['진행_2결과'], "위의 '확인' 항목 체크")
        self.assertEqual(result['진행_2공시문'], '있음')
        self.assertEqual(result['진행_3내용'], '결정')

    def test_basic_table_pairs_keep_labels_aligned_across_empty_values(self):
        pairs = SEARCH.table_pairs([[
            '사건번호', '2026타인3944',
            '결정문송달일', '',
            '확정일', '',
        ]])

        self.assertEqual(pairs['사건번호'], '2026타인3944')
        self.assertNotIn('결정문송달일', pairs)
        self.assertNotIn('확정일', pairs)


if __name__ == '__main__':
    unittest.main()
