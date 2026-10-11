package zookeeper

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/model"
)

// KeeperHostStats is the health of one ClickHouse Keeper server: the machine
// (CPU load, memory, the volume holding Keeper's data) and the Keeper process.
// Keeper has no metrics endpoint by default, so ckman reads these over SSH.
type KeeperHostStats struct {
	Host      string  `json:"host"`
	Cores     int     `json:"cores"`
	Load1     float64 `json:"load1"`
	MemUsed   uint64  `json:"mem_used"`
	MemTotal  uint64  `json:"mem_total"`
	DiskUsed  uint64  `json:"disk_used"`  // the whole volume holding the Keeper path
	DiskTotal uint64  `json:"disk_total"` // servers sharing a disk report the same
	DataBytes uint64  `json:"data_bytes"` // Keeper's own logs and snapshots
	ProcRSS   uint64  `json:"proc_rss"`   // Keeper process memory
	Error     string  `json:"error,omitempty"`
}

const keeperStatsTTL = 15 * time.Second

var keeperStatsCache = struct {
	sync.Mutex
	m map[string]keeperStatsEntry
}{m: map[string]keeperStatsEntry{}}

type keeperStatsEntry struct {
	at    time.Time
	stats []KeeperHostStats
}

// GetKeeperHostStats returns per-server stats for the cluster's ClickHouse
// Keeper servers, cached briefly so polling pages don't open SSH sessions on
// every refresh. External ZooKeeper isn't covered: ckman doesn't manage it.
func GetKeeperHostStats(conf *model.CKManClickHouseConfig) []KeeperHostStats {
	if conf.Keeper != model.ClickhouseKeeper || conf.KeeperConf == nil {
		return nil
	}
	keeperStatsCache.Lock()
	if e, ok := keeperStatsCache.m[conf.Cluster]; ok && time.Since(e.at) < keeperStatsTTL {
		keeperStatsCache.Unlock()
		return e.stats
	}
	keeperStatsCache.Unlock()

	nodes := conf.KeeperConf.KeeperNodes
	out := make([]KeeperHostStats, len(nodes))
	var wg sync.WaitGroup
	for i, host := range nodes {
		wg.Add(1)
		go func(i int, host string) {
			defer wg.Done()
			out[i] = keeperHostStats(conf, host)
		}(i, host)
	}
	wg.Wait()

	keeperStatsCache.Lock()
	keeperStatsCache.m[conf.Cluster] = keeperStatsEntry{at: time.Now(), stats: out}
	keeperStatsCache.Unlock()
	return out
}

func keeperHostStats(conf *model.CKManClickHouseConfig, host string) KeeperHostStats {
	s := KeeperHostStats{Host: host}
	path := conf.KeeperConf.Path
	if path == "" {
		path = "/"
	}
	cmd := fmt.Sprintf(`P='%s'
echo "cores $(nproc)"
echo "load $(cut -d' ' -f1 /proc/loadavg)"
free -b | awk '/^Mem:/{print "mem", $3, $2}'
df -P -B1 "$P" | awk 'NR==2{print "disk", $3, $2}'
echo "data $(du -sb "$P" 2>/dev/null | cut -f1)"
pid=$(pgrep -o -f 'clickhouse-keeper.*--config')
[ -n "$pid" ] && echo "rss $(ps -o rss= -p $pid)"
true`, strings.ReplaceAll(path, "'", ""))
	output, err := common.RemoteExecute(common.SshOptions{
		User:             conf.SshUser,
		Password:         conf.SshPassword,
		Port:             conf.SshPort,
		Host:             host,
		NeedSudo:         conf.NeedSudo,
		AuthenticateType: conf.AuthenticateType,
	}, cmd)
	if err != nil {
		s.Error = err.Error()
		return s
	}
	u := func(v string) uint64 { n, _ := strconv.ParseUint(strings.TrimSpace(v), 10, 64); return n }
	for _, line := range strings.Split(output, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		switch f[0] {
		case "cores":
			s.Cores = int(u(f[1]))
		case "load":
			s.Load1, _ = strconv.ParseFloat(f[1], 64)
		case "mem":
			if len(f) == 3 {
				s.MemUsed, s.MemTotal = u(f[1]), u(f[2])
			}
		case "disk":
			if len(f) == 3 {
				s.DiskUsed, s.DiskTotal = u(f[1]), u(f[2])
			}
		case "data":
			s.DataBytes = u(f[1])
		case "rss":
			s.ProcRSS = u(f[1]) * 1024
		}
	}
	return s
}
