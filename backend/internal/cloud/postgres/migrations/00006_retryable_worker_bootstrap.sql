-- +goose Up
ALTER TABLE ao_access_tickets
    ADD COLUMN worker_epoch BIGINT;

CREATE SEQUENCE ao_worker_epoch_sequence AS BIGINT
    START WITH 2000000000000000000;

SELECT setval(
    'ao_worker_epoch_sequence',
    GREATEST(
        2000000000000000000,
        COALESCE((SELECT MAX(epoch) + 1 FROM ao_worker_connections), 1)
    ),
    false
);

-- +goose Down
DROP SEQUENCE ao_worker_epoch_sequence;

ALTER TABLE ao_access_tickets
    DROP COLUMN worker_epoch;
