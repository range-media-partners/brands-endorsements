import json
import os

from google.cloud import storage

BUCKET_NAME = os.environ["DATA_BUCKET"]
BLOB_NAME = "talent-demographics/latest.json"


def get_talent_data():
    client = storage.Client()
    blob = client.bucket(BUCKET_NAME).blob(BLOB_NAME)
    payload = json.loads(blob.download_as_text())
    return payload["data"]