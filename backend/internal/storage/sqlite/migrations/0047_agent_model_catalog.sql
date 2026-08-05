-- +goose Up
CREATE TABLE agent_model_catalog (
    agent_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    binary_version TEXT NOT NULL DEFAULT '',
    catalog_json TEXT NOT NULL,
    source TEXT NOT NULL,
    fetched_at TIMESTAMP NOT NULL,
    PRIMARY KEY (agent_id, project_id)
);

-- +goose Down
DROP TABLE agent_model_catalog;
