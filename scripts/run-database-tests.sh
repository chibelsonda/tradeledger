#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required." >&2
    exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database_name="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align \
    --command='select current_database();')"

if [[ "$database_name" != *_test ]]; then
    echo "Refusing to run against database '$database_name'; the name must end in _test." >&2
    exit 1
fi

existing_application_table="$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align \
    --command="select to_regclass('public.payments') is not null;")"

if [[ "$existing_application_table" == "t" ]]; then
    echo "Refusing to run against a non-empty application database." >&2
    exit 1
fi

psql_options=("$DATABASE_URL" --no-psqlrc --set=ON_ERROR_STOP=1)

psql "${psql_options[@]}" \
    --file="$project_root/supabase/tests/support/auth_stub.sql"
psql "${psql_options[@]}" \
    --file="$project_root/supabase/tests/support/storage_stub.sql"

for migration in "$project_root"/supabase/migrations/*.sql; do
    echo "Applying $(basename "$migration")"
    psql "${psql_options[@]}" --file="$migration"
done

echo "Running tenant security and payment lifecycle scenarios"
psql "${psql_options[@]}" \
    --file="$project_root/supabase/tests/multi_tenant_foundation.sql"

echo "Database integration tests passed."
