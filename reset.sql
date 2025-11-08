-- reset.sql — "Run as new" without deleting seat definitions
-- Usage (from your VM): psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER password=$PGPASSWORD" -f reset.sql

-- 1) Clear reservations & users
TRUNCATE TABLE purchases RESTART IDENTITY CASCADE;
TRUNCATE TABLE users RESTART IDENTITY CASCADE;

-- 2) Mark all seats available again
UPDATE seats SET status = 'available';
