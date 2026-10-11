package standby

import (
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/backup"
	"github.com/housepower/ckman/service/backup/storage"
	"github.com/pkg/errors"
)

// Storage-sync standby: every interval, each table's changed partitions are
// backed up from every primary shard to the bucket (an incremental on the
// previous backup, so unchanged parts aren't uploaded again) and replace the
// same partitions on the matching standby shard. Every chainRuns syncs a new
// chain starts with a full backup and the old chain is deleted.

const chainRuns = 24

type target interface {
	Dest(key string) string
	DeletePrefix(prefix string) error
}

func openTarget(sb *model.Standby) (target, error) {
	c, err := backup.GetConnection(sb.ConnectionID)
	if err != nil {
		return nil, errors.Wrap(err, "storage connection")
	}
	if c.Type == model.STORAGE_CONN_AZURE {
		az := c.Azure
		az.Container = sb.Bucket
		t := storage.NewAzure(az, "")
		return t, t.Init()
	}
	s3 := c.S3
	s3.Bucket = sb.Bucket
	t := storage.NewS3(s3, "")
	return t, t.Init()
}

func chainPrefix(sb *model.Standby, chain string) string {
	return path.Join("standby", sb.Primary, chain) + "/"
}

// shardConns connects to the first reachable replica of every shard.
func shardConns(conf model.CKManClickHouseConfig) ([]*common.Conn, error) {
	out := make([]*common.Conn, len(conf.Shards))
	for i, shard := range conf.Shards {
		var lastErr error
		for _, r := range shard.Replicas {
			c, err := common.ConnectClickHouse(r.Ip, model.ClickHouseDefaultDB, conf.GetConnOption())
			if err == nil {
				out[i] = c
				break
			}
			lastErr = err
		}
		if out[i] == nil {
			return nil, errors.Errorf("%s shard %d: no replica reachable (%v)", conf.Cluster, i+1, lastErr)
		}
	}
	return out, nil
}

func ident(db, t string) string {
	return fmt.Sprintf("`%s`.`%s`", strings.ReplaceAll(db, "`", ""), strings.ReplaceAll(t, "`", ""))
}

func lit(s string) string {
	return "'" + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), "'", `\'`) + "'"
}

func idList(ids []string) string {
	q := make([]string, len(ids))
	for i, id := range ids {
		q[i] = "ID " + lit(id)
	}
	return strings.Join(q, ", ")
}

// fingerprints: per partition, a hash of its active part names (changes on
// every insert, merge or mutation) and its rows.
func fingerprints(c *common.Conn, db, table string) (map[string]string, uint64, error) {
	rows, err := c.Query(fmt.Sprintf(`SELECT partition_id, toString(cityHash64(arraySort(groupArray(name)))), sum(rows)
FROM system.parts WHERE database = %s AND table = %s AND active GROUP BY partition_id`, lit(db), lit(table)))
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := map[string]string{}
	var total uint64
	for rows.Next() {
		var pid, h string
		var n uint64
		if err := rows.Scan(&pid, &h, &n); err != nil {
			return nil, 0, err
		}
		out[pid] = h
		total += n
	}
	return out, total, nil
}

func tableRows(c *common.Conn, db, table string) uint64 {
	var n uint64
	_ = c.QueryRow(fmt.Sprintf("SELECT sum(rows) FROM system.parts WHERE database = %s AND table = %s AND active", lit(db), lit(table))).Scan(&n)
	return n
}

