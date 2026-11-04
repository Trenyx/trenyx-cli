//! Prices for the shop.

/// 10% off orders of 100 or more.
pub fn discount(total: i64) -> i64 {
    if total >= 100 {
        return total * 9 / 10;
    }
    total
}

/// Keep value between low and high.
pub fn clamp(value: i64, low: i64, high: i64) -> i64 {
    value.min(high).max(low)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_order_gets_discount() {
        assert_eq!(discount(200), 180);
    }

    #[test]
    fn small_order_pays_full_price() {
        assert_eq!(discount(50), 50);
    }

    #[test]
    fn clamp_stays_in_range() {
        assert_eq!(clamp(15, 0, 10), 10);
    }
}
