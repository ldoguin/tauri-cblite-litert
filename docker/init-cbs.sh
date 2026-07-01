#!/bin/sh
# Initialize Couchbase Server for sync tests.
# Runs as a one-shot container after CBS is healthy.

set -e

BASE="http://${CBS_HOST}:8091"

echo "[init-cbs] Waiting for CBS REST API…"
until code=$(curl -so /dev/null -w "%{http_code}" "${BASE}/pools") && { [ "$code" -eq 200 ] || [ "$code" -eq 401 ]; }; do sleep 2; done

echo "[init-cbs] Initializing cluster…"
curl -sf -X POST "${BASE}/pools/default" \
  -d "memoryQuota=512&indexMemoryQuota=256" || true

curl -sf -X POST "${BASE}/node/controller/setupServices" \
  -d "services=kv%2Cn1ql%2Cindex" || true

echo "[init-cbs] Setting index storage mode…"
curl -sf -X POST "${BASE}/settings/indexes" \
  -d "storageMode=plasma" || true

curl -sf -X POST "${BASE}/settings/web" \
  -d "username=${CBS_USER}&password=${CBS_PASS}&port=SAME" || true

echo "[init-cbs] Creating bucket '${CBS_BUCKET}'…"
curl -sf -u "${CBS_USER}:${CBS_PASS}" \
  -X POST "${BASE}/pools/default/buckets" \
  -d "name=${CBS_BUCKET}&bucketType=couchbase&ramQuota=256&replicaNumber=0" || true

echo "[init-cbs] Waiting for bucket to be ready…"
until curl -sf -u "${CBS_USER}:${CBS_PASS}" \
    "${BASE}/pools/default/buckets/${CBS_BUCKET}" >/dev/null; do
  sleep 2
done

# Create the required collections in the _default scope
echo "[init-cbs] Creating collections…"
for COL in photos people inspections annotations clinical; do
  curl -sf -u "${CBS_USER}:${CBS_PASS}" \
    -X POST "${BASE}/pools/default/buckets/${CBS_BUCKET}/scopes/_default/collections" \
    -d "name=${COL}" || true
  echo "  collection: ${COL}"
done

echo "[init-cbs] Waiting for N1QL (query) service to accept connections…"
until curl -sf -u "${CBS_USER}:${CBS_PASS}" \
    "http://${CBS_HOST}:8093/query/service" \
    -d "statement=SELECT+1" >/dev/null 2>&1; do
  sleep 3
done

echo "[init-cbs] Done."