// syncOnce runs one sync of a storage-mode standby. Callers hold its lock.
func syncOnce(sb *model.Standby) error {
	primary, err := repository.Ps.GetClusterbyName(sb.Primary)
	if err != nil {
		return errors.Wrapf(err, "primary %s", sb.Primary)
	}
	standbyConf, err := repository.Ps.GetClusterbyName(sb.Cluster)
	if err != nil {
		return errors.Wrapf(err, "standby cluster %s", sb.Cluster)
	}
	if len(primary.Shards) != len(standbyConf.Shards) {
		return errors.Errorf("%s has %d shards but %s has %d: shard counts must match", sb.Primary, len(primary.Shards), sb.Cluster, len(standbyConf.Shards))
	}
	tgt, err := openTarget(sb)
	if err != nil {
		return err
	}
	pcs, err := shardConns(primary)
	if err != nil {
		return err
	}
	scs, err := shardConns(standbyConf)
	if err != nil {
		return err
	}
	tables, err := listTables(pcs[0], sb.Databases)
	if err != nil {
		return errors.Wrap(err, "list primary tables")
	}
	schema := syncSchema(sb, pcs[0], scs[0], tables)
	problems := schema.problems
	sb.SchemaNotes = schema.notes

	run := time.Now().UTC().Format("20060102T150405")
	newChain := sb.ChainID == "" || sb.ChainRuns >= chainRuns
	oldChain := sb.ChainID
	if newChain {
		sb.ChainID, sb.ChainRuns = run, 0
	}
	if sb.Tables == nil {
		sb.Tables = map[string]*model.StandbyTable{}
	}
	copied := 0
	seen := map[string]bool{}
	for _, t := range tables {
		if !t.data() {
			continue
		}
		seen[t.key()] = true
		if schema.rebuild[t.key()] {
			n, err := rebuildTable(sb, tgt, t, pcs, scs, run)
			if err != nil {
				problems = append(problems, fmt.Sprintf("rebuild %s: %v", t.key(), err))
			}
			copied += n
			continue
		}
		st := sb.Tables[t.key()]
		if st == nil {
			st = &model.StandbyTable{Shards: map[int]map[string]string{}, LastKey: map[int]string{}}
			sb.Tables[t.key()] = st
		}
		st.PrimaryRows, st.StandbyRows = 0, 0
		for i := range pcs {
			n, err := syncShard(sb, tgt, t, st, i, pcs[i], scs[i], run, newChain)
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s shard %d: %v", t.key(), i+1, err))
			}
			copied += n
			st.StandbyRows += tableRows(scs[i], t.db, t.name)
		}
	}
	for k := range sb.Tables {
		if !seen[k] {
			delete(sb.Tables, k) // dropped on the primary (the standby keeps its copy)
		}
	}
	sb.ChainRuns++
	sb.LastSynced = copied
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	if newChain && oldChain != "" && oldChain != sb.ChainID {
		if err := tgt.DeletePrefix(chainPrefix(sb, oldChain)); err != nil {
			log.Logger.Warnf("[standby] %s: delete old chain %s: %v", sb.Primary, oldChain, err)
		}
	}
	return nil
}

