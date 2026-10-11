package backup

import (
	"fmt"
	"testing"
	"time"

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
		if got := pickNativeBase(c.runs, "self", 2, 3, false); got != c.want {
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

func TestPickNativeBase_ForcedFullAndScheduledChains(t *testing.T) {
	ok := model.BACKUP_STATUS_SUCCESS
	runs := []model.BackupRun{nativeRun("r2", "r1", ok, 2), nativeRun("r1", "", ok, 2)}
	if got := pickNativeBase(runs, "self", 2, 0, true); got != "" {
		t.Errorf("a full trigger must start a new chain, got base %q", got)
	}
	long := []model.BackupRun{}
	for i := 9; i >= 1; i-- {
		base := ""
		if i > 1 {
			base = fmt.Sprintf("r%d", i-1)
		}
		long = append(long, nativeRun(fmt.Sprintf("r%d", i), base, ok, 2))
	}
	if got := pickNativeBase(long, "self", 2, 0, false); got != "r9" {
		t.Errorf("with a full schedule there is no chain-length limit, got %q", got)
	}
}

func TestNativeChainsToPrune(t *testing.T) {
	ok := model.BACKUP_STATUS_SUCCESS
	at := func(h int) time.Time { return time.Date(2026, 10, 1, h, 0, 0, 0, time.UTC) }
	mk := func(id, base string, h int) model.BackupRun {
		r := nativeRun(id, base, ok, 2)
		r.StartedAt = at(h)
		return r
	}
	restore := model.BackupRun{RunID: "rs", Native: true, Operation: model.OP_RESTORE, Status: ok, StartedAt: at(1)}
	// newest first: chain C (f3 i5 i4), chain B (f2 i2), chain A (f1)
	runs := []model.BackupRun{mk("i5", "i4", 9), mk("i4", "f3", 8), mk("f3", "", 7), mk("i2", "f2", 5), mk("f2", "", 4), restore, mk("f1", "", 0)}
	got := map[string]bool{}
	for _, r := range nativeChainsToPrune(runs, 2) {
		got[r.RunID] = true
	}
	if len(got) != 1 || !got["f1"] {
		t.Fatalf("keep=2 should prune only chain A (f1), got %v", got)
	}
	if out := nativeChainsToPrune(runs, 5); out != nil {
		t.Fatalf("fewer fulls than keep: nothing to prune, got %v", out)
	}
}

func TestFullBackupDueNow(t *testing.T) {
	p := model.BackupPolicy{BackupStyle: model.BACKUP_STYLE_NATIVE, FullCrontab: "0 0 2 * * *"}
	if !FullBackupDueNow(p, time.Date(2026, 10, 11, 2, 0, 5, 0, time.Local)) {
		t.Error("full schedule fires at 02:00: incremental at 02:00:05 should stand down")
	}
	if FullBackupDueNow(p, time.Date(2026, 10, 11, 3, 0, 0, 0, time.Local)) {
		t.Error("03:00 is not a full-backup time")
	}
}

func TestValidateNativeSchedule(t *testing.T) {
	if err := validateNativeSchedule(model.BACKUP_STYLE_NATIVE, model.BACKUP_SCHEDULED, "0 0 2 * * 0", 4); err != nil {
		t.Errorf("weekly full is valid: %v", err)
	}
	if err := validateNativeSchedule(model.BACKUP_STYLE_FULL, model.BACKUP_SCHEDULED, "0 0 2 * * 0", 0); err == nil {
		t.Error("full_crontab needs native style")
	}
	if err := validateNativeSchedule(model.BACKUP_STYLE_NATIVE, model.BACKUP_SCHEDULED, "* * * * * *", 0); err == nil {
		t.Error("full_crontab must respect the 1h minimum")
	}
	if err := validateNativeSchedule(model.BACKUP_STYLE_NATIVE, model.BACKUP_SCHEDULED, "", -1); err == nil {
		t.Error("negative keep_full must be rejected")
	}
}

func TestScheduler_RegistersFullEntryForNativePolicies(t *testing.T) {
	policies := []model.BackupPolicy{
		{PolicyID: "n1", Crontab: "0 0 * * * *", FullCrontab: "0 0 2 * * 0", BackupStyle: model.BACKUP_STYLE_NATIVE, Enabled: true, ScheduleType: model.BACKUP_SCHEDULED, Instance: "self"},
		{PolicyID: "p1", Crontab: "0 0 3 * * *", BackupStyle: model.BACKUP_STYLE_INCR, Enabled: true, ScheduleType: model.BACKUP_SCHEDULED, Instance: "self"},
	}
	captured := map[string]func() error{}
	cr := &fakeCronCapture{fakeCron: newFakeCron(), captured: captured}
	var incr, full []string
	s := NewScheduler("self", cr, &fakePolicyRepo{items: policies}, func(p model.BackupPolicy) { incr = append(incr, p.PolicyID) }).
		WithFull(func(p model.BackupPolicy) { full = append(full, p.PolicyID) })
	s.Reconcile()
	if len(captured) != 3 || captured["n1#full"] == nil {
		t.Fatalf("expected entries n1, n1#full, p1; got %v", len(captured))
	}
	_ = captured["n1#full"]()
	_ = captured["n1"]()
	if len(full) != 1 || full[0] != "n1" || len(incr) != 1 {
		t.Fatalf("full=%v incr=%v", full, incr)
	}
}
