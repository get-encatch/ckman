package standby

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/model"
)

// Schema sync runs before every data sync and makes the standby's schema
// match the primary's within the synced databases:
//   - tables are matched by the primary's table UUID, so a rename is a rename
//     on the standby too and its data stays;
//   - databases, tables and views gone from the primary are dropped;
//   - a data table whose definition differs gets its columns, skip indexes,
//     TTL and settings altered in place; a different engine, ORDER BY,
//     PARTITION BY, primary or sampling key rebuilds it (see rebuildTable);
//   - views and Distributed tables that differ are dropped and recreated.

const (
	ckfPrefix     = "__ckf_" // ckman's own tables on the standby
	rebuildPrefix = "__ckf_rebuild_"
	zeroUUID      = "00000000-0000-0000-0000-000000000000"
)

type tableInfo struct {
	db, name, engine, engineFull, ddl, uuid           string
	sortingKey, partitionKey, primaryKey, samplingKey string
	dest                                              string // standby name when it differs (rebuild)
}

func (t tableInfo) key() string { return t.db + "." + t.name }
func (t tableInfo) data() bool  { return strings.HasSuffix(t.engine, "MergeTree") }
func (t tableInfo) standbyName() string {
	if t.dest != "" {
		return t.dest
	}
	return t.name
}

var systemDBs = []string{"system", "INFORMATION_SCHEMA", "information_schema"}

func quoteList(items []string) string {
	q := make([]string, len(items))
	for i, s := range items {
		q[i] = lit(s)
	}
	return strings.Join(q, ", ")
}

