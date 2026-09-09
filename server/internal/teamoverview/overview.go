// Package teamoverview owns calendar ranges, usage aggregation and drilldown
// through one authorized query Interface.
package teamoverview

import (
	"context"
	"fmt"
	"github.com/SingleMai/ATape/server/internal/authentication"
	"github.com/SingleMai/ATape/server/internal/canonical"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
)

type Store interface {
	Overview(context.Context, authentication.Principal, string, time.Time, time.Time) (canonical.OverviewSnapshot, error)
}
type Module struct {
	store Store
	now   func() time.Time
}

func New(store Store) *Module { return &Module{store: store, now: time.Now} }

type InvalidQuery struct{ Message string }

func (e *InvalidQuery) Error() string { return e.Message }

type Query struct {
	From, To, Project, Member, Agent, Model string
	Days, Page, Limit                       int
}
type Tokens struct {
	Input      *int64 `json:"input"`
	Output     *int64 `json:"output"`
	CacheRead  *int64 `json:"cacheRead"`
	CacheWrite *int64 `json:"cacheWrite"`
	Total      *int64 `json:"total"`
	Records    int    `json:"records"`
	Sessions   int    `json:"sessions"`
}
type Metrics struct {
	Members       int    `json:"members"`
	ActiveMembers int    `json:"activeMembers"`
	Projects      int    `json:"projects"`
	Sessions      int    `json:"sessions"`
	Messages      int    `json:"messages"`
	Tokens        Tokens `json:"tokens"`
}
type Bucket struct {
	Date     string `json:"date"`
	Agent    string `json:"agent"`
	Sessions int    `json:"sessions"`
	Members  int    `json:"members"`
	Tokens   Tokens `json:"tokens"`
}
type Detail struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Current  bool   `json:"current"`
	Sessions int    `json:"sessions"`
	Projects int    `json:"projects"`
	Tokens   Tokens `json:"tokens"`
}
type Session struct {
	ID          string `json:"id"`
	ProjectID   string `json:"projectId"`
	ProjectName string `json:"projectName"`
	MemberID    string `json:"memberId"`
	MemberName  string `json:"memberName"`
	Agent       string `json:"agent"`
	Title       string `json:"title"`
	UpdatedAt   string `json:"updatedAt"`
	Input       string `json:"input"`
	Output      string `json:"output"`
	Tokens      Tokens `json:"tokens"`
}
type Options struct {
	Projects []Detail `json:"projects"`
	Members  []Detail `json:"members"`
	Agents   []string `json:"agents"`
	Models   []string `json:"models"`
}
type Result struct {
	TeamID              string    `json:"teamId"`
	TeamName            string    `json:"teamName"`
	Timezone            string    `json:"timezone"`
	From                string    `json:"from"`
	To                  string    `json:"to"`
	UpdatedAt           string    `json:"updatedAt"`
	Metrics             Metrics   `json:"metrics"`
	Previous            Metrics   `json:"previous"`
	Trend               []Bucket  `json:"trend"`
	Options             Options   `json:"options"`
	Members             []Detail  `json:"members"`
	Projects            []Detail  `json:"projects"`
	Models              []Detail  `json:"models"`
	Sessions            []Session `json:"sessions"`
	TotalSessions       int       `json:"totalSessions"`
	Page                int       `json:"page"`
	Limit               int       `json:"limit"`
	UnknownTimeSessions int       `json:"unknownTimeSessions"`
}

