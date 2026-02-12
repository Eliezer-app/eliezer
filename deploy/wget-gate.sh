#!/bin/sh
# Allow wget to localhost only. All other targets must go through wget_tool (security-vetted).
for arg in "$@"; do
	case "$arg" in
		http://localhost*|http://127.0.0.1*|http://[::1]*) exec /usr/bin/wget "$@" ;;
		https://localhost*|https://127.0.0.1*|https://[::1]*) exec /usr/bin/wget "$@" ;;
		*://*) echo "wget: external URLs blocked. Use wget_tool instead — it's guarded by the vetting LLM." >&2; exit 1 ;;
	esac
done
# No URL found in args — allow (e.g. wget --help, wget --version)
exec /usr/bin/wget "$@"
