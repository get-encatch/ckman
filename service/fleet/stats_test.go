package fleet

import "testing"

func TestParseSize(t *testing.T) {
	cases := map[string]uint64{
		"12MiB":  12 << 20,
		"1.5GiB": 3 << 29,
		"800kB":  800000,
		"3B":     3,
		" 2GiB ": 2 << 30,
		"0B":     0,
		"bogus":  0,
	}
	for in, want := range cases {
		if got := parseSize(in); got != want {
			t.Errorf("parseSize(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestCPUBusy(t *testing.T) {
	if got := cpuBusy([]string{"100", "900", "150", "1000"}); got < 0.33 || got > 0.34 {
		t.Errorf("50 busy of 150 ticks: got %v", got)
	}
	if got := cpuBusy([]string{"1", "2"}); got != 0 {
		t.Errorf("short sample: got %v", got)
	}
}
