package controller

import (
	"github.com/gin-gonic/gin"
	"github.com/housepower/ckman/model"
	"github.com/housepower/ckman/service/backup"
)

// StorageConnectionController manages saved S3 connections for backups.
type StorageConnectionController struct {
	Controller
}

func NewStorageConnectionController(wrapfunc Wrapfunc) *StorageConnectionController {
	return &StorageConnectionController{Controller: Controller{wrapfunc: wrapfunc}}
}

// maskConnection never sends the secret key back to the browser.
func maskConnection(c model.StorageConnection) model.StorageConnection {
	c.S3.SecretAccessKey = ""
	c.Azure.AccountKey = ""
	return c
}

// @Summary List storage connections (secret keys are not returned)
// @Router /api/v1/storage/connections [get]
func (c *StorageConnectionController) List(ctx *gin.Context) {
	conns, err := backup.ListConnections()
	if err != nil {
		c.wrapfunc(ctx, model.E_DATA_SELECT_FAILED, err)
		return
	}
	for i := range conns {
		conns[i] = maskConnection(conns[i])
	}
	c.wrapfunc(ctx, model.E_SUCCESS, conns)
}

func (c *StorageConnectionController) save(ctx *gin.Context, id string) {
	var conn model.StorageConnection
	if err := model.DecodeRequestBody(ctx.Request, &conn); err != nil {
		c.wrapfunc(ctx, model.E_INVALID_PARAMS, err)
		return
	}
	conn.ConnectionID = id
	saved, err := backup.SaveConnection(conn)
	if err != nil {
		c.wrapfunc(ctx, model.E_DATA_CHECK_FAILED, err)
		return
	}
	c.wrapfunc(ctx, model.E_SUCCESS, maskConnection(saved))
}

// @Summary Create a storage connection (tested before saving)
// @Router /api/v1/storage/connections [post]
func (c *StorageConnectionController) Create(ctx *gin.Context) { c.save(ctx, "") }

// @Summary Update a storage connection; empty keys keep the stored ones
// @Router /api/v1/storage/connections/{id} [put]
func (c *StorageConnectionController) Update(ctx *gin.Context) { c.save(ctx, ctx.Param("id")) }

// @Summary Delete a storage connection that no backup uses
// @Router /api/v1/storage/connections/{id} [delete]
func (c *StorageConnectionController) Delete(ctx *gin.Context) {
	if err := backup.DeleteConnection(ctx.Param("id")); err != nil {
		c.wrapfunc(ctx, model.E_DATA_DELETE_FAILED, err)
		return
	}
	c.wrapfunc(ctx, model.E_SUCCESS, nil)
}

// @Summary Test connection settings without saving; returns the buckets.
// @Description With connection_id set, empty keys are taken from that saved connection.
// @Router /api/v1/storage/connections/test [post]
func (c *StorageConnectionController) Test(ctx *gin.Context) {
	var conn model.StorageConnection
	if err := model.DecodeRequestBody(ctx.Request, &conn); err != nil {
		c.wrapfunc(ctx, model.E_INVALID_PARAMS, err)
		return
	}
	if conn.Type != model.STORAGE_CONN_AZURE && conn.ConnectionID != "" && (conn.S3.AccessKeyID == "" || conn.S3.SecretAccessKey == "") {
		old, err := backup.GetConnection(conn.ConnectionID)
		if err != nil {
			c.wrapfunc(ctx, model.E_DATA_SELECT_FAILED, err)
			return
		}
		if conn.S3.AccessKeyID == "" {
			conn.S3.AccessKeyID = old.S3.AccessKeyID
		}
		if conn.S3.SecretAccessKey == "" {
			conn.S3.SecretAccessKey = old.S3.SecretAccessKey
		}
	}
	var buckets []string
	var err error
	if conn.Type == model.STORAGE_CONN_AZURE {
		if conn.ConnectionID != "" && conn.Azure.AccountKey == "" {
			old, gerr := backup.GetConnection(conn.ConnectionID)
			if gerr != nil {
				c.wrapfunc(ctx, model.E_DATA_SELECT_FAILED, gerr)
				return
			}
			conn.Azure.AccountKey = old.Azure.AccountKey
		}
		buckets, err = backup.ListAzureContainers(conn.Azure)
	} else {
		buckets, err = backup.ListS3Buckets(conn.S3)
	}
	if err != nil {
		c.wrapfunc(ctx, model.E_DATA_CHECK_FAILED, err)
		return
	}
	c.wrapfunc(ctx, model.E_SUCCESS, gin.H{"buckets": buckets})
}

// @Summary List the buckets of a saved connection
// @Router /api/v1/storage/connections/{id}/buckets [get]
func (c *StorageConnectionController) Buckets(ctx *gin.Context) {
	buckets, err := backup.ConnectionBuckets(ctx.Param("id"))
	if err != nil {
		c.wrapfunc(ctx, model.E_DATA_SELECT_FAILED, err)
		return
	}
	c.wrapfunc(ctx, model.E_SUCCESS, buckets)
}

// @Summary Create a bucket through a saved connection
// @Router /api/v1/storage/connections/{id}/buckets [post]
func (c *StorageConnectionController) CreateBucket(ctx *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	if err := model.DecodeRequestBody(ctx.Request, &req); err != nil {
		c.wrapfunc(ctx, model.E_INVALID_PARAMS, err)
		return
	}
	if err := backup.CreateConnectionBucket(ctx.Param("id"), req.Name); err != nil {
		c.wrapfunc(ctx, model.E_DATA_CHECK_FAILED, err)
		return
	}
	c.wrapfunc(ctx, model.E_SUCCESS, nil)
}
