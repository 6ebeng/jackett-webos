#!/bin/sh
echo "=== listVersions via luna-send ==="
luna-send -n 1 -f luna://com.prowlarr.app.service/listVersions '{}'
echo ""
echo "=== end ==="
