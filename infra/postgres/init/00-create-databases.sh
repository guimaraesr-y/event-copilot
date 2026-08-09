#!/bin/sh
set -eu

if ! psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_database WHERE datname='n8n'" | grep -q 1; then
  createdb --username "$POSTGRES_USER" --owner "$POSTGRES_USER" n8n
fi
