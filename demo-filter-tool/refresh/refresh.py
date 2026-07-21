import json
import os
from datetime import datetime, timezone

import pandas as pd
import snowflake.connector
from google.cloud import storage
from cryptography.hazmat.primitives import serialization

BUCKET_NAME = os.environ["DATA_BUCKET"]
BLOB_NAME = "talent-demographics/latest.json"

def _load_private_key() -> bytes:
    """Secret Manager gives us PEM text; the Snowflake connector wants
    DER bytes. This decrypts the PEM with the passphrase, then
    re-serializes it into the format connect() expects."""
    passphrase = os.environ.get("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE")
    p_key = serialization.load_pem_private_key(
        os.environ["SNOWFLAKE_PRIVATE_KEY"].encode(),
        password=passphrase.encode() if passphrase else None,
    )
    return p_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _connect() -> snowflake.connector.SnowflakeConnection:
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        private_key=_load_private_key(),
        warehouse=os.environ.get("SNOWFLAKE_WAREHOUSE", "LOADING_WH"),
        role=os.environ.get("SNOWFLAKE_ROLE", "RANGE_DS"),
    )


def fetch_range_client_ids() -> set[str]:
    """Range's own current roster, pulled live from Snowflake instead of a
    hardcoded list — always reflects whoever is currently on roster."""
    conn = _connect()
    try:
        cur = conn.cursor()
        try:
            cur.execute("SELECT RANGE_ID FROM RANGE.ANALYTICS.VW_CURRENT_RANGE_ROSTER")
            return {row[0] for row in cur.fetchall()}
        finally:
            cur.close()
    finally:
        conn.close()


# Shared by fetch_pivoted() below. The dedup step exists because
# OBJECT_AGG errors on duplicate keys within a group.
# Removed Brands
_BASE_CTES = """
    with range_handle_mapping as (
        select RANGE_ID, DISPLAY_NAME, platform_id
        from range.analytics.entities
            inner join range.analytics.platform_ids
                using (RANGE_ID)
        where entity_type = 'talent'
            and platform = 'instagram'
    ),
    talent_demos as (
        select handle, LABEL as CRITERIA, pct * 100 as PERCENT_PCT,

        CASE
            WHEN pct_median < 0.0001 and pct_mean < 0.0001 THEN pct/0.0001
            when pct_median < 0.0001 then pct / pct_mean
            else pct/pct_median
        end as INDEX_VALUE,

        CASE
            WHEN section_name IN ('Marital status', 'Parental status')  THEN 'Family status'
            WHEN section_name = 'Age - Nielsen'                         THEN 'Age'
            WHEN section_name = 'Personal income'                       THEN 'Income'
            WHEN section_name = 'Sports - teams supported'              THEN 'Sports teams supported'
            WHEN section_name = 'Education status/level'                THEN 'Education level'
            WHEN section_name = 'Music'                                 THEN 'Favorite Music'
            WHEN section_name = 'Sport'                                 THEN 'Favorite Sport'
            ELSE SECTION_NAME
        end as CATEGORY,

        ESTIMATED_SIZE

        from range.analytics.dp_handle_demos
            inner join range.analytics.dp_taxonomy
                using (code)
            inner join range.analytics.dp_handles
                using (handle)
        where SECTION_NAME NOT IN (
            'Location: by city', 'Education Organization', 'Age - Census', 'Hashtags', 'Media', 'Occupations', 'Music - bands', 'Music - solo artists',
            'Likes & interests', 'Industries', 'Employer', 'Influences', 'Brands'
        )
        and network = 'instagram'
    ),
    joined as (
        select RANGE_ID, DISPLAY_NAME, platform_id as INSTAGRAM_HANDLE, CATEGORY, CRITERIA, PERCENT_PCT, INDEX_VALUE,
            ESTIMATED_SIZE/(CASE WHEN PERCENT_PCT = 0 THEN 0.000000001 ELSE PERCENT_PCT END) * 100 as TOTAL_FOLLOWERS
        from range_handle_mapping
            left join talent_demos
                on platform_id = handle
    ),
    talent_identity as (
        -- one DISPLAY_NAME/TOTAL_FOLLOWERS/INSTAGRAM_HANDLE per RANGE_ID via MAX
        -- immune to duplicate/near-duplicate rows in entities
        select RANGE_ID, MAX(DISPLAY_NAME) as DISPLAY_NAME, MAX(TOTAL_FOLLOWERS) as TOTAL_FOLLOWERS, MAX(INSTAGRAM_HANDLE) as INSTAGRAM_HANDLE
        from joined
        group by RANGE_ID
        having MAX(TOTAL_FOLLOWERS) is not null
    ),
    dedup as (
        -- collapses to one value per RANGE_ID/CATEGORY/CRITERIA, independent
        -- of any DISPLAY_NAME/TOTAL_FOLLOWERS differences between duplicates
        -- (this is what OBJECT_AGG below actually needs to be collision-free)
        select RANGE_ID, CATEGORY, CRITERIA,
               MAX(PERCENT_PCT) as PERCENT_PCT,
               MAX(INDEX_VALUE) as INDEX_VALUE
        from joined
        where CATEGORY is not null and CRITERIA is not null
        group by RANGE_ID, CATEGORY, CRITERIA
    )
"""

