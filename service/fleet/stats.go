package fleet

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/housepower/ckman/model"
)

// Containers ckman manages carry these labels.
const (
	LabelManaged   = "ckfleet.managed"
	LabelCluster   = "ckfleet.cluster"
	LabelRole      = "ckfleet.role"
	LabelDiskLimit = "ckfleet.disk_limit"
	LabelDir       = "ckfleet.dir"
)

const statsTTL = 15 * time.Second

var statsCache = struct {
	sync.Mutex
	m map[string]model.MachineStats
}{m: map[string]model.MachineStats{}}

func invalidateStats(id string) {
	statsCache.Lock()
	delete(statsCache.m, id)
	statsCache.Unlock()
}

// AllStats returns live stats for every machine, collected in parallel.
func AllStats() ([]model.MachineStats, error) {
	machines, err := ListMachines()
	if err != nil {
		return nil, err
	}
	out := make([]model.MachineStats, len(machines))
	var wg sync.WaitGroup
	for i, m := range machines {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			full, err := getMachine(id)
			if err != nil {
				out[i] = model.MachineStats{MachineID: id, Error: err.Error()}
				return
			}
			out[i] = Stats(full, false)
		}(i, m.ID)
	}
	wg.Wait()
	return out, nil
}

// MachineStatsByID returns live stats for one machine.
func MachineStatsByID(id string) (model.MachineStats, error) {
	m, err := getMachine(id)
	if err != nil {
		return model.MachineStats{}, err
	}
	return Stats(m, false), nil
}

// Stats reads the machine and its ckman containers over SSH (cached briefly
// unless fresh).
func Stats(m model.Machine, fresh bool) model.MachineStats {
	if !fresh {
		statsCache.Lock()
		if s, ok := statsCache.m[m.ID]; ok && time.Since(s.CollectedAt) < statsTTL {
			statsCache.Unlock()
			return s
		}
		statsCache.Unlock()
	}
	s := collect(m)
	statsCache.Lock()
	statsCache.m[m.ID] = s
	statsCache.Unlock()
	return s
}

