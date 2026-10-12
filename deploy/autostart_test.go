package deploy

import (
	"os/exec"
	"strings"
	"testing"
)

func TestAutostartScriptIsValidShell(t *testing.T) {
	for _, start := range []string{"/opt/ck/bin/clickhouse-server --config-file=/opt/ck/etc/a.xml --daemon; echo ok", ""} {
		script := autostartScript("/opt/ck/", "clickhouse-server", start)
		if out, err := exec.Command("sh", "-n", "-c", script).CombinedOutput(); err != nil {
			t.Fatalf("invalid shell (%v): %s\n%s", err, out, script)
		}
		if start != "" && !strings.Contains(script, "ckman-autostart /opt/ck clickhouse-server") {
			t.Fatalf("no tag: %s", script)
		}
	}
}
