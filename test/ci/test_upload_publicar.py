from http.client import BadStatusLine
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'skills' / 'publicar-deploy' / 'scripts'))
import upload_publicar

TEST_KEY = "upl_" + "A" * 43


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / 'docs.zip'
        with zipfile.ZipFile(self.archive, 'w') as bundle:
            bundle.writestr('index.html', 'article')
            bundle.writestr('assets/a b.txt', '')

    def test_uploads_raw_files_with_one_request_id_and_retries_only_transient_errors(self):
        requests = []
        failed = False
        final = {'ok': True, 'revision_id': 'rev_test', 'files': 2, 'entry_path': 'index.html', 'url': 'https://publicar.example/articles/'}

        def send(request, timeout):
            nonlocal failed
            query = parse_qs(urlsplit(request.full_url).query)
            stage = query['stage'][0]
            requests.append((stage, request))
            self.assertEqual(request.get_header('Idempotency-key'), 'run-1')
            self.assertEqual(request.get_header('Authorization'), 'Bearer ' + TEST_KEY)
            self.assertTrue(request.get_header('User-agent').startswith('publicar-uploader/'))
            if stage == 'start':
                manifest = json.loads(request.data)
                self.assertEqual(manifest['files'][0], {'path': 'index.html', 'size_bytes': 7,
                    'content_hash': base64.urlsafe_b64encode(hashlib.sha256(b'article').digest()).decode().rstrip('=')})
                return io.BytesIO(json.dumps({'revision_id': 'rev_test', 'status': 'uploading'}).encode())
            if stage == 'file':
                if not failed:
                    failed = True
                    raise HTTPError(request.full_url, 503, 'temporary', {}, io.BytesIO(b'private response'))
                self.assertEqual(request.data, b'article' if query['path'][0] == 'index.html' else b'')
                return io.BytesIO(json.dumps({'ok': True, 'path': query['path'][0]}).encode())
            return io.BytesIO(json.dumps(final).encode())

        with patch('urllib.request.OpenerDirector.open', side_effect=send), patch('time.sleep'):
            result = upload_publicar.upload_site(self.archive, 'https://publicar.example', 'proj_test', TEST_KEY, 'run-1')
        self.assertEqual(result, final)
        self.assertEqual([stage for stage, _ in requests], ['start', 'file', 'file', 'file', 'complete'])

    def test_never_follows_redirects_or_retries_authorization_or_conflict_errors(self):
        for status in [302, 401, 403, 409, 410]:
            with self.subTest(status=status), patch('urllib.request.OpenerDirector.open', side_effect=HTTPError(
                    'https://publicar.example', status, 'failed', {}, io.BytesIO(b'secret-reflection'))) as send:
                with self.assertRaisesRegex(RuntimeError, f'HTTP {status}') as failure:
                    upload_publicar.upload_site(self.archive, 'https://publicar.example', 'proj_test', TEST_KEY, 'run-1')
                self.assertNotIn('secret-reflection', str(failure.exception))
                self.assertEqual(send.call_count, 1)

    def test_rejects_unsafe_zip_paths_before_network_access(self):
        with zipfile.ZipFile(self.archive, 'w') as bundle:
            bundle.writestr('../index.html', 'article')
        with patch('urllib.request.OpenerDirector.open') as send:
            with self.assertRaises(ValueError):
                upload_publicar.upload_site(self.archive, 'https://publicar.example', 'proj_test', TEST_KEY, 'run-1')
            send.assert_not_called()

    def test_masks_invalid_http_responses_and_rejects_malformed_keys_without_echoing_them(self):
        with patch('urllib.request.OpenerDirector.open', side_effect=BadStatusLine('SYNTHETIC_RESPONSE_MARKER')) as send, patch('time.sleep'):
            with self.assertRaises(RuntimeError) as failure:
                upload_publicar.upload_site(self.archive, 'https://publicar.example', 'proj_test', TEST_KEY, 'run-1')
            self.assertNotIn('SYNTHETIC_RESPONSE_MARKER', str(failure.exception))
            self.assertEqual(send.call_count, 4)
        with patch('urllib.request.OpenerDirector.open') as send:
            with self.assertRaises(ValueError) as failure:
                upload_publicar.upload_site(self.archive, 'https://publicar.example', 'proj_test', 'malformed-secret\n', 'run-1')
            self.assertNotIn('malformed-secret', str(failure.exception))
            send.assert_not_called()


if __name__ == '__main__':
    unittest.main()