func listTables(c *common.Conn, dbs []string) ([]tableInfo, error) {
	q := `SELECT database, name, engine, engine_full, create_table_query, toString(uuid),
  sorting_key, partition_key, primary_key, sampling_key FROM system.tables
WHERE database NOT IN (` + quoteList(systemDBs) + `) AND is_temporary = 0
  AND NOT startsWith(name, '.inner') AND NOT startsWith(name, '` + ckfPrefix + `') AND engine IN ('MergeTree', 'ReplacingMergeTree', 'SummingMergeTree',
  'AggregatingMergeTree', 'CollapsingMergeTree', 'VersionedCollapsingMergeTree', 'GraphiteMergeTree',
  'ReplicatedMergeTree', 'ReplicatedReplacingMergeTree', 'ReplicatedSummingMergeTree', 'ReplicatedAggregatingMergeTree',
  'ReplicatedCollapsingMergeTree', 'ReplicatedVersionedCollapsingMergeTree', 'ReplicatedGraphiteMergeTree',
  'Distributed', 'View', 'MaterializedView')`
	if len(dbs) > 0 {
		q += " AND database IN (" + quoteList(dbs) + ")"
	}
	rows, err := c.Query(q + " ORDER BY database, name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []tableInfo
	for rows.Next() {
		var t tableInfo
		if err := rows.Scan(&t.db, &t.name, &t.engine, &t.engineFull, &t.ddl, &t.uuid,
			&t.sortingKey, &t.partitionKey, &t.primaryKey, &t.samplingKey); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	// data tables first, then Distributed, then views (they refer to tables)
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out, nil
}

func rank(t tableInfo) int {
	switch {
	case t.data():
		return 0
	case t.engine == "Distributed":
		return 1
	default:
		return 2
	}
}

func listDatabases(c *common.Conn, dbs []string) (map[string]bool, error) {
	q := "SELECT name FROM system.databases WHERE name NOT IN (" + quoteList(systemDBs) + ")"
	if len(dbs) > 0 {
		q += " AND name IN (" + quoteList(dbs) + ")"
	}
	rows, err := c.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out[d] = true
	}
	return out, nil
}

var (
	createRe         = regexp.MustCompile(`^CREATE (TABLE|VIEW|MATERIALIZED VIEW) (\S+)`)
	uuidRe           = regexp.MustCompile(` UUID '[0-9a-f-]+'`)
	replicatedArgsRe = regexp.MustCompile(`(Replicated\w*MergeTree)\('(?:[^'\\]|\\.)*', '(?:[^'\\]|\\.)*'(?:, )?`)
	keeperPathRe     = regexp.MustCompile(`(Replicated\w*MergeTree\(')((?:[^'\\]|\\.)*)'`)
)

// standbyDDL turns a primary CREATE into an idempotent ON CLUSTER create on
// the standby; Distributed tables point at the standby cluster.
func standbyDDL(ddl, primary, standby string) string {
	ddl = createRe.ReplaceAllString(ddl, "CREATE $1 IF NOT EXISTS $2 ON CLUSTER `"+standby+"`")
	return strings.ReplaceAll(ddl, "Distributed('"+primary+"'", "Distributed('"+standby+"'")
}

// normalDDL is a definition with what legitimately differs between the two
// clusters taken out: table name and UUID, Keeper path and replica name, and
// the cluster a Distributed table points at.
func normalDDL(ddl, cluster string) string {
	ddl = uuidRe.ReplaceAllString(ddl, "")
	ddl = createRe.ReplaceAllString(ddl, "CREATE $1 _")
	ddl = replicatedArgsRe.ReplaceAllString(ddl, "$1(")
	return strings.ReplaceAll(ddl, "Distributed('"+cluster+"'", "Distributed('_'")
}

// rebuildDDL creates the primary's table under another name, with its own
// Keeper path so it never joins the table it will replace.
func rebuildDDL(ddl, name, suffix string) string {
	ddl = createRe.ReplaceAllStringFunc(ddl, func(m string) string {
		sub := createRe.FindStringSubmatch(m)
		dot := strings.LastIndex(sub[2], ".")
		return "CREATE " + sub[1] + " " + sub[2][:dot+1] + "`" + name + "`"
	})
	if loc := keeperPathRe.FindStringSubmatchIndex(ddl); loc != nil {
		ddl = ddl[:loc[5]] + "/" + suffix + ddl[loc[5]:]
	}
	return ddl
}

func rebuildName(table string) string {
	n := rebuildPrefix + table
	if len(n) > 200 {
		n = n[:200]
	}
	return n
}

// structural is what an ALTER can't change: a difference rebuilds the table.
func structural(t tableInfo) string {
	return strings.Join([]string{strings.TrimPrefix(t.engine, "Replicated"), t.sortingKey, t.partitionKey, t.primaryKey, t.samplingKey}, "|")
}

type schemaResult struct {
	problems []string        // failed statements: the sync fails
	notes    []string        // differences left as they are
	rebuild  map[string]bool // data tables to rebuild in this sync
}

func (r *schemaResult) fail(format string, args ...interface{}) {
	r.problems = append(r.problems, fmt.Sprintf(format, args...))
}

func (r *schemaResult) note(format string, args ...interface{}) {
	r.notes = append(r.notes, fmt.Sprintf(format, args...))
}

func onCluster(sb *model.Standby) string { return " ON CLUSTER `" + sb.Cluster + "`" }

// syncSchema makes the standby's schema match the primary's. tables is the
// primary's list (listTables).
func syncSchema(sb *model.Standby, pc, sc *common.Conn, tables []tableInfo) schemaResult {
	res := schemaResult{rebuild: map[string]bool{}}
	stables, err := listTables(sc, sb.Databases)
	if err != nil {
		res.fail("read standby schema: %v", err)
		return res
	}
	sdbs, err := listDatabases(sc, sb.Databases)
	if err != nil {
		res.fail("read standby databases: %v", err)
		return res
	}
	pdbs, err := listDatabases(pc, sb.Databases)
	if err != nil {
		res.fail("read primary databases: %v", err)
		return res
	}
	have := map[string]tableInfo{}
	for _, t := range stables {
		have[t.key()] = t
	}
	want := map[string]bool{}
	for _, t := range tables {
		want[t.key()] = true
	}
	if sb.Tables == nil {
		sb.Tables = map[string]*model.StandbyTable{}
	}
	createDB := func(db string) bool {
		if sdbs[db] {
			return true
		}
		if err := sc.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS `%s`%s", db, onCluster(sb))); err != nil {
			res.fail("create database %s: %v", db, err)
			return false
		}
		sdbs[db] = true
		return true
	}

	// renames: the primary's table UUID now has another name
	uuids := map[string]string{}
	for _, t := range tables {
		if t.uuid == "" || t.uuid == zeroUUID {
			continue
		}
		uuids[t.uuid] = t.key()
		old, seen := sb.TableUUIDs[t.uuid]
		if !seen || old == t.key() || want[old] {
			continue
		}
		ot, ok := have[old]
		if _, taken := have[t.key()]; !ok || taken || !createDB(t.db) {
			continue
		}
		q := fmt.Sprintf("RENAME TABLE %s TO %s%s", ident(ot.db, ot.name), ident(t.db, t.name), onCluster(sb))
		if err := sc.Exec(q); err != nil {
			res.fail("rename %s to %s: %v", old, t.key(), err)
			continue
		}
		delete(have, old)
		ot.db, ot.name = t.db, t.name
		have[t.key()] = ot
		if st := sb.Tables[old]; st != nil {
			sb.Tables[t.key()] = st
			delete(sb.Tables, old)
		}
	}

	// create, alter or recreate
	for _, t := range tables {
		if !createDB(t.db) {
			continue
		}
		cur, exists := have[t.key()]
		if exists && (cur.data() != t.data() || (!t.data() && normalDDL(cur.ddl, sb.Cluster) != normalDDL(t.ddl, sb.Primary))) {
			// a view or Distributed table that changed, or a table that became a view
			if err := sc.Exec("DROP TABLE IF EXISTS " + ident(t.db, t.name) + onCluster(sb) + " SYNC"); err != nil {
				res.fail("drop %s to recreate it: %v", t.key(), err)
				continue
			}
			exists = false
		}
		if !exists {
			if err := sc.Exec(standbyDDL(t.ddl, sb.Primary, sb.Cluster)); err != nil {
				res.fail("create %s: %v", t.key(), err)
			}
			delete(sb.Tables, t.key()) // a new table is copied in full
			continue
		}
		if t.data() && normalDDL(cur.ddl, sb.Cluster) != normalDDL(t.ddl, sb.Primary) {
			alterTable(sb, pc, sc, t, cur, &res)
		}
	}

	// drops: views first, data tables last; never when the primary looks empty
	if len(tables) == 0 && len(stables) > 0 {
		res.note("the primary has no tables: nothing was dropped on the standby")
	} else {
		sort.SliceStable(stables, func(i, j int) bool { return rank(stables[i]) > rank(stables[j]) })
		for _, t := range stables {
			if _, ok := have[t.key()]; !ok || want[t.key()] {
				continue // renamed or still on the primary
			}
			if err := sc.Exec("DROP TABLE IF EXISTS " + ident(t.db, t.name) + onCluster(sb) + " SYNC"); err != nil {
				res.fail("drop %s: %v", t.key(), err)
				continue
			}
			delete(sb.Tables, t.key())
		}
		if len(pdbs) > 0 {
			for db := range sdbs {
				if !pdbs[db] && db != model.ClickHouseDefaultDB {
					if err := sc.Exec(fmt.Sprintf("DROP DATABASE IF EXISTS `%s`%s SYNC", db, onCluster(sb))); err != nil {
						res.fail("drop database %s: %v", db, err)
					}
				}
			}
		}
	}
	sb.TableUUIDs = uuids
	return res
}

