#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="backups/vincent-$stamp.dump"
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$target"
test -s "$target"
echo "Đã tạo bản sao lưu: $target"
