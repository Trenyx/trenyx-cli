// Package pricing holds prices for the shop.
package pricing

// Discount takes 10% off orders of 100 or more.
func Discount(total int) int {
	if total >= 100 {
		return total * 9 / 10
	}
	return total
}

// Clamp keeps value between low and high.
func Clamp(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}
