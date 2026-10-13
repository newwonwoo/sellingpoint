import unittest

from connection_probe import classify_probe


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


if __name__ == '__main__':
    unittest.main()
