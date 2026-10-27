"""Object storage for model weights and demonstrations.

OBJECT_STORE_URL picks the backend:
  file:///path/to/dir   a local directory (development and tests)
  s3://bucket/prefix    S3, or any S3-compatible store with S3_ENDPOINT_URL set
                        (credentials from the usual AWS environment variables or role)
"""
import os
from pathlib import Path
from urllib.parse import urlparse


class LocalObjects:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key):
        path = (self.root / key).resolve()
        if self.root.resolve() not in path.parents:
            raise ValueError(f'object key escapes the store: {key!r}')
        return path

    def put(self, key, data):
        path = self.path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + '.tmp')
        tmp.write_bytes(data)
        tmp.replace(path)

    def get(self, key):
        return self.path(key).read_bytes()

    def delete(self, key):
        self.path(key).unlink(missing_ok=True)


class S3Objects:
    def __init__(self, bucket, prefix='', endpoint_url=None):
        import boto3
        self.client = boto3.client('s3', endpoint_url=endpoint_url)
        self.bucket, self.prefix = bucket, prefix.strip('/')

    def key(self, key):
        return f'{self.prefix}/{key}' if self.prefix else key

    def put(self, key, data):
        self.client.put_object(Bucket=self.bucket, Key=self.key(key), Body=data)

    def get(self, key):
        return self.client.get_object(Bucket=self.bucket, Key=self.key(key))['Body'].read()

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket, Key=self.key(key))


def open_objects(url=None):
    """The object store named by `url` (default OBJECT_STORE_URL)."""
    url = url or os.environ.get('OBJECT_STORE_URL')
    if not url:
        raise ValueError('Set OBJECT_STORE_URL (file:///dir or s3://bucket/prefix).')
    parsed = urlparse(url)
    if parsed.scheme == 'file':
        return LocalObjects(parsed.path)
    if parsed.scheme == 's3':
        return S3Objects(parsed.netloc, parsed.path, os.environ.get('S3_ENDPOINT_URL') or None)
    raise ValueError(f'unsupported object store: {url!r}')
