-- reset.sql — "Run as new" without deleting seat definitions
-- Usage (from your VM): psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER password=$PGPASSWORD" -f reset.sql

-- 1) Clear reservations & users
TRUNCATE TABLE purchases RESTART IDENTITY CASCADE;
TRUNCATE TABLE users RESTART IDENTITY CASCADE;

-- 2) Mark all seats available again
UPDATE seats SET status = 'available';



INSERT INTO purchases (order_id, phone, email, affiliation, reserved_at, created_at)
VALUES ('RMHFRNK9P', '6504185241', 'josuegarciastudio@gmail.com', 'none', now(), now());

INSERT INTO purchase_seats (order_id, seat_id, guest_name)
VALUES 
    ('RMHFRNK9P', 'B05', 'Josue Garcia'),
    ('RMHFRNK9P', 'B06', 'Josue Garcia');