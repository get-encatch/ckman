package fleet

import (
	"encoding/base64"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	jsoniter "github.com/json-iterator/go"
	"github.com/pkg/errors"
)

var json = jsoniter.ConfigCompatibleWithStandardLibrary

var (
	nameRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
	labelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$`)
	pathRe  = regexp.MustCompile(`^/[A-Za-z0-9._/-]*$`)
)

// ListMachines returns all machines without their SSH passwords.
func ListMachines() ([]model.Machine, error) {
	raws, err := repository.Ps.ListFleetObjects(model.FleetKindMachine)
	if err != nil {
		return nil, err
	}
	out := make([]model.Machine, 0, len(raws))
	for _, raw := range raws {
		var m model.Machine
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, errors.Wrap(err, "decode machine")
		}
		m.SshPassword = ""
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// getMachine returns the stored machine with its password decrypted, for
// SSH use inside the service.
func getMachine(id string) (model.Machine, error) {
	raw, err := repository.Ps.GetFleetObject(model.FleetKindMachine, id)
	if err != nil {
		return model.Machine{}, err
	}
	var m model.Machine
	if err := json.Unmarshal(raw, &m); err != nil {
		return model.Machine{}, errors.Wrap(err, "decode machine")
	}
	if m.SshPassword != "" {
		m.SshPassword = common.AesDecryptECB(m.SshPassword)
	}
	return m, nil
}

// GetMachine returns one machine without its password.
func GetMachine(id string) (model.Machine, error) {
	m, err := getMachine(id)
	m.SshPassword = ""
	return m, err
}

// MachineByIP finds the machine with this IP (with its password, internal).
func MachineByIP(ip string) (model.Machine, bool) {
	all, err := ListMachines()
	if err != nil {
		return model.Machine{}, false
	}
	for _, m := range all {
		if m.IP == ip {
			full, err := getMachine(m.ID)
			return full, err == nil
		}
	}
	return model.Machine{}, false
}

func validate(m *model.Machine) error {
	m.Name = strings.TrimSpace(m.Name)
	m.IP = strings.TrimSpace(m.IP)
	m.Zone = strings.TrimSpace(m.Zone)
	if !nameRe.MatchString(m.Name) {
		return errors.New("name: letters, digits, '.', '_' or '-', up to 63 characters")
	}
	if net.ParseIP(m.IP) == nil {
		return errors.Errorf("%q is not an IP address", m.IP)
	}
	if m.Zone != "" && !nameRe.MatchString(m.Zone) {
		return errors.New("zone: letters, digits, '.', '_' or '-'")
	}
	for k, v := range m.Labels {
		if !labelRe.MatchString(k) || (v != "" && !labelRe.MatchString(v)) {
			return errors.Errorf("label %s=%s: letters, digits, '.', '_', '/' or '-'", k, v)
		}
	}
	if m.SshUser == "" {
		m.SshUser = "root"
	}
	if m.SshPort == 0 {
		m.SshPort = 22
	}
	if m.AuthenticateType != model.SshPasswordSave && m.AuthenticateType != model.SshPasswordUsePubkey {
		return errors.New("sign in with a saved password or ckman's SSH key")
	}
	if m.DataDir == "" {
		m.DataDir = model.FleetDefaultDataDir
	}
	m.DataDir = strings.TrimRight(m.DataDir, "/")
	if !pathRe.MatchString(m.DataDir) || m.DataDir == "" || m.DataDir == "/" {
		return errors.Errorf("data folder %q must be an absolute path other than /", m.DataDir)
	}
	return nil
}

// SaveMachine adds (ID empty) or updates a machine. It checks SSH and Docker
// first: an unreachable machine is refused, a machine without Docker is saved
// with status no_docker so the UI can show how to install it.
func SaveMachine(in model.Machine) (model.Machine, error) {
	if err := validate(&in); err != nil {
		return model.Machine{}, err
	}
	all, err := ListMachines()
	if err != nil {
		return model.Machine{}, err
	}
	for _, m := range all {
		if m.ID == in.ID {
			continue
		}
		if m.IP == in.IP {
			return model.Machine{}, errors.Errorf("machine %s already uses %s", m.Name, m.IP)
		}
		if m.Name == in.Name {
			return model.Machine{}, errors.Errorf("a machine is already named %s", m.Name)
		}
	}
	if in.ID == "" {
		in.ID = uuid.NewString()
		in.CreateTime = time.Now()
	} else {
		old, err := getMachine(in.ID)
		if err != nil {
			return model.Machine{}, err
		}
		in.CreateTime = old.CreateTime
		if in.SshPassword == "" {
			in.SshPassword = old.SshPassword // empty on edit = keep
		}
	}
	if in.AuthenticateType == model.SshPasswordUsePubkey {
		in.SshPassword = ""
	}
	if err := check(&in); err != nil {
		return model.Machine{}, err
	}
	return in, put(in)
}

func put(m model.Machine) error {
	m.UpdateTime = time.Now()
	if m.SshPassword != "" {
		m.SshPassword = common.AesEncryptECB(m.SshPassword)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	invalidateStats(m.ID)
	return repository.Ps.PutFleetObject(model.FleetKindMachine, m.ID, m.Name, raw)
}

// CheckMachine re-reads a machine's facts and status and saves them.
func CheckMachine(id string) (model.Machine, error) {
	m, err := getMachine(id)
	if err != nil {
		return model.Machine{}, err
	}
	if err := check(&m); err != nil {
		m.Status = model.MachineStatusUnreachable
		m.StatusMessage = err.Error()
	}
	if err := put(m); err != nil {
		return model.Machine{}, err
	}
	m.SshPassword = ""
	return m, nil
}

// DeleteMachine removes a machine from the fleet. Refused while ckman-managed
// containers run on it or a cluster uses it.
func DeleteMachine(id string) error {
	m, err := getMachine(id)
	if err != nil {
		return err
	}
	if users := ClustersOnMachine(m.IP); len(users) > 0 {
		return errors.Errorf("clusters still use %s: %s", m.Name, strings.Join(users, ", "))
	}
	if st := Stats(m, true); st.Error == "" && len(st.Containers) > 0 {
		return errors.Errorf("%d ckman containers still exist on %s", len(st.Containers), m.Name)
	}
	invalidateStats(id)
	return repository.Ps.DeleteFleetObject(model.FleetKindMachine, id)
}

// ClustersOnMachine lists the clusters with a node or Keeper on this IP.
func ClustersOnMachine(ip string) []string {
	clusters, err := repository.Ps.GetAllClusters()
	if err != nil {
		return nil
	}
	var out []string
	for name, c := range clusters {
		used := false
		for _, h := range c.Hosts {
			used = used || h == ip
		}
		if c.KeeperConf != nil {
			for _, h := range c.KeeperConf.KeeperNodes {
				used = used || h == ip
			}
		}
		if used {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func sshOpts(m model.Machine) common.SshOptions {
	return common.SshOptions{
		User:             m.SshUser,
		Password:         m.SshPassword,
		Port:             m.SshPort,
		Host:             m.IP,
		NeedSudo:         m.SshUser != "root",
		AuthenticateType: m.AuthenticateType,
	}
}

// Run runs a shell script on the machine over SSH. The script travels
// base64-encoded as one command, so ckman's sudo wrapping (which splits on
// ';') prefixes the whole script for non-root users. Errors carry the
// script's output, not the script.
func Run(m model.Machine, script string) (string, error) {
	b64 := base64.StdEncoding.EncodeToString([]byte(script))
	out, err := common.RemoteExecute(sshOpts(m), fmt.Sprintf(`sh -c "$(echo %s | base64 -d)"`, b64))
	if err != nil {
		return out, cleanErr(m, err)
	}
	return out, nil
}

// cleanErr drops the command text ckman's SSH helper puts in its errors.
func cleanErr(m model.Machine, err error) error {
	cause := errors.Cause(err).Error()
	msg := err.Error()
	if i := strings.Index(msg, " fail: "); i >= 0 {
		output := strings.TrimSpace(strings.TrimSuffix(msg[i+len(" fail: "):], ": "+cause))
		if output != "" {
			return errors.Errorf("%s: %s", m.IP, lastLines(output, 5))
		}
	}
	return errors.Errorf("%s: %s", m.IP, cause)
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "; ")
}

// check fills Facts and Status. It returns an error only when SSH fails.
func check(m *model.Machine) error {
	cmd := fmt.Sprintf(`D='%s'
mkdir -p "$D"
echo "hostname $(hostname)"
echo "arch $(uname -m)"
echo "os $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" | tr ' ' '_')"
echo "cores $(nproc)"
free -b | awk '/^Mem:/{print "mem", $2}'
df -P -B1 "$D" | awk 'NR==2{print "disk", $2}'
echo "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
true`, m.DataDir)
	out, err := Run(*m, cmd)
	if err != nil {
		return errors.Errorf("can't reach the machine over SSH (%v)", err)
	}
	f := model.MachineFacts{CheckedAt: time.Now()}
	for _, line := range strings.Split(out, "\n") {
		k, v, _ := strings.Cut(strings.TrimSpace(line), " ")
		v = strings.TrimSpace(v)
		switch k {
		case "hostname":
			f.Hostname = v
		case "arch":
			f.Arch = v
		case "os":
			f.OS = strings.ReplaceAll(v, "_", " ")
		case "cores":
			f.Cores, _ = strconv.Atoi(v)
		case "mem":
			f.MemTotal, _ = strconv.ParseUint(v, 10, 64)
		case "disk":
			f.DiskTotal, _ = strconv.ParseUint(v, 10, 64)
		case "docker":
			f.DockerVersion = v
		}
	}
	m.Facts = f
	if f.DockerVersion == "" {
		m.Status = model.MachineStatusNoDocker
		m.StatusMessage = "Docker isn't installed or isn't running"
	} else {
		m.Status = model.MachineStatusReady
		m.StatusMessage = ""
	}
	return nil
}
