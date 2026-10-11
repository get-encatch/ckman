package fleet

import (
	"fmt"
	"sync"

	"github.com/housepower/ckman/model"
)

// Container returns the live stats of a cluster's container ("clickhouse" or
// "keeper") on the machine with this IP, from the cached machine stats.
func Container(cluster, role, ip string) (model.ContainerStats, bool) {
	m, ok := MachineByIP(ip)
	if !ok {
		return model.ContainerStats{}, false
	}
	name := model.ContainerName(cluster, role)
	for _, c := range Stats(m, false).Containers {
		if c.Name == name {
			return c, true
		}
	}
	return model.ContainerStats{}, false
}

// HumanBytes formats like the UI's parser expects: "1.50 GiB".
func HumanBytes(n uint64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB", "PiB"}
	v := float64(n)
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	return fmt.Sprintf("%.2f %s", v, units[i])
}

// WarmStats reads the machines behind these IPs in parallel, so per-node
// lookups that follow hit the cache instead of SSHing one by one.
func WarmStats(ips []string) {
	var wg sync.WaitGroup
	for _, ip := range ips {
		m, ok := MachineByIP(ip)
		if !ok {
			continue
		}
		wg.Add(1)
		go func(m model.Machine) {
			defer wg.Done()
			Stats(m, false)
		}(m)
	}
	wg.Wait()
}