// syncShard copies one shard of one table; it returns how many partitions
// were replaced on the standby.
func syncShard(sb *model.Standby, tgt target, t tableInfo, st *model.StandbyTable, i int,
	pc, sc *common.Conn, run string, newChain bool) (int, error) {
	fp, rows, err := fingerprints(pc, t.db, t.name)
	if err != nil {
		return 0, errors.Wrap(err, "read primary partitions")
	}
	st.PrimaryRows += rows
	last := st.Shards[i]
	if last == nil {
		last = map[string]string{}
		st.Shards[i] = last
	}
	var changed, removed []string
	if len(last) == 0 {
		// first copy: partitions only the standby has go too (a rejoined
		// old primary may hold writes the active cluster never got)
		have, _, err := fingerprints(sc, t.db, t.standbyName())
		if err != nil {
			return 0, errors.Wrap(err, "read standby partitions")
		}
		for pid := range have {
			if _, ok := fp[pid]; !ok {
				last[pid] = ""
			}
		}
	}
	for pid, h := range fp {
		if last[pid] != h {
			changed = append(changed, pid)
		}
	}
	for pid := range last {
		if _, ok := fp[pid]; !ok {
			removed = append(removed, pid)
		}
	}
	sort.Strings(changed)
	backupIDs := changed
	if newChain || st.LastKey[i] == "" {
		backupIDs = make([]string, 0, len(fp))
		for pid := range fp {
			backupIDs = append(backupIDs, pid)
		}
		sort.Strings(backupIDs)
	}
	name, dst := ident(t.db, t.name), ident(t.db, t.standbyName())
	if newChain && len(backupIDs) == 0 {
		delete(st.LastKey, i) // nothing to back up: don't keep a base in the old chain
	}
	if len(backupIDs) > 0 && (len(changed) > 0 || newChain) {
		key := path.Join(chainPrefix(sb, sb.ChainID), run, t.key(), fmt.Sprintf("shard%d", i+1))
		q := fmt.Sprintf("BACKUP TABLE %s PARTITIONS %s TO %s", name, idList(backupIDs), tgt.Dest(key))
		if !newChain && st.LastKey[i] != "" {
			q += " SETTINGS base_backup = " + tgt.Dest(st.LastKey[i])
		}
		if err := pc.Exec(q); err != nil {
			return 0, errors.Wrap(err, "backup")
		}
		st.LastKey[i] = key
		if len(changed) > 0 {
			// the standby keeps its current partitions until the new ones
			// are restored and swapped in: a failed restore leaves no hole
			if err := stagedReplace(sc, t, changed, tgt.Dest(key)); err != nil {
				return 0, err
			}
		}
		for _, pid := range changed {
			last[pid] = fp[pid]
		}
	}
	for _, pid := range removed {
		if err := sc.Exec(fmt.Sprintf("ALTER TABLE %s DROP PARTITION ID %s", dst, lit(pid))); err != nil {
			return len(changed), errors.Wrapf(err, "drop removed partition %s", pid)
		}
		delete(last, pid)
	}
	return len(changed), nil
}

// rebuildTable replaces a standby table whose definition can't be altered
// into the primary's: the primary's definition is created under a temporary
// name, filled from a full backup of every shard and exchanged with the old
// table, which is then dropped. Until the exchange the old table serves reads.
func rebuildTable(sb *model.Standby, tgt target, t tableInfo, pcs, scs []*common.Conn, run string) (int, error) {
	tmp := t
	tmp.dest = rebuildName(t.name)
	drop := func(table string) error {
		return scs[0].Exec("DROP TABLE IF EXISTS " + ident(t.db, table) + onCluster(sb) + " SYNC")
	}
	if err := drop(tmp.dest); err != nil {
		return 0, errors.Wrap(err, "drop an old rebuild table")
	}
	ddl := rebuildDDL(t.ddl, tmp.dest, "ckf_"+strings.ToLower(run))
	if err := scs[0].Exec(standbyDDL(ddl, sb.Primary, sb.Cluster)); err != nil {
		return 0, errors.Wrap(err, "create the new table")
	}
	st := &model.StandbyTable{Shards: map[int]map[string]string{}, LastKey: map[int]string{}}
	copied := 0
	for i := range pcs {
		n, err := syncShard(sb, tgt, tmp, st, i, pcs[i], scs[i], run, true)
		copied += n
		if err != nil {
			_ = drop(tmp.dest)
			return copied, errors.Wrapf(err, "shard %d", i+1)
		}
		st.StandbyRows += tableRows(scs[i], t.db, tmp.dest)
	}
	if err := scs[0].Exec(fmt.Sprintf("EXCHANGE TABLES %s AND %s%s", ident(t.db, t.name), ident(t.db, tmp.dest), onCluster(sb))); err != nil {
		_ = drop(tmp.dest)
		return copied, errors.Wrap(err, "swap in the new table")
	}
	if err := drop(tmp.dest); err != nil {
		log.Logger.Warnf("[standby] %s: drop the replaced %s: %v", sb.Primary, t.key(), err)
	}
	sb.Tables[t.key()] = st
	return copied, nil
}

// Staged replace: changed partitions are restored into a staging table next
// to the real one, then swapped in with REPLACE PARTITION (atomic per
// partition, replicated to the other standby replicas). The staging table is
// a non-replicated copy of the real table's structure, so it never touches
// Keeper.

