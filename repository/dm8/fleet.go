package dm8

import (
	"time"

	"github.com/housepower/ckman/repository"
	"github.com/pkg/errors"
	dmSchema "github.com/wanlay/gorm-dm8/schema"
)

// TblFleetObject stores fleet objects (machines, standbys, settings) as JSON
// documents keyed by kind and id, so new fleet features need no new tables.
type TblFleetObject struct {
	Kind       string        `gorm:"column:OBJ_KIND;primaryKey;size:32"`
	ID         string        `gorm:"column:OBJ_ID;primaryKey;size:128"`
	Name       string        `gorm:"column:OBJ_NAME;size:128"`
	Body       dmSchema.Clob `gorm:"column:OBJ_BODY;size:1024000"`
	UpdateTime string        `gorm:"column:UPDATE_TIME;size:32"`
}

// PutFleetObject inserts or replaces one object.
func (mp *DM8Persistent) PutFleetObject(kind, id, name string, body []byte) error {
	now := time.Now().Format("2006-01-02 15:04:05.999")
	tx := mp.Client.Model(&TblFleetObject{}).Where("OBJ_KIND = ? AND OBJ_ID = ?", kind, id).Updates(map[string]interface{}{
		"OBJ_NAME":    name,
		"OBJ_BODY":    dmSchema.Clob(string(body)),
		"UPDATE_TIME": now,
	})
	if tx.Error != nil {
		return wrapError(tx.Error)
	}
	if tx.RowsAffected > 0 {
		return nil
	}
	return wrapError(mp.Client.Create(&TblFleetObject{Kind: kind, ID: id, Name: name, Body: dmSchema.Clob(string(body)), UpdateTime: now}).Error)
}

func (mp *DM8Persistent) GetFleetObject(kind, id string) ([]byte, error) {
	var tbl TblFleetObject
	if err := mp.Client.Where("OBJ_KIND = ? AND OBJ_ID = ?", kind, id).First(&tbl).Error; err != nil {
		return nil, wrapError(err)
	}
	return []byte(tbl.Body), nil
}

func (mp *DM8Persistent) ListFleetObjects(kind string) ([][]byte, error) {
	var tbls []TblFleetObject
	if err := mp.Client.Where("OBJ_KIND = ?", kind).Order("OBJ_NAME").Find(&tbls).Error; err != nil {
		return nil, wrapError(err)
	}
	out := make([][]byte, 0, len(tbls))
	for _, t := range tbls {
		out = append(out, []byte(t.Body))
	}
	return out, nil
}

func (mp *DM8Persistent) DeleteFleetObject(kind, id string) error {
	tx := mp.Client.Where("OBJ_KIND = ? AND OBJ_ID = ?", kind, id).Delete(&TblFleetObject{})
	if tx.Error != nil {
		return errors.Wrap(tx.Error, "")
	}
	if tx.RowsAffected == 0 {
		return repository.ErrRecordNotFound
	}
	return nil
}
