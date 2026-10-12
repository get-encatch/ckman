package backup

import (
	"strings"
	"testing"
)

func order(cands []candidate) string {
	var hosts []string
	for _, c := range cands {
		hosts = append(hosts, c.host)
	}
	return strings.Join(hosts, ",")
}

func TestRankCandidates(t *testing.T) {
	cases := []struct {
		name       string
		replicated bool
		cands      []candidate
		want       string
	}{
		{"read-only replica goes last", true, []candidate{
			{host: "a", pos: 0, readonly: true}, {host: "b", pos: 1}}, "b,a"},
		{"preferred zone beats less busy", true, []candidate{
			{host: "a", pos: 0, busy: 0}, {host: "b", pos: 1, busy: 5, inZone: true}}, "b,a"},
		{"less delay, then less busy", true, []candidate{
			{host: "a", pos: 0, delay: 30}, {host: "b", pos: 1, delay: 0, busy: 9}, {host: "c", pos: 2, delay: 0, busy: 1}}, "c,b,a"},
		{"unreplicated: the replica with the rows", false, []candidate{
			{host: "a", pos: 0, rows: 0, inZone: true}, {host: "b", pos: 1, rows: 1000}}, "b,a"},
		{"all equal: list order", true, []candidate{
			{host: "a", pos: 0}, {host: "b", pos: 1}}, "a,b"},
	}
	for _, c := range cases {
		rankCandidates(c.cands, c.replicated)
		if got := order(c.cands); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}

func TestPickNote(t *testing.T) {
	cands := []candidate{{host: "b", pos: 1, rows: 900}, {host: "a", pos: 0, rows: 100}}
	if n := pickNote(cands, false, ""); !strings.Contains(n, "isn't replicated") || !strings.Contains(n, "different rows") {
		t.Errorf("unreplicated note: %q", n)
	}
	cands = []candidate{{host: "b", pos: 1, inZone: true}, {host: "a", pos: 0, readonly: true}}
	if n := pickNote(cands, true, "zone-b"); !strings.Contains(n, "a is read-only") || !strings.Contains(n, "zone zone-b") {
		t.Errorf("note: %q", n)
	}
	if n := pickNote([]candidate{{host: "a"}}, true, ""); n != "" {
		t.Errorf("plain pick has a note: %q", n)
	}
}