// alterTable brings an existing standby data table in line with the primary.
func alterTable(sb *model.Standby, pc, sc *common.Conn, t, cur tableInfo, res *schemaResult) {
	if structural(cur) != structural(t) {
		res.rebuild[t.key()] = true
		return
	}
	name := ident(t.db, t.name)
	exec := func(what, q string) {
		if err := sc.Exec(q); err != nil {
			res.fail("%s %s: %v", t.key(), what, err)
		}
	}
	syncColumns(sb, pc, sc, t, exec)
	syncIndexes(sb, pc, sc, t, exec)

	pttl, psettings := splitEngine(t.engineFull)
	sttl, ssettings := splitEngine(cur.engineFull)
	if pttl != sttl {
		if pttl == "" {
			exec("remove TTL", "ALTER TABLE "+name+onCluster(sb)+" REMOVE TTL")
		} else {
			// the primary's parts arrive with its TTL already applied
			exec("modify TTL", "ALTER TABLE "+name+onCluster(sb)+" MODIFY TTL "+pttl+" SETTINGS materialize_ttl_after_modify = 0")
		}
	}
	keys := make([]string, 0, len(psettings))
	for k := range psettings {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if ssettings[k] != psettings[k] {
			exec("setting "+k, fmt.Sprintf("ALTER TABLE %s%s MODIFY SETTING %s = %s", name, onCluster(sb), k, psettings[k]))
		}
	}
	for k := range ssettings {
		if _, ok := psettings[k]; !ok {
			exec("setting "+k, fmt.Sprintf("ALTER TABLE %s%s RESET SETTING %s", name, onCluster(sb), k))
		}
	}

	var after string
	if err := sc.QueryRow(fmt.Sprintf("SELECT create_table_query FROM system.tables WHERE database = %s AND name = %s", lit(t.db), lit(t.name))).Scan(&after); err == nil &&
		normalDDL(after, sb.Cluster) != normalDDL(t.ddl, sb.Primary) {
		res.note("%s: definition still differs from the primary (data still syncs)", t.key())
	}
}

var settingRe = regexp.MustCompile(`(\w+) = ('(?:[^'\\]|\\.)*'|[^,]+)(?:, |$)`)

// splitEngine reads the table TTL and settings out of engine_full.
func splitEngine(engineFull string) (string, map[string]string) {
	settings := map[string]string{}
	s := engineFull
	if i := strings.LastIndex(s, " SETTINGS "); i >= 0 {
		for _, m := range settingRe.FindAllStringSubmatch(s[i+len(" SETTINGS "):], -1) {
			settings[m[1]] = strings.TrimSpace(m[2])
		}
		s = s[:i]
	}
	ttl := ""
	if i := strings.Index(s, " TTL "); i >= 0 {
		ttl = s[i+len(" TTL "):]
	}
	return ttl, settings
}

