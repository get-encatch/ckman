package standby

import (
	"fmt"
	"path"
	"regexp"
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

type tableInfo struct {
	db, name, engine, ddl string
}

func (t tableInfo) key() string { return t.db + "." + t.name }
func (t tableInfo) data() bool  { return strings.HasSuffix(t.engine, "MergeTree") }

func listTables(c *common.Conn, dbs []string) ([]tableInfo, error) {
	q := `SELECT database, name, engine, create_table_query FROM system.tables
WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND is_temporary = 0
  AND NOT startsWith(name, '.inner') AND engine IN ('MergeTree', 'ReplacingMergeTree', 'SummingMergeTree',
  'AggregatingMergeTree', 'CollapsingMergeTree', 'VersionedCollapsingMergeTree', 'GraphiteMergeTree',
  'ReplicatedMergeTree', 'ReplicatedReplacingMergeTree', 'ReplicatedSummingMergeTree', 'ReplicatedAggregatingMergeTree',
  'ReplicatedCollapsingMergeTree', 'ReplicatedVersionedCollapsingMergeTree', 'ReplicatedGraphiteMergeTree',
  'Distributed', 'View', 'MaterializedView')`
	if len(dbs) > 0 {
		quoted := make([]string, len(dbs))
		for i, d := range dbs {
			quoted[i] = lit(d)
		}
		q += " AND database IN (" + strings.Join(quoted, ", ") + ")"
	}
	rows, err := c.Query(q + " ORDER BY database, name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []tableInfo
	for rows.Next() {
		var t tableInfo
		if err := rows.Scan(&t.db, &t.name, &t.engine, &t.ddl); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	// data tables first, then Distributed, then views (they refer to tables)
	rank := func(t tableInfo) int {
		switch {
		case t.data():
			return 0
		case t.engine == "Distributed":
			return 1
		default:
			return 2
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out, nil
}

var createRe = regexp.MustCompile(`^CREATE (TABLE|VIEW|MATERIALIZED VIEW) (\S+)`)

// standbyDDL turns a primary CREATE into an idempotent ON CLUSTER create on
// the standby; Distributed tables point at the standby cluster.
func standbyDDL(ddl, primary, standby string) string {
	ddl = createRe.ReplaceAllString(ddl, "CREATE $1 IF NOT EXISTS $2 ON CLUSTER `"+standby+"`")
	return strings.ReplaceAll(ddl, "Distributed('"+primary+"'", "Distributed('"+standby+"'")
}

func existing(c *common.Conn) (map[string]bool, map[string]bool, error) {
	tables, dbs := map[string]bool{}, map[string]bool{}
	rows, err := c.Query("SELECT database, name FROM system.tables")
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var d, n string
		if err := rows.Scan(&d, &n); err == nil {
			tables[d+"."+n] = true
		}
	}
	rows.Close()
	rows, err = c.Query("SELECT name FROM system.databases")
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err == nil {
			dbs[d] = true
		}
	}
	return tables, dbs, nil
}

type column struct {
	name, typ, kind, expr string
}

// spec is the column's definition as it appears in ALTER: type and default.
func (c column) spec() string {
	if c.kind == "" {
		return c.typ
	}
	return fmt.Sprintf("%s %s %s", c.typ, c.kind, c.expr)
}

func columns(c *common.Conn, db, table string) ([]column, error) {
	rows, err := c.Query(fmt.Sprintf("SELECT name, type, default_kind, default_expression FROM system.columns WHERE database = %s AND table = %s ORDER BY position", lit(db), lit(table)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []column
	for rows.Next() {
		var col column
		if err := rows.Scan(&col.name, &col.typ, &col.kind, &col.expr); err != nil {
			return nil, err
		}
		out = append(out, col)
	}
	return out, nil
}

// syncColumns makes the standby table's columns match the primary's: added
// columns go in the same position with the same default, changed ones are
// modified. RESTORE refuses a table whose definition differs.
func syncColumns(sb *model.Standby, pc, sc *common.Conn, t tableInfo) []string {
	pcols, err := columns(pc, t.db, t.name)
	if err != nil {
		return nil
	}
	scols, err := columns(sc, t.db, t.name)
	if err != nil {
		return nil
	}
	have := map[string]column{}
	for _, c := range scols {
		have[c.name] = c
	}
	var problems []string
	for i, c := range pcols {
		var q string
		if old, ok := have[c.name]; !ok {
			pos := " FIRST"
			if i > 0 {
				pos = " AFTER `" + pcols[i-1].name + "`"
			}
			q = fmt.Sprintf("ALTER TABLE %s ON CLUSTER `%s` ADD COLUMN IF NOT EXISTS `%s` %s%s", ident(t.db, t.name), sb.Cluster, c.name, c.spec(), pos)
		} else if old.spec() != c.spec() {
			q = fmt.Sprintf("ALTER TABLE %s ON CLUSTER `%s` MODIFY COLUMN `%s` %s", ident(t.db, t.name), sb.Cluster, c.name, c.spec())
		} else {
			continue
		}
		if err := sc.Exec(q); err != nil {
			problems = append(problems, fmt.Sprintf("column %s.%s: %v", t.key(), c.name, err))
		}
	}
	return problems
}

// syncSchema creates missing databases and tables on the standby and adds
// columns that appeared on the primary.
func syncSchema(sb *model.Standby, pc, sc *common.Conn, tables []tableInfo) []string {
	var problems []string
	have, dbs, err := existing(sc)
	if err != nil {
		return []string{fmt.Sprintf("read standby schema: %v", err)}
	}
	for _, t := range tables {
		if !dbs[t.db] {
			if err := sc.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS `%s` ON CLUSTER `%s`", t.db, sb.Cluster)); err != nil {
				problems = append(problems, fmt.Sprintf("create database %s: %v", t.db, err))
				continue
			}
			dbs[t.db] = true
		}
		if !have[t.key()] {
			if err := sc.Exec(standbyDDL(t.ddl, sb.Primary, sb.Cluster)); err != nil {
				problems = append(problems, fmt.Sprintf("create %s: %v", t.key(), err))
			}
			continue
		}
		if t.data() {
			problems = append(problems, syncColumns(sb, pc, sc, t)...)
		}
	}
	return problems
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
	problems := syncSchema(sb, pcs[0], scs[0], tables)

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
	name := ident(t.db, t.name)
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
			for _, pid := range changed {
				if err := sc.Exec(fmt.Sprintf("ALTER TABLE %s DROP PARTITION ID %s", name, lit(pid))); err != nil {
					return 0, errors.Wrapf(err, "drop partition %s on standby", pid)
				}
			}
			q := fmt.Sprintf("RESTORE TABLE %s PARTITIONS %s FROM %s SETTINGS allow_non_empty_tables = 1",
				name, idList(changed), tgt.Dest(key))
			if err := sc.Exec(q); err != nil {
				// definitions can still differ in ways the column sync doesn't
				// cover (codecs, settings); the parts themselves fit
				if !strings.Contains(err.Error(), "different definition") {
					return 0, errors.Wrap(err, "restore")
				}
				log.Logger.Warnf("[standby] %s: %s differs from the primary's definition; restoring anyway", sb.Cluster, t.key())
				if err := sc.Exec(q + ", allow_different_table_def = 1"); err != nil {
					return 0, errors.Wrap(err, "restore")
				}
			}
		}
		for _, pid := range changed {
			last[pid] = fp[pid]
		}
	}
	for _, pid := range removed {
		if err := sc.Exec(fmt.Sprintf("ALTER TABLE %s DROP PARTITION ID %s", name, lit(pid))); err != nil {
			return len(changed), errors.Wrapf(err, "drop removed partition %s", pid)
		}
		delete(last, pid)
	}
	return len(changed), nil
}