func (m *Module) Open(ctx context.Context, principal authentication.Principal, teamID string, q Query) (Result, error) {
	loc, _ := time.LoadLocation("Asia/Singapore")
	now := m.now().In(loc)
	until := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, 1)
	days := q.Days
	if days == 0 {
		days = 30
	}
	if days < 1 || days > 366 {
		return Result{}, &InvalidQuery{"Choose a range of 1–366 days."}
	}
	from := until.AddDate(0, 0, -days)
	if q.From != "" || q.To != "" {
		var err error
		from, err = time.ParseInLocation("2006-01-02", q.From, loc)
		if err != nil {
			return Result{}, &InvalidQuery{"Invalid start date."}
		}
		end, err := time.ParseInLocation("2006-01-02", q.To, loc)
		if err != nil {
			return Result{}, &InvalidQuery{"Invalid end date."}
		}
		until = end.AddDate(0, 0, 1)
		days = int(until.Sub(from).Hours() / 24)
		if days < 1 || days > 366 {
			return Result{}, &InvalidQuery{"Choose a range of 1–366 days."}
		}
	}
	for _, value := range []string{teamID, q.Project, q.Member, q.Agent, q.Model} {
		if len(value) > 500 {
			return Result{}, &InvalidQuery{"Filter is too long."}
		}
	}
	if q.Page < 0 || q.Page > 100000 {
		return Result{}, &InvalidQuery{"Invalid page."}
	}
	if q.Limit == 0 {
		q.Limit = 10
	}
	if q.Limit < 1 || q.Limit > 50 {
		return Result{}, &InvalidQuery{"Page size must be 1–50."}
	}
	previousFrom := from.AddDate(0, 0, -days)
	readUntil := until
	if readUntil.After(now.Add(time.Nanosecond)) {
		readUntil = now.Add(time.Nanosecond)
	}
	snapshot, err := m.store.Overview(ctx, principal, teamID, previousFrom, readUntil)
	if err != nil {
		return Result{}, err
	}
	result := Result{TeamID: snapshot.Team.ID, TeamName: snapshot.Team.Name, Timezone: loc.String(), From: from.Format("2006-01-02"), To: until.AddDate(0, 0, -1).Format("2006-01-02"), UpdatedAt: now.UTC().Format(time.RFC3339Nano), Page: q.Page, Limit: q.Limit, UnknownTimeSessions: snapshot.UnknownTimeSessions}
	result.Options = options(snapshot)
	current := aggregate(snapshot, q, from, until, loc)
	previous := aggregate(snapshot, q, previousFrom, from, loc)
	result.Metrics = current.metrics
	result.Previous = previous.metrics
	result.Trend = current.trend
	result.Members = current.members
	result.Projects = current.projects
	result.Models = current.models
	result.TotalSessions = len(current.sessions)
	start := min(q.Page*q.Limit, len(current.sessions))
	end := min(start+q.Limit, len(current.sessions))
	result.Sessions = current.sessions[start:end]
	return result, nil
}

type tokenSum struct {
	value                      Tokens
	input, output, read, write bool
	sessions                   map[string]bool
}

func (t *tokenSum) add(u canonical.UsageRecord) {
	if t.sessions == nil {
		t.sessions = map[string]bool{}
		t.input = true
		t.output = true
		t.read = true
		t.write = true
	}
	t.sessions[u.SessionID] = true
	t.value.Records++
	add := func(dst **int64, src *int64, complete *bool) {
		if src == nil {
			*complete = false
			return
		}
		if *dst == nil {
			n := int64(0)
			*dst = &n
		}
		if **dst > 9007199254740991-*src {
			*complete = false
			return
		}
		**dst += *src
	}
	add(&t.value.Input, u.InputTokens, &t.input)
	add(&t.value.Output, u.OutputTokens, &t.output)
	add(&t.value.CacheRead, u.CacheReadTokens, &t.read)
	add(&t.value.CacheWrite, u.CacheWriteTokens, &t.write)
}
func (t *tokenSum) get() Tokens {
	v := t.value
	v.Sessions = len(t.sessions)
	// Only complete classifications are exposed as a sum. Missing components
	// cannot turn a partially known amount into an apparently exact total.
	if !t.input {
		v.Input = nil
	}
	if !t.output {
		v.Output = nil
	}
	if !t.read {
		v.CacheRead = nil
	}
	if !t.write {
		v.CacheWrite = nil
	}
	if v.Input != nil && v.Output != nil && *v.Input <= 9007199254740991-*v.Output {
		n := *v.Input + *v.Output
		v.Total = &n
	}
	return v
}

type group struct {
	sessions, projects, members map[string]bool
	tokens                      tokenSum
}

func newGroup() *group {
	return &group{sessions: map[string]bool{}, projects: map[string]bool{}, members: map[string]bool{}}
}
func (g *group) mark(s canonical.SessionRecord) {
	g.sessions[s.ID] = true
	g.projects[s.ProjectID] = true
	g.members[s.CapturedByUserID] = true
}

type aggregation struct {
	metrics                   Metrics
	trend                     []Bucket
	members, projects, models []Detail
	sessions                  []Session
}

