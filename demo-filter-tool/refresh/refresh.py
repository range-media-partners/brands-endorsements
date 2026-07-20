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


# To be replaced by Snowflake pull eventually once those IDs are stored in Snowflake
RANGE_CLIENT_IDS = {
    'RNG-0003857', 'RNG-0004256', 'RNG-0001303', 'RNG-0000084', 'RNG-0003914', 'RNG-0003711', 'RNG-0000365', 'RNG-0001459', 'RNG-0000284', 'RNG-0001620', 'RNG-0001748', 'RNG-0000409', 
    'RNG-0001780', 'RNG-0000870', 'RNG-0000407', 'RNG-0000457', 'RNG-0004173', 'RNG-0002664', 'RNG-0000880', 'RNG-0001601', 'RNG-0000732', 'RNG-0003932', 'RNG-0000599', 'RNG-0003562', 
    'RNG-0003684', 'RNG-0001685', 'RNG-0004326', 'RNG-0003623', 'RNG-0002230', 'RNG-0003537', 'RNG-0003663', 'RNG-0003720', 'RNG-0004107', 'RNG-0004854', 'RNG-0000739', 'RNG-0001642', 
    'RNG-0004291', 'RNG-0001939', 'RNG-0001738', 'RNG-0002742', 'RNG-0004349', 'RNG-0000340', 'RNG-0002008', 'RNG-0003620', 'RNG-0000953', 'RNG-0004855', 'RNG-0000974', 'RNG-0003523', 
    'RNG-0003683', 'RNG-0004212', 'RNG-0003599', 'RNG-0002617', 'RNG-0004856', 'RNG-0002687', 'RNG-0001143', 'RNG-0003630', 'RNG-0003609', 'RNG-0002248', 'RNG-0002144', 'RNG-0002263', 
    'RNG-0003238', 'RNG-0002527', 'RNG-0000301', 'RNG-0003555', 'RNG-0003641', 'RNG-0003579', 'RNG-0003608', 'RNG-0003851', 'RNG-0000622', 'RNG-0003822', 'RNG-0002111', 'RNG-0002874', 
    'RNG-0003246', 'RNG-0003180', 'RNG-0004814', 'RNG-0001046', 'RNG-0004831', 'RNG-0004820', 'RNG-0004770', 'RNG-0004857', 'RNG-0004858', 'RNG-0004862', 'RNG-0004916', 'RNG-0001607', 
    'RNG-0001657', 'RNG-0000092', 'RNG-0004052', 'RNG-0000119', 'RNG-0000353', 'RNG-0001358', 'RNG-0000260', 'RNG-0001321', 'RNG-0004065', 'RNG-0001652', 'RNG-0000103', 'RNG-0004769', 
    'RNG-0000945', 'RNG-0002710', 'RNG-0001823', 'RNG-0001458', 'RNG-0000289', 'RNG-0000612', 'RNG-0000438', 'RNG-0004214', 'RNG-0000440', 'RNG-0003604', 'RNG-0003699', 'RNG-0003636', 
    'RNG-0003710', 'RNG-0002201', 'RNG-0003714', 'RNG-0003724', 'RNG-0004863', 'RNG-0002474', 'RNG-0003544', 'RNG-0003666', 'RNG-0002588', 'RNG-0002214', 'RNG-0000577', 'RNG-0002055', 
    'RNG-0002279', 'RNG-0003973', 'RNG-0003705', 'RNG-0000679', 'RNG-0002105', 'RNG-0004864', 'RNG-0002669', 'RNG-0003557', 'RNG-0001349', 'RNG-0000529', 'RNG-0001741', 'RNG-0000308', 
    'RNG-0001361', 'RNG-0000056', 'RNG-0001893', 'RNG-0001453', 'RNG-0001698', 'RNG-0002199', 'RNG-0001467', 'RNG-0003565', 'RNG-0004865', 'RNG-0000530', 'RNG-0004029', 'RNG-0004193', 
    'RNG-0003598', 'RNG-0002631', 'RNG-0001910', 'RNG-0001742', 'RNG-0001519', 'RNG-0002380', 'RNG-0002888', 'RNG-0003538', 'RNG-0002942', 'RNG-0003674', 'RNG-0000701', 'RNG-0003589', 
    'RNG-0004866', 'RNG-0001632', 'RNG-0003925', 'RNG-0003621', 'RNG-0004266', 'RNG-0004867', 'RNG-0004517', 'RNG-0004847', 'RNG-0003658', 'RNG-0003843', 'RNG-0004868', 'RNG-0004869', 
    'RNG-0004515', 'RNG-0004870', 'RNG-0000745', 'RNG-0001294', 'RNG-0003625', 'RNG-0001284', 'RNG-0000160', 'RNG-0001686', 'RNG-0001444', 'RNG-0001989', 'RNG-0003010', 'RNG-0003648', 
    'RNG-0003524', 'RNG-0001131', 'RNG-0000505', 'RNG-0002392', 'RNG-0001664', 'RNG-0004871', 'RNG-0001782', 'RNG-0001281', 'RNG-0001874', 'RNG-0001052', 'RNG-0001803', 'RNG-0002131', 
    'RNG-0000689', 'RNG-0001283', 'RNG-0001420', 'RNG-0003751', 'RNG-0004872', 'RNG-0000281', 'RNG-0000348', 'RNG-0002615', 'RNG-0002119', 'RNG-0000576', 'RNG-0004145', 'RNG-0002150',
    'RNG-0003823', 'RNG-0004159', 'RNG-0000995', 'RNG-0004874', 'RNG-0001129', 'RNG-0000523', 'RNG-0002294', 'RNG-0004264', 'RNG-0000885', 'RNG-0002543', 'RNG-0001703', 'RNG-0003943', 
    'RNG-0003959', 'RNG-0000590', 'RNG-0002267', 'RNG-0000774', 'RNG-0000884', 'RNG-0001691', 'RNG-0004875', 'RNG-0004651', 'RNG-0004876', 'RNG-0000500', 'RNG-0000461', 'RNG-0004650', 
    'RNG-0003603', 'RNG-0001901', 'RNG-0002345', 'RNG-0000280', 'RNG-0001684', 'RNG-0001378', 'RNG-0004160', 'RNG-0001512', 'RNG-0000484', 'RNG-0002506', 'RNG-0003534', 'RNG-0002316', 
    'RNG-0001430', 'RNG-0002001', 'RNG-0004877', 'RNG-0000680', 'RNG-0004878', 'RNG-0003592', 'RNG-0001988', 'RNG-0002471', 'RNG-0000216', 'RNG-0004062', 'RNG-0001884', 'RNG-0001879', 
    'RNG-0000503', 'RNG-0003626', 'RNG-0001712', 'RNG-0003567', 'RNG-0000960', 'RNG-0001220', 'RNG-0003638', 'RNG-0000408', 'RNG-0001817', 'RNG-0003731', 'RNG-0004099', 'RNG-0004879', 
    'RNG-0003995', 'RNG-0004137', 'RNG-0003545', 'RNG-0000655', 'RNG-0000520', 'RNG-0000833', 'RNG-0003531', 'RNG-0004095', 'RNG-0004271', 'RNG-0001860', 'RNG-0003657', 'RNG-0000842', 
    'RNG-0003610', 'RNG-0002208', 'RNG-0000802', 'RNG-0003650', 'RNG-0001168', 'RNG-0004027', 'RNG-0003532', 'RNG-0003605', 'RNG-0000727', 'RNG-0004130', 'RNG-0004129', 'RNG-0000264', 
    'RNG-0004151', 'RNG-0002016', 'RNG-0001627', 'RNG-0004237', 'RNG-0000886', 'RNG-0001912', 'RNG-0003722', 'RNG-0003868', 'RNG-0004174', 'RNG-0003945', 'RNG-0003726', 'RNG-0003977', 
    'RNG-0003248', 'RNG-0003615', 'RNG-0003694', 'RNG-0001837', 'RNG-0003941', 'RNG-0003639', 'RNG-0001001', 'RNG-0004104', 'RNG-0002216', 'RNG-0000270', 'RNG-0003078', 'RNG-0004248', 
    'RNG-0000127', 'RNG-0000531', 'RNG-0002020', 'RNG-0000475', 'RNG-0004262', 'RNG-0003799', 'RNG-0000723', 'RNG-0000528', 'RNG-0000916', 'RNG-0003570', 'RNG-0001109', 'RNG-0003704', 
    'RNG-0000803', 'RNG-0002531', 'RNG-0002323', 'RNG-0003558', 'RNG-0002884', 'RNG-0001637', 'RNG-0000786', 'RNG-0002554', 'RNG-0004880', 'RNG-0002154', 'RNG-0004881', 'RNG-0003902', 
    'RNG-0003654', 'RNG-0000300', 'RNG-0000990', 'RNG-0002960', 'RNG-0003587', 'RNG-0004882', 'RNG-0002964', 'RNG-0001771', 'RNG-0002876', 'RNG-0003689', 'RNG-0003547', 'RNG-0003578', 
    'RNG-0001032', 'RNG-0002251', 'RNG-0004846', 'RNG-0004177', 'RNG-0001094', 'RNG-0004134', 'RNG-0004883', 'RNG-0001452', 'RNG-0001831', 'RNG-0000387', 'RNG-0000628', 'RNG-0003976', 
    'RNG-0004884', 'RNG-0000448', 'RNG-0003546', 'RNG-0000841', 'RNG-0003591', 'RNG-0003697', 'RNG-0003628', 'RNG-0003680', 'RNG-0000571', 'RNG-0002604', 'RNG-0003729', 'RNG-0004885', 
    'RNG-0000871', 'RNG-0003718', 'RNG-0004889', 'RNG-0002785', 'RNG-0004890', 'RNG-0004893', 'RNG-0004892', 'RNG-0000412', 'RNG-0000473', 'RNG-0001962', 'RNG-0001281', 'RNG-0000972', 
    'RNG-0001460', 'RNG-0000543', 'RNG-0002157', 'RNG-0000604', 'RNG-0000663', 'RNG-0004893', 'RNG-0002064', 'RNG-0000380', 'RNG-0000589', 'RNG-0000866', 'RNG-0001666', 'RNG-0001492', 
    'RNG-0000680', 'RNG-0003521', 'RNG-0000914', 'RNG-0000935', 'RNG-0004894'
}