_PIVOT_QUERY = _BASE_CTES + """
    select
        ti.RANGE_ID,
        ti.DISPLAY_NAME,
        ti.TOTAL_FOLLOWERS,
        ti.INSTAGRAM_HANDLE,
        OBJECT_AGG('percent__' || d.CATEGORY || '__' || d.CRITERIA, TO_VARIANT(d.PERCENT_PCT)) as PERCENT_MAP,
        OBJECT_AGG('index__' || d.CATEGORY || '__' || d.CRITERIA, TO_VARIANT(d.INDEX_VALUE)) as INDEX_MAP
    from talent_identity ti
        inner join dedup d
            on d.RANGE_ID = ti.RANGE_ID
    group by ti.RANGE_ID, ti.DISPLAY_NAME, ti.TOTAL_FOLLOWERS, ti.INSTAGRAM_HANDLE
"""


def fetch_pivoted() -> pd.DataFrame:
    conn = _connect()
    try:
        return pd.read_sql(_PIVOT_QUERY, conn)
    finally:
        conn.close()


def _parse_pair_key(key: str, prefix: str) -> tuple[str, str]:
    """'percent__CATEGORY__CRITERIA' -> (CATEGORY, CRITERIA). Criteria may
    itself contain '__', so only split on the first '__' after the prefix."""
    category, _, criteria = key[len(prefix):].partition("__")
    return category, criteria


def build_columns(df: pd.DataFrame) -> list[dict]:
    """Distinct (category, criteria) pairs across all records, sorted for
    a stable column order run-to-run."""
    pairs = set()
    for row in df.itertuples(index=False):
        percent_map = json.loads(row.PERCENT_MAP) if row.PERCENT_MAP else {}
        for key, val in percent_map.items():
            if val is None:
                continue
            pairs.add(_parse_pair_key(key, "percent__"))
    return [{"category": c, "criteria": r} for c, r in sorted(pairs)]


def build_records(df: pd.DataFrame, columns: list[dict]) -> list[dict]:
    """Sparse shape: idx[i]/percent[i]/index[i] are parallel. idx[i] is the
    position in `columns`. Pairs absent or null for a talent are omitted."""
    col_index = {(c["category"], c["criteria"]): i for i, c in enumerate(columns)}
    records = []
    for row in df.itertuples(index=False):
        percent_map = json.loads(row.PERCENT_MAP) if row.PERCENT_MAP else {}
        index_map = json.loads(row.INDEX_MAP) if row.INDEX_MAP else {}

        idx, percent, index = [], [], []
        for key, p_val in percent_map.items():
            if p_val is None:
                continue
            category, criteria = _parse_pair_key(key, "percent__")
            idx.append(col_index[(category, criteria)])
            percent.append(p_val)
            index.append(index_map.get("index__" + category + "__" + criteria))

            # Minor update
        records.append({
            "range_id": row.RANGE_ID,
            "display_name": row.DISPLAY_NAME,
            "total_followers": row.TOTAL_FOLLOWERS,
            "instagram_handle": row.INSTAGRAM_HANDLE,
            "idx": idx,
            "percent": percent,
            "index": index,
        })
    return records


def attach_range_client_flag(records: list[dict], range_client_ids: set[str]) -> list[dict]:
    for r in records:
        r["is_range_client"] = r["range_id"] in range_client_ids
    return records


def main():
    df = fetch_pivoted()
    columns = build_columns(df)
    records = build_records(df, columns)
    range_client_ids = fetch_range_client_ids()
    records = attach_range_client_flag(records, range_client_ids)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "columns": columns,
        "data": records,
    }

    client = storage.Client()
    bucket = client.bucket(BUCKET_NAME)
    bucket.blob(BLOB_NAME).upload_from_string(
        json.dumps(payload), content_type="application/json"
    )
    print(f"Wrote {len(records)} records to gs://{BUCKET_NAME}/{BLOB_NAME}")


if __name__ == "__main__":
    main()