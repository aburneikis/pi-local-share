# pi-local-share

Serve the current pi session as HTML on your LAN instead of exporting a file or pushing to GitHub.

## Security

The server binds to `0.0.0.0` over plain HTTP with no authentication. Anyone on your
network who has (or guesses) the URL can read the whole session transcript, including any
secrets, file contents or command output it contains. Only use this on a network you trust,
and stop the share when you are done.

## Install

(cd to the dir)
```
pi install .
```

from github
```
pi install https://github.com/aburneikis/pi-local-share
```

or symlink `index.ts` into `~/.pi/agent/extensions/`.

## Usage

```
/lshare          # share for 1h
/lshare 30m      # custom duration (s, m, h, d)
/lshare status
/lshare stop
```

The URL is `http://<lan-ip>:<random-port>/<random-slug>`, copied to the clipboard via `wl-copy`.
The page is re-exported on each request (cached 5s), so teammates see the live session on refresh.
The server stops when the time runs out or when pi exits.

(wl-copy wont work on all systems, e.g. macOS)
