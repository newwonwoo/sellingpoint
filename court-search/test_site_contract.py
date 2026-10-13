import unittest

from site_contract import (
    json_schema_snapshot,
    selector_union,
    validate_direct_payloads,
)


def valid_payloads():
    basic = {
        'status': 200,
        'data': {
            'dma_csBasCtt': {
                'userCsNo': '2026타인3944',
                'csNm': '부동산인도명령',
                'lwstDvsCd': '2',
                'jdbnNm': '경매4계',
                'csRcptYmd': '20260821',
                'csUltmtYmd': '20260825',
            },
            'dlt_reltCsLst': [],
            'dlt_btprtCttLst': [],
        },
    }
    progress = {
        'status': 200,
        'data': {
            'dlt_csProgCtt': [
                {'progYmd': '20260825', 'progCtt': '결정', 'progRslt': ''},
            ],
        },
    }
    return basic, progress


class SiteContractTests(unittest.TestCase):
    def test_valid_direct_contract(self):
        basic, progress = valid_payloads()
        result = validate_direct_payloads(
            basic, progress, '2026타인3944'
        )

        self.assertTrue(result['ok'])
        self.assertEqual(result['errors'], [])
        self.assertEqual(len(result['fingerprint']), 16)

    def test_changed_basic_keys_are_rejected(self):
        basic, progress = valid_payloads()
        basic['data']['renamedCaseBlock'] = basic['data'].pop('dma_csBasCtt')

        result = validate_direct_payloads(
            basic, progress, '2026타인3944'
        )

        self.assertFalse(result['ok'])
        self.assertIn('basic_case_block_missing', result['errors'])

    def test_missing_progress_contract_is_rejected(self):
        basic, progress = valid_payloads()
        progress['data']['renamedProgress'] = progress['data'].pop(
            'dlt_csProgCtt'
        )

        result = validate_direct_payloads(
            basic, progress, '2026타인3944'
        )

        self.assertFalse(result['ok'])
        self.assertIn('progress_list_missing', result['errors'])

    def test_mismatched_case_number_is_rejected(self):
        basic, progress = valid_payloads()
        basic['data']['dma_csBasCtt']['userCsNo'] = '2026타인9999'

        result = validate_direct_payloads(
            basic, progress, '2026타인3944'
        )

        self.assertFalse(result['ok'])
        self.assertIn('case_number_mismatch', result['errors'])

    def test_schema_snapshot_does_not_store_values(self):
        snapshot = json_schema_snapshot({
            'btprtNm': '주택도시보증공사',
            'rows': [{'secret': 'masked-name'}],
        })
        rendered = repr(snapshot)

        self.assertNotIn('주택도시보증공사', rendered)
        self.assertNotIn('masked-name', rendered)
        self.assertIn('btprtNm', rendered)

    def test_selector_union_includes_semantic_marker_and_suffix(self):
        selector = selector_union('court')

        self.assertIn('data-court-search-role="court"', selector)
        self.assertIn('id$="_sbx_cortCd"', selector)


if __name__ == '__main__':
    unittest.main()
