import json
import os

from google.cloud import storage

BUCKET_NAME = os.environ["DATA_BUCKET"]
BLOB_NAME = "talent-demographics/latest.json"

_cache = None

def get_talent_data():
    global _cache
    if _cache is None:
        client = storage.Client()
        blob = client.bucket(BUCKET_NAME).blob(BLOB_NAME)
        payload = json.loads(blob.download_as_text())
        _cache = {"columns": payload["columns"], "data": payload["data"]}
    return _cache