package runner

import (
	"testing"

	"github.com/housepower/ckman/log"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/repository/sqlite"
)

// A task whose final status never reached the database used to stay
// Running until ckman restarted. Sweep heals it.
func TestSweep(t *testing.T) {
	log.InitLoggerConsole()
	sp := sqlite.NewSQLitePersistent()
	if err := sp.Init(sqlite.LocalConfig{ConfigDir: t.TempDir(), ConfigFile: "sweep"}); err != nil {
		t.Fatal(err)
	}
	repository.Ps = sp
	r := &RunnerService{ServerIp: "10.0.0.1"}
	for _, id := range []string{"orphan", "kept", "alive", "other"} {
		ip := r.ServerIp
		if id == "other" {
			ip = "10.0.0.2" // another ckman instance
		}
		if err := sp.CreateTask(model.Task{TaskId: id, ServerIp: ip, Status: model.TaskStatusRunning}); err != nil {
			t.Fatal(err)
		}
	}
	r.unsaved.Store("kept", outcome{model.TaskStatusSuccess, "Success"}) // its save failed earlier
	r.cancels.Store("alive", func() {})                                  // still running

	r.Sweep()

	want := map[string]int{
		"orphan": model.TaskStatusFailed,
		"kept":   model.TaskStatusSuccess,
		"alive":  model.TaskStatusRunning,
		"other":  model.TaskStatusRunning,
	}
	for id, status := range want {
		got, err := sp.GetTaskbyTaskId(id)
		if err != nil || got.Status != status {
			t.Errorf("%s: status %d, want %d (%v)", id, got.Status, status, err)
		}
	}
	if _, ok := r.unsaved.Load("kept"); ok {
		t.Error("saved outcome still kept")
	}
}
