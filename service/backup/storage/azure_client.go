package storage

import (
	"context"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/bloberror"
	"github.com/housepower/ckman/model"
	"github.com/pkg/errors"
)

// AzureClient wraps the Blob service of one storage account (shared key).
type AzureClient struct {
	c *azblob.Client
}

func NewAzureClient(cfg model.TargetAzure) (*AzureClient, error) {
	if cfg.AccountName == "" || cfg.AccountKey == "" {
		return nil, errors.New("Azure account name and key are required")
	}
	cred, err := azblob.NewSharedKeyCredential(cfg.AccountName, cfg.AccountKey)
	if err != nil {
		return nil, errors.Wrap(err, "Azure credentials")
	}
	c, err := azblob.NewClientWithSharedKeyCredential(strings.TrimRight(cfg.Endpoint, "/")+"/", cred, nil)
	if err != nil {
		return nil, errors.Wrap(err, "Azure client")
	}
	return &AzureClient{c: c}, nil
}

func azCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 60*time.Second)
}

// ListContainers lists the account's containers (also a connection test).
func (a *AzureClient) ListContainers() ([]string, error) {
	ctx, cancel := azCtx()
	defer cancel()
	var out []string
	pager := a.c.NewListContainersPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, errors.Wrap(err, "list containers")
		}
		for _, c := range page.ContainerItems {
			if c.Name != nil {
				out = append(out, *c.Name)
			}
		}
	}
	return out, nil
}

// CreateContainer creates a container; an existing one is fine.
func (a *AzureClient) CreateContainer(name string) error {
	ctx, cancel := azCtx()
	defer cancel()
	_, err := a.c.CreateContainer(ctx, name, nil)
	if err != nil && !bloberror.HasCode(err, bloberror.ContainerAlreadyExists) {
		return errors.Wrap(err, "create container")
	}
	return nil
}

// ListBlobs returns the blob names under prefix.
func (a *AzureClient) ListBlobs(container, prefix string) ([]string, error) {
	ctx, cancel := azCtx()
	defer cancel()
	var out []string
	pager := a.c.NewListBlobsFlatPager(container, &azblob.ListBlobsFlatOptions{Prefix: &prefix})
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, errors.Wrap(err, "list blobs")
		}
		for _, b := range page.Segment.BlobItems {
			if b.Name != nil {
				out = append(out, *b.Name)
			}
		}
	}
	return out, nil
}

// DeletePrefix removes every blob under prefix.
func (a *AzureClient) DeletePrefix(container, prefix string) error {
	names, err := a.ListBlobs(container, prefix)
	if err != nil {
		return err
	}
	for _, n := range names {
		ctx, cancel := azCtx()
		_, err := a.c.DeleteBlob(ctx, container, n, nil)
		cancel()
		if err != nil && !bloberror.HasCode(err, bloberror.BlobNotFound) {
			return errors.Wrapf(err, "delete %s", n)
		}
	}
	return nil
}
