#!/bin/sh
# Allow curl to localhost only. All other targets must go through wget_tool (security-vetted).
for arg in "$@"; do
	case "$arg" in
		http://localhost*|http://127.0.0.1*|http://[::1]*) exec /usr/bin/curl "$@" ;;
		https://localhost*|https://127.0.0.1*|https://[::1]*) exec /usr/bin/curl "$@" ;;
		*://*) echo "curl: external URLs blocked. Use wget_tool instead — it's guarded by the vetting LLM." >&2; exit 1 ;;
	esac
done
# No URL found in args — allow (e.g. curl --help, curl --version)
exec /usr/bin/curl "$@"
