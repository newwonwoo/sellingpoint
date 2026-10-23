import unittest
from unittest.mock import patch

from connection_probe import classify_probe, classify_page, diagnose, probe


class ProbeClassificationTests(unittest.TestCase):
    def test_browser_success_is_authoritative_when_direct_transport_fails(self):
        classification = classify_probe(
            False,
            {'page_loaded': True, 'classification': 'HEALTHY'},
            True,
        )

        self.assertEqual(classification, 'HEALTHY')

    def test_loaded_page_structure_change_has_priority_over_transport_probe(self):
        classification = classify_probe(
            False,
            {'page_loaded': True, 'classification': 'FORM_CHANGED'},
            False,
        )

        self.assertEqual(classification, 'FORM_CHANGED')

    def test_unloaded_browser_and_transport_failure_is_network_error(self):
        classification = classify_probe(
            False,
            {
                'page_loaded': False,
                'classification': 'BROWSER_CONNECTION_ERROR',
            },
            False,
        )

        self.assertEqual(classification, 'NETWORK_ERROR')

    def test_http_failures_are_not_structure_changes(self):
        for status, expected in [(403, 'ACCESS_DENIED'), (429, 'RATE_LIMITED'), (503, 'SERVER_ERROR')]:
            with self.subTest(status=status):
                self.assertEqual(classify_probe(False, {}, False, {'http': {'status': status}}), expected)

    def test_environment_error_is_not_a_network_error(self):
        self.assertEqual(classify_probe(False, {'classification': 'BROWSER_ENVIRONMENT_ERROR'}, False), 'BROWSER_ENVIRONMENT_ERROR')

    def test_partial_or_error_page_is_not_a_structure_change(self):
        self.assertEqual(classify_page({'appMarker': False}, []), 'PAGE_UNAVAILABLE')
        self.assertEqual(classify_page({'appMarker': True}, [{'error': 'net::ERR_CONNECTION_RESET'}]), 'PAGE_UNAVAILABLE')
        self.assertEqual(classify_page({'appMarker': True}, [{'status': 403}]), 'ACCESS_DENIED')
        self.assertEqual(classify_page({'appMarker': True}, []), 'PAGE_UNAVAILABLE')
        self.assertEqual(classify_page({'appMarker': True, 'resolved': {'court': {}}}, []), 'FORM_CHANGED')
        self.assertEqual(classify_page({'formOk': True}, []), 'CAPTCHA_CHANGED')
        self.assertEqual(classify_page({'formOk': True, 'captchaOk': True}, [{'status': 404}]), 'HEALTHY')


def transport(ok=False, status=None):
    return {'dns': {'ok': True}, 'tcp': {'ok': ok}, 'tls': {},
            'http': {'ok': ok, 'status': status} if status else {}, 'runner': {}}, ok


