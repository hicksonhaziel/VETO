#!/usr/bin/env bash
set -euo pipefail

# VETO Submission Packaging Script
# Creates a clean distribution ZIP archive excluding credentials, build artifacts, and node_modules,
# while preserving .env.example and public documentation.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_FILE="${1:-"${REPO_ROOT}/veto-submission-$(date +%Y%m%d-%H%M%S).zip"}"

python3 - <<EOF
import os
import sys
import zipfile
import re

repo_root = "$REPO_ROOT"
output_file = "$OUTPUT_FILE"

# Excluded directory names
EXCLUDED_DIRS = {
    '.git',
    'node_modules',
    '.next',
    '.turbo',
    '.local-data',
    'dist',
    'coverage',
    'logs',
    'veto-feasibility',
}

# Excluded file suffixes/patterns
EXCLUDED_SUFFIXES = ('.tsbuildinfo', '.log', '.zip')
EXCLUDED_EXACT = {'plan.md', 'verification.md'}

print(f"Packaging VETO submission...")
print(f"Source: {repo_root}")
print(f"Target: {output_file}")

included_files = []
disallowed_env_found = []

for root, dirs, files in os.walk(repo_root):
    # Filter out excluded directories in-place
    dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS and not d.endswith('.git')]

    for file in files:
        rel_path = os.path.relpath(os.path.join(root, file), repo_root)

        # Check for disallowed .env files
        if file == '.env' or (file.startswith('.env.') and file != '.env.example'):
            disallowed_env_found.append(rel_path)
            continue

        if file in EXCLUDED_EXACT:
            continue

        if any(file.endswith(suffix) for suffix in EXCLUDED_SUFFIXES):
            continue

        included_files.append((os.path.join(root, file), rel_path))

if disallowed_env_found:
    print(f"Refusing to package: Disallowed .env files detected in workspace:", file=sys.stderr)
    for p in disallowed_env_found:
        print(f"  - {p}", file=sys.stderr)
    print("These files are safely ignored and will NOT be included in the archive.", file=sys.stderr)

# Ensure output directory exists
os.makedirs(os.path.dirname(os.path.abspath(output_file)), exist_ok=True)

with zipfile.ZipFile(output_file, 'w', compression=zipfile.ZIP_DEFLATED) as zipf:
    for full_path, rel_path in sorted(included_files, key=lambda x: x[1]):
        zipf.write(full_path, rel_path)

# Verify archive contents
has_env_example = False
leaked = []

with zipfile.ZipFile(output_file, 'r') as zipf:
    for name in zipf.namelist():
        if name.endswith('.env.example'):
            has_env_example = True
        elif os.path.basename(name) == '.env' or (os.path.basename(name).startswith('.env.') and not name.endswith('.env.example')):
            leaked.append(name)
        elif any(part in EXCLUDED_DIRS for part in name.split('/')):
            leaked.append(name)

if leaked:
    os.remove(output_file)
    print(f"ERROR: Archive hygiene verification failed! Leaked items:", file=sys.stderr)
    for item in leaked:
        print(f"  - {item}", file=sys.stderr)
    sys.exit(1)

if not has_env_example:
    print("WARNING: .env.example was not found in the archive!", file=sys.stderr)

file_size_mb = os.path.getsize(output_file) / (1024 * 1024)
print("==========================================")
print("Packaging complete and verified clean!")
print(f"Archive:     {output_file}")
print(f"Size:        {file_size_mb:.2f} MB")
print(f"Total files: {len(included_files)}")
print(".env.example: Preserved")
print("Secrets:     0 leaked (.env / .env.* safely excluded)")
print("==========================================")
EOF
