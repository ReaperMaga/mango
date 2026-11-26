package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// A space's people are who its tokens are for. A person has an id that never changes and a name they may
// change; the planner stores the id (an assignee), so a new name shows everywhere at once. One person's tokens
// (a laptop, a desktop) share the person.

// Person is someone in a space.
type Person struct {
	ID      string `json:"id"`
	SpaceID string `json:"-"`
	Name    string `json:"name"`
	// Active: they have a write token that is not revoked, so they may be assigned. The others stay listed
	// so what they were assigned keeps their name.
	Active bool `json:"active"`
	// Tokens is how many of their tokens are not revoked.
	Tokens int `json:"-"`
}

// Token is an access token as listed: never the token itself, which only its maker sees.
type Token struct {
	ID         string
	SpaceID    string
	PersonID   string
	Person     string // the person's name now
	Role       string
	CreatedAt  int64
	LastUsedAt int64 // 0: never
	RevokedAt  int64 // 0: not revoked
}

// Principal is who a request comes from.
type Principal struct {
	TokenID  string
	PersonID string
	// Name is the person's: who the planner shows as "you".
	Name      string
	SpaceID   string
	SpaceName string
	Role      string
}

func (p *Principal) CanWrite() bool { return p.Role == "write" }

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// MaxPersonName is the longest name of a person, in characters.
const MaxPersonName = 64

// PersonName checks a person's name and returns it trimmed: printable text that does not start with "@" (a
// filter's "@me" stands for whoever reads it).
func PersonName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", invalid("A name is needed: the person the token is for, shown to everyone in its space.")
	}
	if len([]rune(name)) > MaxPersonName {
		return "", invalid("A name is at most %d characters.", MaxPersonName)
	}
	if strings.HasPrefix(name, "@") {
		return "", invalid("A name does not start with @.")
	}
	for _, r := range name {
		if !unicode.IsPrint(r) {
			return "", invalid("A name is printable text, without line breaks or control characters.")
		}
	}
	return name, nil
}

func conflict(name string) error {
	return &Error{Status: 409, Code: "conflict", Message: fmt.Sprintf("Someone in this space is called %q already.", name)}
}

// migrate brings a database from before people up to date: one person for each name its tokens had in a
// space (the same name in another case is the same person).
func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version >= 2 {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	has := false
	rows, err := tx.Query(`SELECT name FROM pragma_table_info('tokens')`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var col string
		if err := rows.Scan(&col); err != nil {
			rows.Close()
			return err
		}
		has = has || col == "person_id"
	}
	rows.Close()
	if !has {
		if _, err := tx.Exec(`ALTER TABLE tokens ADD COLUMN person_id TEXT`); err != nil {
			return err
		}
	}
	type token struct {
		id, space, name string
		created         int64
	}
	var tokens []token
	rows, err = tx.Query(`SELECT id, space_id, name, created_at FROM tokens WHERE person_id IS NULL ORDER BY created_at, id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var t token
		if err := rows.Scan(&t.id, &t.space, &t.name, &t.created); err != nil {
			rows.Close()
			return err
		}
		tokens = append(tokens, t)
	}
	rows.Close()
	made := map[string][]Person{}
	for _, t := range tokens {
		name := strings.TrimSpace(t.name)
		if name == "" {
			name = t.id
		}
		var id string
		for _, p := range made[t.space] {
			if strings.EqualFold(p.Name, name) {
				id = p.ID
			}
		}
		if id == "" {
			h, err := randomHex(6)
			if err != nil {
				return err
			}
			id = "per_" + h
			if _, err := tx.Exec(`INSERT INTO people (id, space_id, name, created_at) VALUES (?, ?, ?, ?)`, id, t.space, name, t.created); err != nil {
				return err
			}
			made[t.space] = append(made[t.space], Person{ID: id, Name: name})
		}
		if _, err := tx.Exec(`UPDATE tokens SET person_id = ? WHERE id = ?`, id, t.id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`PRAGMA user_version = 2`); err != nil {
		return err
	}
	return tx.Commit()
}

// personNamed finds the person of a space with this name, in any case; "" when there is none.
func personNamed(ctx context.Context, tx *sql.Tx, spaceID, name, except string) (string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, name FROM people WHERE space_id = ? AND id != ?`, spaceID, except)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var id, n string
		if err := rows.Scan(&id, &n); err != nil {
			return "", err
		}
		if strings.EqualFold(n, name) {
			return id, rows.Err()
		}
	}
	return "", rows.Err()
}

