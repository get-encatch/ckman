package sqlite

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
)

// Six destroys finishing at once used to share one swapped connection: one
// commit ended the others' transactions and their task updates. Each InTx
// must stay isolated while other goroutines keep writing outside it.
func TestSQLite_InTxConcurrent(t *testing.T) {
	sp := newTestSP(t)
	const n = 8
	for i := 0; i < n; i++ {
		if err := sp.CreateCluster(model.CKManClickHouseConfig{Cluster: fmt.Sprintf("c%d", i)}); err != nil {
			t.Fatal(err)
		}
		if err := sp.CreateTask(model.Task{TaskId: fmt.Sprintf("t%d", i), ClusterName: fmt.Sprintf("c%d", i), Status: model.TaskStatusRunning}); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	errs := make(chan error, 4*n)
	for i := 0; i < n; i++ {
		wg.Add(2)
		go func(i int) { // a destroy's Store step
			defer wg.Done()
			errs <- sp.InTx(func(tx repository.PersistentMgr) error {
				if _, err := tx.GetAllTasks(); err != nil {
					return err
				}
				return tx.DeleteCluster(fmt.Sprintf("c%d", i))
			})
		}(i)
		go func(i int) { // its task status updates, outside any transaction
			defer wg.Done()
			for k := 0; k < 5; k++ {
				task, err := sp.GetTaskbyTaskId(fmt.Sprintf("t%d", i))
				if err != nil {
					errs <- err
					return
				}
				task.Status = model.TaskStatusSuccess
				if err := sp.UpdateTask(task); err != nil {
					errs <- err
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent write failed: %v", err)
		}
	}
	if all, _ := sp.GetAllClusters(); len(all) != 0 {
		t.Fatalf("%d clusters left", len(all))
	}
	for i := 0; i < n; i++ {
		if task, _ := sp.GetTaskbyTaskId(fmt.Sprintf("t%d", i)); task.Status != model.TaskStatusSuccess {
			t.Fatalf("task t%d lost its update: %v", i, task.Status)
		}
	}
}

func TestSQLite_InTxRollback(t *testing.T) {
	sp := newTestSP(t)
	boom := errors.New("boom")
	err := sp.InTx(func(tx repository.PersistentMgr) error {
		if err := tx.CreateCluster(model.CKManClickHouseConfig{Cluster: "gone"}); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) || sp.ClusterExists("gone") {
		t.Fatalf("rollback: err=%v exists=%v", err, sp.ClusterExists("gone"))
	}
}
