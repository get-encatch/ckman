package deploy

import (
	"fmt"
	"math"
	"path"
	"strings"
	"sync"

	"github.com/housepower/ckman/ckconfig"
	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
	"github.com/pkg/errors"
)

// Docker mode: each cluster has a root folder <machine data dir>/<cluster>/
// (conf.Cwd, also conf.Path and KeeperConf.Path) on every machine. It is
// mounted into the containers at the same path, so the configs ckman
// generates (paths under Cwd and Path) are valid inside the container too.
// The containers use host networking with the cluster's own port block.

const (
	roleClickHouse = "clickhouse"
	roleKeeper     = "keeper"
	clickhouseUID  = "101:101" // the clickhouse user in the official images
)

func dockerSsh(conf *model.CKManClickHouseConfig, host string) common.SshOptions {
	return common.SshOptions{
		User:             conf.SshUser,
		Password:         conf.SshPassword,
		Port:             conf.SshPort,
		Host:             host,
		NeedSudo:         conf.SshUser != "root",
		AuthenticateType: conf.AuthenticateType,
	}
}

// dockerOnHosts runs a script (built per host) on every host in parallel.
func dockerOnHosts(conf *model.CKManClickHouseConfig, hosts []string, step string, script func(host string) string) error {
	var wg sync.WaitGroup
	var mu sync.Mutex
	var errs []string
	for _, host := range hosts {
		innerHost := host
		wg.Add(1)
		_ = common.Pool.Submit(func() {
			defer wg.Done()
			if out, err := common.RemoteExecute(dockerSsh(conf, innerHost), common.ScriptCmd(script(innerHost))); err != nil {
				mu.Lock()
				errs = append(errs, fmt.Sprintf("%s: %s", innerHost, lastLine(out, err)))
				mu.Unlock()
				return
			}
			log.Logger.Debugf("[docker] %s %s done", innerHost, step)
		})
	}
	wg.Wait()
	if len(errs) > 0 {
		return errors.Errorf("%s failed: %s", step, strings.Join(errs, "; "))
	}
	log.Logger.Infof("[docker] %s done", step)
	return nil
}

func lastLine(out string, err error) string {
	if s := strings.TrimSpace(out); s != "" {
		lines := strings.Split(s, "\n")
		return lines[len(lines)-1]
	}
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && i+2 < len(msg) {
		return msg[i+2:]
	}
	return msg
}

func dockerRoot(conf *model.CKManClickHouseConfig) string {
	return strings.TrimRight(conf.Cwd, "/")
}

type roleSpec struct {
	name      string
	image     string
	cpu       float64
	memMB     int
	diskGB    int
	dataDir   string   // what disk usage is measured on
	dirs      []string // created (and given to the clickhouse user) on install
	mounts    []string // host:container besides the root
	configs   []string // config folders: given to the clickhouse user before each start
	env       []string
	removable []string // removed on uninstall
}

func spec(conf *model.CKManClickHouseConfig, role string) roleSpec {
	r := dockerRoot(conf)
	d := conf.Docker
	if role == roleKeeper {
		return roleSpec{
			name:      model.ContainerName(conf.Cluster, roleKeeper),
			image:     d.KeeperImage + ":" + conf.Version,
			cpu:       d.KeeperCPU,
			memMB:     d.KeeperMemoryMB,
			diskGB:    d.KeeperDiskGB,
			dataDir:   path.Join(r, "clickhouse-keeper"),
			dirs:      []string{path.Join(r, "clickhouse-keeper"), path.Join(r, "log", "clickhouse-keeper"), path.Join(r, "etc", "clickhouse-keeper")},
			mounts:    []string{path.Join(r, "etc", "clickhouse-keeper") + ":/etc/clickhouse-keeper"},
			configs:   []string{path.Join(r, "etc", "clickhouse-keeper")},
			removable: []string{path.Join(r, "clickhouse-keeper"), path.Join(r, "log", "clickhouse-keeper"), path.Join(r, "etc", "clickhouse-keeper")},
		}
	}
	etc := path.Join(r, "etc", "clickhouse-server")
	return roleSpec{
		name:    model.ContainerName(conf.Cluster, roleClickHouse),
		image:   d.Image + ":" + conf.Version,
		cpu:     d.CPU,
		memMB:   d.MemoryMB,
		diskGB:  d.DiskGB,
		dataDir: path.Join(r, "clickhouse"),
		dirs: []string{path.Join(r, "clickhouse"), path.Join(r, "log", "clickhouse-server"),
			path.Join(etc, "config.d"), path.Join(etc, "users.d")},
		mounts: []string{path.Join(etc, "config.d") + ":/etc/clickhouse-server/config.d",
			path.Join(etc, "users.d") + ":/etc/clickhouse-server/users.d"},
		configs: []string{etc},
		// the image would otherwise write a users.d file limiting "default" to localhost
		env:       []string{"CLICKHOUSE_SKIP_USER_SETUP=1"},
		removable: []string{path.Join(r, "clickhouse"), path.Join(r, "log", "clickhouse-server"), etc},
	}
}

