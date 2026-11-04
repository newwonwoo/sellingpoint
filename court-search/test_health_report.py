import unittest

from health_report import build_report


HEALTHY = {'success': True, 'classification': 'HEALTHY'}
VALID = {'results': [{'사건번호': '2026타인3944', '사건명': '[전자]부동산인도명령'}]}


class HealthReportTests(unittest.TestCase):
    def test_healthy_requires_successful_diagnosis_lookup_and_expected_case(self):
        report = build_report(HEALTHY, 'success', 'success', VALID, [])
        self.assertEqual(report['status'], 'healthy')

    def test_failed_preflight_does_not_become_structure_changed(self):
        for classification in ['NETWORK_ERROR', 'ACCESS_DENIED', 'RATE_LIMITED', 'PAGE_UNAVAILABLE', 'BROWSER_ENVIRONMENT_ERROR']:
            with self.subTest(classification=classification):
                report = build_report({'classification': classification}, 'failure', 'skipped', {}, [])
                self.assertEqual(report['status'], 'unavailable')
                self.assertEqual(report['classification'], classification)

    def test_no_result_crash_captcha_or_timeout_is_not_structure_evidence(self):
        for outcome, result, expected in [
            ('failure', {}, 'LOOKUP_UNAVAILABLE'),
            ('success', {}, 'LOOKUP_UNAVAILABLE'),
            ('success', {'results': [{'사건명': '조회실패: 법원 사이트 연결 실패'}]}, 'NETWORK_ERROR'),
            ('success', {'results': [{'사건명': '조회실패: 결과 화면 대기 단계 시간 초과'}]}, 'LOOKUP_TIMEOUT'),
            ('success', {'results': [{'사건명': '조회실패: 캡차 인식 실패'}]}, 'LOOKUP_UNAVAILABLE'),
            ('success', {'results': [{'사건번호': '2026타인3944', '사건명': '사건없음'}]}, 'CANARY_MISMATCH'),
        ]:
            with self.subTest(expected=expected):
                report = build_report(HEALTHY, 'success', outcome, result, [])
                self.assertEqual(report['status'], 'unavailable')
                self.assertEqual(report['classification'], expected)

    def test_explicit_contract_evidence_can_report_structure_change(self):
        for classification in ['API_CHANGED', 'RESULT_CHANGED']:
            with self.subTest(classification=classification):
                report = build_report(HEALTHY, 'success', 'success', {}, [{'classification': classification}])
                self.assertEqual(report['status'], 'structure_changed')
                self.assertEqual(report['classification'], classification)

    def test_lookup_form_event_without_loading_evidence_is_inconclusive(self):
        for classification in ['FORM_CHANGED', 'CAPTCHA_CHANGED', 'RESULT_PAGE_UNRECOGNIZED']:
            report = build_report(HEALTHY, 'success', 'success', {}, [{'classification': classification}])
            self.assertEqual(report['status'], 'unavailable')
            self.assertEqual(report['classification'], 'LOOKUP_UNAVAILABLE')

    def test_preflight_confirmed_form_changes_remain_structure_changes(self):
        for classification in ['FORM_CHANGED', 'CAPTCHA_CHANGED']:
            report = build_report({'classification': classification}, 'failure', 'skipped', {}, [])
            self.assertEqual(report['status'], 'structure_changed')

    def test_protocol_failure_takes_priority_over_result_unrecognized(self):
        for status, expected in [(0, 'NETWORK_ERROR'), (403, 'ACCESS_DENIED'), (429, 'RATE_LIMITED'), (503, 'SERVER_ERROR'), (200, 'LOOKUP_UNAVAILABLE')]:
            with self.subTest(status=status):
                events = [{'classification': 'API_PROTOCOL_ERROR', 'details': {'http_status': status}}, {'classification': 'RESULT_PAGE_UNRECOGNIZED'}]
                report = build_report(HEALTHY, 'success', 'success', {}, events)
                self.assertEqual(report['status'], 'unavailable')
                self.assertEqual(report['classification'], expected)

    def test_successful_fallback_is_healthy_despite_earlier_protocol_error(self):
        report = build_report(HEALTHY, 'success', 'success', VALID, [{'classification': 'API_PROTOCOL_ERROR'}])
        self.assertEqual(report['status'], 'healthy')

    def test_missing_diagnosis_never_uses_leftover_success_as_healthy(self):
        report = build_report({}, 'failure', 'success', VALID, [])
        self.assertEqual(report['status'], 'unavailable')
        self.assertEqual(report['classification'], 'DIAGNOSIS_UNAVAILABLE')


    def test_i0002_is_reported_as_missing_case_not_server_error(self):
        expected = [{'court': '서울남부지방법원', 'case_no': '2026타인0001'}]
        result = {'results': [{'사건번호': '2026타인0001', '사건명': '사건없음'}]}
        event_shapes = [
            {'classification': 'API_CASE_NOT_FOUND', 'details': {'error_code': 'I_0002'}},
            {'classification': 'API_PROTOCOL_ERROR', 'details': {'http_status': 550, 'error_code': 'I_0002'}},
        ]

        for event in event_shapes:
            with self.subTest(event=event['classification']):
                report = build_report(
                    HEALTHY, 'success', 'success', result, [event], '',
                    expected_cases=expected,
                )
                self.assertEqual(report['status'], 'unavailable')
                self.assertEqual(report['classification'], 'CANARY_CASE_NOT_FOUND')
                self.assertEqual(report['canary']['attemptedCount'], 1)
                self.assertEqual(report['canary']['failedCount'], 1)

    def test_deferred_cases_are_not_counted_as_attempted_failures(self):
        expected = [
            {'court': '서울남부지방법원', 'case_no': f'2026타인{i:04d}'}
            for i in range(1, 11)
        ]
        rows = [
            {'사건번호': expected[0]['case_no'], '사건명': '조회실패: 구조변경'},
            {'사건번호': expected[1]['case_no'], '사건명': '사건없음'},
        ]
        rows.extend(
            {'사건번호': case['case_no'], '사건명': '조회보류: 구조변경 차단기'}
            for case in expected[2:]
        )

        report = build_report(
            HEALTHY, 'success', 'success', {'results': rows}, [], '',
            expected_cases=expected,
        )

        self.assertEqual(report['canary']['expectedCount'], 10)
        self.assertEqual(report['canary']['returnedCount'], 10)
        self.assertEqual(report['canary']['attemptedCount'], 2)
        self.assertEqual(report['canary']['notAttemptedCount'], 8)
        self.assertEqual(report['canary']['failedCount'], 2)
        self.assertEqual(report['canary']['notReturnedCount'], 0)


if __name__ == '__main__':
    unittest.main()
