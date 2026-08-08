#!/usr/bin/env bash
#
# One-shot setup for the gcloud MCP server, so Claude can drive Google Cloud in
# the same session it already drives Supabase.
#
# Run once on your own machine, from the repo root:
#
#   ./scripts/setup-gcloud-mcp.sh
#
# Then restart Claude Code. The server is declared in .mcp.json and starts
# automatically; the Supabase MCP is a claude.ai connector and is unaffected.
#
# What it does NOT do: create the Google OAuth client for Sign in with Google.
# No Google API can. See supabase/README.md.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-cloud-xp}"
ACL_DIR="$HOME/.config/gcloud-mcp"
ACL_FILE="$ACL_DIR/acl.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- gcloud CLI
if command -v gcloud >/dev/null 2>&1; then
  say "gcloud already installed: $(gcloud --version | head -1)"
else
  say "Installing the gcloud CLI"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install --cask google-cloud-sdk
      else
        echo "Homebrew not found. Install gcloud manually:"
        echo "  https://cloud.google.com/sdk/docs/install"
        exit 1
      fi
      ;;
    Linux)
      curl -fsSL https://sdk.cloud.google.com | bash -s -- --disable-prompts
      # shellcheck disable=SC1090
      source "$HOME/google-cloud-sdk/path.bash.inc"
      ;;
    *)
      echo "Unsupported platform. Install gcloud manually:"
      echo "  https://cloud.google.com/sdk/docs/install"
      exit 1
      ;;
  esac
fi

# ---------------------------------------------------------------- access control
# The MCP server runs whatever gcloud command it is handed, so the denylist is
# the only thing standing between a bad inference and a deleted project. Deny
# beats allow here: an allowlist would need constant widening and would quietly
# break reads, while these entries are the operations that are not recoverable.
say "Writing the command denylist to $ACL_FILE"
mkdir -p "$ACL_DIR"
cat > "$ACL_FILE" <<'JSON'
{
  "deny": [
    "projects delete",
    "resource-manager",
    "iam service-accounts keys create",
    "billing",
    "sql instances delete",
    "storage rm",
    "compute instances delete",
    "run services delete",
    "secrets delete",
    "auth revoke"
  ]
}
JSON

# ---------------------------------------------------------------- auth
if gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  say "Already signed in as $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
else
  say "Opening a browser to sign in to Google Cloud"
  gcloud auth login
fi

say "Setting up application default credentials"
gcloud auth application-default login || true

say "Setting the active project to $PROJECT_ID"
gcloud config set project "$PROJECT_ID"

# ---------------------------------------------------------------- verify
say "Verifying"
gcloud config list
echo
echo "Projects visible to this account:"
gcloud projects list --format="table(projectId,name)" 2>/dev/null || \
  echo "  (none listed — the account may lack resourcemanager.projects.list)"

say "Done. Restart Claude Code, then ask it to run a gcloud command."