func collect(m model.Machine) model.MachineStats {
	s := model.MachineStats{MachineID: m.ID, CollectedAt: time.Now(), Containers: []model.ContainerStats{}}
	f := `{{.Name}}|{{.State.Status}}|{{.Config.Image}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|` +
		`{{index .Config.Labels "%s"}}|{{index .Config.Labels "%s"}}|{{index .Config.Labels "%s"}}|{{index .Config.Labels "%s"}}`
	inspect := fmt.Sprintf(f, LabelCluster, LabelRole, LabelDiskLimit, LabelDir)
	cmd := fmt.Sprintf(`D='%s'
echo "cores $(nproc)"
echo "load $(cut -d' ' -f1 /proc/loadavg)"
cpu() { awk '/^cpu /{print $2+$3+$4+$7+$8+$9, $5+$6}' /proc/stat; }
a=$(cpu); sleep 1; echo "cpu $a $(cpu)"
free -b | awk '/^Mem:/{print "mem", $3, $2}'
df -P -B1 "$D" 2>/dev/null | awk 'NR==2{print "disk", $3, $2}'
ids=$(docker ps -aq --filter label=%s=1 2>/dev/null)
for c in $ids; do echo "ctr|$(docker inspect --format '%s' $c)"; done
run=$(docker ps -q --filter label=%s=1 2>/dev/null)
[ -n "$run" ] && docker stats --no-stream --format 'st|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' $run
for c in $ids; do d=$(docker inspect --format '{{index .Config.Labels "%s"}}' $c); [ -d "$d" ] && echo "du|$d|$(timeout 10 du -sb "$d" 2>/dev/null | cut -f1)"; done
true`, m.DataDir, LabelManaged, inspect, LabelManaged, LabelDir)
	out, err := Run(m, cmd)
	if err != nil {
		s.Error = err.Error()
		return s
	}
	byName := map[string]*model.ContainerStats{}
	du := map[string]uint64{}
	var order []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ctr|") {
			p := strings.Split(line, "|")
			if len(p) < 10 {
				continue
			}
			c := &model.ContainerStats{
				Name:    strings.TrimPrefix(p[1], "/"),
				State:   p[2],
				Image:   p[3],
				Cluster: noValue(p[6]),
				Role:    noValue(p[7]),
				Dir:     noValue(p[9]),
			}
			if n, err := strconv.ParseFloat(p[4], 64); err == nil {
				c.CPULimit = n / 1e9
			}
			c.MemLimit, _ = strconv.ParseUint(p[5], 10, 64)
			c.DiskLimit, _ = strconv.ParseUint(noValue(p[8]), 10, 64)
			byName[c.Name] = c
			order = append(order, c.Name)
			continue
		}
		if strings.HasPrefix(line, "st|") {
			p := strings.Split(line, "|")
			if len(p) < 4 {
				continue
			}
			if c := byName[p[1]]; c != nil {
				c.CPUPercent, _ = strconv.ParseFloat(strings.TrimSuffix(p[2], "%"), 64)
				used, _, _ := strings.Cut(p[3], "/")
				c.MemUsed = parseSize(used)
			}
			continue
		}
		if strings.HasPrefix(line, "du|") {
			p := strings.Split(line, "|")
			if len(p) == 3 {
				du[p[1]], _ = strconv.ParseUint(p[2], 10, 64)
			}
			continue
		}
		k, v, _ := strings.Cut(line, " ")
		fs := strings.Fields(v)
		switch k {
		case "cores":
			s.Cores, _ = strconv.Atoi(v)
		case "load":
			s.Load1, _ = strconv.ParseFloat(v, 64)
		case "cpu":
			s.CPUUsed = cpuBusy(fs)
		case "mem":
			if len(fs) == 2 {
				s.MemUsed, _ = strconv.ParseUint(fs[0], 10, 64)
				s.MemTotal, _ = strconv.ParseUint(fs[1], 10, 64)
			}
		case "disk":
			if len(fs) == 2 {
				s.DiskUsed, _ = strconv.ParseUint(fs[0], 10, 64)
				s.DiskTotal, _ = strconv.ParseUint(fs[1], 10, 64)
			}
		}
	}
	s.CPUUsed *= float64(s.Cores)
	for _, name := range order {
		c := byName[name]
		c.DiskUsed = du[c.Dir]
		s.ReservedCPU += c.CPULimit
		s.ReservedMem += c.MemLimit
		s.ReservedDisk += c.DiskLimit
		s.Containers = append(s.Containers, *c)
	}
	return s
}

func noValue(v string) string {
	if v == "<no value>" {
		return ""
	}
	return v
}

// parseSize reads docker's human sizes: "12.5MiB", "1.2GiB", "800kB", "3B".
func parseSize(v string) uint64 {
	v = strings.TrimSpace(v)
	units := []struct {
		suffix string
		mult   float64
	}{
		{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30}, {"TiB", 1 << 40},
		{"kB", 1e3}, {"KB", 1e3}, {"MB", 1e6}, {"GB", 1e9}, {"TB", 1e12}, {"B", 1},
	}
	for _, u := range units {
		if strings.HasSuffix(v, u.suffix) {
			n, err := strconv.ParseFloat(strings.TrimSuffix(v, u.suffix), 64)
			if err != nil {
				return 0
			}
			return uint64(n * u.mult)
		}
	}
	n, _ := strconv.ParseFloat(v, 64)
	return uint64(n)
}

// cpuBusy turns two /proc/stat samples (busy idle busy idle) into the share
// of time the CPUs were busy (0..1); the caller scales it by cores.
func cpuBusy(f []string) float64 {
	if len(f) != 4 {
		return 0
	}
	var n [4]float64
	for i, v := range f {
		n[i], _ = strconv.ParseFloat(v, 64)
	}
	busy, idle := n[2]-n[0], n[3]-n[1]
	if busy+idle <= 0 {
		return 0
	}
	return busy / (busy + idle)
}