const stagePrefix = "__ckf_stage_"

func stageName(table string) string {
	n := stagePrefix + table
	if len(n) > 200 {
		n = n[:200]
	}
	return n
}

func stagedReplace(sc *common.Conn, t tableInfo, ids []string, dest string) error {
	var engineFull string
	q := fmt.Sprintf("SELECT engine_full FROM system.tables WHERE database = %s AND name = %s", lit(t.db), lit(t.standbyName()))
	if err := sc.QueryRow(q).Scan(&engineFull); err != nil {
		return errors.Wrap(err, "read the standby table's engine")
	}
	engine, err := stagingEngine(engineFull)
	if err != nil {
		return err
	}
	source := ident(t.db, t.name) // its name in the backup
	target := ident(t.db, t.standbyName())
	stage := ident(t.db, stageName(t.standbyName()))
	_ = sc.Exec("DROP TABLE IF EXISTS " + stage + " SYNC")
	defer func() { _ = sc.Exec("DROP TABLE IF EXISTS " + stage + " SYNC") }()
	if err := sc.Exec(fmt.Sprintf("CREATE TABLE %s AS %s ENGINE = %s", stage, target, engine)); err != nil {
		return errors.Wrap(err, "create staging table")
	}
	// the backup holds the replicated definition; the staging table differs
	// only in not being replicated
	q = fmt.Sprintf("RESTORE TABLE %s AS %s PARTITIONS %s FROM %s SETTINGS allow_non_empty_tables = 1, allow_different_table_def = 1",
		source, stage, idList(ids), dest)
	if err := sc.Exec(q); err != nil {
		return errors.Wrap(err, "restore into staging (the standby table is unchanged)")
	}
	for _, pid := range ids {
		if err := sc.Exec(fmt.Sprintf("ALTER TABLE %s REPLACE PARTITION ID %s FROM %s", target, lit(pid), stage)); err != nil {
			return errors.Wrapf(err, "swap in partition %s", pid)
		}
	}
	return nil
}

// stagingEngine is the engine of a non-replicated copy of a table:
// "ReplicatedReplacingMergeTree('/path', '{replica}', ver) PARTITION BY ..."
// becomes "ReplacingMergeTree(ver) PARTITION BY ...". Other engines stay.
func stagingEngine(engineFull string) (string, error) {
	if !strings.HasPrefix(engineFull, "Replicated") {
		return engineFull, nil
	}
	nameEnd := strings.IndexFunc(engineFull, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z')
	})
	if nameEnd < 0 {
		return strings.TrimPrefix(engineFull, "Replicated"), nil
	}
	name := strings.TrimPrefix(engineFull[:nameEnd], "Replicated")
	if engineFull[nameEnd] != '(' {
		return name + engineFull[nameEnd:], nil // no arguments: default Keeper path
	}
	closeAt, args := -1, []string{}
	depth, inQuote, start := 0, false, nameEnd+1
	for i := nameEnd; i < len(engineFull) && closeAt < 0; i++ {
		c := engineFull[i]
		if inQuote {
			if c == '\\' {
				i++
			} else if c == '\'' {
				inQuote = false
			}
			continue
		}
		switch c {
		case '\'':
			inQuote = true
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				closeAt = i
				args = append(args, strings.TrimSpace(engineFull[start:i]))
			}
		case ',':
			if depth == 1 {
				args = append(args, strings.TrimSpace(engineFull[start:i]))
				start = i + 1
			}
		}
	}
	if closeAt < 0 {
		return "", errors.Errorf("can't read engine %q", engineFull)
	}
	quoted := func(a string) bool { return strings.HasPrefix(a, "'") }
	if len(args) >= 2 && quoted(args[0]) && quoted(args[1]) {
		args = args[2:] // Keeper path and replica name
	}
	if len(args) == 1 && args[0] == "" {
		args = nil
	}
	return name + "(" + strings.Join(args, ", ") + ")" + engineFull[closeAt+1:], nil
}