// sized is the spec with one instance's limits.
func (s roleSpec) sized(z model.Size) roleSpec {
	s.cpu, s.memMB, s.diskGB = z.CPU, z.MemoryMB, z.DiskGB
	return s
}

// runCmd is the docker run that creates the container.
func runCmd(conf *model.CKManClickHouseConfig, s roleSpec) string {
	r := dockerRoot(conf)
	args := []string{"docker run -d", "--name " + s.name, "--network host", "--restart unless-stopped",
		"--ulimit nofile=262144:262144", "--cap-add SYS_NICE", "--cap-add NET_ADMIN", "--cap-add IPC_LOCK",
		fmt.Sprintf("-v %s:%s", r, r)}
	for _, m := range s.mounts {
		args = append(args, "-v "+m)
	}
	for _, e := range s.env {
		args = append(args, "-e "+e)
	}
	if s.cpu > 0 {
		args = append(args, fmt.Sprintf("--cpus %g", s.cpu))
	}
	if s.memMB > 0 {
		args = append(args, fmt.Sprintf("--memory %dm --memory-swap %dm", s.memMB, s.memMB))
	}
	labels := map[string]string{
		"ckfleet.managed": "1",
		"ckfleet.cluster": conf.Cluster,
		"ckfleet.role":    strings.TrimPrefix(s.name, "ckf-"+conf.Cluster+"-"),
		"ckfleet.dir":     s.dataDir,
	}
	if s.diskGB > 0 {
		labels["ckfleet.disk_limit"] = fmt.Sprintf("%d", int64(s.diskGB)<<30)
	}
	for _, k := range []string{"ckfleet.managed", "ckfleet.cluster", "ckfleet.role", "ckfleet.dir", "ckfleet.disk_limit"} {
		if v, ok := labels[k]; ok {
			args = append(args, fmt.Sprintf("--label %s=%s", k, v))
		}
	}
	args = append(args, s.image)
	return strings.Join(args, " ")
}

func pullScript(image string) string {
	return fmt.Sprintf("docker image inspect %s >/dev/null 2>&1 || docker pull -q %s >/dev/null", image, image)
}

func installScript(s roleSpec) string {
	return fmt.Sprintf("docker rm -f %s >/dev/null 2>&1\nmkdir -p %s\nchown -R %s %s",
		s.name, strings.Join(s.dirs, " "), clickhouseUID, strings.Join(s.dirs, " "))
}

func startScript(conf *model.CKManClickHouseConfig, s roleSpec) string {
	// ckman uploads configs as root with mode 0600; they hold passwords, so
	// they go to the clickhouse user rather than becoming world-readable.
	// An existing container is started as is; otherwise it is created.
	return fmt.Sprintf("chown -R %s %s\ndocker start %s >/dev/null 2>&1 || %s >/dev/null",
		clickhouseUID, strings.Join(s.configs, " "), s.name, runCmd(conf, s))
}

func uninstallScript(conf *model.CKManClickHouseConfig, s roleSpec) string {
	r := dockerRoot(conf)
	return fmt.Sprintf("docker rm -f %s >/dev/null 2>&1\nrm -rf %s\nrmdir %s %s %s 2>/dev/null\ntrue",
		s.name, strings.Join(s.removable, " "), path.Join(r, "etc"), path.Join(r, "log"), r)
}

// limitsHostInfo: ClickHouse sizes pools and memory settings from the host;
// in Docker mode the container's limits are the host.
func limitsHostInfo(conf *model.CKManClickHouseConfig, infos []ckconfig.HostInfo, ext *model.CkDeployExt) {
	d := conf.Docker
	if d == nil {
		return
	}
	for i := range infos {
		z := d.ServerDefault()
		if i < len(conf.Hosts) {
			z = d.ServerSize(conf.Hosts[i])
		}
		if z.MemoryMB > 0 {
			infos[i].MemoryTotal = z.MemoryMB * 1024 // KiB, like /proc/meminfo
		}
		if z.CPU > 0 {
			infos[i].NumCPU = int(math.Ceil(z.CPU))
			ext.NumCPU = common.MaxInt(ext.NumCPU, infos[i].NumCPU)
		}
	}
}

// ─── ClickHouse ──────────────────────────────────────────────────────────────

func (d *CKDeploy) dockerPrepare() error {
	s := spec(d.Conf, roleClickHouse)
	return dockerOnHosts(d.Conf, d.Conf.Hosts, "pull "+s.image, func(string) string { return pullScript(s.image) })
}

