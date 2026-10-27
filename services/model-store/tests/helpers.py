"""A throwaway database per test run: created from TEST_DATABASE_URL's server, migrated with
deploy/db/migrations, dropped afterwards. Tests that need it skip without TEST_DATABASE_URL."""
import os
import uuid
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import psycopg

MIGRATIONS = Path(__file__).resolve().parents[3] / 'deploy' / 'db' / 'migrations'
ADMIN_URL = os.environ.get('TEST_DATABASE_URL')


def create_database():
    """A fresh migrated database; returns its URL."""
    name = f'pml_test_{uuid.uuid4().hex[:10]}'
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f'create database {name}')
    url = urlunparse(urlparse(ADMIN_URL)._replace(path='/' + name))
    with psycopg.connect(url, autocommit=True) as conn:
        for migration in sorted(MIGRATIONS.glob('*.sql')):
            conn.execute(migration.read_text())
    return url


def drop_database(url):
    name = urlparse(url).path.lstrip('/')
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f'drop database if exists {name} with (force)')


def new_user(url, login=None):
    with psycopg.connect(url, autocommit=True) as conn:
        return str(conn.execute('insert into users (login) values (%s) returning id', (login or f'dev:{uuid.uuid4().hex[:6]}',)).fetchone()[0])