// AddToken makes a token for a person of a space and returns it; only its SHA-256 is stored. The person is
// found by name (in any case), or made.
func (s *Store) AddToken(ctx context.Context, spaceID, name, role string) (string, Token, error) {
	if role != "read" && role != "write" {
		return "", Token{}, invalid("A role is read or write, not %q.", role)
	}
	name, err := PersonName(name)
	if err != nil {
		return "", Token{}, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", Token{}, err
	}
	idHex, err := randomHex(6)
	if err != nil {
		return "", Token{}, err
	}
	token := "pls_" + base64.RawURLEncoding.EncodeToString(secret)
	t := Token{ID: "tok_" + idHex, SpaceID: spaceID, Role: role, CreatedAt: s.Now()}

	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return "", Token{}, err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM spaces WHERE id = ?`, spaceID).Scan(&exists); err != nil {
		return "", Token{}, err
	}
	if exists == 0 {
		return "", Token{}, ErrNotFound
	}
	personID, err := personNamed(ctx, tx, spaceID, name, "")
	if err != nil {
		return "", Token{}, err
	}
	t.Person = name
	if personID == "" {
		h, err := randomHex(6)
		if err != nil {
			return "", Token{}, err
		}
		personID = "per_" + h
		if _, err := tx.ExecContext(ctx, `INSERT INTO people (id, space_id, name, created_at) VALUES (?, ?, ?, ?)`, personID, spaceID, name, t.CreatedAt); err != nil {
			return "", Token{}, err
		}
	} else if err := tx.QueryRowContext(ctx, `SELECT name FROM people WHERE id = ?`, personID).Scan(&t.Person); err != nil {
		return "", Token{}, err
	}
	t.PersonID = personID
	if _, err := tx.ExecContext(ctx, `INSERT INTO tokens (id, space_id, name, role, hash, created_at, person_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		t.ID, spaceID, name, role, hashToken(token), t.CreatedAt, personID); err != nil {
		return "", Token{}, err
	}
	if err := tx.Commit(); err != nil {
		return "", Token{}, err
	}
	return token, t, nil
}

// People are everyone in a space, sorted the way a person reads them.
func (s *Store) People(ctx context.Context, spaceID string) ([]Person, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT p.id, p.space_id, p.name,
		EXISTS (SELECT 1 FROM tokens t WHERE t.person_id = p.id AND t.role = 'write' AND t.revoked_at IS NULL),
		(SELECT COUNT(*) FROM tokens t WHERE t.person_id = p.id AND t.revoked_at IS NULL)
		FROM people p WHERE p.space_id = ?`, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Person{}
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.ID, &p.SpaceID, &p.Name, &p.Active, &p.Tokens); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].ID < out[j].ID
	})
	return out, rows.Err()
}

// RenamePerson gives a person of a space a new name, which nobody else there has (in any case). False when it
// was their name already.
func (s *Store) RenamePerson(ctx context.Context, spaceID, personID, name string) (bool, error) {
	name, err := PersonName(name)
	if err != nil {
		return false, err
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var now string
	err = tx.QueryRowContext(ctx, `SELECT name FROM people WHERE id = ? AND space_id = ?`, personID, spaceID).Scan(&now)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	} else if err != nil {
		return false, err
	}
	if now == name {
		return false, nil
	}
	other, err := personNamed(ctx, tx, spaceID, name, personID)
	if err != nil {
		return false, err
	}
	if other != "" {
		return false, conflict(name)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE people SET name = ? WHERE id = ?`, name, personID); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// SpaceOfPerson is the space a person is in.
func (s *Store) SpaceOfPerson(ctx context.Context, personID string) (string, error) {
	var space string
	err := s.r.QueryRowContext(ctx, `SELECT space_id FROM people WHERE id = ?`, personID).Scan(&space)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return space, err
}

// Tokens lists the tokens of a space, or of all spaces when spaceID is "".
func (s *Store) Tokens(ctx context.Context, spaceID string) ([]Token, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT t.id, t.space_id, COALESCE(t.person_id, ''), COALESCE(p.name, t.name), t.role, t.created_at,
		COALESCE(t.last_used_at, 0), COALESCE(t.revoked_at, 0)
		FROM tokens t LEFT JOIN people p ON p.id = t.person_id
		WHERE ? = '' OR t.space_id = ? ORDER BY t.space_id, t.created_at, t.id`, spaceID, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		if err := rows.Scan(&t.ID, &t.SpaceID, &t.PersonID, &t.Person, &t.Role, &t.CreatedAt, &t.LastUsedAt, &t.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) RevokeToken(ctx context.Context, id string) error {
	res, err := s.w.ExecContext(ctx, `UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, s.Now(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Authenticate finds who a token belongs to. It is looked up by its SHA-256, so how long a lookup takes
// says nothing about the token. ErrNotFound: unknown or revoked.
func (s *Store) Authenticate(ctx context.Context, token string) (*Principal, error) {
	var p Principal
	err := s.r.QueryRowContext(ctx, `SELECT t.id, COALESCE(t.person_id, ''), COALESCE(pe.name, t.name), t.space_id, s.name, t.role
		FROM tokens t JOIN spaces s ON s.id = t.space_id LEFT JOIN people pe ON pe.id = t.person_id
		WHERE t.hash = ? AND t.revoked_at IS NULL`, hashToken(token)).Scan(&p.TokenID, &p.PersonID, &p.Name, &p.SpaceID, &p.SpaceName, &p.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	s.touch(p.TokenID)
	return &p, nil
}
