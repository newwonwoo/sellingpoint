import unittest
from unittest.mock import patch

from PIL import Image

import captcha_solver


class FakeReader:
    def __init__(self, answers):
        self.answers = iter(answers)
        self.calls = 0

    def recognize(self, *_args, **_kwargs):
        self.calls += 1
        answer, confidence = next(self.answers)
        if answer is None:
            return []
        return [(None, answer, confidence)]


class FastCaptchaTests(unittest.TestCase):
    def setUp(self):
        self.variants = [Image.new('L', (120, 46), 255) for _ in range(4)]

    def test_stops_after_three_high_confidence_votes(self):
        reader = FakeReader([
            ('123456', 0.91),
            ('123456', 0.88),
            ('123456', 0.93),
            ('654321', 0.99),
        ])
        with patch.object(captcha_solver, 'FAST_PATH_MIN_VOTES', 3), patch.object(
            captcha_solver, 'FAST_PATH_MIN_CONFIDENCE', 0.55
        ):
            answer = captcha_solver._predict_fast(reader, self.variants)
        self.assertEqual(answer, '123456')
        self.assertEqual(reader.calls, 3)

    def test_uncertain_votes_fall_back(self):
        reader = FakeReader([
            ('123456', 0.91),
            ('654321', 0.88),
            ('123456', 0.40),
            (None, 0.0),
        ])
        with patch.object(captcha_solver, 'FAST_PATH_MIN_VOTES', 3), patch.object(
            captcha_solver, 'FAST_PATH_MIN_CONFIDENCE', 0.55
        ):
            answer = captcha_solver._predict_fast(reader, self.variants)
        self.assertIsNone(answer)
        self.assertEqual(reader.calls, 4)


if __name__ == '__main__':
    unittest.main()
