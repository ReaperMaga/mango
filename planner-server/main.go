// planner-server syncs the Mango Planner plugin's boards between computers. See README.md and PROTOCOL.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/ReaperMaga/mango/planner-server/internal/api"
	"github.com/ReaperMaga/mango/planner-server/internal/live"
	"github.com/ReaperMaga/mango/planner-server/internal/store"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "0.1.0"

const keepMutations = 7 * 24 * time.Hour

const usage = `planner-server syncs the Mango Planner's boards between computers.

Usage:
  planner-server serve [--addr :8080] [--db planner.db] [--allow-origin *] [--keep-tombstones 90d]
                       [--tls-cert file --tls-key file]
  planner-server space add <id> [--name "Team"] [--db planner.db]
  planner-server space list [--db planner.db]
  planner-server space remove <id> --yes [--db planner.db]
  planner-server token add --space <id> --name <person> [--role write|read] [--db planner.db]
  planner-server token list [--space <id>] [--db planner.db]
  planner-server token revoke <tokenId> [--db planner.db]
  planner-server person list [--space <id>] [--db planner.db]
  planner-server person rename <personId> --name <new name> [--db planner.db]
  planner-server version

PLANNER_ADDR, PLANNER_DB and PLANNER_ALLOW_ORIGIN set the defaults of --addr, --db and --allow-origin.
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		var u usageError
		if errors.As(err, &u) {
			fmt.Fprintf(os.Stderr, "%s\n\n%s", err, usage)
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, "planner-server:", err)
		os.Exit(1)
	}
}

type usageError string

func (e usageError) Error() string { return string(e) }

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func run(args []string) error {
	if len(args) == 0 {
		fmt.Print(usage)
		return nil
	}
	switch cmd, rest := args[0], args[1:]; cmd {
	case "serve":
		return serve(rest)
	case "space", "token", "person":
		if len(rest) == 0 {
			return usageError("planner-server " + cmd + " needs a subcommand.")
		}
		if cmd == "space" {
			return space(rest[0], rest[1:])
		}
		if cmd == "person" {
			return person(rest[0], rest[1:])
		}
		return token(rest[0], rest[1:])
	case "version", "--version", "-v":
		fmt.Println("planner-server", version)
		return nil
	case "help", "--help", "-h":
		fmt.Print(usage)
		return nil
	}
	return usageError(fmt.Sprintf("Unknown command %q.", args[0]))
}

// parse reads flags wherever they are among the arguments, and answers the others in order.
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	fs.SetOutput(io.Discard)
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, usageError(err.Error())
		}
		args = fs.Args()
		if len(args) == 0 {
			return positional, nil
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
}

// parseKeep reads 90d, 90 (days) or a Go duration such as 2160h. 0 keeps tombstones for good.
func parseKeep(v string) (time.Duration, error) {
	if days, ok := strings.CutSuffix(v, "d"); ok {
		v = days
	}
	if n, err := strconv.Atoi(v); err == nil && n >= 0 {
		return time.Duration(n) * 24 * time.Hour, nil
	}
	if d, err := time.ParseDuration(v); err == nil && d >= 0 {
		return d, nil
	}
	return 0, usageError(fmt.Sprintf("--keep-tombstones %q: give days (90d or 90) or a duration (2160h).", v))
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", env("PLANNER_ADDR", ":8080"), "address to listen on")
	dbPath := fs.String("db", env("PLANNER_DB", "planner.db"), "the SQLite file")
	allowOrigin := fs.String("allow-origin", env("PLANNER_ALLOW_ORIGIN", "*"), "origins allowed by CORS, comma separated, or *")
	keepFlag := fs.String("keep-tombstones", "90d", "how long deleted documents are remembered")
	tlsCert := fs.String("tls-cert", "", "TLS certificate file (PEM)")
	tlsKey := fs.String("tls-key", "", "TLS key file (PEM)")
	rest, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(rest) > 0 {
		return usageError(fmt.Sprintf("serve takes no arguments, only flags (got %q).", rest[0]))
	}
	if (*tlsCert == "") != (*tlsKey == "") {
		return usageError("--tls-cert and --tls-key go together.")
	}
	keepTombstones, err := parseKeep(*keepFlag)
	if err != nil {
		return err
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	broker := live.New()
	st.OnCommit = func(space string, seq int64, docs []store.Doc) {
		broker.Publish(space, live.Event{Seq: seq, Docs: docs})
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		tick := time.NewTicker(time.Hour)
		defer tick.Stop()
		for {
			if err := st.Prune(ctx, keepMutations, keepTombstones); err != nil && ctx.Err() == nil {
				log.Error("prune", "err", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()

	srv := &http.Server{
		Addr:              *addr,
		Handler:           api.New(st, broker, "planner-server "+version, *allowOrigin, log).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute, // a 64 MiB body on a slow line
		WriteTimeout:      5 * time.Minute, // event streams lift it for themselves
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	srv.RegisterOnShutdown(broker.Close)

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", *addr, "db", *dbPath, "tls", *tlsCert != "", "version", version)
		if *tlsCert != "" {
			errc <- srv.ListenAndServeTLS(*tlsCert, *tlsKey)
		} else {
			errc <- srv.ListenAndServe()
		}
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	return nil
}

func dbFlag(fs *flag.FlagSet) *string {
	return fs.String("db", env("PLANNER_DB", "planner.db"), "the SQLite file")
}

func when(ms int64) string {
	if ms == 0 {
		return "-"
	}
	return time.UnixMilli(ms).Local().Format("2006-01-02 15:04")
}

func space(sub string, args []string) error {
	fs := flag.NewFlagSet("space "+sub, flag.ContinueOnError)
	dbPath := dbFlag(fs)
	name := fs.String("name", "", "the space's name, shown in the Planner")
	yes := fs.Bool("yes", false, "really remove it")
	rest, err := parse(fs, args)
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch sub {
	case "add":
		if len(rest) != 1 {
			return usageError("space add takes one space id.")
		}
		st, err := store.Open(*dbPath)
		if err != nil {
			return err
		}
		defer st.Close()
		if err := st.AddSpace(ctx, rest[0], *name); err != nil {
			return err
		}
		fmt.Printf("Added space %s. Make a token for it: planner-server token add --space %s --name <person>\n", rest[0], rest[0])
		return nil
	case "list":
		st, err := store.Open(*dbPath)
		if err != nil {
			return err
		}
		defer st.Close()
		spaces, err := st.Spaces(ctx)
		if err != nil {
			return err
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tNAME\tDOCUMENTS\tTOKENS\tSEQ\tCREATED")
		for _, s := range spaces {
			fmt.Fprintf(tw, "%s\t%s\t%d\t%d\t%d\t%s\n", s.ID, s.Name, s.Docs, s.Tokens, s.Seq, when(s.CreatedAt))
		}
		return tw.Flush()
	case "remove":
		if len(rest) != 1 {
			return usageError("space remove takes one space id.")
		}
		if !*yes {
			return fmt.Errorf("removing space %s deletes its documents and tokens for good; add --yes to do it", rest[0])
		}
		st, err := store.Open(*dbPath)
		if err != nil {
			return err
		}
		defer st.Close()
		if err := st.RemoveSpace(ctx, rest[0]); errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("there is no space %q", rest[0])
		} else if err != nil {
			return err
		}
		fmt.Printf("Removed space %s with its documents and tokens.\n", rest[0])
		return nil
	}
	return usageError(fmt.Sprintf("Unknown command space %s.", sub))
}

func token(sub string, args []string) error {
	fs := flag.NewFlagSet("token "+sub, flag.ContinueOnError)
	dbPath := dbFlag(fs)
	spaceID := fs.String("space", "", "the space the token is for")
	name := fs.String("name", "", "the person it is for, shown to everyone in the space (a name they have already: another token of theirs)")
	role := fs.String("role", "write", "write or read")
	rest, err := parse(fs, args)
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch sub {
	case "add":
		if len(rest) > 0 {
			return usageError("token add takes only flags.")
		}
		if *spaceID == "" || *name == "" {
			return usageError("token add needs --space and --name.")
		}
		st, err := store.Open(*dbPath)
		if err != nil {
			return err
		}
		defer st.Close()
		tok, t, err := st.AddToken(ctx, *spaceID, *name, *role)
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("there is no space %q (planner-server space list)", *spaceID)
		} else if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "Token %s (%s) for %s (%s) in space %s. It is shown only now:\n", t.ID, t.Role, t.Person, t.PersonID, t.SpaceID)
		fmt.Println(tok)
		return nil
	case "list":
		if len(rest) > 0 {
			return usageError("token list takes only flags.")
		}
		st, err := store.Open(*dbPath)
		if err != nil {
			return err
		}
		defer st.Close()
		tokens, err := st.Tokens(ctx, *spaceID)
		if err != nil {
			return err
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tSPACE\tPERSON\tPERSON ID\tROLE\tCREATED\tLAST USED\tREVOKED")
		for _, t := range tokens {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", t.ID, t.SpaceID, t.Person, t.PersonID, t.Role, when(t.CreatedAt), when(t.LastUsedAt), when(t.RevokedAt))
		}
		return tw.Flush()
	case "revoke":
		if len(rest) != 1 {
			return usageError("token revoke takes one token id (planner-server token list).")
		}
		st, err := store.Open(*dbPath)
		if err != nil {
			return err
		}
		defer st.Close()
		if err := st.RevokeToken(ctx, rest[0]); errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("there is no token %q that is not revoked already", rest[0])
		} else if err != nil {
			return err
		}
		fmt.Printf("Revoked %s. Requests with it are refused from now on.\n", rest[0])
		return nil
	}
	return usageError(fmt.Sprintf("Unknown command token %s.", sub))
}

func person(sub string, args []string) error {
	fs := flag.NewFlagSet("person "+sub, flag.ContinueOnError)
	dbPath := dbFlag(fs)
	spaceID := fs.String("space", "", "only the people of this space")
	name := fs.String("name", "", "the new name")
	rest, err := parse(fs, args)
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch sub {
	case "list":
		if len(rest) > 0 {
			return usageError("person list takes only flags.")
		}
		st, err := store.Open(*dbPath)
		if err != nil {
			return err
		}
		defer st.Close()
		spaces, err := st.Spaces(ctx)
		if err != nil {
			return err
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tSPACE\tNAME\tTOKENS\tASSIGNABLE")
		for _, sp := range spaces {
			if *spaceID != "" && sp.ID != *spaceID {
				continue
			}
			people, err := st.People(ctx, sp.ID)
			if err != nil {
				return err
			}
			for _, p := range people {
				assignable := "no"
				if p.Active {
					assignable = "yes"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%d\t%s\n", p.ID, sp.ID, p.Name, p.Tokens, assignable)
			}
		}
		return tw.Flush()
	case "rename":
		if len(rest) != 1 || *name == "" {
			return usageError("person rename takes one person id (planner-server person list) and --name.")
		}
		st, err := store.Open(*dbPath)
		if err != nil {
			return err
		}
		defer st.Close()
		space, err := st.SpaceOfPerson(ctx, rest[0])
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("there is no person %q (planner-server person list)", rest[0])
		} else if err != nil {
			return err
		}
		if _, err := st.RenamePerson(ctx, space, rest[0], *name); err != nil {
			return err
		}
		fmt.Printf("Renamed %s. Planners connected to %s show the new name within half a minute.\n", rest[0], space)
		return nil
	}
	return usageError(fmt.Sprintf("Unknown command person %s.", sub))
}
