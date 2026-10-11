package backup

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/service/backup/storage"
)

// NativeStorage is implemented by storages that support whole-table native
// backups (S3 and Local).
type NativeStorage interface {
	NativeBackupSQL(key, baseKey string) string
	NativeRestoreSQL(partitionIDs []string, key string) string
	// DeleteNativeBackup removes everything one native run stored (all shards).
	DeleteNativeBackup(hosts []string, runPrefix string) error
}

// isFullTrigger reports whether a run was asked to start a new chain.
func isFullTrigger(trigger string) bool {
	return trigger == model.TRIGGER_CRON_FULL || trigger == model.TRIGGER_MANUAL_FULL
}

// FullBackupDueNow reports whether a native policy's full-backup schedule
// fires within a minute of now; the incremental schedule then stands down.
func FullBackupDueNow(p model.BackupPolicy, now time.Time) bool {
	if p.BackupStyle != model.BACKUP_STYLE_NATIVE || p.FullCrontab == "" {
		return false
	}
	next, err := NextRunAfter(p.FullCrontab, now.Add(-30*time.Second))
	return err == nil && next.Sub(now) <= 30*time.Second
}

// nativeFullEvery is the count-based chain limit. Policies with their own
// full-backup schedule have none: the schedule starts the new chains.
func nativeFullEvery(p model.BackupPolicy) int {
	if p.FullCrontab != "" {
		return 0
	}
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
		r.BaseRunID = pickNativeBase(runs, r.RunID, len(e.conns), nativeFullEvery(policy), isFullTrigger(r.TriggerType))
	}
	return nil
}

// pickNativeBase returns the run a new native backup should be incremental
// on, or "" for a full backup. runs must be newest first. The base is the
// newest successful native backup of the policy, unless a full backup was
// asked for, the chain since the last full one already holds fullEvery
// backups (0 = no limit), or the shard count changed (a new shard has no
// earlier backup to build on).
func pickNativeBase(runs []model.BackupRun, self string, shards, fullEvery int, forceFull bool) string {
	if forceFull {
		return ""
	}
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
	if latest == nil || (fullEvery > 0 && chain >= fullEvery) || latest.NativeShards != shards {
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
	if err := e.repo.UpdateRun(run); err != nil {
		return err
	}
	if run.BaseRunID == "" {
		if policy, perr := e.repo.GetPolicyForRun(run.PolicyID); perr == nil && policy.KeepFull > 0 {
			e.pruneNativeChains(run, policy.KeepFull, ns)
		}
	}
	return nil
}

// nativeChainsToPrune returns the native backup runs older than the newest
// keep full backups: whole chains, so no kept backup loses its base. runs must
// be newest first; restore runs are never returned.
func nativeChainsToPrune(runs []model.BackupRun, keep int) []model.BackupRun {
	fulls := 0
	var cutoff time.Time
	for _, r := range runs {
		if r.Native && r.Operation != model.OP_RESTORE && r.Status == model.BACKUP_STATUS_SUCCESS && r.BaseRunID == "" {
			fulls++
			if fulls == keep {
				cutoff = r.StartedAt
				break
			}
		}
	}
	if fulls < keep {
		return nil
	}
	var old []model.BackupRun
	for _, r := range runs {
		if r.Native && r.Operation != model.OP_RESTORE && !r.StartedAt.IsZero() && r.StartedAt.Before(cutoff) {
			old = append(old, r)
		}
	}
	return old
}

// pruneNativeChains applies "keep the newest N full backups" after a new full
// backup succeeded: older chains are deleted from storage, then from the
// ledger. Failures are logged; the backup itself already succeeded.
func (e *Executor) pruneNativeChains(run model.BackupRun, keep int, ns NativeStorage) {
	if e.policyRuns == nil || e.deleteRun == nil {
		return
	}
	runs, err := e.policyRuns(run.PolicyID)
	if err != nil {
		log.Logger.Warnf("[exec] retention: list runs of policy %s: %v", run.PolicyID, err)
		return
	}
	for i, r := range runs {
		if r.RunID == run.RunID {
			// the ledger still says running: the run is marked done after this returns
			runs[i].Status = model.BACKUP_STATUS_SUCCESS
			continue
		}
		if r.Status == model.BACKUP_STATUS_QUEUED || r.Status == model.BACKUP_STATUS_RUNNING {
			log.Logger.Infof("[exec] retention: policy %s has run %s in flight, pruning next time", run.PolicyID, r.RunID)
			return
		}
	}
	for _, old := range nativeChainsToPrune(runs, keep) {
		prefix := storage.JoinNativeRunPrefix(old.StoragePrefix, old.Database, old.Table, old.RunID)
		if derr := ns.DeleteNativeBackup(e.hosts, prefix); derr != nil {
			log.Logger.Warnf("[exec] retention: delete backup %s: %v", prefix, derr)
			continue // keep the record so it can be retried
		}
		if derr := e.deleteRun(old.RunID); derr != nil {
			log.Logger.Warnf("[exec] retention: delete run %s: %v", old.RunID, derr)
		}
		log.Logger.Infof("[exec] retention: pruned native run %s of policy %s", old.RunID, run.PolicyID)
	}
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
	var ids []string // nil = whole table
	if !run.WholeTable {
		for _, p := range run.Partitions {
			ids = append(ids, p.PartitionID)
		}
	}
	if e.tableExists != nil {
		// RESTORE would create a missing table on one replica per shard only,
		// leaving the other replicas without it.
		for _, c := range e.conns {
			ok, err := e.tableExists(c.host, run.Database, run.Table)
			if err != nil {
				return fmt.Errorf("check table on %s: %w", c.host, err)
			}
			if !ok {
				return fmt.Errorf("table %s.%s doesn't exist on %s; create it ON CLUSTER first (its CREATE statement is in the backup)",
					run.Database, run.Table, c.host)
			}
		}
	}
	setNativeStatus(&run, model.BACKUP_PARTITION_STATUS_RUNNING, "", 0)
	if err := e.repo.UpdateRun(run); err != nil {
		return fmt.Errorf("mark run running: %w", err)
	}
	start := time.Now()
	if run.Replace {
		// TRUNCATE / DROP PARTITION on replicated tables reach every replica of the shard.
		var stmts []string
		if ids == nil {
			stmts = append(stmts, fmt.Sprintf("TRUNCATE TABLE `%s`.`%s`", run.Database, run.Table))
		} else {
			for _, id := range ids {
				stmts = append(stmts, fmt.Sprintf("ALTER TABLE `%s`.`%s` DROP%s", run.Database, run.Table, storage.PartitionClause("", id)))
			}
		}
		for _, stmt := range stmts {
			if errs := e.runOnShards(func(*shardConn) string { return stmt }); len(errs) > 0 {
				msg := "emptying before restore: " + strings.Join(errs, "; ")
				setNativeStatus(&run, model.BACKUP_PARTITION_STATUS_FAILED, msg, int(time.Since(start).Seconds()))
				_ = e.repo.UpdateRun(run)
				return errors.New(msg)
			}
		}
	}
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
