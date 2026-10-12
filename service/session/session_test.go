package session

import (
	"testing"
	"time"

	"github.com/housepower/ckman/common"
	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/repository/sqlite"
)

func setup(t *testing.T) {
	log.InitLoggerConsole()
	sp := sqlite.NewSQLitePersistent()
	if err := sp.Init(sqlite.LocalConfig{ConfigDir: t.TempDir(), ConfigFile: "s"}); err != nil {
		t.Fatal(err)
	}
	repository.Ps = sp
	mu.Lock()
	cache = map[string]*entry{}
	mu.Unlock()
}

// forget drops the in-memory cache, like a ckman restart or another instance.
func forget() {
	mu.Lock()
	cache = map[string]*entry{}
	mu.Unlock()
}

func TestSessionsSurviveRestart(t *testing.T) {
	setup(t)
	if err := Create("tok-a", "alice", time.Hour); err != nil {
		t.Fatal(err)
	}
	forget()
	if !Valid("tok-a") {
		t.Fatal("session lost after restart")
	}
	if Valid("tok-unknown") {
		t.Fatal("unknown token accepted")
	}
	Delete("tok-a")
	forget()
	if Valid("tok-a") {
		t.Fatal("logged-out session still valid")
	}
}

func TestSessionExpiryAndTouch(t *testing.T) {
	setup(t)
	if err := Create("tok-b", "bob", time.Second); err != nil {
		t.Fatal(err)
	}
	Touch("tok-b", time.Hour) // moves far enough to be written back
	forget()
	time.Sleep(1100 * time.Millisecond)
	if !Valid("tok-b") {
		t.Fatal("touched session expired")
	}
	if err := Create("tok-c", "bob", time.Second); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1100 * time.Millisecond)
	forget()
	if Valid("tok-c") {
		t.Fatal("expired session accepted")
	}
	Sweep()
	if len(all()) != 1 {
		t.Fatalf("sweep left %d sessions, want 1", len(all()))
	}
}

func TestDeleteUserKeepsCurrent(t *testing.T) {
	setup(t)
	for _, tok := range []string{"t1", "t2", "t3"} {
		if err := Create(tok, "carol", time.Hour); err != nil {
			t.Fatal(err)
		}
	}
	_ = Create("t4", "dave", time.Hour)
	DeleteUser("carol", "t2")
	forget()
	if Valid("t1") || Valid("t3") || !Valid("t2") || !Valid("t4") {
		t.Fatalf("t1=%v t2=%v t3=%v t4=%v", Valid("t1"), Valid("t2"), Valid("t3"), Valid("t4"))
	}
}

func TestSigningKeyIsRandomAndStable(t *testing.T) {
	setup(t)
	if err := LoadSigningKey(); err != nil {
		t.Fatal(err)
	}
	j := common.NewJWT()
	tok, err := j.CreateToken(common.CustomClaims{Name: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if err := LoadSigningKey(); err != nil { // second start: same key
		t.Fatal(err)
	}
	if _, code := common.NewJWT().ParserToken(tok); code != "0000" {
		t.Fatalf("token from before the restart rejected: %s", code)
	}
	common.SetSigningKey([]byte("change me")) // the old public default
	if _, code := common.NewJWT().ParserToken(tok); code == "0000" {
		t.Fatal("token verifies with the public default key")
	}
}
