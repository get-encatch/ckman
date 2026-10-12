package deploy

import (
	"encoding/base64"
	"fmt"
	"hash/crc32"
	"path"
	"strings"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/log"
)

// Package-installed (tgz) servers are plain processes with no service
// manager, so a reboot left them down. Start enables an autostart that runs
// ckman's own start command at boot: a oneshot systemd unit when systemd
// runs and we are root, else a crontab @reboot entry. Stop and Uninstall
// remove it, so a cluster stopped on purpose stays stopped. Each install
// folder and server gets its own unit or entry.

func autostartNames(cwd, svr string) (runner, unit, tag string) {
	cwd = strings.TrimRight(cwd, "/")
	runner = path.Join(cwd, "bin", "ckman-start-"+svr+".sh")
	unit = fmt.Sprintf("ckman-%08x-%s.service", crc32.ChecksumIEEE([]byte(cwd)), svr)
	tag = "ckman-autostart " + cwd + " " + svr
	return
}

// autostartScript enables (startCmd set) or removes the autostart.
func autostartScript(cwd, svr, startCmd string) string {
	runner, unit, tag := autostartNames(cwd, svr)
	var b strings.Builder
	fmt.Fprintf(&b, "unit=/etc/systemd/system/%s\n", unit)
	// always start from a clean slate: no unit, no crontab entry
	fmt.Fprintf(&b, "if [ -f $unit ]; then systemctl disable %s >/dev/null 2>&1; rm -f $unit; systemctl daemon-reload; fi\n", unit)
	fmt.Fprintf(&b, "if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF '# %s'; then crontab -l 2>/dev/null | grep -vF '# %s' | crontab -; fi\n", tag, tag)
	if startCmd == "" {
		fmt.Fprintf(&b, "rm -f %s\n", runner)
		return b.String()
	}
	script := base64.StdEncoding.EncodeToString([]byte("#!/bin/sh\n" + startCmd + "\n"))
	fmt.Fprintf(&b, "echo %s | base64 -d > %s && chmod 755 %s\n", script, runner, runner)
	fmt.Fprintf(&b, `if [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ]; then
  printf '[Unit]\nDescription=Start %s in %s (ckman)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=%s\n\n[Install]\nWantedBy=multi-user.target\n' > $unit
  systemctl daemon-reload && systemctl enable %s >/dev/null 2>&1 && echo systemd
elif command -v crontab >/dev/null 2>&1; then
  (crontab -l 2>/dev/null; echo '@reboot %s # %s') | crontab - && echo cron
else
  echo 'no systemd (as root) or cron: %s will not start after a reboot' >&2
fi
`, svr, path.Dir(path.Dir(runner)), runner, unit, runner, tag, svr)
	return b.String()
}

// setAutostart enables or removes the autostart on one host; failures only
// warn, they never fail a start or stop.
func setAutostart(sshOpts common.SshOptions, cwd, svr, startCmd string) {
	out, err := common.RemoteExecute(sshOpts, common.ScriptCmd(autostartScript(cwd, svr, startCmd)))
	switch {
	case err != nil:
		log.Logger.Warnf("[%s] %s autostart after reboot: %v", sshOpts.Host, svr, err)
	case startCmd != "":
		log.Logger.Infof("[%s] %s starts after a reboot (%s)", sshOpts.Host, svr, strings.TrimSpace(out))
	}
}
