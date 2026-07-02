#!/bin/sh
echo "=== calling selectVersion via luna-send ==="
luna-send -n 1 -f luna://com.prowlarr.app.service/selectVersion '{"version":"v2.4.0.5391"}'
echo ""
echo "=== state watch ==="
S=/media/developer/apps/usr/palm/services/com.prowlarr.app.service/prowlarr-run.sh
for i in 1 2 3 4 5; do
    sh "$S" status 2>&1 | tail -n1 | grep -o '"state":"[^"]*"'
    sleep 3
done
