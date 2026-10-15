"""Capture a verified desktop-owned bridge binding; never activate or replace one.

Stage/config/status files are inputs, not proof of ownership. The capture pins
reviewed files and actual argv, then independently re-observes every process,
listener and the bridge health challenge immediately before exclusive publication.
No token, native app IPC, model request, or process-control operation is used.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile

_spec = importlib.util.spec_from_file_location('desktop_capture_runtime', Path(__file__).with_name('desktop-bridge-runtime.py'))
runtime = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runtime)
STAGE_SCHEMA = 'codex-desktop-owned-candidate-v1'
CONFIG_SCHEMA = 'codex-desktop-owned-bridge-v1'
PIN_ROLES = ('shim', 'bridge', 'server', 'script', 'config')


class CaptureError(Exception):
    """Messages are fixed, sanitized explanations suitable for CLI output."""


def require(condition, message):
    if not condition:
        raise CaptureError(message)


def local_path(value):
    runtime.local_path(value)
    # ntpath also accepts forward-slash UNC spelling. Capture only drive paths;
    # neither network shares nor device namespaces are reviewed local inputs.
    require(re.fullmatch(r'[A-Za-z]:', ntpath.splitdrive(value)[0]) is not None,
            'Capture paths must use a local Windows drive.')
    return value


def digest_file(filename):
    digest = hashlib.sha256()
    with open(filename, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_document(filename, *, expected_hash=None):
    with open(filename, 'rb') as stream:
        data = stream.read(262145)
    require(len(data) <= 262144, 'An input document exceeds the capture size limit.')
    if expected_hash is not None:
        require(hashlib.sha256(data).hexdigest() == expected_hash.lower(), 'The reviewed configuration changed.')
    value = json.loads(data.decode('utf-8-sig'))
    require(isinstance(value, dict), 'An input document is not an object.')
    return value


def valid_hash(value):
    return isinstance(value, str) and runtime.HEX.fullmatch(value) is not None


def validate_stage(stage):
    require(isinstance(stage, dict) and stage.get('schema') == STAGE_SCHEMA, 'Candidate schema is invalid.')
    require(stage.get('activated') is False, 'A reviewed, unmodified stage manifest is required.')
    pins = stage.get('expectedHashes')
    require(isinstance(pins, dict) and set(pins) == set(PIN_ROLES)
            and all(valid_hash(pins.get(role)) for role in PIN_ROLES), 'Reviewed candidate hashes are incomplete.')
    local_path(stage.get('executable'))
    local_path(stage.get('configFile'))
    require(runtime.canonical(stage['configFile']) == runtime.canonical(stage['executable'] + '.json'),
            'The shim configuration must be its exact sidecar file.')


def validate_status(config, stage, status):
    require(isinstance(config, dict) and config.get('schema') == CONFIG_SCHEMA, 'Bridge configuration schema is invalid.')
    for key in ('realCliPath', 'nodePath', 'bridgePath', 'tokenFile', 'statusFile'):
        local_path(config.get(key))
    require(type(config.get('port')) is int and 1024 <= config['port'] <= 65535, 'The reviewed bridge port is invalid.')
    require(isinstance(status, dict) and status.get('schema') == 'codex-desktop-stdio-health-v1', 'Bridge status schema is invalid.')
    require(status.get('state') == 'ready' and status.get('primaryReady') is True, 'The native desktop connection is not ready.')
    require(isinstance(status.get('instanceId'), str)
            and re.fullmatch(r'[A-Za-z0-9_-]{16,128}', status['instanceId']), 'Bridge instance identity is invalid.')
    for key in ('shimPid', 'bridgePid', 'backendPid'):
        require(type(status.get(key)) is int and 0 < status[key] <= 0xffffffff, 'Bridge status has invalid process identities.')
    require(status.get('parentPid') == status['shimPid'], 'Bridge status does not identify the same shim parent.')
    require(len({status[key] for key in ('shimPid', 'bridgePid', 'backendPid')}) == 3, 'Bridge process roles must be distinct.')
    for key, expected in (('execPath', config['nodePath']), ('scriptPath', config['bridgePath']), ('configPath', stage['configFile'])):
        require(runtime.canonical(status.get(key)) == runtime.canonical(expected), 'Bridge status differs from the reviewed candidate paths.')
    runtime.timestamp_ticks(status.get('recordedAt'))


def windows_argv(command):
    require(isinstance(command, str) and command and len(command) <= 32768 and '\0' not in command,
            'A process command line is unavailable or invalid.')
    if os.name != 'nt':
        raise CaptureError('Windows command-line decoding is required.')
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    count = ctypes.c_int()
    pointer = shell.CommandLineToArgvW(command, ctypes.byref(count))
    require(bool(pointer), 'A process command line could not be decoded.')
    try:
        return [pointer[index] for index in range(count.value)]
    finally:
        kernel.LocalFree(ctypes.cast(pointer, ctypes.c_void_p))


def stdio_invocation(args):
    index, found = 0, False
    while index < len(args):
        arg = args[index]
        index += 1
        if arg in ('-c', '--config', '--enable', '--disable'):
            if index >= len(args):
                return False
            index += 1
        elif arg.startswith(('--config=', '--enable=', '--disable=')):
            continue
        elif not found and arg == 'app-server':
            found = True
        elif not found or arg not in ('--analytics-default-enabled', '--strict-config', '--stdio'):
            return False
    return found


DISCOVERY_PS = r"""
$ErrorActionPreference='Stop'
$spec=[Console]::In.ReadToEnd() | ConvertFrom-Json
$filter=($spec.pids | ForEach-Object {'ProcessId = ' + [string][uint32]$_}) -join ' OR '
$children=@(Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop)
$shim=@($children | Where-Object {$_.ProcessId -eq $spec.shimPid})
if ($shim.Count -ne 1 -or [uint32]$shim[0].ParentProcessId -eq 0) { throw 'Shim identity unavailable' }
$desktop=@(Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [string][uint32]$shim[0].ParentProcessId) -ErrorAction Stop)
$processes=@(@($children + $desktop) | ForEach-Object {
  [ordered]@{pid=[long]$_.ProcessId;parent=[long]$_.ParentProcessId;path=$_.ExecutablePath;
    created=$_.CreationDate.ToUniversalTime().ToString('o');commandLine=$_.CommandLine}
})
[ordered]@{computer=$env:COMPUTERNAME;processes=$processes} | ConvertTo-Json -Depth 5 -Compress
"""


def discover_processes(status):
    require(os.name == 'nt', 'Windows process discovery is required.')
    spec = {'pids': [status[key] for key in ('shimPid', 'bridgePid', 'backendPid')], 'shimPid': status['shimPid']}
    child_env = {k: v for k, v in os.environ.items() if k.lower() != 'psmodulepath'}
    root = next((v for k, v in child_env.items() if k.lower() == 'systemroot'), '')
    local_path(root)
    directory = ntpath.join(root, 'System32', 'WindowsPowerShell', 'v1.0')
    child_env['PSModulePath'] = ntpath.join(directory, 'Modules')
    result = subprocess.run([ntpath.join(directory, 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DISCOVERY_PS],
                            input=json.dumps(spec), capture_output=True, text=True, timeout=20,
                            creationflags=subprocess.CREATE_NO_WINDOW, env=child_env)
    require(result.returncode == 0, 'Read-only process discovery failed; provider details suppressed.')
    require(len(result.stdout) <= 262144, 'Process discovery exceeded its output limit.')
    return json.loads(result.stdout.lstrip('\ufeff'))


def build_manifest(stage, config, status, observation, *, desktop_path, desktop_hash, computer, host,
                   file_hash=digest_file, parse_argv=windows_argv):
    validate_stage(stage)
    validate_status(config, stage, status)
    local_path(desktop_path)
    require(valid_hash(desktop_hash), 'A reviewed desktop executable hash is required.')
    require(isinstance(computer, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,255}', computer), 'An explicit computer identity is required.')
    require(isinstance(host, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', host), 'An explicit host identity is required.')
    require(isinstance(observation, dict) and isinstance(observation.get('computer'), str)
            and observation['computer'].upper() == computer.upper(), 'Process discovery came from another computer.')
    processes = observation.get('processes')
    require(isinstance(processes, list) and len(processes) == 4 and all(isinstance(p, dict) for p in processes),
            'Exactly four live process identities are required.')
    require(all(type(p.get('pid')) is int and p['pid'] > 0 for p in processes), 'A discovered process identity is invalid.')
    mapping = {p['pid']: p for p in processes}
    require(len(mapping) == 4, 'Discovered process identities are duplicated.')
    shim = mapping.get(status['shimPid'], {})
    desktop_pid = shim.get('parent')
    require(type(desktop_pid) is int and desktop_pid in mapping, 'The real shim parent was not observed.')
    pids = {'desktop': desktop_pid, 'shim': status['shimPid'], 'bridge': status['bridgePid'], 'server': status['backendPid']}
    require(len(set(pids.values())) == 4 and set(pids.values()) == set(mapping), 'The observed process chain is incomplete.')
    paths = {'desktop': desktop_path, 'shim': stage['executable'], 'bridge': config['nodePath'],
             'server': config['realCliPath'], 'script': config['bridgePath'], 'config': stage['configFile']}
    pins = {**stage['expectedHashes'], 'desktop': desktop_hash}
    reviewed = stage.get('files')
    require(isinstance(reviewed, list) and all(isinstance(item, dict) for item in reviewed), 'The candidate file review is incomplete.')
    reviewed_map = {runtime.canonical(item.get('path')): item.get('sha256') for item in reviewed}
    require(len(reviewed_map) == len(reviewed), 'Candidate file review contains duplicate paths.')
    for role in PIN_ROLES:
        pin = reviewed_map.get(runtime.canonical(paths[role]))
        require(valid_hash(pin) and pin.lower() == pins[role].lower(), 'Candidate file review disagrees with its expected hashes.')
    for role, path in paths.items():
        require(file_hash(path).lower() == pins[role].lower(), 'A reviewed candidate or desktop file changed.')
    manifest = {'schema': runtime.SCHEMA, 'computer': computer.upper(), 'host': host,
                'endpoint': f"ws://127.0.0.1:{config['port']}", 'instanceId': status['instanceId']}
    argv = {}
    previous = None
    for role in runtime.ROLES:
        actual = mapping[pids[role]]
        require(runtime.canonical(actual.get('path')) == runtime.canonical(paths[role]), 'A live executable differs from its reviewed path.')
        created = runtime.timestamp_ticks(actual.get('created'))
        if previous:
            require(actual.get('parent') == previous['pid'] and created >= runtime.timestamp_ticks(previous['created']),
                    'Exact desktop-owned process ancestry was not verified.')
        item = {'pid': actual['pid'], 'path': paths[role], 'created': actual['created'], 'executableSha256': pins[role].lower()}
        if role != 'desktop':
            command = actual.get('commandLine')
            require(isinstance(command, str) and command and len(command) <= 32768 and '\0' not in command,
                    'A process command line is unavailable or invalid.')
            argv[role] = parse_argv(command)
            require(isinstance(argv[role], list) and argv[role] and all(isinstance(a, str) for a in argv[role])
                    and runtime.canonical(argv[role][0]) == runtime.canonical(paths[role]), 'Process argv does not name the reviewed executable.')
            item['commandLineSha256'] = hashlib.sha256(command.encode('utf-8')).hexdigest()
        manifest[role] = item
        previous = item
    native = argv['shim'][1:]
    require(stdio_invocation(native) and argv['server'][1:] == native, 'The native stdio arguments were not preserved through the shim.')
    bridge_args = argv['bridge'][1:]
    require(len(bridge_args) >= 4 and runtime.canonical(bridge_args[0]) == runtime.canonical(paths['script'])
            and bridge_args[1] == '--config' and runtime.canonical(bridge_args[2]) == runtime.canonical(paths['config'])
            and bridge_args[3] == '--' and bridge_args[4:] == native, 'The bridge arguments do not match the reviewed stdio route.')
    for role in ('script', 'config'):
        manifest[role] = {'path': paths[role], 'sha256': pins[role].lower()}
    runtime.validate_manifest(manifest, computer, expected_computer=computer, expected_host=host)
    return manifest


def publish_exclusive(filename, manifest):
    """Flush a temporary file, then atomically link it into an absent destination."""
    target = Path(filename)
    descriptor, temporary = tempfile.mkstemp(prefix='.binding-capture-', suffix='.tmp', dir=target.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(manifest, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        # Unlike replace/rename, link cannot overwrite an existing destination.
        os.link(temporary, target)
    finally:
        os.unlink(temporary)


def capture(stage_path, output_path, *, desktop_path, desktop_hash, computer, host,
            reader=read_document, file_hash=digest_file, process_provider=discover_processes,
            parse_argv=windows_argv, snapshot_provider=None, publisher=publish_exclusive):
    local_path(stage_path)
    local_path(output_path)
    require(not os.path.lexists(output_path), 'The binding destination already exists; it will not be overwritten.')
    stage = reader(stage_path)
    validate_stage(stage)
    config = reader(stage['configFile'], expected_hash=stage['expectedHashes']['config'])
    local_path(config.get('statusFile'))
    status = reader(config['statusFile'])
    validate_status(config, stage, status)
    observation = process_provider(status)
    manifest = build_manifest(stage, config, status, observation, desktop_path=desktop_path, desktop_hash=desktop_hash,
                              computer=computer, host=host, file_hash=file_hash, parse_argv=parse_argv)
    provider = snapshot_provider or (lambda value: runtime.windows_snapshot(value, expected_computer=computer, expected_host=host))
    proof = runtime.verify_binding(manifest, provider(manifest), computer=computer, expected_computer=computer, expected_host=host)
    publisher(output_path, manifest)
    return {'ok': True, 'bindingPath': output_path, 'computer': computer.upper(), 'host': host,
            'endpoint': manifest['endpoint'], 'runtimeId': proof['runtime_id'], 'verified': True, 'activationPerformed': False}


class SanitizedParser(argparse.ArgumentParser):
    def error(self, message):
        raise CaptureError('Invalid capture arguments; use --help for the required fields.')


def main(argv=None):
    parser = SanitizedParser(description=__doc__)
    for option in ('stage-manifest', 'desktop-path', 'desktop-sha256', 'computer', 'host', 'output'):
        parser.add_argument('--' + option, required=True)
    try:
        args = parser.parse_args(argv)
        result = capture(args.stage_manifest, args.output, desktop_path=args.desktop_path, desktop_hash=args.desktop_sha256,
                         computer=args.computer, host=args.host)
        print(json.dumps(result))
        return 0
    except (CaptureError, runtime.RuntimeAdmissionError) as error:
        result = {'ok': False, 'error': {'code': 'capture_refused', 'message': str(error)}, 'activationPerformed': False}
    except Exception:
        result = {'ok': False, 'error': {'code': 'capture_failed', 'message': 'Capture failed; provider details suppressed. No binding was replaced.'}, 'activationPerformed': False}
    print(json.dumps(result))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
