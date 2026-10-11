package clickhouse

import (
	"fmt"
	"sort"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/model"
	"github.com/pkg/errors"
)

// Plain MergeTree tables keep their data on one server only: a replica added
// to the shard gets an empty copy. These helpers find such tables and convert
// them in place with ATTACH TABLE ... AS REPLICATED (no server restart).

type UnreplicatedHost struct {
	Host  string `json:"host"`
	Shard int    `json:"shard"`
	Rows  uint64 `json:"rows"`
}

type UnreplicatedTable struct {
	Database string             `json:"database"`
	Table    string             `json:"table"`
	Engine   string             `json:"engine"`
	Hosts    []UnreplicatedHost `json:"hosts"`
}

const unreplicatedSQL = `SELECT database, name, engine, ifNull(total_rows, 0)
FROM system.tables
WHERE engine LIKE '%MergeTree' AND engine NOT LIKE 'Replicated%' AND engine NOT LIKE 'Shared%'
  AND is_temporary = 0
  AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
ORDER BY database, name`

// ListUnreplicatedTables returns the MergeTree-family tables that are not
// replicated, with their row count on every server that has them.
func ListUnreplicatedTables(conf *model.CKManClickHouseConfig) ([]UnreplicatedTable, error) {
	byName := map[string]*UnreplicatedTable{}
	for i, shard := range conf.Shards {
		for _, r := range shard.Replicas {
			conn, err := common.ConnectClickHouse(r.Ip, model.ClickHouseDefaultDB, conf.GetConnOption())
			if err != nil {
				return nil, errors.Wrapf(err, "connect to %s", r.Ip)
			}
			rows, err := conn.Query(unreplicatedSQL)
			if err != nil {
				return nil, errors.Wrap(err, r.Ip)
			}
			for rows.Next() {
				var db, tbl, engine string
				var n uint64
				if err := rows.Scan(&db, &tbl, &engine, &n); err != nil {
					rows.Close()
					return nil, errors.Wrap(err, r.Ip)
				}
				key := db + "." + tbl
				t := byName[key]
				if t == nil {
					t = &UnreplicatedTable{Database: db, Table: tbl, Engine: engine}
					byName[key] = t
				}
				t.Hosts = append(t.Hosts, UnreplicatedHost{Host: r.Ip, Shard: i + 1, Rows: n})
			}
			rows.Close()
		}
	}
	out := make([]UnreplicatedTable, 0, len(byName))
	for _, t := range byName {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Database != out[j].Database {
			return out[i].Database < out[j].Database
		}
		return out[i].Table < out[j].Table
	})
	return out, nil
}

// ConvertToReplicated turns database.table into its Replicated* engine on every
// server. In each shard the server holding the rows converts first and
// registers its parts in Keeper; the other replicas (empty) then join and
// fetch them. A shard where more than one replica has rows is refused: their
// data would be merged into one copy with duplicates.
func ConvertToReplicated(conf *model.CKManClickHouseConfig, database, table string) ([]string, error) {
	tables, err := ListUnreplicatedTables(conf)
	if err != nil {
		return nil, err
	}
	var t *UnreplicatedTable
	for i := range tables {
		if tables[i].Database == database && tables[i].Table == table {
			t = &tables[i]
		}
	}
	if t == nil {
		return nil, errors.Errorf("%s.%s is not a non-replicated MergeTree table on any server", database, table)
	}
	name := fmt.Sprintf("`%s`.`%s`", database, table)

	// per shard: the server with rows first
	var order []UnreplicatedHost
	for s := 1; s <= len(conf.Shards); s++ {
		var hosts []UnreplicatedHost
		withRows := 0
		for _, h := range t.Hosts {
			if h.Shard == s {
				hosts = append(hosts, h)
				if h.Rows > 0 {
					withRows++
				}
			}
		}
		if withRows > 1 {
			return nil, errors.Errorf("shard %d: more than one replica has rows in %s.%s; empty all but one first", s, database, table)
		}
		sort.SliceStable(hosts, func(i, j int) bool { return hosts[i].Rows > hosts[j].Rows })
		order = append(order, hosts...)
	}

	var done []string
	for _, h := range order {
		conn, err := common.ConnectClickHouse(h.Host, model.ClickHouseDefaultDB, conf.GetConnOption())
		if err != nil {
			return done, errors.Wrapf(err, "connect to %s", h.Host)
		}
		if err := conn.Exec("DETACH TABLE " + name); err != nil {
			return done, errors.Wrapf(err, "%s: detach", h.Host)
		}
		if err := conn.Exec("ATTACH TABLE " + name + " AS REPLICATED"); err != nil {
			_ = conn.Exec("ATTACH TABLE " + name) // put the table back as it was
			return done, errors.Wrapf(err, "%s: attach as replicated", h.Host)
		}
		if err := conn.Exec("SYSTEM RESTORE REPLICA " + name); err != nil {
			return done, errors.Wrapf(err, "%s: register in Keeper", h.Host)
		}
		done = append(done, h.Host)
	}
	return done, nil
}
