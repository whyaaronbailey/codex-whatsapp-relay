import copy
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('bridge_runtime', Path(__file__).with_name('desktop-bridge-runtime.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.now = '2026-10-15T03:00:04.0000000Z'
        self.manifest = {'schema': r.SCHEMA, 'computer': 'KAMPUTER', 'host': 'local',
                         'endpoint': 'ws://127.0.0.1:4505', 'instanceId': 'test_instance_0123456789'}
        names = ['ChatGPT.exe', 'codex-relay-shim.exe', 'node.exe', 'codex.exe']
        for index, role in enumerate(r.ROLES):
            self.manifest[role] = {'pid': 100 + index, 'path': 'C:\\Trusted\\' + names[index],
                                   'created': f'2026-10-15T02:00:0{index}.0000001Z',
                                   'executableSha256': str(index + 1) * 64, 'commandLineSha256': 'a' * 64}
        self.manifest['script'] = {'path': 'C:\\Trusted\\bridge.mjs', 'sha256': '5' * 64}
        self.manifest['config'] = {'path': 'C:\\Trusted\\bridge.json', 'sha256': '6' * 64}
        self.snapshot = {'computer': 'KAMPUTER', 'started_utc': '2026-10-15T03:00:01Z',
                         'observed_utc': '2026-10-15T03:00:03Z', 'processes': [], 'files': {},
                         'connections': [{'pid': 102, 'state': 'Listen', 'local_port': 4505, 'local_address': '127.0.0.1'}],
                         'challenge': 'b' * 32, 'health': {'schema': 'codex-desktop-stdio-health-v1',
                             'instanceId': self.manifest['instanceId'], 'bridgePid': 102, 'backendPid': 103,
                             'primaryReady': True, 'state': 'ready', 'challenge': 'b' * 32}}
        for index, role in enumerate(r.ROLES):
            p = copy.deepcopy(self.manifest[role])
            p['parent'] = 99 + index
            self.snapshot['processes'].append(p)
        for role in (*r.ROLES, 'script', 'config'):
            p = self.manifest[role]
            self.snapshot['files'][r.canonical(p['path'])] = p.get('sha256', p.get('executableSha256'))

    def verify(self):
        return r.verify_binding(self.manifest, self.snapshot, computer='KAMPUTER', now=self.now)

    def rejected(self):
        with self.assertRaises(r.RuntimeAdmissionError):
            self.verify()

    def test_exact_desktop_owned_stdio_chain_is_accepted(self):
        proof = self.verify()
        self.assertTrue(proof['verified'])
        self.assertEqual(proof['server']['pid'], 103)
        self.assertFalse(proof['mutation_performed'])

    def test_reused_pid_rejected_even_with_same_executable(self):
        self.snapshot['processes'][2]['created'] = '2026-10-15T02:01:00Z'
        self.rejected()

    def test_process_birth_preserves_hundred_nanosecond_precision(self):
        self.snapshot['processes'][2]['created'] = '2026-10-15T02:00:02.0000002Z'
        self.rejected()

    def test_unrelated_bridge_with_same_name_is_rejected(self):
        self.snapshot['processes'][2]['parent'] = 500
        self.rejected()

    def test_child_older_than_parent_rejected(self):
        value = '2026-10-15T01:00:00Z'
        self.manifest['server']['created'] = value
        self.snapshot['processes'][3]['created'] = value
        self.rejected()

    def test_command_arguments_changed(self):
        self.snapshot['processes'][2]['commandLineSha256'] = 'f' * 64
        self.rejected()

    def test_wrong_backend_path(self):
        self.snapshot['processes'][3]['path'] = 'C:\\Untrusted\\codex.exe'
        self.rejected()

    def test_executable_source_and_config_changes_rejected(self):
        for role in (*r.ROLES, 'script', 'config'):
            with self.subTest(role=role):
                key = r.canonical(self.manifest[role]['path'])
                old = self.snapshot['files'][key]
                self.snapshot['files'][key] = 'f' * 64
                self.rejected()
                self.snapshot['files'][key] = old

    def test_no_listener(self):
        self.snapshot['connections'] = []
        self.rejected()

    def test_listener_owned_by_unrelated_node(self):
        self.snapshot['connections'][0]['pid'] = 777
        self.rejected()

    def test_non_loopback_listener_rejected(self):
        self.snapshot['connections'][0]['local_address'] = '0.0.0.0'
        self.rejected()

    def test_second_untrusted_listener_rejected(self):
        self.snapshot['connections'].append({'pid': 777, 'state': 'Listen', 'local_port': 4505, 'local_address': '127.0.0.1'})
        self.rejected()

    def test_stale_snapshot(self):
        self.now = '2026-10-15T03:00:07Z'
        self.rejected()

    def test_future_snapshot(self):
        self.now = '2026-10-15T03:00:02Z'
        self.rejected()

    def test_old_health_response(self):
        self.snapshot['health']['challenge'] = 'c' * 32
        self.rejected()

    def test_desktop_not_initialized_or_disconnected(self):
        self.snapshot['health']['primaryReady'] = False
        self.rejected()

    def test_backend_exit_health(self):
        self.snapshot['health']['state'] = 'backend-exited'
        self.rejected()

    def test_previous_bridge_instance(self):
        self.snapshot['health']['instanceId'] = 'older_bridge_instance'
        self.rejected()

    def test_wrong_host(self):
        self.manifest['host'] = 'vm'
        self.rejected()

    def test_wrong_computer(self):
        self.snapshot['computer'] = 'CLAUDE'
        self.rejected()

    def test_duplicate_pid(self):
        self.snapshot['processes'].append(copy.deepcopy(self.snapshot['processes'][0]))
        self.rejected()

    def test_network_or_malformed_endpoint_rejected(self):
        for value in ['ws://localhost:4505', 'ws://192.168.1.2:4505', 'ws://127.0.0.1:80', 'ws://127.0.0.1:4505/path']:
            self.manifest['endpoint'] = value
            self.rejected()

    def test_shared_filesystem_binary_path_rejected(self):
        self.manifest['shim']['path'] = '\\\\server\\share\\shim.exe'
        self.rejected()


class SnapshotCollectionTests(unittest.TestCase):
    setUp = RuntimeTests.setUp

    def collect(self, *, returncode=0):
        result = SimpleNamespace(returncode=returncode, stdout=json.dumps(self.snapshot))
        connection = mock.Mock()
        connection.getresponse.return_value = SimpleNamespace(
            status=200, read=lambda limit: json.dumps(self.snapshot['health']).encode())
        with (mock.patch.object(r.os, 'name', 'nt'),
              mock.patch.object(r.socket, 'gethostname', return_value='KAMPUTER'),
              mock.patch.object(r.subprocess, 'CREATE_NO_WINDOW', 0, create=True),
              mock.patch.object(r.subprocess, 'run', return_value=result) as run,
              mock.patch.object(r.http.client, 'HTTPConnection', return_value=connection),
              mock.patch.object(r.secrets, 'token_hex', return_value='b' * 32)):
            snapshot = r.windows_snapshot(self.manifest)
        return snapshot, run, connection

    def test_collector_scopes_queries_and_preserves_parent_environment(self):
        with mock.patch.dict(os.environ, {'SystemRoot': r'C:\Windows', 'PSModulePath': r'C:\PowerShell7\Modules'}, clear=True):
            original = dict(os.environ)
            snapshot, run, connection = self.collect()
            self.assertEqual(dict(os.environ), original)
        args, kwargs = run.call_args
        self.assertEqual(args[0][0], r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
        self.assertEqual(kwargs['env']['PSModulePath'], r'C:\Windows\System32\WindowsPowerShell\v1.0\Modules')
        self.assertEqual([k for k in kwargs['env'] if k.lower() == 'psmodulepath'], ['PSModulePath'])
        payload = json.loads(kwargs['input'])
        self.assertEqual(payload['pids'], [100, 101, 102, 103])
        self.assertEqual(payload['port'], 4505)
        self.assertIn('Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop', args[0][-1])
        self.assertIn('Get-NetTCPConnection -LocalPort ([int]$spec.port) -State Listen -ErrorAction Stop', args[0][-1])
        self.assertEqual(snapshot['challenge'], 'b' * 32)
        connection.request.assert_called_once_with('GET', '/health?challenge=' + 'b' * 32, headers={'Cache-Control': 'no-cache'})
        connection.close.assert_called_once()

    def test_collection_failure_remains_fail_closed(self):
        with mock.patch.dict(os.environ, {'SystemRoot': r'C:\Windows'}, clear=True):
            with self.assertRaises(r.RuntimeAdmissionError):
                self.collect(returncode=1)


if __name__ == '__main__':
    unittest.main()