func aggregate(s canonical.OverviewSnapshot, q Query, from, until time.Time, loc *time.Location) aggregation {
	result := aggregation{trend: []Bucket{}, members: []Detail{}, projects: []Detail{}, models: []Detail{}, sessions: []Session{}}
	memberNames := map[string]canonical.OverviewMember{}
	projectNames := map[string]string{}
	for _, m := range s.Members {
		memberNames[m.ID] = m
		if m.Current {
			result.metrics.Members++
		}
	}
	for _, p := range s.Projects {
		projectNames[p.ID] = p.Name
	}
	sessions := map[string]canonical.SessionRecord{}
	modelsForSession := map[string]bool{}
	selectedModel := q.Model
	if selectedModel == "__unknown__" {
		selectedModel = ""
	}
	for _, u := range s.Usage {
		if u.Model == selectedModel && !u.OccurredAt.Before(from) && u.OccurredAt.Before(until) {
			modelsForSession[u.SessionID] = true
		}
	}
	for _, v := range s.Sessions {
		if (q.Project == "" || v.ProjectID == q.Project) && (q.Member == "" || v.CapturedByUserID == q.Member) && (q.Agent == "" || v.Actor.Harness == q.Agent) && (q.Model == "" || modelsForSession[v.ID]) {
			sessions[v.ID] = v
		}
	}
	all := newGroup()
	byMember := map[string]*group{}
	byProject := map[string]*group{}
	byModel := map[string]*group{}
	byDay := map[string]*group{}
	bySession := map[string]*group{}
	latest := map[string]time.Time{}
	input := map[string]canonical.OverviewEvent{}
	output := map[string]canonical.OverviewEvent{}
	messages := map[string]bool{}
	pick := func(groups map[string]*group, key string) *group {
		g := groups[key]
		if g == nil {
			g = newGroup()
			groups[key] = g
		}
		return g
	}
	mark := func(session canonical.SessionRecord, at time.Time) []*group {
		day := at.In(loc).Format("2006-01-02") + "\x00" + session.Actor.Harness
		groups := []*group{all, pick(byMember, session.CapturedByUserID), pick(byProject, session.ProjectID), pick(byDay, day), pick(bySession, session.ID)}
		for _, g := range groups {
			g.mark(session)
		}
		if at.After(latest[session.ID]) {
			latest[session.ID] = at
		}
		return groups
	}
	for _, e := range s.Events {
		v, ok := sessions[e.SessionID]
		if !ok || e.At.Before(from) || !e.At.Before(until) {
			continue
		}
		mark(v, e.At)
		if !e.Root {
			continue
		}
		if e.Author == v.Actor.Name {
			messages[fmt.Sprintf("%s:%d", v.ID, e.Order)] = true
			if old, ok := input[v.ID]; !ok || e.Order > old.Order || e.Order == old.Order && e.Index > old.Index {
				input[v.ID] = e
			}
		} else {
			if old, ok := output[v.ID]; !ok || e.Order > old.Order || e.Order == old.Order && e.Index > old.Index {
				output[v.ID] = e
			}
		}
	}
	for _, u := range s.Usage {
		v, ok := sessions[u.SessionID]
		if !ok || u.OccurredAt.Before(from) || !u.OccurredAt.Before(until) || (q.Model != "" && u.Model != selectedModel) {
			continue
		}
		for _, g := range mark(v, u.OccurredAt) {
			g.tokens.add(u)
		}
		g := pick(byModel, u.Model)
		g.mark(v)
		g.tokens.add(u)
	}
	result.metrics.ActiveMembers = len(all.members)
	result.metrics.Projects = len(all.projects)
	result.metrics.Sessions = len(all.sessions)
	result.metrics.Messages = len(messages)
	result.metrics.Tokens = all.tokens.get()
	for key, g := range byDay {
		parts := strings.SplitN(key, "\x00", 2)
		result.trend = append(result.trend, Bucket{Date: parts[0], Agent: parts[1], Sessions: len(g.sessions), Members: len(g.members), Tokens: g.tokens.get()})
	}
	sort.Slice(result.trend, func(i, j int) bool {
		a, b := result.trend[i], result.trend[j]
		return a.Date < b.Date || a.Date == b.Date && a.Agent < b.Agent
	})
	for id, g := range byMember {
		m := memberNames[id]
		name := m.Name
		if name == "" {
			name = "Former member"
		}
		result.members = append(result.members, Detail{ID: id, Name: name, Current: m.Current, Sessions: len(g.sessions), Projects: len(g.projects), Tokens: g.tokens.get()})
	}
	for id, g := range byProject {
		result.projects = append(result.projects, Detail{ID: id, Name: projectNames[id], Current: true, Sessions: len(g.sessions), Projects: len(g.projects), Tokens: g.tokens.get()})
	}
	for id, g := range byModel {
		name := id
		if name == "" {
			name = "Unknown model"
			id = "__unknown__"
		}
		result.models = append(result.models, Detail{ID: id, Name: name, Current: true, Sessions: len(g.sessions), Projects: len(g.projects), Tokens: g.tokens.get()})
	}
	sortDetails(result.members)
	sortDetails(result.projects)
	sortDetails(result.models)
	for id, g := range bySession {
		v := sessions[id]
		owner := memberNames[v.CapturedByUserID]
		name := owner.Name
		if name == "" {
			name = "Former member"
		}
		in, out := input[id], output[id]
		reply := ""
		if out.Order >= in.Order {
			reply = lastSentence(out.Text)
		}
		result.sessions = append(result.sessions, Session{ID: id, ProjectID: v.ProjectID, ProjectName: projectNames[v.ProjectID], MemberID: v.CapturedByUserID, MemberName: name, Agent: v.Actor.Harness, Title: v.Title, UpdatedAt: latest[id].UTC().Format(time.RFC3339Nano), Input: preview(in.Text), Output: reply, Tokens: g.tokens.get()})
	}
	sort.Slice(result.sessions, func(i, j int) bool {
		a, b := result.sessions[i], result.sessions[j]
		return latest[a.ID].After(latest[b.ID]) || latest[a.ID].Equal(latest[b.ID]) && a.ID < b.ID
	})
	return result
}
func sortDetails(v []Detail) {
	sort.Slice(v, func(i, j int) bool {
		return v[i].Sessions > v[j].Sessions || v[i].Sessions == v[j].Sessions && v[i].Name < v[j].Name
	})
}
func options(s canonical.OverviewSnapshot) Options {
	r := Options{Projects: []Detail{}, Members: []Detail{}, Agents: []string{}, Models: []string{}}
	agents, models := map[string]bool{}, map[string]bool{}
	for _, p := range s.Projects {
		r.Projects = append(r.Projects, Detail{ID: p.ID, Name: p.Name, Current: p.State == "active"})
	}
	for _, m := range s.Members {
		r.Members = append(r.Members, Detail{ID: m.ID, Name: m.Name, Current: m.Current})
	}
	for _, v := range s.Sessions {
		agents[v.Actor.Harness] = true
	}
	for _, u := range s.Usage {
		if u.Model == "" {
			models["__unknown__"] = true
		} else {
			models[u.Model] = true
		}
	}
	for k := range agents {
		r.Agents = append(r.Agents, k)
	}
	for k := range models {
		r.Models = append(r.Models, k)
	}
	sort.Strings(r.Agents)
	sort.Strings(r.Models)
	sortDetails(r.Projects)
	sortDetails(r.Members)
	return r
}
func preview(text string) string {
	// These are capture wrappers, not user prose. Remove the entire block so
	// context contents cannot become a conversation preview.
	for _, tag := range []string{"environment_context", "system-reminder", "system"} {
		for {
			start := strings.Index(text, "<"+tag+">")
			if start < 0 {
				break
			}
			end := strings.Index(text[start:], "</"+tag+">")
			if end < 0 {
				text = text[:start]
				break
			}
			text = text[:start] + text[start+end+len(tag)+3:]
		}
	}
	lines := []string{}
	skip := false
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "# Files mentioned by the user:") {
			skip = true
			continue
		}
		if strings.HasPrefix(t, "## My request:") {
			skip = false
			continue
		}
		if skip || strings.HasPrefix(t, "<environment_context>") || strings.HasPrefix(t, "<system") {
			continue
		}
		lines = append(lines, t)
	}
	value := strings.Join(strings.Fields(strings.Join(lines, " ")), " ")
	r := []rune(value)
	if len(r) > 360 {
		return string(r[:360]) + "…"
	}
	return value
}
func lastSentence(text string) string {
	text = strings.TrimSpace(text)
	r := []rune(text)
	end := len(r)
	for end > 0 && unicode.IsSpace(r[end-1]) {
		end--
	}
	start := end
	for start > 0 {
		start--
		if start < end-1 && strings.ContainsRune("。！？!?\n", r[start]) {
			start++
			break
		}
		if start < end-2 && r[start] == '.' && unicode.IsSpace(r[start+1]) {
			start++
			break
		}
	}
	return preview(string(r[start:end]))
}