def _connect() -> snowflake.connector.SnowflakeConnection:
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        private_key=_load_private_key(),
        warehouse=os.environ.get("SNOWFLAKE_WAREHOUSE", "LOADING_WH"),
        role=os.environ.get("SNOWFLAKE_ROLE", "RANGE_DS"),
    )


# Shared by the pairs lookup and both pivot queries below, so the
# category/criteria derivation logic can't drift between them.
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
            WHEN section_name IN ('Marital status', 'Parental status') THEN 'Family status'
            ELSE section_name
        end as CATEGORY,

        followers_submitted as TOTAL_FOLLOWERS

        from range.analytics.dp_handle_demos
            inner join range.analytics.dp_taxonomy
                using (code)
            inner join range.analytics.dp_handles
                using (handle)
        where SECTION_NAME NOT IN (
            'Location: by city', 'Education Organization', 'Age - Census', 'Hashtags', 'Media', 'Occupations', 'Music - bands', 'Music - solo artists',
            'Likes & interests', 'Industries', 'Employer', 'Influences'
        )
        and network = 'instagram'
    ),
    joined as (
        select RANGE_ID, DISPLAY_NAME, TOTAL_FOLLOWERS, CATEGORY, CRITERIA, PERCENT_PCT, INDEX_VALUE
        from range_handle_mapping
            left join talent_demos
                on platform_id = handle
    )
