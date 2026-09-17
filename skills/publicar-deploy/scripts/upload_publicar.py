#!/usr/bin/env python3
"""生成済みZIPのファイルをpublicarへ分割送信する。"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import time
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request
import zipfile


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def upload_site(archive: Path, endpoint: str, project_id: str, key: str, request_id: str) -> dict:
    parsed = urlsplit(endpoint)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('PUBLICAR_ENDPOINTにはHTTPSの接続先を指定してください')
    if not re.fullmatch(r'proj_[A-Za-z0-9_-]+', project_id) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', request_id) or not re.fullmatch(r'upl_[A-Za-z0-9_-]{43}', key):
        raise ValueError('プロジェクト、要求ID、キーの設定を確認してください')
    entries = []
    paths = set()
    total = 0
    with zipfile.ZipFile(archive) as bundle:
        for file in bundle.infolist():
            if file.is_dir():
                continue
            path = file.filename
            if (path.startswith('/') or '\\' in path or path != path.strip() or len(path.encode()) > 512 or
                    any(part in ('', '.', '..') for part in path.split('/')) or path in paths or
                    any(ord(char) < 32 or ord(char) == 127 for char in path)):
                raise ValueError('ZIPに不正なファイルパスがあります')
            paths.add(path)
            total += file.file_size
            if len(paths) > 200 or total > 20 * 1024 * 1024 or file.file_size > 5 * 1024 * 1024:
                raise ValueError('publicarのファイル数または容量上限を超えています')
            with bundle.open(file) as source:
                content = source.read(5 * 1024 * 1024 + 1)
            if len(content) != file.file_size:
                raise ValueError('ZIPのファイルサイズが一致しません')
            entries.append(({'path': path, 'size_bytes': len(content), 'content_hash':
                base64.urlsafe_b64encode(hashlib.sha256(content).digest()).decode().rstrip('=')}, content))
    if not entries or not any(meta['path'].endswith('.html') for meta, _ in entries):
        raise ValueError('HTMLの入口ファイルが必要です')
    manifest = json.dumps({'files': [meta for meta, _ in entries]}, ensure_ascii=False, separators=(',', ':')).encode()
    if len(manifest) > 128 * 1024:
        raise ValueError('送信ファイル一覧が128KiBを超えています')
    opener = build_opener(NoRedirect())
    deadline = time.monotonic() + 14 * 60
    url = endpoint.rstrip('/') + '/api/v1/projects/' + project_id + '/deploy'

    def send(stage, body=b'', path=None):
        query = {'stage': stage}
        if path is not None:
            query['path'] = path
        request = Request(url + '?' + urlencode(query), method='POST', data=body, headers={
            'Authorization': 'Bearer ' + key, 'Idempotency-Key': request_id,
            'User-Agent': 'publicar-uploader/1.0 (+https://github.com/u-ichi/cliniconnect-patient-recruitment)',
            'Content-Type': 'application/json' if stage == 'start' else 'application/octet-stream'})
        for attempt in range(4):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('分割送信の実行期限を超えました。公開確定結果を確認してください')
            try:
                with opener.open(request, timeout=min(60, remaining)) as response:
                    content = response.read(64 * 1024 + 1)
                if len(content) > 64 * 1024:
                    raise RuntimeError('publicarの応答が上限を超えています')
                value = json.loads(content)
                if not isinstance(value, dict):
                    raise ValueError('invalid response')
                return value
            except HTTPError as error:
                status = error.code
                error.close()
                if status not in (408, 429, 500, 502, 503, 504) or attempt == 3:
                    raise RuntimeError(f'publicar {stage}: HTTP {status}') from None
            except (URLError, TimeoutError, ConnectionError, HTTPException):
                if attempt == 3:
                    raise RuntimeError(f'publicar {stage}: 通信に失敗しました') from None
            except (ValueError, UnicodeError):
                # 応答が壊れた場合も同じIDで再送し、受付済みかをサーバー側で判定する。
                if attempt == 3:
                    raise RuntimeError(f'publicar {stage}: 応答を確認できませんでした') from None
            time.sleep(min(2 ** attempt, max(0, deadline - time.monotonic())))
        raise RuntimeError('publicarの応答を取得できませんでした')

    started = send('start', manifest)
    revision = started.get('revision_id')
    if not isinstance(revision, str) or not re.fullmatch(r'rev_[A-Za-z0-9_-]+', revision):
        raise RuntimeError('publicarの更新IDを確認できませんでした')
    if started.get('status') == 'uploading':
        for meta, content in entries:
            result = send('file', content, meta['path'])
            if result.get('ok') is not True or result.get('path') != meta['path']:
                raise RuntimeError('ファイルの保存結果が一致しません')
    elif started.get('ok') is not True:
        raise RuntimeError('publicarの送信開始結果を確認できませんでした')
    completed = send('complete')
    if (completed.get('ok') is not True or completed.get('revision_id') != revision or
            completed.get('files') != len(entries) or completed.get('entry_path') not in paths):
        raise RuntimeError('publicarの公開確定結果が一致しません')
    return {name: completed[name] for name in ('ok', 'revision_id', 'files', 'entry_path', 'url')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=Path('tmp/publicar/docs.zip'))
    parser.add_argument('--result', type=Path, default=Path('tmp/publicar/result.json'))
    args = parser.parse_args()
    try:
        result = upload_site(args.archive, os.environ['PUBLICAR_ENDPOINT'], os.environ['PUBLICAR_PROJECT_ID'],
            os.environ['PUBLICAR_DEPLOY_KEY'], f"gh-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}")
    except (RuntimeError, ValueError, KeyError, zipfile.BadZipFile, OSError) as error:
        # 外部応答、ヘッダー、秘密値を例外表示へ含めない。
        if isinstance(error, (RuntimeError, ValueError)):
            parser.exit(1, str(error) + '\n')
        parser.exit(1, '送信ファイルまたは環境設定を確認してください\n')
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(json.dumps(result, ensure_ascii=False) + '\n')
    print('published_revision=' + result['revision_id'])
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write(f"source_commit={os.environ.get('GITHUB_SHA', '')}\n\nrevision={result['revision_id']}\n")


if __name__ == '__main__':
    main()