type column struct {
	name, typ, kind, expr, codec, comment string
}

// spec is the column's definition as it appears in ALTER.
func (c column) spec() string {
	s := c.typ
	if c.kind != "" {
		s += " " + c.kind + " " + c.expr
	}
	if c.codec != "" {
		s += " " + c.codec
	}
	return s
}

func columns(c *common.Conn, db, table string) ([]column, error) {
	rows, err := c.Query(fmt.Sprintf("SELECT name, type, default_kind, default_expression, compression_codec, comment FROM system.columns WHERE database = %s AND table = %s ORDER BY position", lit(db), lit(table)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []column
	for rows.Next() {
		var col column
		if err := rows.Scan(&col.name, &col.typ, &col.kind, &col.expr, &col.codec, &col.comment); err != nil {
			return nil, err
		}
		out = append(out, col)
	}
	return out, nil
}

// syncColumns adds (in the same position), modifies and drops columns.
func syncColumns(sb *model.Standby, pc, sc *common.Conn, t tableInfo, exec func(what, q string)) {
	pcols, err := columns(pc, t.db, t.name)
	if err != nil {
		return
	}
	scols, err := columns(sc, t.db, t.name)
	if err != nil {
		return
	}
	have := map[string]column{}
	for _, c := range scols {
		have[c.name] = c
	}
	keep := map[string]bool{}
	name := ident(t.db, t.name)
	for i, c := range pcols {
		keep[c.name] = true
		old, ok := have[c.name]
		switch {
		case !ok:
			pos := " FIRST"
			if i > 0 {
				pos = " AFTER `" + pcols[i-1].name + "`"
			}
			exec("add column "+c.name, fmt.Sprintf("ALTER TABLE %s%s ADD COLUMN IF NOT EXISTS `%s` %s%s", name, onCluster(sb), c.name, c.spec(), pos))
		case old.spec() != c.spec():
			exec("modify column "+c.name, fmt.Sprintf("ALTER TABLE %s%s MODIFY COLUMN `%s` %s", name, onCluster(sb), c.name, c.spec()))
		}
		if (!ok && c.comment != "") || (ok && old.comment != c.comment) {
			exec("comment column "+c.name, fmt.Sprintf("ALTER TABLE %s%s COMMENT COLUMN `%s` %s", name, onCluster(sb), c.name, lit(c.comment)))
		}
	}
	for _, c := range scols {
		if !keep[c.name] {
			exec("drop column "+c.name, fmt.Sprintf("ALTER TABLE %s%s DROP COLUMN IF EXISTS `%s`", name, onCluster(sb), c.name))
		}
	}
}

type skipIndex struct{ expr, typ string }

func indexes(c *common.Conn, db, table string) (map[string]skipIndex, map[string]uint64, error) {
	rows, err := c.Query(fmt.Sprintf("SELECT name, expr, type_full, granularity FROM system.data_skipping_indices WHERE database = %s AND table = %s", lit(db), lit(table)))
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out, gran := map[string]skipIndex{}, map[string]uint64{}
	for rows.Next() {
		var n string
		var ix skipIndex
		var g uint64
		if err := rows.Scan(&n, &ix.expr, &ix.typ, &g); err != nil {
			return nil, nil, err
		}
		out[n], gran[n] = ix, g
	}
	return out, gran, nil
}

// syncIndexes adds, drops and redefines skip indexes. The primary's parts
// carry their index files, so nothing is materialized on the standby.
func syncIndexes(sb *model.Standby, pc, sc *common.Conn, t tableInfo, exec func(what, q string)) {
	pix, pgran, err := indexes(pc, t.db, t.name)
	if err != nil {
		return
	}
	six, sgran, err := indexes(sc, t.db, t.name)
	if err != nil {
		return
	}
	name := ident(t.db, t.name)
	for n, ix := range six {
		if p, ok := pix[n]; !ok || p != ix || pgran[n] != sgran[n] {
			exec("drop index "+n, fmt.Sprintf("ALTER TABLE %s%s DROP INDEX IF EXISTS `%s`", name, onCluster(sb), n))
		}
	}
	names := make([]string, 0, len(pix))
	for n := range pix {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		ix := pix[n]
		if s, ok := six[n]; ok && s == ix && sgran[n] == pgran[n] {
			continue
		}
		exec("add index "+n, fmt.Sprintf("ALTER TABLE %s%s ADD INDEX IF NOT EXISTS `%s` %s TYPE %s GRANULARITY %d", name, onCluster(sb), n, ix.expr, ix.typ, pgran[n]))
	}
}