"""


def _fetch_category_criteria_pairs(conn) -> list[tuple[str, str]]:
    """Distinct (CATEGORY, CRITERIA) combinations — drives how many
    percent__/index__ columns each pivot query generates (~11,350 pairs,
    confirmed against DP_TAXONOMY)."""
    query = _BASE_CTES + """
        select distinct CATEGORY, CRITERIA
        from joined
        where CATEGORY is not null and CRITERIA is not null
        order by 1, 2
    """
    cur = conn.cursor()
    try:
        cur.execute(query)
        return cur.fetchall()
    finally:
        cur.close()


def _escape_literal(text: str) -> str:
    return text.replace("'", "''")


def _escape_ident(text: str) -> str:
    return text.replace('"', '""')


def _build_pivot_query(pairs: list[tuple[str, str]], value_col: str) -> str:
    """value_col is 'PERCENT_PCT' or 'INDEX_VALUE'. One MAX(CASE WHEN...)
    conditional-aggregate column per pair, done server-side in Snowflake —
    the DataFrame we build locally ends up ~1,850 x ~11,350, not the
    ~5M-row long format that was OOMing the job."""
    prefix = "percent__" if value_col == "PERCENT_PCT" else "index__"
    case_lines = []
    for category, criteria in pairs:
        cat_lit = _escape_literal(category)
        crit_lit = _escape_literal(criteria)
        col_name = _escape_ident(f"{prefix}{category}__{criteria}")
        case_lines.append(
            f"MAX(CASE WHEN CATEGORY = '{cat_lit}' AND CRITERIA = '{crit_lit}' "
            f'THEN {value_col} END) AS "{col_name}"'
        )
    case_sql = ",\n        ".join(case_lines)

    return _BASE_CTES + f"""
        select
            RANGE_ID,
            MAX(DISPLAY_NAME) as DISPLAY_NAME,
            MAX(TOTAL_FOLLOWERS) as TOTAL_FOLLOWERS,
            {case_sql}
        from joined
        group by RANGE_ID
        having MAX(TOTAL_FOLLOWERS) is not null
    """


def fetch_pivoted_frames() -> tuple[pd.DataFrame, pd.DataFrame]:
    conn = _connect()
    try:
        pairs = _fetch_category_criteria_pairs(conn)
        percent_df = pd.read_sql(_build_pivot_query(pairs, "PERCENT_PCT"), conn)
        index_df = pd.read_sql(_build_pivot_query(pairs, "INDEX_VALUE"), conn)
        return percent_df, index_df
    finally:
        conn.close()


def merge_wide(percent_df: pd.DataFrame, index_df: pd.DataFrame) -> list[dict]:
    """Both frames are already one row per talent — just join them,
    same shape the frontend already expects."""
    index_df = index_df.drop(columns=["DISPLAY_NAME", "TOTAL_FOLLOWERS"])
    wide = percent_df.merge(index_df, on="RANGE_ID", how="inner")
    wide = wide.rename(columns={
        "RANGE_ID": "range_id",
        "DISPLAY_NAME": "display_name",
        "TOTAL_FOLLOWERS": "total_followers",
    })
    wide = wide.where(pd.notnull(wide), None)
    return wide.to_dict(orient="records")


def attach_range_client_flag(records: list[dict]) -> list[dict]:
    for r in records:
        r["is_range_client"] = r["range_id"] in RANGE_CLIENT_IDS
    return records


def main():
    percent_df, index_df = fetch_pivoted_frames()
    records = merge_wide(percent_df, index_df)
    records = attach_range_client_flag(records)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
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