package fleet

import (
	"net/http"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/housepower/ckman/common"
	"github.com/pkg/errors"
)

// Docker Hub tags of the official images, newest first. Only full versions
// (26.9.15.5) are listed; "latest"/"head"/"-alpine" variants are skipped.

var fullVersion = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)

var versionCache = struct {
	sync.Mutex
	at   map[string]time.Time
	tags map[string][]string
}{at: map[string]time.Time{}, tags: map[string][]string{}}

var hubClient = &http.Client{Timeout: 15 * time.Second}

// ImageVersions lists up to 40 versions of a Docker Hub repository
// ("clickhouse/clickhouse-server"), cached for an hour.
func ImageVersions(repo string) ([]string, error) {
	versionCache.Lock()
	if t, ok := versionCache.at[repo]; ok && time.Since(t) < time.Hour {
		tags := versionCache.tags[repo]
		versionCache.Unlock()
		return tags, nil
	}
	versionCache.Unlock()

	seen := map[string]bool{}
	var tags []string
	url := "https://hub.docker.com/v2/repositories/" + repo + "/tags?page_size=100&ordering=last_updated"
	for page := 0; page < 6 && url != "" && len(tags) < 120; page++ {
		var body struct {
			Next    string `json:"next"`
			Results []struct {
				Name string `json:"name"`
			} `json:"results"`
		}
		resp, err := hubClient.Get(url)
		if err != nil {
			return nil, errors.Wrap(err, "Docker Hub")
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil {
			return nil, errors.Wrap(err, "Docker Hub")
		}
		for _, r := range body.Results {
			if fullVersion.MatchString(r.Name) && !seen[r.Name] {
				seen[r.Name] = true
				tags = append(tags, r.Name)
			}
		}
		url = body.Next
	}
	sort.Slice(tags, func(i, j int) bool { return common.CompareClickHouseVersion(tags[i], tags[j]) > 0 })
	if len(tags) > 40 {
		tags = tags[:40]
	}
	versionCache.Lock()
	versionCache.at[repo], versionCache.tags[repo] = time.Now(), tags
	versionCache.Unlock()
	return tags, nil
}

// ImageVersionExists checks one tag on Docker Hub.
func ImageVersionExists(repo, tag string) (bool, error) {
	resp, err := hubClient.Get("https://hub.docker.com/v2/repositories/" + repo + "/tags/" + tag)
	if err != nil {
		return false, errors.Wrap(err, "Docker Hub")
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK, nil
}
