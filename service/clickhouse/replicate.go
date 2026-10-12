package clickhouse

import (
	"sort"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/model"
	"github.com/pkg/errors"
)

// Plain MergeTree tables keep their data on one server only: a replica added
// to the shard gets an empty copy. ckman lists them so the UI can warn; which
// engine a table uses stays the user's choice.

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
