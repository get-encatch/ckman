package backup

import (
	"testing"

	"github.com/housepower/ckman/model"
)

func nativeRun(id, base, status string, shards int) model.BackupRun {
	return model.BackupRun{RunID: id, Native: true, BaseRunID: base, Status: status,
		Operation: model.OP_BACKUP, NativeShards: shards}
}

func TestPickNativeBase(t *testing.T) {
	ok := model.BACKUP_STATUS_SUCCESS
	cases := []struct {
		name string
		runs []model.BackupRun // newest first
		want string
	}{
		{"first run is full", nil, ""},
		{"builds on newest success", []model.BackupRun{
			nativeRun("r2", "r1", ok, 2), nativeRun("r1", "", ok, 2)}, "r2"},
		{"skips failed runs", []model.BackupRun{
			nativeRun("r3", "r2", model.BACKUP_STATUS_FAILED, 2), nativeRun("r2", "r1", ok, 2), nativeRun("r1", "", ok, 2)}, "r2"},
		{"full again once the chain is long enough", []model.BackupRun{
			nativeRun("r3", "r2", ok, 2), nativeRun("r2", "r1", ok, 2), nativeRun("r1", "", ok, 2)}, ""},
		{"chain counts from the last full only", []model.BackupRun{
			nativeRun("r5", "r4", ok, 2), nativeRun("r4", "", ok, 2), nativeRun("r3", "r2", ok, 2), nativeRun("r2", "r1", ok, 2)}, "r5"},
		{"full when the shard count changed", []model.BackupRun{
			nativeRun("r1", "", ok, 1)}, ""},
		{"ignores per-partition runs", []model.BackupRun{
			{RunID: "p1", Status: ok, Operation: model.OP_BACKUP}}, ""},
	}
	for _, c := range cases {
		if got := pickNativeBase(c.runs, "self", 2, 3); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestResolveRunPartitions_FillsPartitionIDs(t *testing.T) {
	e := &Executor{
		conns: []*shardConn{{host: "h1", shard: 1}},
		listAllPartitions: func(*shardConn, string, string) ([]string, error) {
			return []string{"tuple()"}, nil
		},
		partitionIDs: func(*shardConn, string, string) (map[string]string, error) {
			return map[string]string{"tuple()": "all"}, nil
		},
	}
	r := model.BackupRun{Operation: model.OP_BACKUP}
	policy := model.BackupPolicy{BackupStyle: model.BACKUP_STYLE_FULL, Database: "d", Table: "t"}
	if err := e.resolveRunPartitions(&r, policy); err != nil {
		t.Fatal(err)
	}
	if len(r.Partitions) != 1 || r.Partitions[0].PartitionID != "all" || r.Partitions[0].KeySegment() != "all" {
		t.Fatalf("unpartitioned table should be addressed as partition ID all: %+v", r.Partitions)
	}
}

func TestResolveRunPartitions_Native(t *testing.T) {
	e := &Executor{
		conns: []*shardConn{{host: "h1", shard: 1}, {host: "h3", shard: 2}},
		nativeInventory: func(*shardConn, string, string) ([]model.BackupRunPartition, error) {
			return []model.BackupRunPartition{{Partition: "20261007", PartitionID: "20261007", Rows: 10}}, nil
		},
		policyRuns: func(string) ([]model.BackupRun, error) {
			return []model.BackupRun{nativeRun("prev", "", model.BACKUP_STATUS_SUCCESS, 2)}, nil
		},
	}
	r := model.BackupRun{RunID: "new", Operation: model.OP_BACKUP}
	policy := model.BackupPolicy{BackupStyle: model.BACKUP_STYLE_NATIVE, Database: "d", Table: "t"}
	if err := e.resolveRunPartitions(&r, policy); err != nil {
		t.Fatal(err)
	}
	if !r.Native || r.BaseRunID != "prev" || len(r.Partitions) != 1 {
		t.Fatalf("expected native run chained on prev: %+v", r)
	}
}

func TestValidateNativeOptions(t *testing.T) {
	if err := validateNativeOptions(model.BACKUP_STYLE_NATIVE, true, false, 0); err == nil {
		t.Error("clean must be rejected for native backups")
	}
	if err := validateNativeOptions(model.BACKUP_STYLE_NATIVE, false, true, 0); err == nil {
		t.Error("checksum must be rejected for native backups")
	}
	if err := validateNativeOptions(model.BACKUP_STYLE_FULL, true, true, 0); err != nil {
		t.Errorf("per-partition options must stay allowed: %v", err)
	}
	if err := validateNativeOptions(model.BACKUP_STYLE_NATIVE, false, false, -1); err == nil {
		t.Error("negative full_every must be rejected")
	}
}
