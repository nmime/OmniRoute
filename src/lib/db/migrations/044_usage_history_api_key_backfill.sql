-- Usage History API Key Backfill
-- Backfills missing API key names and IDs in usage_history using the connection_id

DROP TABLE IF EXISTS _omniroute_usage_history_api_key_name_backfill;
DROP TABLE IF EXISTS _omniroute_usage_history_api_key_id_backfill;

CREATE TEMP TABLE _omniroute_usage_history_api_key_name_backfill AS
SELECT connection_id, api_key_name
FROM (
  SELECT
    connection_id,
    api_key_name,
    ROW_NUMBER() OVER (
      PARTITION BY connection_id
      ORDER BY COUNT(*) DESC, api_key_name ASC
    ) AS rank
  FROM usage_history
  WHERE connection_id IS NOT NULL
    AND api_key_name IS NOT NULL
    AND api_key_name != ''
  GROUP BY connection_id, api_key_name
)
WHERE rank = 1;

CREATE TEMP TABLE _omniroute_usage_history_api_key_id_backfill AS
SELECT connection_id, api_key_id
FROM (
  SELECT
    connection_id,
    api_key_id,
    ROW_NUMBER() OVER (
      PARTITION BY connection_id
      ORDER BY COUNT(*) DESC, api_key_id ASC
    ) AS rank
  FROM usage_history
  WHERE connection_id IS NOT NULL
    AND api_key_id IS NOT NULL
    AND api_key_id != ''
  GROUP BY connection_id, api_key_id
)
WHERE rank = 1;

UPDATE usage_history
SET 
  api_key_name = (
    SELECT api_key_name
    FROM _omniroute_usage_history_api_key_name_backfill AS backfill
    WHERE backfill.connection_id = usage_history.connection_id
  ),
  api_key_id = (
    SELECT api_key_id
    FROM _omniroute_usage_history_api_key_id_backfill AS backfill
    WHERE backfill.connection_id = usage_history.connection_id
  )
WHERE (api_key_name IS NULL OR api_key_name = '')
  AND connection_id IS NOT NULL;

DROP TABLE IF EXISTS _omniroute_usage_history_api_key_name_backfill;
DROP TABLE IF EXISTS _omniroute_usage_history_api_key_id_backfill;
