package pricing

import "testing"

func TestLargeOrderGetsDiscount(t *testing.T) {
	if got := Discount(200); got != 180 {
		t.Fatalf("got %d", got)
	}
}

func TestSmallOrderPaysFullPrice(t *testing.T) {
	if got := Discount(50); got != 50 {
		t.Fatalf("got %d", got)
	}
}

func TestClampStaysInRange(t *testing.T) {
	if got := Clamp(15, 0, 10); got != 10 {
		t.Fatalf("got %d", got)
	}
}
