package sqlite

import (
	"errors"
	"testing"

	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
)

func TestSQLite_ClusterDrafts(t *testing.T) {
	sp := newTestSP(t)
	if err := sp.CreateCluster(model.CKManClickHouseConfig{Cluster: "live"}); err != nil {
		t.Fatal(err)
	}
	// a draft cant take a clusters name
	if err := sp.SaveClusterDraft("live", "", []byte(`{}`)); !errors.Is(err, repository.ErrRecordExists) {
		t.Fatalf("draft over a cluster: %v", err)
	}
	if err := sp.SaveClusterDraft("draft-1", "", []byte(`{"v":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := sp.SaveClusterDraft("analytics", "draft-1", []byte(`{"v":2}`)); err != nil {
		t.Fatal(err) // rename
	}
	if b, err := sp.GetClusterDraft("analytics"); err != nil || string(b) != `{"v":2}` {
		t.Fatalf("renamed draft: %s %v", b, err)
	}
	if _, err := sp.GetClusterDraft("draft-1"); err == nil {
		t.Fatal("old draft name still there")
	}
	// drafts never show up as clusters
	all, _ := sp.GetAllClusters()
	if len(all) != 1 || sp.ClusterExists("analytics") {
		t.Fatalf("draft visible as a cluster: %v", all)
	}
	if err := sp.UpdateCluster(model.CKManClickHouseConfig{Cluster: "analytics"}); err == nil {
		t.Fatal("UpdateCluster changed a draft")
	}
	if d, _ := sp.ListClusterDrafts(); len(d) != 1 {
		t.Fatalf("drafts: %d", len(d))
	}
	// creating the cluster replaces its draft
	if err := sp.CreateCluster(model.CKManClickHouseConfig{Cluster: "analytics"}); err != nil {
		t.Fatal(err)
	}
	if d, _ := sp.ListClusterDrafts(); len(d) != 0 || !sp.ClusterExists("analytics") {
		t.Fatalf("draft not replaced: %d drafts", len(d))
	}
	if err := sp.SaveClusterDraft("x", "", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if err := sp.DeleteClusterDraft("x"); err != nil {
		t.Fatal(err)
	}
	if d, _ := sp.ListClusterDrafts(); len(d) != 0 {
		t.Fatal("draft not deleted")
	}
}
