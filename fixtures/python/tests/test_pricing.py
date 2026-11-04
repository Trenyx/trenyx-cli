import unittest

from pricing import clamp, discount


class PricingTest(unittest.TestCase):
    def test_large_order_gets_discount(self):
        self.assertEqual(discount(200), 180)

    def test_small_order_pays_full_price(self):
        self.assertEqual(discount(50), 50)

    def test_clamp_stays_in_range(self):
        self.assertEqual(clamp(15, 0, 10), 10)
