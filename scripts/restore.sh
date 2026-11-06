#!/bin/sh
set -eu
if [ "${RESTORE_CONFIRM:-}" != "YES" ] || [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo 'Cách dùng: RESTORE_CONFIRM=YES ./scripts/restore.sh backups/vincent-....dump' >&2
  echo 'Hãy sao lưu hiện trạng và dừng api/worker trước khi khôi phục.' >&2
  exit 1
fi
backup="$1"
cd "$(dirname "$0")/.."
docker compose stop api worker
docker compose exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$backup"
docker compose up -d api worker
echo 'Đã khôi phục PostgreSQL. Kiểm tra dữ liệu và trạng thái đồng bộ trước khi bật thu tiền.'
