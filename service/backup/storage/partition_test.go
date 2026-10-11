package storage

import (
	"strings"
	"testing"

	"github.com/housepower/ckman/model"
)

func TestPartitionClause(t *testing.T) {
	cases := []struct{ name, id, want string }{
		{"20261007", "20261007", " PARTITION ID '20261007'"},
		{"tuple()", "all", ""}, // unpartitioned table: whole table, no clause
		{"(202610,'eu')", "3c2d5f0e1b", " PARTITION ID '3c2d5f0e1b'"},
		{"20261007", "", " PARTITION '20261007'"}, // legacy run without an ID
		{"all", "", ""},
	}
	for _, c := range cases {
		if got := PartitionClause(c.name, c.id); got != c.want {
			t.Errorf("PartitionClause(%q, %q) = %q, want %q", c.name, c.id, got, c.want)
		}
	}
}

func TestPartitionsClause(t *testing.T) {
	if got := PartitionsClause([]string{"20261007", "20261008"}); got != " PARTITIONS ID '20261007', ID '20261008'" {
		t.Errorf("got %q", got)
	}
	if got := PartitionsClause([]string{"all"}); got != "" {
		t.Errorf("unpartitioned table should restore whole table, got %q", got)
	}
	if got := PartitionsClause(nil); got != "" {
		t.Errorf("empty list should restore whole table, got %q", got)
	}
}

func TestJoinNativeKey(t *testing.T) {
	if got := JoinNativeKey("/lab/", "demo", "events", "run1", 2); got != "lab/native/demo.events/run1/shard2" {
		t.Errorf("got %q", got)
	}
	if got := JoinNativeKey("", "demo", "events", "run1", 1); got != "native/demo.events/run1/shard1" {
		t.Errorf("got %q", got)
	}
}

func TestS3_NativeBackupSQL(t *testing.T) {
	s := NewS3(model.TargetS3{Endpoint: "http://s3:9000/", Bucket: "b", AccessKeyID: "AK", SecretAccessKey: "SK"}, "zstd")
	full := s.NativeBackupSQL("lab/native/d.t/r1/shard1", "")
	if !strings.HasPrefix(full, " TO S3('http://s3:9000/b/lab/native/d.t/r1/shard1', 'AK', 'SK')") {
		t.Errorf("unexpected full backup sql: %s", full)
	}
	if strings.Contains(full, "base_backup") || strings.Contains(full, "deduplicate_files") {
		t.Errorf("full native backup must not set base_backup or disable dedup: %s", full)
	}
	incr := s.NativeBackupSQL("lab/native/d.t/r2/shard1", "lab/native/d.t/r1/shard1")
	if !strings.Contains(incr, "base_backup = S3('http://s3:9000/b/lab/native/d.t/r1/shard1', 'AK', 'SK')") {
		t.Errorf("incremental native backup must point at its base: %s", incr)
	}
	restore := s.NativeRestoreSQL([]string{"20261007"}, "lab/native/d.t/r2/shard1")
	if restore != " PARTITIONS ID '20261007' FROM S3('http://s3:9000/b/lab/native/d.t/r2/shard1', 'AK', 'SK')" {
		t.Errorf("unexpected restore sql: %s", restore)
	}
}

func TestLocal_NativeBackupSQL(t *testing.T) {
	l := NewLocal(model.TargetLocal{Path: "/backup"}, "", nil)
	if got := l.NativeBackupSQL("k2", "k1"); !strings.Contains(got, "TO File('/backup/k2')") || !strings.Contains(got, "base_backup = File('/backup/k1')") {
		t.Errorf("unexpected local native sql: %s", got)
	}
}
