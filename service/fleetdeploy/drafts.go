package fleetdeploy

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/housepower/ckman/repository"
	"github.com/pkg/errors"
)

// Draft is a create-cluster form saved half-way. It lives in the clusters
// table (status "draft"), so it survives a reload or another browser, and
// its name reserves the cluster name. The form never holds the password.
type Draft struct {
	Name      string          `json:"name"`
	Step      int             `json:"step"`
	Form      json.RawMessage `json:"form"`
	TaskID    string          `json:"task_id,omitempty"` // the create task, once started
	UpdatedAt time.Time       `json:"updated_at"`
}

// unnamed drafts get a placeholder that no cluster can have ('-')
var draftNameRe = regexp.MustCompile(`^draft-[0-9a-f]{8}$`)

func newDraftName() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "draft-" + hex.EncodeToString(b)
}

// SaveDraft creates a draft (old empty) or updates draft old, renaming it
// when d.Name differs.
func SaveDraft(old string, d Draft) (Draft, error) {
	d.Name = strings.TrimSpace(d.Name)
	switch {
	case d.Name == "" && draftNameRe.MatchString(old):
		d.Name = old
	case d.Name == "":
		d.Name = newDraftName()
	case !clusterNameRe.MatchString(d.Name) && !draftNameRe.MatchString(d.Name):
		return d, errors.New("cluster name: start with a letter; letters, digits and '_' only")
	}
	if len(d.Form) == 0 {
		d.Form = json.RawMessage("{}")
	}
	d.UpdatedAt = time.Now().UTC()
	body, err := json.Marshal(d)
	if err != nil {
		return d, err
	}
	if err := repository.Ps.SaveClusterDraft(d.Name, old, body); err != nil {
		if errors.Is(err, repository.ErrRecordExists) {
			return d, errors.Errorf("the name %s is taken by a cluster or another draft", d.Name)
		}
		return d, err
	}
	return d, nil
}

func GetDraft(name string) (Draft, error) {
	var d Draft
	body, err := repository.Ps.GetClusterDraft(name)
	if err != nil {
		return d, errors.Errorf("no draft named %s", name)
	}
	return d, json.Unmarshal(body, &d)
}

// ListDrafts returns the drafts, most recently changed first.
func ListDrafts() ([]Draft, error) {
	bodies, err := repository.Ps.ListClusterDrafts()
	if err != nil {
		return nil, err
	}
	out := make([]Draft, 0, len(bodies))
	for _, b := range bodies {
		var d Draft
		if json.Unmarshal(b, &d) == nil {
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func DeleteDraft(name string) error {
	return repository.Ps.DeleteClusterDraft(name)
}
