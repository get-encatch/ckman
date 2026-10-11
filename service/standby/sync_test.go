package standby

import "testing"

func TestStandbyDDL(t *testing.T) {
	cases := []struct{ in, want string }{
		{
			"CREATE TABLE demo.events (`ts` DateTime) ENGINE = ReplicatedMergeTree ORDER BY ts",
			"CREATE TABLE IF NOT EXISTS demo.events ON CLUSTER `c_dr` (`ts` DateTime) ENGINE = ReplicatedMergeTree ORDER BY ts",
		},
		{
			"CREATE TABLE demo.events_all (`ts` DateTime) ENGINE = Distributed('c', 'demo', 'events', rand())",
			"CREATE TABLE IF NOT EXISTS demo.events_all ON CLUSTER `c_dr` (`ts` DateTime) ENGINE = Distributed('c_dr', 'demo', 'events', rand())",
		},
		{
			"CREATE MATERIALIZED VIEW demo.mv TO demo.daily AS SELECT 1",
			"CREATE MATERIALIZED VIEW IF NOT EXISTS demo.mv ON CLUSTER `c_dr` TO demo.daily AS SELECT 1",
		},
		{
			"CREATE VIEW demo.v AS SELECT * FROM demo.events_all",
			"CREATE VIEW IF NOT EXISTS demo.v ON CLUSTER `c_dr` AS SELECT * FROM demo.events_all",
		},
	}
	for _, c := range cases {
		if got := standbyDDL(c.in, "c", "c_dr"); got != c.want {
			t.Errorf("standbyDDL(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

func TestSQLQuoting(t *testing.T) {
	if got := lit(`a'b\c`); got != `'a\'b\\c'` {
		t.Errorf("lit: %s", got)
	}
	if got := idList([]string{"20261010", "all"}); got != "ID '20261010', ID 'all'" {
		t.Errorf("idList: %s", got)
	}
	if got := ident("db", "t`x"); got != "`db`.`tx`" {
		t.Errorf("ident: %s", got)
	}
}

func TestColumnSpec(t *testing.T) {
	if got := (column{typ: "String"}).spec(); got != "String" {
		t.Errorf("plain: %s", got)
	}
	if got := (column{typ: "LowCardinality(String)", kind: "DEFAULT", expr: "'IN'"}).spec(); got != "LowCardinality(String) DEFAULT 'IN'" {
		t.Errorf("default: %s", got)
	}
}

func TestStagingEngine(t *testing.T) {
	cases := map[string]string{
		"ReplicatedMergeTree('/clickhouse/tables/{cluster}/demo/events/{shard}', '{replica}') PARTITION BY toYYYYMMDD(ts) ORDER BY (user_id, ts) SETTINGS index_granularity = 8192": "MergeTree() PARTITION BY toYYYYMMDD(ts) ORDER BY (user_id, ts) SETTINGS index_granularity = 8192",
		"ReplicatedReplacingMergeTree('/p/{shard}', '{replica}', ver) ORDER BY id":                                                                                                  "ReplacingMergeTree(ver) ORDER BY id",
		"ReplicatedCollapsingMergeTree('/p', 'r', sign) ORDER BY (a, b)":                                                                                                            "CollapsingMergeTree(sign) ORDER BY (a, b)",
		"ReplicatedMergeTree ORDER BY id":                                                 "MergeTree ORDER BY id",
		"ReplicatedGraphiteMergeTree('/p', 'r', 'graphite_rollup') ORDER BY (Path, Time)": "GraphiteMergeTree('graphite_rollup') ORDER BY (Path, Time)",
		"ReplicatedMergeTree('/a,b(c)', 'it\\'s') ORDER BY id":                            "MergeTree() ORDER BY id",
		"MergeTree PARTITION BY d ORDER BY id":                                            "MergeTree PARTITION BY d ORDER BY id",
	}
	for in, want := range cases {
		got, err := stagingEngine(in)
		if err != nil || got != want {
			t.Errorf("stagingEngine(%q)\n got %q, %v\nwant %q", in, got, err, want)
		}
	}
}
