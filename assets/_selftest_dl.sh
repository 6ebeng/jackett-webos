#!/bin/sh
S=/media/developer/apps/usr/palm/services/com.prowlarr.app.service/prowlarr-run.sh
echo "=== trigger install of v2.4.0.5397 ==="
luna-send -n 1 -f luna://com.prowlarr.app.service/selectVersion '{"version":"v2.4.0.5397"}'
echo ""
echo "=== watch state + downloadedBytes ==="
i=0
while [ $i -lt 10 ]; do
    sh "$S" status 2>&1 | tail -n1 | grep -o '"state":"[^"]*","version":"[^"]*","arch":"[^"]*","port":[0-9]*,"downloadedBytes":[0-9]*'
    sleep 3
    i=$((i + 1))
done
