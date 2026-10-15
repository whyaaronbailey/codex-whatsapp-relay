"""Read-only ownership verification for the desktop-owned stdio relay.

Checks exact live process ancestry, reviewed on-disk files, the loopback listener,
and a fresh primary-connection health response. Does not open desktop private IPC.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import http.client
import json
import ntpath
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess

SCHEMA = 'codex-desktop-stdio-binding-v1'
ROLES = ('desktop', 'shim', 'bridge', 'server')
HEX = re.compile(r'^[0-9a-fA-F]{64}$')
THREAD_ID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$', re.I)
STAMP = re.compile(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$')


class RuntimeAdmissionError(Exception):
    pass


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def timestamp_ticks(value):
    match = STAMP.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise RuntimeAdmissionError('Invalid exact process timestamp.')
    try:
        base = dt.datetime.fromisoformat(match[1] + match[3].replace('Z', '+00:00'))
        span = base.astimezone(dt.timezone.utc) - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
        return (span.days * 86400 + span.seconds) * 10_000_000 + int((match[2] or '').ljust(7, '0'))
    except ValueError:
        raise RuntimeAdmissionError('Invalid exact process timestamp.') from None


def canonical(value):
    return ntpath.normcase(ntpath.normpath(value)) if isinstance(value, str) else ''


def local_path(value):
    if (not isinstance(value, str) or not ntpath.isabs(value) or not ntpath.splitdrive(value)[0]
            or value.startswith('\\\\') or any(c in value for c in '\0\r\n')):
        raise RuntimeAdmissionError('Expected an absolute local Windows path.')
    return value


def endpoint_port(endpoint):
    match = re.fullmatch(r'ws://127\.0\.0\.1:([0-9]{4,5})', endpoint or '')
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise RuntimeAdmissionError('Expected a literal nonprivileged loopback WebSocket endpoint.')
    return int(match[1])


def validate_manifest(manifest, computer, *, expected_computer='KAMPUTER', expected_host='local'):
    if (not isinstance(manifest, dict) or manifest.get('schema') != SCHEMA
            or not isinstance(computer, str) or computer.upper() != expected_computer.upper()
            or manifest.get('computer', '').upper() != computer.upper() or manifest.get('host') != expected_host):
        raise RuntimeAdmissionError('Bridge binding does not match the configured computer and host.')
    port = endpoint_port(manifest.get('endpoint'))
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', manifest.get('instanceId', '')):
        raise RuntimeAdmissionError('Bridge instance identity is absent.')
    pids = []
    for role in ROLES:
        process = manifest.get(role)
        if not isinstance(process, dict) or type(process.get('pid')) is not int or process['pid'] <= 0:
            raise RuntimeAdmissionError('Exact process identities are required.')
        pids.append(process['pid'])
        timestamp_ticks(process.get('created'))
        local_path(process.get('path'))
        if not HEX.fullmatch(process.get('executableSha256', '')):
            raise RuntimeAdmissionError('Each executable must have a reviewed content hash.')
        if role != 'desktop' and not HEX.fullmatch(process.get('commandLineSha256', '')):
            raise RuntimeAdmissionError('Each bridge child must have an exact argument fingerprint.')
    if len(set(pids)) != len(pids):
        raise RuntimeAdmissionError('Bridge process roles must be distinct.')
    if ntpath.basename(manifest['desktop']['path']).lower() not in ('chatgpt.exe', 'codex.exe'):
        raise RuntimeAdmissionError('Desktop executable identity is invalid.')
    if ntpath.basename(manifest['server']['path']).lower() != 'codex.exe':
        raise RuntimeAdmissionError('Backend must be the native Codex executable.')
    if ntpath.basename(manifest['bridge']['path']).lower() != 'node.exe':
        raise RuntimeAdmissionError('Bridge runtime identity is invalid.')
    for role in ('script', 'config'):
        item = manifest.get(role)
        if not isinstance(item, dict) or not HEX.fullmatch(item.get('sha256', '')):
            raise RuntimeAdmissionError('Reviewed bridge source/configuration is required.')
        local_path(item.get('path'))
    return port


def verify_binding(manifest, snapshot, *, computer=None, now=None,
                   expected_computer='KAMPUTER', expected_host='local'):
    computer = computer or socket.gethostname()
    port = validate_manifest(manifest, computer, expected_computer=expected_computer, expected_host=expected_host)
    if not isinstance(snapshot, dict) or snapshot.get('computer', '').upper() != computer.upper():
        raise RuntimeAdmissionError('Ownership snapshot is invalid or from another computer.')
    start, finish, current = (timestamp_ticks(snapshot.get('started_utc')),
                              timestamp_ticks(snapshot.get('observed_utc')), timestamp_ticks(now or utc_now()))
    if not start <= finish <= current or current - start > 5 * 10_000_000:
        raise RuntimeAdmissionError('Ownership snapshot is stale, future-dated, or too slow.')
    processes, connections, files = snapshot.get('processes'), snapshot.get('connections'), snapshot.get('files')
    if not isinstance(processes, list) or not isinstance(connections, list) or not isinstance(files, dict):
        raise RuntimeAdmissionError('Ownership snapshot is incomplete.')
    if len({p.get('pid') for p in processes}) != len(processes):
        raise RuntimeAdmissionError('Duplicate process identities in snapshot.')
    mapping = {p.get('pid'): p for p in processes}
    prior = None
    for role in ROLES:
        expected = manifest[role]
        actual = mapping.get(expected['pid'], {})
        if (canonical(actual.get('path')) != canonical(expected['path'])
                or timestamp_ticks(actual.get('created')) != timestamp_ticks(expected['created'])
                or (role != 'desktop' and actual.get('commandLineSha256') != expected['commandLineSha256'])):
            raise RuntimeAdmissionError('A recorded process has exited, changed, or reused its PID.')
        if prior and (actual.get('parent') != prior['pid']
                      or timestamp_ticks(actual['created']) < timestamp_ticks(prior['created'])):
            raise RuntimeAdmissionError('Exact desktop-owned bridge ancestry was not verified.')
        if files.get(canonical(expected['path']), '').lower() != expected['executableSha256'].lower():
            raise RuntimeAdmissionError('A reviewed bridge executable changed.')
        prior = expected
    for role in ('script', 'config'):
        if files.get(canonical(manifest[role]['path']), '').lower() != manifest[role]['sha256'].lower():
            raise RuntimeAdmissionError('Reviewed bridge source or configuration changed.')
    listeners = [c for c in connections if c.get('state') == 'Listen' and c.get('local_port') == port]
    if not listeners or any(c.get('pid') != manifest['bridge']['pid'] or c.get('local_address') != '127.0.0.1'
                            for c in listeners):
        raise RuntimeAdmissionError('The exact bridge does not exclusively own the loopback listener.')
    health = snapshot.get('health', {})
    challenge = snapshot.get('challenge', '')
    if (not re.fullmatch(r'[0-9a-f]{32}', challenge) or health.get('challenge') != challenge
            or health.get('schema') != 'codex-desktop-stdio-health-v1'
            or health.get('instanceId') != manifest['instanceId']
            or health.get('bridgePid') != manifest['bridge']['pid']
            or health.get('backendPid') != manifest['server']['pid']
            or health.get('primaryReady') is not True or health.get('state') != 'ready'):
        raise RuntimeAdmissionError('Fresh primary desktop connection was not verified.')
    server = manifest['server']
    identity = f"{computer.upper()}|{server['pid']}|{timestamp_ticks(server['created'])}|{canonical(server['path'])}|{manifest['instanceId']}"
    return {'verified': True, 'host': expected_host, 'computer': computer.upper(), 'endpoint': manifest['endpoint'],
            'runtime_id': hashlib.sha256(identity.encode()).hexdigest(), 'verified_utc': now or utc_now(),
            'desktop': manifest['desktop'], 'server': server, 'bridge': manifest['bridge'],
            'transport': 'desktop-owned-stdio-multiplexer', 'mutation_performed': False}


SNAPSHOT_PS = r"""
$ErrorActionPreference='Stop'
$spec = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Hash-Text([string]$value) {
  $hash=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
$filter = ($spec.pids | ForEach-Object { 'ProcessId = ' + [string][int]$_ }) -join ' OR '
$all = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop)
$processes=@($all | ForEach-Object { [ordered]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;path=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().ToString('o');commandLineSha256=(Hash-Text $_.CommandLine)} })
$connections=@(Get-NetTCPConnection -LocalPort ([int]$spec.port) -State Listen -ErrorAction Stop | ForEach-Object {[ordered]@{pid=[int]$_.OwningProcess;state=$_.State.ToString();local_address=$_.LocalAddress;local_port=[int]$_.LocalPort}})
$files=@{}
foreach($file in $spec.files) { $files[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
[ordered]@{computer=$env:COMPUTERNAME;processes=$processes;connections=$connections;files=$files} | ConvertTo-Json -Depth 8 -Compress
"""


def windows_snapshot(manifest, *, expected_computer='KAMPUTER', expected_host='local'):
    if os.name != 'nt':
        raise RuntimeAdmissionError('Windows ownership observation is required.')
    port = validate_manifest(manifest, socket.gethostname(), expected_computer=expected_computer, expected_host=expected_host)
    started = utc_now()
    spec = {'pids': [manifest[r]['pid'] for r in ROLES], 'port': port,
            'files': list(dict.fromkeys(manifest[r]['path'] for r in (*ROLES, 'script', 'config')))}
    # PowerShell 7 or a caller's custom modules must not select incompatible
    # CIM/security providers for this Windows PowerShell observation child.
    # Do not change the parent environment or search PATH for this executable.
    child_env = {k: v for k, v in os.environ.items() if k.lower() != 'psmodulepath'}
    system_root = next((v for k, v in child_env.items() if k.lower() == 'systemroot'), '')
    local_path(system_root)
    powershell_dir = ntpath.join(system_root, 'System32', 'WindowsPowerShell', 'v1.0')
    child_env['PSModulePath'] = ntpath.join(powershell_dir, 'Modules')
    try:
        result = subprocess.run([ntpath.join(powershell_dir, 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_PS],
                                input=json.dumps(spec), capture_output=True, text=True, timeout=15,
                                creationflags=subprocess.CREATE_NO_WINDOW, env=child_env)
        if result.returncode:
            raise RuntimeAdmissionError('Windows ownership observation failed; stderr suppressed.')
        snapshot = json.loads(result.stdout.lstrip('\ufeff'))
        snapshot['files'] = {canonical(k): v for k, v in snapshot['files'].items()}
        challenge = secrets.token_hex(16)
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            connection.request('GET', '/health?challenge=' + challenge, headers={'Cache-Control': 'no-cache'})
            response = connection.getresponse()
            body = response.read(16385)
            if response.status != 200 or len(body) > 16384:
                raise RuntimeAdmissionError('Bridge health response is unavailable or excessive.')
            health = json.loads(body)
        finally:
            connection.close()
        snapshot.update(started_utc=started, observed_utc=utc_now(), challenge=challenge, health=health)
        return snapshot
    except RuntimeAdmissionError:
        raise
    except (OSError, ValueError, subprocess.TimeoutExpired, http.client.HTTPException):
        raise RuntimeAdmissionError('Read-only bridge ownership collection failed.') from None


class WindowsRuntimeBinding:
    def __init__(self, manifest_path, *, expected_computer='KAMPUTER', expected_host='local', snapshot_provider=None, computer=None):
        try:
            self.manifest = json.loads(Path(manifest_path).read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            raise RuntimeAdmissionError('Bridge binding manifest is unavailable or invalid.') from None
        self.computer = computer or socket.gethostname()
        self.expected_computer, self.expected_host = expected_computer, expected_host
        validate_manifest(self.manifest, self.computer, expected_computer=expected_computer, expected_host=expected_host)
        self.snapshot_provider = snapshot_provider or (lambda manifest: windows_snapshot(
            manifest, expected_computer=expected_computer, expected_host=expected_host))

    def verify(self, thread_id):
        if not isinstance(thread_id, str) or not THREAD_ID.fullmatch(thread_id):
            raise RuntimeAdmissionError('An exact native Codex chat ID is required.')
        proof = verify_binding(self.manifest, self.snapshot_provider(self.manifest), computer=self.computer,
                               expected_computer=self.expected_computer, expected_host=self.expected_host)
        proof['thread_id'] = thread_id
        return proof


RuntimeBinding = WindowsRuntimeBinding
