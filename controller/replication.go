package controller

import (
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/housepower/ckman/deploy"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/repository"
	"github.com/housepower/ckman/service/backup/bvalidate"
	"github.com/housepower/ckman/service/clickhouse"
)

// ListUnreplicatedTables lists MergeTree tables that are not replicated, with
// their rows per server. GET /ck/table/unreplicated/{clusterName}
func (controller *ClickHouseController) ListUnreplicatedTables(c *gin.Context) {
	clusterName := c.Param(ClickHouseClusterPath)
	conf, err := repository.Ps.GetClusterbyName(clusterName)
	if err != nil {
		controller.wrapfunc(c, model.E_RECORD_NOT_FOUND, fmt.Sprintf("cluster %s does not exist", clusterName))
		return
	}
	tables, err := clickhouse.ListUnreplicatedTables(&conf)
	if err != nil {
		controller.wrapfunc(c, model.E_CH_CONNECT_FAILED, err)
		return
	}
	controller.wrapfunc(c, model.E_SUCCESS, tables)
}

type convertReplicatedReq struct {
	Database string `json:"database"`
	Table    string `json:"table"`
}

// ConvertTableToReplicated converts a MergeTree table to its Replicated*
// engine on every server. POST /ck/table/convert_replicated/{clusterName}
func (controller *ClickHouseController) ConvertTableToReplicated(c *gin.Context) {
	clusterName := c.Param(ClickHouseClusterPath)
	var req convertReplicatedReq
	if err := c.ShouldBindJSON(&req); err != nil {
		controller.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	if err := bvalidate.ValidateIdentifier(req.Database); err != nil {
		controller.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	if err := bvalidate.ValidateIdentifier(req.Table); err != nil {
		controller.wrapfunc(c, model.E_INVALID_PARAMS, err)
		return
	}
	conf, err := repository.Ps.GetClusterbyName(clusterName)
	if err != nil {
		controller.wrapfunc(c, model.E_RECORD_NOT_FOUND, fmt.Sprintf("cluster %s does not exist", clusterName))
		return
	}
	hosts, err := clickhouse.ConvertToReplicated(&conf, req.Database, req.Table)
	if err != nil {
		controller.wrapfunc(c, model.E_DATA_UPDATE_FAILED, fmt.Errorf("%v (converted so far: %v)", err, hosts))
		return
	}
	controller.wrapfunc(c, model.E_SUCCESS, gin.H{"hosts": hosts})
}

// RestartNode stops and starts ClickHouse on one server.
// PUT /ck/node/restart/{clusterName}?ip=
func (controller *ClickHouseController) RestartNode(c *gin.Context) {
	clusterName := c.Param(ClickHouseClusterPath)
	ip := c.Query("ip")
	if ip == "" {
		controller.wrapfunc(c, model.E_INVALID_PARAMS, fmt.Errorf("node ip does not exist"))
		return
	}
	conf, err := repository.Ps.GetClusterbyName(clusterName)
	if err != nil {
		controller.wrapfunc(c, model.E_RECORD_NOT_FOUND, fmt.Sprintf("cluster %s does not exist", clusterName))
		return
	}
	if err := verifySshPassword(c, &conf, conf.SshUser, conf.SshPassword); err != nil {
		controller.wrapfunc(c, model.E_DATA_CHECK_FAILED, err)
		return
	}
	found := false
	for _, h := range conf.Hosts {
		found = found || h == ip
	}
	if !found {
		controller.wrapfunc(c, model.E_INVALID_PARAMS, fmt.Errorf("%s is not a node of cluster %s", ip, clusterName))
		return
	}
	con := conf
	con.Hosts = []string{ip}
	if err := deploy.StopCkCluster(&con); err != nil {
		controller.wrapfunc(c, model.E_SSH_EXECUTE_FAILED, err)
		return
	}
	if err := deploy.StartCkCluster(&con); err != nil {
		controller.wrapfunc(c, model.E_SSH_EXECUTE_FAILED, err)
		return
	}
	controller.wrapfunc(c, model.E_SUCCESS, nil)
}
