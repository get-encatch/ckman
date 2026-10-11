package backup

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/service/backup/storage"
)

// NativeStorage is implemented by storages that support whole-table native
// backups (S3 and Local).
type NativeStorage interface {
	NativeBackupSQL(key, baseKey string) string
	NativeRestoreSQL(partitionIDs []string, key string) string
}

func nativeFullEvery(p model.BackupPolicy) int {
	if p.FullEvery > 0 {
		return p.FullEvery
	}
	return model.DEFAULT_NATIVE_FULL_EVERY
}

// resolveNativeRun prepares a native backup run: the table's partitions are
// recorded (for display and partial restore) and the run is chained onto the
// previous native backup of the policy when possible.
func (e *Executor) resolveNativeRun(r *model.BackupRun, policy model.BackupPolicy) error {
	if e.nativeInventory == nil {
		return errors.New("native backup requires nativeInventory hook")
	}
	inv, err := e.nativeInventory(e.conns[0], policy.Database, policy.Table)
	if err != nil {
		return fmt.Errorf("list partitions: %w", err)
	}
	r.Native = true
	r.Partitions = inv
	r.BaseRunID = ""
	if e.policyRuns != nil {
		runs, perr := e.policyRuns(policy.PolicyID)
		if perr != nil {
			return fmt.Errorf("list previous runs: %w", perr)
		}
		r.BaseRunID = pickNativeBase(runs, r.RunID, len(e.conns), nativeFullEvery(policy))
	}
	return nil
}

// pickNativeBase returns the run a new native backup should be incremental
// on, or "" for a full backup. runs must be newest first. The base is the
// newest successful native backup of the policy, unless the chain since the
// last full one already holds fullEvery backups or the shard count changed
// (a new shard has no earlier backup to build on).
func pickNativeBase(runs []model.BackupRun, self string, shards, fullEvery int) string {
	var latest *model.BackupRun
	chain := 0
	for i := range runs {
		r := &runs[i]
		if r.RunID == self || !r.Native || r.Operation == model.OP_RESTORE || r.Status != model.BACKUP_STATUS_SUCCESS {
			continue
		}
		if latest == nil {
			latest = r
		}
		chain++
		if r.BaseRunID == "" {
			break
		}
	}
	if latest == nil || chain >= fullEvery || latest.NativeShards != shards {
		return ""
	}
	return latest.RunID
}

// setNativeStatus applies the outcome of a native run to every partition it
// covers: a whole-table backup or restore succeeds or fails as one.
func setNativeStatus(run *model.BackupRun, status, msg string, elapsed int) {
	for i := range run.Partitions {
		run.Partitions[i].Status = status
		run.Partitions[i].Msg = msg
		run.Partitions[i].Elapsed = elapsed
	}
}

// runOnShards executes one statement per shard connection in parallel and
// returns the per-host errors.
func (e *Executor) runOnShards(sqlFor func(c *shardConn) string) []string {
	type result struct {
		host string
		err  error
	}
	ch := make(chan result, len(e.conns))
	for _, c := range e.conns {
		c := c
		go func() { ch <- result{c.host, e.execSQL(c.host, sqlFor(c))} }()
	}
	var errs []string
	for range e.conns {
		if r := <-ch; r.err != nil {
			errs = append(errs, fmt.Sprintf("[%s] %v", r.host, r.err))
		}
	}
	return errs
}

func (e *Executor) nativeBackup(run model.BackupRun) error {
	ns, ok := e.storage.(NativeStorage)
	if !ok {
		return fmt.Errorf("storage %s does not support native backups", e.storage.Type())
	}
	run.NativeShards = len(e.conns)
	setNativeStatus(&run, model.BACKUP_PARTITION_STATUS_RUNNING, "", 0)
	if err := e.repo.UpdateRun(run); err != nil {
		return fmt.Errorf("mark run running: %w", err)
	}
	start := time.Now()
	errs := e.runOnShards(func(c *shardConn) string {
		key := storage.JoinNativeKey(run.StoragePrefix, run.Database, run.Table, run.RunID, c.shard)
		baseKey := ""
		if run.BaseRunID != "" {
			baseKey = storage.JoinNativeKey(run.StoragePrefix, run.Database, run.Table, run.BaseRunID, c.shard)
		}
		return fmt.Sprintf("BACKUP TABLE `%s`.`%s`%s", run.Database, run.Table, ns.NativeBackupSQL(key, baseKey))
	})
	elapsed := int(time.Since(start).Seconds())
	if len(errs) > 0 {
		msg := strings.Join(errs, "; ")
		setNativeStatus(&run, model.BACKUP_PARTITION_STATUS_FAILED, msg, elapsed)
		_ = e.repo.UpdateRun(run)
		return errors.New(msg)
	}
	setNativeStatus(&run, model.BACKUP_PARTITION_STATUS_SUCCESS, "", elapsed)
	return e.repo.UpdateRun(run)
}

func (e *Executor) nativeRestore(run model.BackupRun) error {
	ns, ok := e.storage.(NativeStorage)
	if !ok {
		return fmt.Errorf("storage %s does not support native backups", e.storage.Type())
	}
	if run.SourceRunID == "" {
		return errors.New("native restore without a source run")
	}
	if run.NativeShards != 0 && run.NativeShards != len(e.conns) {
		return fmt.Errorf("the backup was taken with %d shards but the cluster now has %d; restore shard by shard is not supported",
			run.NativeShards, len(e.conns))
	}
	ids := make([]string, 0, len(run.Partitions))
	for _, p := range run.Partitions {
		ids = append(ids, p.PartitionID)
	}
	setNativeStatus(&run, model.BACKUP_PARTITION_STATUS_RUNNING, "", 0)
	if err := e.repo.UpdateRun(run); err != nil {
		return fmt.Errorf("mark run running: %w", err)
	}
	start := time.Now()
	errs := e.runOnShards(func(c *shardConn) string {
		key := storage.JoinNativeKey(run.StoragePrefix, run.Database, run.Table, run.SourceRunID, c.shard)
		return fmt.Sprintf("RESTORE TABLE `%s`.`%s`%s SETTINGS allow_non_empty_tables=true",
			run.Database, run.Table, ns.NativeRestoreSQL(ids, key))
	})
	elapsed := int(time.Since(start).Seconds())
	if len(errs) > 0 {
		msg := strings.Join(errs, "; ")
		setNativeStatus(&run, model.BACKUP_PARTITION_STATUS_FAILED, msg, elapsed)
		_ = e.repo.UpdateRun(run)
		return errors.New(msg)
	}
	setNativeStatus(&run, model.BACKUP_PARTITION_STATUS_SUCCESS, "", elapsed)
	return e.repo.UpdateRun(run)
}
