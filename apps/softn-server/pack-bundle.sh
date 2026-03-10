#!/usr/bin/env bash
# Pack the test-bundle directory into a .softn ZIP file
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="$SCRIPT_DIR/test-bundle"
OUTPUT="$SCRIPT_DIR/test-app.softn"

# Remove old output
rm -f "$OUTPUT"

# Use PowerShell on Windows (zip not available)
BUNDLE_WIN=$(cygpath -w "$BUNDLE_DIR")
OUTPUT_WIN=$(cygpath -w "$OUTPUT")

# PowerShell Compress-Archive only supports .zip extension, so create as .zip then rename
TEMP_ZIP="${OUTPUT%.softn}.zip"
TEMP_ZIP_WIN=$(cygpath -w "$TEMP_ZIP")
rm -f "$TEMP_ZIP"

powershell -NoProfile -Command "Compress-Archive -Path '$BUNDLE_WIN\\*' -DestinationPath '$TEMP_ZIP_WIN' -Force"
mv "$TEMP_ZIP" "$OUTPUT"

echo "Created: $OUTPUT ($(wc -c < "$OUTPUT") bytes)"
