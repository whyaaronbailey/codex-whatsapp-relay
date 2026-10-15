import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('capture_bridge', Path(__file__).with_name('capture-desktop-bridge-binding.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class CaptureFixture(unittest.TestCase):
    def setUp(self):
        self.paths = {'desktop': r'C:\Reviewed\ChatGPT.exe', 'shim': r'C:\Candidate\codex-desktop-owned-shim.exe',
                      'bridge': r'C:\Reviewed\node.exe', 'server': r'C:\Reviewed\codex.exe',
                      'script': r'C:\Reviewed\bridge.mjs', 'config': r'C:\Candidate\codex-desktop-owned-shim.exe.json'}
        self.pins = {role: str(index + 1) * 64 for index, role in enumerate(self.paths)}
        self.stage_path = r'C:\Candidate\candidate-manifest.json'
        self.output = r'C:\Candidate\new-binding.json'
        self.stage = {'schema': c.STAGE_SCHEMA, 'activated': False, 'executable': self.paths['shim'],
                      'configFile': self.paths['config'], 'expectedHashes': {role: self.pins[role] for role in c.PIN_ROLES},
                      'files': [{'path': self.paths[role], 'sha256': self.pins[role]} for role in c.PIN_ROLES]}
        self.config = {'schema': c.CONFIG_SCHEMA, 'realCliPath': self.paths['server'], 'nodePath': self.paths['bridge'],
                       'bridgePath': self.paths['script'], 'tokenFile': r'C:\Private\must-not-read.token',
                       'statusFile': r'C:\Candidate\status.json', 'port': 4505}
        self.status = {'schema': 'codex-desktop-stdio-health-v1', 'instanceId': 'instance_0123456789',
                       'primaryReady': True, 'state': 'ready', 'bridgePid': 102, 'backendPid': 103,
                       'parentPid': 101, 'shimPid': 101, 'execPath': self.paths['bridge'],
                       'scriptPath': self.paths['script'], 'configPath': self.paths['config'],
                       'recordedAt': '2026-10-15T01:00:00Z'}
        native = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '--stdio']
        argv = {'desktop': [self.paths['desktop']], 'shim': [self.paths['shim'], *native],
                'bridge': [self.paths['bridge'], self.paths['script'], '--config', self.paths['config'], '--', *native],
                'server': [self.paths['server'], *native]}
        self.observation = {'computer': 'KAMPUTER', 'processes': [
            {'pid': 100 + index, 'parent': 99 + index, 'path': self.paths[role],
             'created': f'2026-10-15T01:00:0{index}.0000001Z', 'commandLine': json.dumps(argv[role])}
            for index, role in enumerate(c.runtime.ROLES)]}
        self.hashes = {c.runtime.canonical(path): self.pins[role] for role, path in self.paths.items()}

    def build(self):
        return c.build_manifest(self.stage, self.config, self.status, self.observation,
                                desktop_path=self.paths['desktop'], desktop_hash=self.pins['desktop'],
                                computer='KAMPUTER', host='local', file_hash=lambda path: self.hashes[c.runtime.canonical(path)],
                                parse_argv=json.loads)

    def snapshot(self, manifest):
        now = c.runtime.utc_now()
        value = {'computer': 'KAMPUTER', 'started_utc': now, 'observed_utc': now, 'processes': [],
                 'files': self.hashes.copy(), 'connections': [{'pid': 102, 'state': 'Listen', 'local_port': 4505, 'local_address': '127.0.0.1'}],
                 'challenge': 'b' * 32, 'health': {**self.status, 'challenge': 'b' * 32}}
        for index, role in enumerate(c.runtime.ROLES):
            value['processes'].append({**manifest[role], 'parent': 99 + index})
        return value

    def reader(self, path, **kwargs):
        values = {self.stage_path: self.stage, self.paths['config']: self.config, self.config['statusFile']: self.status}
        if path == self.paths['config']:
            self.assertEqual(kwargs, {'expected_hash': self.pins['config']})
        else:
            self.assertFalse(kwargs)
        return copy.deepcopy(values[path])

    def capture(self, publisher, snapshot_provider=None):
        with mock.patch.object(c.os.path, 'lexists', return_value=False):
            return c.capture(self.stage_path, self.output, desktop_path=self.paths['desktop'], desktop_hash=self.pins['desktop'],
                             computer='KAMPUTER', host='local', reader=self.reader,
                             file_hash=lambda path: self.hashes[c.runtime.canonical(path)],
                             process_provider=lambda status: copy.deepcopy(self.observation), parse_argv=json.loads,
                             snapshot_provider=snapshot_provider or self.snapshot, publisher=publisher)


class ManifestTests(CaptureFixture):
    def refused(self):
        with self.assertRaises((c.CaptureError, c.runtime.RuntimeAdmissionError)):
            self.build()

    def test_derives_real_desktop_parent_and_only_persists_fingerprints(self):
        manifest = self.build()
        self.assertEqual(manifest['desktop']['pid'], 100)
        self.assertEqual(manifest['server']['pid'], 103)
        self.assertEqual(manifest['endpoint'], 'ws://127.0.0.1:4505')
        encoded = json.dumps(manifest)
        self.assertNotIn('features.code_mode_host', encoded)
        self.assertNotIn('tokenFile', encoded)
        self.assertNotIn('commandLine"', encoded)
        expected = hashlib.sha256(self.observation['processes'][2]['commandLine'].encode()).hexdigest()
        self.assertEqual(manifest['bridge']['commandLineSha256'], expected)

    def test_missing_review_pin_is_rejected(self):
        del self.stage['expectedHashes']['shim']
        self.refused()

    def test_disagreeing_review_file_hash_is_rejected(self):
        self.stage['files'][0]['sha256'] = 'f' * 64
        self.refused()

    def test_each_changed_reviewed_file_is_rejected(self):
        for role, path in self.paths.items():
            with self.subTest(role=role):
                key = c.runtime.canonical(path)
                old = self.hashes[key]
                self.hashes[key] = 'f' * 64
                self.refused()
                self.hashes[key] = old

    def test_wrong_desktop_executable_path_is_rejected(self):
        self.observation['processes'][0]['path'] = r'C:\Elsewhere\ChatGPT.exe'
        self.refused()

    def test_status_pids_cannot_adopt_an_unrelated_process_chain(self):
        self.observation['processes'][2]['parent'] = 500
        self.refused()

    def test_reused_parent_pid_with_newer_birth_is_rejected(self):
        self.observation['processes'][0]['created'] = '2026-10-15T01:01:00Z'
        self.refused()

    def test_missing_parent_is_rejected(self):
        self.observation['processes'][1]['parent'] = 500
        self.refused()

    def test_duplicate_processes_are_rejected(self):
        self.observation['processes'][0] = copy.deepcopy(self.observation['processes'][1])
        self.refused()

    def test_different_computer_is_rejected(self):
        self.observation['computer'] = 'CLAUDE'
        self.refused()

    def test_status_must_name_reviewed_paths(self):
        self.status['configPath'] = r'C:\Elsewhere\configuration.json'
        self.refused()

    def test_disconnected_desktop_status_is_rejected(self):
        self.status['primaryReady'] = False
        self.refused()

    def test_missing_command_line_is_rejected(self):
        self.observation['processes'][3]['commandLine'] = None
        self.refused()

    def test_backend_argv_must_preserve_native_flags(self):
        argv = json.loads(self.observation['processes'][3]['commandLine'])
        argv[2] = 'features.code_mode_host=false'
        self.observation['processes'][3]['commandLine'] = json.dumps(argv)
        self.refused()

    def test_node_must_run_exact_script_config_and_native_args(self):
        for index, changed in [(1, r'C:\Elsewhere\bridge.mjs'), (3, r'C:\Elsewhere\config.json'), (6, 'other-setting=true')]:
            with self.subTest(index=index):
                old = self.observation['processes'][2]['commandLine']
                argv = json.loads(old)
                argv[index] = changed
                self.observation['processes'][2]['commandLine'] = json.dumps(argv)
                self.refused()
                self.observation['processes'][2]['commandLine'] = old

    def test_non_stdio_and_option_value_confusion_are_rejected(self):
        for args in [['app-server', '--listen', 'ws://127.0.0.1:4503'], ['exec', 'app-server'], ['-c', 'app-server'],
                     ['-c', 'app-server', 'exec'], ['app-server', '--config']]:
            with self.subTest(args=args):
                self.assertFalse(c.stdio_invocation(args))


class CaptureTests(CaptureFixture):
    def test_verified_capture_publishes_once_without_reading_token(self):
        publish = mock.Mock()
        result = self.capture(publish)
        publish.assert_called_once()
        self.assertEqual(publish.call_args.args[0], self.output)
        self.assertTrue(result['verified'])
        self.assertFalse(result['activationPerformed'])
        self.assertNotIn('must-not-read.token', json.dumps(result))

    def test_changed_process_after_discovery_is_not_published(self):
        publish = mock.Mock()
        def changed(manifest):
            snapshot = self.snapshot(manifest)
            snapshot['processes'][2]['created'] = '2026-10-15T02:00:00Z'
            return snapshot
        with self.assertRaises(c.runtime.RuntimeAdmissionError):
            self.capture(publish, changed)
        publish.assert_not_called()

    def test_fresh_ownership_failures_never_publish(self):
        mutations = [lambda s: s['connections'].clear(),
                     lambda s: s['health'].update(challenge='c' * 32),
                     lambda s: s['health'].update(instanceId='different_instance_0123'),
                     lambda s: s['health'].update(primaryReady=False),
                     lambda s: s.update(started_utc='2020-01-01T00:00:00Z')]
        for mutate in mutations:
            publish = mock.Mock()
            def changed(manifest):
                snapshot = self.snapshot(manifest)
                mutate(snapshot)
                return snapshot
            with self.assertRaises(c.runtime.RuntimeAdmissionError):
                self.capture(publish, changed)
            publish.assert_not_called()

    def test_existing_destination_refused_before_discovery(self):
        reader = mock.Mock()
        with mock.patch.object(c.os.path, 'lexists', return_value=True):
            with self.assertRaises(c.CaptureError):
                c.capture(self.stage_path, self.output, desktop_path=self.paths['desktop'], desktop_hash=self.pins['desktop'],
                          computer='KAMPUTER', host='local', reader=reader)
        reader.assert_not_called()


class FileAndCliTests(unittest.TestCase):
    def test_unc_and_device_paths_are_rejected_in_both_separator_styles(self):
        for value in [r'\\server\share\file.json', '//server/share/file.json', r'\\?\C:\file.json']:
            with self.subTest(value=value), self.assertRaises((c.CaptureError, c.runtime.RuntimeAdmissionError)):
                c.local_path(value)

    def test_publication_is_exclusive_and_leaves_no_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'binding.json'
            c.publish_exclusive(target, {'verified': 'first'})
            with self.assertRaises(FileExistsError):
                c.publish_exclusive(target, {'verified': 'second'})
            self.assertEqual(json.loads(target.read_text()), {'verified': 'first'})
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['binding.json'])

    def test_reviewed_config_is_hashed_from_the_exact_bytes_read(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'config.json'
            data = b'{"schema":"reviewed"}'
            target.write_bytes(data)
            self.assertEqual(c.read_document(target, expected_hash=hashlib.sha256(data).hexdigest())['schema'], 'reviewed')
            target.write_text('{"schema":"changed"}')
            with self.assertRaises(c.CaptureError):
                c.read_document(target, expected_hash=hashlib.sha256(data).hexdigest())

    def test_cli_suppresses_provider_errors_and_secrets(self):
        output = io.StringIO()
        args = ['--stage-manifest', r'C:\stage.json', '--desktop-path', r'C:\ChatGPT.exe',
                '--desktop-sha256', 'a' * 64, '--computer', 'KAMPUTER', '--host', 'local', '--output', r'C:\binding.json']
        with mock.patch.object(c, 'capture', side_effect=OSError('PRIVATE_TOKEN_CANARY')), contextlib.redirect_stdout(output):
            self.assertEqual(c.main(args), 1)
        self.assertNotIn('PRIVATE_TOKEN_CANARY', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['error']['code'], 'capture_failed')

    def test_invalid_cli_is_sanitized_json(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(c.main(['--secret=PRIVATE_TOKEN_CANARY']), 1)
        self.assertNotIn('PRIVATE_TOKEN_CANARY', output.getvalue())
        self.assertFalse(json.loads(output.getvalue())['ok'])

    @unittest.skipUnless(os.name == 'nt', 'Native Windows command-line decoding')
    def test_windows_argv_preserves_quotes_spaces_and_native_options(self):
        args = [r'C:\Program Files\Codex\codex.exe', '-c', 'quoted="value with spaces"', 'app-server', '--stdio']
        self.assertEqual(c.windows_argv(subprocess.list2cmdline(args)), args)


if __name__ == '__main__':
    unittest.main()
