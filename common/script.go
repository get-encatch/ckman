package common

import (
	"encoding/base64"
	"fmt"
)

// ScriptCmd wraps a multi-line shell script as a single command (base64 piped
// into sh), so RemoteExecute's sudo wrapping, which splits on ';', prefixes
// the whole script for non-root users.
func ScriptCmd(script string) string {
	b64 := base64.StdEncoding.EncodeToString([]byte(script))
	return fmt.Sprintf(`sh -c "$(echo %s | base64 -d)"`, b64)
}