class RetryTests(unittest.TestCase):
    def setUp(self):
        self.ip = patch('connection_probe.discover_public_ip', return_value='test-ip').start()
        self.transport = patch('connection_probe.probe').start()
        self.browser = patch('connection_probe.probe_browser').start()
        self.sleep = patch('connection_probe.time.sleep').start()
        self.addCleanup(patch.stopall)

    def test_transient_failure_then_recovery_preserves_history(self):
        self.transport.side_effect = [transport(), transport(True, 200)]
        self.browser.side_effect = [({'classification': 'BROWSER_CONNECTION_ERROR'}, False), ({'classification': 'HEALTHY'}, True)]
        report = diagnose('https://court.example/', 12, 30, attempts=3)
        self.assertEqual(report['classification'], 'HEALTHY')
        self.assertEqual(report['attempt_count'], 2)
        self.assertEqual(report['attempts'][0]['failure_stage'], 'tcp')
        self.assertNotIn('attempts', report['attempts'][-1])
        self.sleep.assert_called_once_with(5)

    def test_persistent_failure_is_bounded_and_records_control(self):
        self.transport.side_effect = [transport(), transport(), transport(), transport(True, 200)]
        self.browser.return_value = ({'classification': 'BROWSER_CONNECTION_ERROR'}, False)
        report = diagnose('https://court.example/', 12, 30, attempts=3)
        self.assertEqual(report['classification'], 'NETWORK_ERROR')
        self.assertEqual(report['attempt_count'], 3)
        self.assertEqual([c.args[0] for c in self.sleep.call_args_list], [5, 10])
        self.assertEqual(self.browser.call_count, 3)
        self.assertEqual(report['network_diagnosis']['scope'], 'target_path_failure')
        self.assertFalse(report['network_diagnosis']['cause_confirmed'])
        self.assertEqual(self.transport.call_args.args[0], 'https://github.com/')

    def test_failed_control_does_not_claim_proven_runner_failure(self):
        self.transport.side_effect = [transport(), transport()]
        self.browser.return_value = ({'classification': 'BROWSER_CONNECTION_ERROR'}, False)
        report = diagnose('https://court.example/', 12, 30)
        self.assertEqual(report['network_diagnosis']['scope'], 'runner_or_shared_path_failure')
        self.assertFalse(report['network_diagnosis']['cause_confirmed'])

    def test_restrictions_stop_without_browser_or_retry(self):
        for status, expected in [(403, 'ACCESS_DENIED'), (429, 'RATE_LIMITED')]:
            with self.subTest(status=status):
                self.transport.return_value = transport(False, status)
                report = diagnose('https://court.example/', 12, 30, attempts=3)
                self.assertEqual(report['classification'], expected)
                self.assertEqual(report['attempt_count'], 1)
                self.browser.assert_not_called()
                self.sleep.assert_not_called()

    def test_browser_restriction_or_structure_change_is_not_retried(self):
        for classification in ['ACCESS_DENIED', 'RATE_LIMITED', 'FORM_CHANGED', 'CAPTCHA_CHANGED', 'BROWSER_ENVIRONMENT_ERROR']:
            with self.subTest(classification=classification):
                self.transport.return_value = transport(True, 200)
                self.browser.return_value = ({'classification': classification, 'page_loaded': True}, False)
                report = diagnose('https://court.example/', 12, 30, attempts=3)
                self.assertEqual(report['classification'], classification)
                self.assertEqual(report['attempt_count'], 1)
                self.sleep.assert_not_called()

    def test_server_retry_after_prevents_early_retry(self):
        self.transport.return_value = transport(False, 503)
        self.browser.return_value = ({'classification': 'SERVER_ERROR', 'retry_after': '120'}, False)
        report = diagnose('https://court.example/', 12, 30, attempts=3)
        self.assertEqual(report['classification'], 'SERVER_ERROR')
        self.assertEqual(report['retry_suppressed'], 'server_retry_after')
        self.assertEqual(report['attempt_count'], 1)
        self.sleep.assert_not_called()


class TransportEvidenceTests(unittest.TestCase):
    @patch('connection_probe.http.client.HTTPSConnection')
    @patch('connection_probe.ssl.create_default_context')
    @patch('connection_probe.socket.create_connection')
    @patch('connection_probe.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('203.0.113.1', 443))])
    def test_restriction_status_does_not_wait_for_response_body(self, dns, tcp, tls, http):
        tls.return_value.wrap_socket.return_value.__enter__.return_value.version.return_value = 'TLSv1.3'
        response = http.return_value.getresponse.return_value
        response.status = 429
        response.getheader.return_value = '120'
        response.read.side_effect = TimeoutError('slow body')
        report, ok = probe('https://court.example/', 12, include_public_ip=False)
        self.assertFalse(ok)
        self.assertEqual(report['http']['status'], 429)
        self.assertEqual(report['http']['retry_after'], '120')
        response.read.assert_not_called()

    @patch('connection_probe.socket.create_connection', side_effect=TimeoutError('timed out'))
    @patch('connection_probe.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('203.0.113.1', 443))])
    def test_tcp_timeout_preserves_stage_error_and_does_not_attempt_tls(self, dns, tcp):
        report, ok = probe('https://court.example/', 12, include_public_ip=False)
        self.assertFalse(ok)
        self.assertEqual(report['tcp']['error_type'], 'TimeoutError')
        self.assertIn('elapsed_ms', report['tcp'])
        self.assertEqual(report['tls'], {})
        self.assertEqual(report['http'], {})
        tcp.assert_called_once_with(('court.example', 443), timeout=12)


if __name__ == '__main__':
    unittest.main()
