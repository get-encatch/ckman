// Package session keeps login sessions in ckman's database, so they survive
// a restart and are shared by every ckman instance. A short in-memory cache
// in front keeps requests from hitting the database: an entry is trusted
// for cacheFor, then checked again (so a logout or revoke on one instance
// reaches the others within that time), and the sliding expiry is written
// back only when it has moved by a tenth of the session timeout.
package session

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"

	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/repository"
	jsoniter "github.com/json-iterator/go"
)

var json = jsoniter.ConfigCompatibleWithStandardLibrary

const (
	kind     = "session"
	cacheFor = time.Minute
)

// record is what the database holds: never the token itself, only its hash.
type record struct {
	ID      string `json:"id"`
	User    string `json:"user"`
	Expires int64  `json:"expires"` // unix seconds
}

type entry struct {
	record
	checked time.Time // when the database last confirmed it
	saved   int64     // expiry last written to the database
}

var (
	mu    sync.Mutex
	cache = map[string]*entry{}
)

func id(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func put(r record) error {
	body, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return repository.Ps.PutFleetObject(kind, r.ID, r.User, body)
}

// Create starts a session for user.
func Create(token, user string, ttl time.Duration) error {
	r := record{ID: id(token), User: user, Expires: time.Now().Add(ttl).Unix()}
	if err := put(r); err != nil {
		return err
	}
	mu.Lock()
	cache[r.ID] = &entry{record: r, checked: time.Now(), saved: r.Expires}
	mu.Unlock()
	return nil
}

// Valid reports whether token belongs to a live session.
func Valid(token string) bool {
	key := id(token)
	now := time.Now()
	mu.Lock()
	e := cache[key]
	mu.Unlock()
	if e != nil && now.Sub(e.checked) < cacheFor {
		return e.Expires > now.Unix()
	}
	body, err := repository.Ps.GetFleetObject(kind, key)
	if err != nil {
		mu.Lock()
		delete(cache, key)
		mu.Unlock()
		return false
	}
	var r record
	if json.Unmarshal(body, &r) != nil || r.Expires <= now.Unix() {
		return false
	}
	mu.Lock()
	if e != nil && e.Expires > r.Expires {
		r.Expires = e.Expires // a touch not yet written back
	}
	cache[key] = &entry{record: r, checked: now, saved: r.Expires}
	mu.Unlock()
	return true
}

// Touch moves the session's expiry to ttl from now.
func Touch(token string, ttl time.Duration) {
	key := id(token)
	mu.Lock()
	e := cache[key]
	if e == nil {
		mu.Unlock()
		return
	}
	e.Expires = time.Now().Add(ttl).Unix()
	write := e.Expires-e.saved >= int64(ttl.Seconds()/10)
	r := e.record
	if write {
		e.saved = e.Expires
	}
	mu.Unlock()
	if write {
		if err := put(r); err != nil {
			log.Logger.Warnf("[session] extend: %v", err)
		}
	}
}

// Delete ends one session (logout).
func Delete(token string) {
	key := id(token)
	mu.Lock()
	delete(cache, key)
	mu.Unlock()
	_ = repository.Ps.DeleteFleetObject(kind, key)
}

// DeleteUser ends every session of user except keep (a token, or "").
func DeleteUser(user, keep string) {
	keepID := ""
	if keep != "" {
		keepID = id(keep)
	}
	for _, r := range all() {
		if r.User == user && r.ID != keepID {
			mu.Lock()
			delete(cache, r.ID)
			mu.Unlock()
			_ = repository.Ps.DeleteFleetObject(kind, r.ID)
		}
	}
	mu.Lock()
	for k, e := range cache {
		if e.User == user && k != keepID {
			delete(cache, k)
		}
	}
	mu.Unlock()
}

func all() []record {
	bodies, err := repository.Ps.ListFleetObjects(kind)
	if err != nil {
		return nil
	}
	out := make([]record, 0, len(bodies))
	for _, b := range bodies {
		var r record
		if json.Unmarshal(b, &r) == nil {
			out = append(out, r)
		}
	}
	return out
}

// Sweep removes expired sessions from the database and the cache.
func Sweep() {
	now := time.Now().Unix()
	for _, r := range all() {
		if r.Expires <= now {
			_ = repository.Ps.DeleteFleetObject(kind, r.ID)
		}
	}
	mu.Lock()
	for k, e := range cache {
		if e.Expires <= now {
			delete(cache, k)
		}
	}
	mu.Unlock()
}

// StartSweeper sweeps every 10 minutes until stop is closed.
func StartSweeper(stop <-chan struct{}) {
	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				Sweep()
			}
		}
	}()
}