func (d *CKDeploy) dockerInstall() error {
	s := spec(d.Conf, roleClickHouse)
	return dockerOnHosts(d.Conf, d.Conf.Hosts, "install", func(string) string { return installScript(s) })
}

func (d *CKDeploy) dockerStart() error {
	s := spec(d.Conf, roleClickHouse)
	return dockerOnHosts(d.Conf, d.Conf.Hosts, "start", func(host string) string {
		return startScript(d.Conf, s.sized(d.Conf.Docker.ServerSize(host)))
	})
}

func (d *CKDeploy) dockerStop() error {
	s := spec(d.Conf, roleClickHouse)
	return dockerOnHosts(d.Conf, d.Conf.Hosts, "stop", func(string) string {
		return fmt.Sprintf("docker stop -t 60 %s >/dev/null 2>&1\ntrue", s.name)
	})
}

func (d *CKDeploy) dockerRestart() error {
	s := spec(d.Conf, roleClickHouse)
	return dockerOnHosts(d.Conf, d.Conf.Hosts, "restart", func(string) string {
		return fmt.Sprintf("docker restart -t 60 %s >/dev/null", s.name)
	})
}

// dockerUpgrade removes the container; Start then creates it from the new
// image (Prepare has pulled it). Data and configs stay on the machine.
func (d *CKDeploy) dockerUpgrade() error {
	s := spec(d.Conf, roleClickHouse)
	return dockerOnHosts(d.Conf, d.Conf.Hosts, "upgrade", func(string) string {
		return fmt.Sprintf("docker rm -f %s >/dev/null 2>&1\ntrue", s.name)
	})
}

func (d *CKDeploy) dockerUninstall() error {
	s := spec(d.Conf, roleClickHouse)
	return dockerOnHosts(d.Conf, d.Conf.Hosts, "uninstall", func(string) string { return uninstallScript(d.Conf, s) })
}

// ─── Keeper ──────────────────────────────────────────────────────────────────

func (d *KeeperDeploy) dockerHosts() []string { return d.targets() }

func (d *KeeperDeploy) dockerPrepare() error {
	s := spec(d.Conf, roleKeeper)
	return dockerOnHosts(d.Conf, d.dockerHosts(), "pull "+s.image, func(string) string { return pullScript(s.image) })
}

func (d *KeeperDeploy) dockerInstall() error {
	s := spec(d.Conf, roleKeeper)
	return dockerOnHosts(d.Conf, d.dockerHosts(), "install keeper", func(string) string { return installScript(s) })
}

func (d *KeeperDeploy) dockerStart() error {
	s := spec(d.Conf, roleKeeper)
	return dockerOnHosts(d.Conf, d.dockerHosts(), "start keeper", func(host string) string {
		return startScript(d.Conf, s.sized(d.Conf.Docker.KeeperSize(host)))
	})
}

func (d *KeeperDeploy) dockerStop() error {
	s := spec(d.Conf, roleKeeper)
	return dockerOnHosts(d.Conf, d.dockerHosts(), "stop keeper", func(string) string {
		return fmt.Sprintf("docker stop -t 30 %s >/dev/null 2>&1\ntrue", s.name)
	})
}

func (d *KeeperDeploy) dockerRestart() error {
	s := spec(d.Conf, roleKeeper)
	return dockerOnHosts(d.Conf, d.dockerHosts(), "restart keeper", func(string) string {
		return fmt.Sprintf("docker restart -t 30 %s >/dev/null", s.name)
	})
}

func (d *KeeperDeploy) dockerUpgrade() error {
	s := spec(d.Conf, roleKeeper)
	return dockerOnHosts(d.Conf, d.dockerHosts(), "upgrade keeper", func(string) string {
		return fmt.Sprintf("docker rm -f %s >/dev/null 2>&1\ntrue", s.name)
	})
}

func (d *KeeperDeploy) dockerUninstall() error {
	s := spec(d.Conf, roleKeeper)
	return dockerOnHosts(d.Conf, d.dockerHosts(), "uninstall keeper", func(string) string { return uninstallScript(d.Conf, s) })
}

func ownConfigs(conf *model.CKManClickHouseConfig, hosts []string, role string) error {
	s := spec(conf, role)
	return dockerOnHosts(conf, hosts, "own "+role+" configs", func(string) string {
		return fmt.Sprintf("chown -R %s %s", clickhouseUID, strings.Join(s.configs, " "))
	})
}

func (d *CKDeploy) dockerOwnConfigs() error { return ownConfigs(d.Conf, d.Conf.Hosts, roleClickHouse) }

func (d *KeeperDeploy) dockerOwnConfigs() error {
	return ownConfigs(d.Conf, d.dockerHosts(), roleKeeper)
}
