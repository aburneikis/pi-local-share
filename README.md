# pi-local-share

Serve the current pi session as HTML on your LAN instead of exporting a file or pushing to GitHub.

## Install

```
pi install /home/aburneikis/Code/pi-local-share
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
