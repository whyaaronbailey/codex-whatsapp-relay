"""One-shot, opt-in Windows package launcher for a desktop-owned Codex bridge.

Default execution only checks pins. --probe invokes a harmless package-context
access probe. --arm --wait observes normal Quit; it never closes an application.
Every launch attempt has durable exclusive reservations and is never retried.
The old manager must be disabled separately. An optional old-backend gate tracks
its exact descendants and checks the listener and public loaded-thread list;
operators must also prevent other clients from admitting new work to that server.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes as w
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid

SCHEMA = "codex-desktop-owned-launch-v1"
POWERSHELL = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"


class LaunchError(RuntimeError):
    def __init__(self, code, *, uncertain=False, details=None, identity_unavailable=False):
        super().__init__(code)
        self.code, self.uncertain = code, uncertain
        self.details, self.identity_unavailable = details or {}, identity_unavailable


def fail(code, *, uncertain=False, details=None):
    raise LaunchError(code, uncertain=uncertain, details=details)


def missing_identity(row):
    return row is not None and (not row.get("path") or type(row.get("createdTicks")) is not int)


def identity_error(code, expected, observed):
    # Only executable identity and OS error metadata; never argv, environment or RPC data.
    fields = ("pid", "ppid", "name", "path", "createdTicks", "identityError")
    return LaunchError(code, identity_unavailable=missing_identity(observed), details={
        "pid": expected["pid"], "expected": dict(expected),
        "observed": {key: observed[key] for key in fields if key in observed}})


def parentage_error(code, parent, child, snapshot):
    fields = ("pid", "ppid", "name", "path", "createdTicks", "identityError")
    observed_parent = snapshot.get(parent["pid"])
    return LaunchError(code, details={"parent": dict(parent),
        "observedParent": None if observed_parent is None else {key: observed_parent[key] for key in fields if key in observed_parent},
        "child": {key: child[key] for key in fields if key in child}})


def observe_with_rechecks(runtime, observe, *, snapshot=None, sleep=time.sleep, clock=time.monotonic):
    """At most three observations, never a launch retry or an inferred process exit."""
    snapshot = runtime.snapshot() if snapshot is None else snapshot
    deadline = clock() + 1.0
    for attempt in range(3):
        try:
            return observe(snapshot), snapshot
        except LaunchError as error:
            if not error.identity_unavailable:
                raise
            error.details["identityObservations"] = attempt + 1
            if attempt == 2 or clock() >= deadline:
                raise
            sleep(0.05)
            snapshot = runtime.snapshot()


def utc():
    return datetime.now(timezone.utc).isoformat()


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(path):
    return str(Path(path).resolve()).casefold()


def absolute(value):
    return isinstance(value, str) and Path(value).is_absolute() and not re.search(r"[\x00-\x1f]", value)


def pin(value, name):
    if (not isinstance(value, dict) or set(value) != {"path", "sha256"}
            or not absolute(value.get("path"))
            or not re.fullmatch(r"[a-fA-F0-9]{64}", value.get("sha256", ""))
            or not Path(value["path"]).is_file()
            or sha(value["path"]) != value["sha256"].lower()):
        fail("pin_mismatch_" + name)


def identity(value):
    if (not isinstance(value, dict) or set(value) != {"pid", "createdTicks", "path"}
            or type(value.get("pid")) is not int or value["pid"] <= 0
            or type(value.get("createdTicks")) is not int or value["createdTicks"] <= 0
            or not absolute(value.get("path"))):
        fail("invalid_process_identity")
    return value


def same(actual, expected):
    return (actual is not None and actual.get("pid") == expected["pid"]
            and actual.get("createdTicks") == expected["createdTicks"]
            and actual.get("path") is not None
            and canonical(actual["path"]) == canonical(expected["path"]))


def exclusive(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def publish(path, value):
    destination = Path(path)
    if destination.exists():
        fail("result_already_exists", uncertain=True)
    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
    exclusive(temporary, value)
    os.replace(temporary, destination)


def wait_status(directory, state, **fields):
    destination = Path(directory) / "wait-status.json"
    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
    exclusive(temporary, {"schema": SCHEMA, "state": state, "recordedAt": utc(), "automaticRetry": False, **fields})
    os.replace(temporary, destination)


def validate_config(config, *, source_path=None, computer=None):
    required = {"schema", "computerName", "oldDesktop", "desktopSha256", "candidateManifest",
                "pythonw", "source", "package", "expectedOtherFiles", "stateDir", "cwd",
                "managerDisabledAcknowledged"}
    optional = {"oldManager", "oldBackend", "waitSeconds", "oldBackendWaitSeconds", "pollSeconds", "invocationWaitSeconds"}
    if not isinstance(config, dict) or not required <= set(config) or set(config) - required - optional or config.get("schema") != SCHEMA:
        fail("invalid_configuration")
    if not isinstance(config["computerName"], str) or not config["computerName"]:
        fail("invalid_computer_name")
    if computer is not None and config["computerName"].casefold() != computer.casefold():
        fail("wrong_computer")
    identity(config["oldDesktop"])
    pin({"path": config["oldDesktop"]["path"], "sha256": config["desktopSha256"]}, "desktop")
    for name in ("candidateManifest", "pythonw", "source"):
        pin(config[name], name)
    if canonical(config["source"]["path"]) != canonical(source_path or __file__):
        fail("wrong_launcher_source")
    package = config["package"]
    if (not isinstance(package, dict) or set(package) != {"fullName", "familyName", "appId"}
            or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", value) for value in package.values())):
        fail("invalid_package")
    if Path(config["oldDesktop"]["path"]).parent.parent.name.casefold() != package["fullName"].casefold():
        fail("desktop_package_path_mismatch")
    for name in ("stateDir", "cwd"):
        if not absolute(config[name]):
            fail("invalid_" + name)
    if not Path(config["cwd"]).is_dir():
        fail("working_directory_missing")
    if type(config["managerDisabledAcknowledged"]) is not bool:
        fail("invalid_manager_acknowledgment")
    if not isinstance(config["expectedOtherFiles"], list):
        fail("invalid_extra_pins")
    for item in config["expectedOtherFiles"]:
        pin(item, "dependency")
    for name, default, low, high in (("waitSeconds", 3600, 1, 86400), ("oldBackendWaitSeconds", 3600, 2700, 86400), ("pollSeconds", 5, 0.05, 30), ("invocationWaitSeconds", 30, 1, 120)):
        value = config.get(name, default)
        if type(value) not in (int, float) or not low <= value <= high:
            fail("invalid_" + name)
    if "oldManager" in config:
        identity(config["oldManager"])
    if "oldBackend" in config:
        backend = config["oldBackend"]
        if not isinstance(backend, dict) or set(backend) != {"endpoint", "transportPath", "pinnedSha256", "server", "admissionClosedAcknowledged"}:
            fail("invalid_old_backend")
        endpoint = urlsplit(backend["endpoint"])
        if (endpoint.scheme != "ws" or endpoint.hostname != "127.0.0.1" or not endpoint.port
                or endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment or endpoint.username or endpoint.password):
            fail("invalid_old_backend_endpoint")
        identity(backend["server"])
        pin({"path": backend["transportPath"], "sha256": backend["pinnedSha256"]}, "old_transport")
        if type(backend["admissionClosedAcknowledged"]) is not bool:
            fail("invalid_admission_acknowledgment")
    manifest = load(config["candidateManifest"]["path"])
    if (manifest.get("schema") != "codex-desktop-owned-candidate-v1" or manifest.get("activated") is not False
            or not isinstance(manifest.get("files"), list) or not isinstance(manifest.get("expectedHashes"), dict)):
        fail("invalid_candidate_manifest")
    pinned = {}
    for item in manifest["files"]:
        pin(item, "candidate_file")
        key = canonical(item["path"])
        if key in pinned:
            fail("duplicate_candidate_pin")
        pinned[key] = item["sha256"].lower()
    bridge = load(manifest["configFile"])
    expected_paths = {"shim": manifest["executable"], "config": manifest["configFile"],
                      "bridge": bridge["nodePath"], "server": bridge["realCliPath"], "script": bridge["bridgePath"]}
    if set(manifest["expectedHashes"]) != set(expected_paths):
        fail("candidate_hash_fields_mismatch")
    for name, filename in expected_paths.items():
        if not absolute(filename) or pinned.get(canonical(filename)) != manifest["expectedHashes"][name]:
            fail("candidate_hash_mapping_mismatch")
    if canonical(manifest["executable"]) == canonical(config["oldDesktop"]["path"]):
        fail("candidate_is_desktop")
    return manifest


class QuitTracker:
    """Tracks exact observed old-process instances, never just PID/name matches."""
    def __init__(self, old, *, retained_root=False):
        self.old = identity(old)
        self.tracked = {old["pid"]: dict(old)}
        self.retired = set()
        self.retired_at = {}
        self.started = False
        self.retained_root = retained_root
        self.remaining = 0

    def observe(self, snapshot):
        if not isinstance(snapshot, dict):
            fail("invalid_process_snapshot")
        if self.retained_root and not same(snapshot.get(self.old["pid"]), self.old) and not (
                self.started and missing_identity(snapshot.get(self.old["pid"]))):
            fail("old_backend_identity_changed")
        if not self.started and not same(snapshot.get(self.old["pid"]), self.old):
            fail("old_desktop_not_exactly_present")
        self.started = True
        unavailable = None
        for pid, expected in self.tracked.items():
            if pid in snapshot and not same(snapshot[pid], expected):
                replacement = snapshot[pid]
                if (replacement.get("path") and type(replacement.get("createdTicks")) is int
                        and replacement["createdTicks"] > expected["createdTicks"]):
                    # A proven newer incarnation establishes that the old one
                    # exited. Never treat the replacement as the old process.
                    self.retired.add(pid)
                    self.retired_at.setdefault(pid, replacement["createdTicks"])
                else:
                    error = identity_error("tracked_process_replaced_or_unreadable", expected, replacement)
                    if not error.identity_unavailable:
                        raise error
                    unavailable = unavailable or error
            elif pid in self.retired and pid in snapshot:
                fail("retired_identity_reappeared")
        changed = True
        while changed:
            changed = False
            for pid, process in snapshot.items():
                parent_id = process.get("ppid")
                if parent_id not in self.tracked:
                    continue
                parent = self.tracked[parent_id]
                if parent_id in self.retired:
                    if pid not in self.tracked or pid in self.retired:
                        if missing_identity(process):
                            raise parentage_error("historical_backend_parentage_ambiguous", parent, process, snapshot)
                        # Only a child born after proven reuse is unrelated to the
                        # original parent. Retain older possible children below,
                        # even after the replacement itself has disappeared.
                        if process["createdTicks"] >= self.retired_at[parent_id]:
                            continue
                if pid in self.tracked:
                    if pid in self.retired:
                        # One PID cannot replace a historical identity with a new
                        # possibly owned generation in this checkpoint format.
                        raise parentage_error("replacement_is_new_old_tree_descendant", parent, process, snapshot)
                    continue
                if (not process.get("path") or type(process.get("createdTicks")) is not int
                        or process["createdTicks"] < parent["createdTicks"]):
                    raise parentage_error("descendant_identity_ambiguous", parent, process, snapshot)
                # Enumeration can first see a child after its parent exits. Its
                # ancestry is uncertain, so conservatively retain the readable
                # exact instance and its descendants until they naturally drain.
                self.tracked[pid] = {key: process[key] for key in ("pid", "createdTicks", "path")}
                changed = True
        if not self.retained_root:
            desktop_name = Path(self.old["path"]).name.casefold()
            for pid, process in snapshot.items():
                if process.get("name", "").casefold() == desktop_name and (pid not in self.tracked or pid in self.retired):
                    fail("another_desktop_observed")
        self.remaining = sum(pid in snapshot and pid not in self.retired
                             and not (self.retained_root and pid == self.old["pid"]) for pid in self.tracked)
        # Keep every readable possibly owned descendant/retirement before
        # resampling. An unreadable new identity still refuses immediately.
        if unavailable:
            raise unavailable
        return self.remaining == 0

    def checkpoint(self):
        return {"tracked": list(self.tracked.values()), "retiredPids": sorted(self.retired),
                "retiredAtTicks": {str(pid): self.retired_at[pid] for pid in sorted(self.retired)}}


def backend_tracker(config, state=None):
    if "oldBackend" not in config:
        if state is not None:
            fail("unexpected_old_backend_tracking")
        return None
    tracker = QuitTracker(config["oldBackend"]["server"], retained_root=True)
    if state is not None:
        if (not isinstance(state, dict) or set(state) != {"tracked", "retiredPids", "retiredAtTicks"}
                or not isinstance(state["tracked"], list) or not isinstance(state["retiredPids"], list)
                or not isinstance(state["retiredAtTicks"], dict)):
            fail("invalid_old_backend_tracking")
        values = [identity(item) for item in state["tracked"]]
        tracked = {item["pid"]: dict(item) for item in values}
        retired = state["retiredPids"]
        cutoffs = state["retiredAtTicks"]
        if (len(tracked) != len(values) or not same(tracked.get(tracker.old["pid"]), tracker.old)
                or any(type(pid) is not int or pid not in tracked or pid == tracker.old["pid"] for pid in retired)
                or len(set(retired)) != len(retired) or set(cutoffs) != {str(pid) for pid in retired}
                or any(type(cutoffs[str(pid)]) is not int or cutoffs[str(pid)] <= tracked[pid]["createdTicks"] for pid in retired)):
            fail("invalid_old_backend_tracking")
        tracker.tracked, tracker.retired, tracker.started = tracked, set(retired), True
        tracker.retired_at = {pid: cutoffs[str(pid)] for pid in retired}
    return tracker


def waiter_tree_gate(tracker, backend):
    if os.getpid() in tracker.tracked:
        fail("waiter_is_inside_old_desktop_tree")
    if backend and os.getpid() in backend.tracked:
        fail("waiter_is_inside_old_backend_tree")
    if backend and (backend.old["pid"] in tracker.tracked or tracker.old["pid"] in backend.tracked):
        fail("old_desktop_and_backend_trees_overlap")


def manager_gate(config, snapshot):
    if config["managerDisabledAcknowledged"] is not True:
        fail("manager_disable_acknowledgment_required")
    manager = config.get("oldManager")
    if manager and manager["pid"] in snapshot:
        fail("old_manager_still_present_or_pid_reused")
    if config.get("oldBackend", {}).get("admissionClosedAcknowledged") is False:
        fail("old_backend_admission_acknowledgment_required")


def observe_owned_trees(config, snapshot, tracker, backend):
    manager_gate(config, snapshot)
    unavailable = None
    for tree in (tracker, backend):
        if tree is None:
            continue
        try:
            tree.observe(snapshot)
        except LaunchError as error:
            if not error.identity_unavailable:
                raise
            unavailable = unavailable or error
    waiter_tree_gate(tracker, backend)
    if unavailable:
        raise unavailable
    return tracker.remaining == 0


def final_process_gate(config, tracked, snapshot, *, backend=None):
    manager_gate(config, snapshot)
    unavailable = None
    if "oldBackend" in config:
        if backend is None:
            fail("old_backend_tracking_required")
        try:
            if not backend.observe(snapshot):
                fail("old_backend_descendants_still_present")
        except LaunchError as error:
            if not error.identity_unavailable:
                raise
            unavailable = error
    unreadable_pids = set()
    for item in tracked:
        actual = snapshot.get(item["pid"])
        if missing_identity(actual):
            unavailable = unavailable or identity_error("old_process_still_present_or_ambiguous", item, actual)
            unreadable_pids.add(item["pid"])
            continue
        if actual and (not actual.get("path") or type(actual.get("createdTicks")) is not int
                       or actual["createdTicks"] <= item["createdTicks"]):
            raise identity_error("old_process_still_present_or_ambiguous", item, actual)
    tracked_by_pid = {item["pid"]: item for item in tracked}
    for pid, actual in snapshot.items():
        parent = tracked_by_pid.get(actual.get("ppid"))
        if parent is not None and pid not in tracked_by_pid:
            current_parent = snapshot.get(parent["pid"])
            if (current_parent is None or missing_identity(current_parent)
                    or current_parent["createdTicks"] <= parent["createdTicks"]):
                fail("unobserved_descendant_after_parent_exit")
            if missing_identity(actual) or actual["createdTicks"] < current_parent["createdTicks"]:
                fail("historical_backend_parentage_ambiguous")
    desktop_name = Path(config["oldDesktop"]["path"]).name.casefold()
    if any(item.get("name", "").casefold() == desktop_name and pid not in unreadable_pids for pid, item in snapshot.items()):
        fail("another_desktop_observed")
    if unavailable:
        raise unavailable


def old_backend_count(config, runtime, *, tracker=None):
    backend = config.get("oldBackend")
    if not backend:
        return 0
    server = backend["server"]
    port = urlsplit(backend["endpoint"]).port
    def verify():
        def observe(snapshot):
            if tracker:
                tracker.observe(snapshot)
            elif not same(snapshot.get(server["pid"]), server):
                fail("old_backend_identity_changed")
            if runtime.listener_owners(port) != {server["pid"]}:
                fail("old_backend_listener_mismatch")
        observe_with_rechecks(runtime, observe)
    verify()
    try:
        count = runtime.loaded_thread_count(backend)
        if type(count) is not int or count < 0:
            fail("old_backend_response_invalid")
    except Exception as error:
        if isinstance(error, LaunchError):
            raise
        fail("old_backend_query_failed")
    verify()
    return count


def old_backend_empty(config, runtime, *, tracker=None):
    return old_backend_count(config, runtime, tracker=tracker) == 0


class WindowsRuntime:
    def __init__(self):
        if os.name != "nt":
            fail("windows_required")
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    def _process_identity(self, pid):
        kernel = self.kernel
        kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        kernel.OpenProcess.restype = w.HANDLE
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return {"identityError": {"phase": "OpenProcess", "win32Error": ctypes.get_last_error()}}
        kernel.CloseHandle.argtypes = [w.HANDLE]
        kernel.CloseHandle.restype = w.BOOL
        try:
            return self._handle_identity(handle)
        except LaunchError as error:
            return {"identityError": error.details}
        finally:
            if not kernel.CloseHandle(handle):
                fail("process_handle_close_failed")

    def _handle_identity(self, handle):
        kernel = self.kernel
        kernel.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4
        kernel.GetProcessTimes.restype = w.BOOL
        created, exited, kt, ut = (w.FILETIME() for _ in range(4))
        kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
        kernel.QueryFullProcessImageNameW.restype = w.BOOL
        length = w.DWORD(32768)
        filename = ctypes.create_unicode_buffer(length.value)
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kt), ctypes.byref(ut)):
            fail("process_identity_unavailable", details={"phase": "GetProcessTimes", "win32Error": ctypes.get_last_error()})
        if not kernel.QueryFullProcessImageNameW(handle, 0, filename, ctypes.byref(length)):
            fail("process_identity_unavailable", details={"phase": "QueryFullProcessImageNameW", "win32Error": ctypes.get_last_error()})
        return {"createdTicks": (created.dwHighDateTime << 32) | created.dwLowDateTime, "path": filename.value}

    def snapshot(self):
        class Entry(ctypes.Structure):
            _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD), ("pid", w.DWORD),
                        ("heap", ctypes.c_size_t), ("module", w.DWORD), ("threads", w.DWORD),
                        ("ppid", w.DWORD), ("priority", w.LONG), ("flags", w.DWORD), ("name", w.WCHAR * 260)]
        kernel = self.kernel
        kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
        kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
        kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
        kernel.Process32FirstW.restype = kernel.Process32NextW.restype = w.BOOL
        kernel.CloseHandle.argtypes = [w.HANDLE]
        kernel.CloseHandle.restype = w.BOOL
        handle = kernel.CreateToolhelp32Snapshot(2, 0)
        if handle == ctypes.c_void_p(-1).value:
            fail("process_snapshot_failed")
        rows = {}
        try:
            entry = Entry(); entry.dwSize = ctypes.sizeof(entry)
            found = kernel.Process32FirstW(handle, ctypes.byref(entry))
            if not found:
                fail("process_snapshot_failed")
            while found:
                rows[entry.pid] = {"pid": entry.pid, "ppid": entry.ppid, "name": entry.name}
                found = kernel.Process32NextW(handle, ctypes.byref(entry))
            if ctypes.get_last_error() != 18:
                fail("process_snapshot_incomplete")
        finally:
            if not kernel.CloseHandle(handle):
                fail("snapshot_handle_close_failed")
        for pid, row in rows.items():
            row.update(self._process_identity(pid))
        return rows

    def listener_owners(self, port):
        library = ctypes.WinDLL("iphlpapi", use_last_error=True)
        function = library.GetExtendedTcpTable
        function.argtypes = [w.LPVOID, ctypes.POINTER(w.DWORD), w.BOOL, w.ULONG, ctypes.c_int, w.ULONG]
        function.restype = w.DWORD
        size = w.DWORD()
        if function(None, ctypes.byref(size), False, 2, 3, 0) != 122:
            fail("listener_query_failed")
        data = ctypes.create_string_buffer(size.value)
        if function(data, ctypes.byref(size), False, 2, 3, 0) != 0:
            fail("listener_query_changed_or_failed")
        class Row(ctypes.Structure):
            _fields_ = [(name, w.DWORD) for name in ("state", "localAddress", "localPort", "remoteAddress", "remotePort", "pid")]
        count = w.DWORD.from_buffer(data).value
        if 4 + count * ctypes.sizeof(Row) > len(data):
            fail("listener_table_invalid")
        owners = set()
        for index in range(count):
            row = Row.from_buffer(data, 4 + index * ctypes.sizeof(Row))
            address = socket.inet_ntoa(int(row.localAddress).to_bytes(4, "little"))
            if socket.ntohs(row.localPort & 0xffff) == port and address in ("127.0.0.1", "0.0.0.0"):
                owners.add(row.pid)
        return owners

    def loaded_thread_count(self, backend):
        pin({"path": backend["transportPath"], "sha256": backend["pinnedSha256"]}, "old_transport")
        spec = importlib.util.spec_from_file_location("_desktop_launch_public_transport", backend["transportPath"])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        rpc = module.Rpc(module.WebSocket(backend["endpoint"], timeout=5))
        try:
            rpc.request("initialize", {"clientInfo": {"name": "desktop_owned_launch_gate", "version": "1"}}, timeout=5)
            rpc.ws.send_json({"method": "initialized", "params": {}})
            count, cursor, seen = 0, None, set()
            for _ in range(100):
                params = {"limit": 100, **({"cursor": cursor} if cursor else {})}
                result = rpc.request("thread/loaded/list", params, timeout=5)
                if (not isinstance(result, dict) or not isinstance(result.get("data"), list)
                        or not all(isinstance(item, str) for item in result["data"]) or rpc.server_requests):
                    fail("old_backend_response_invalid")
                count += len(result["data"])
                cursor = result.get("nextCursor")
                if cursor is None:
                    return count
                if not isinstance(cursor, str) or not cursor or len(cursor) > 4096 or cursor in seen:
                    fail("old_backend_cursor_invalid")
                seen.add(cursor)
            fail("old_backend_pagination_exceeded")
        finally:
            rpc.close()

    def package_access(self, desktop):
        kernel = self.kernel
        kernel.GetCurrentPackageFullName.argtypes = [ctypes.POINTER(w.UINT), w.LPWSTR]
        kernel.GetCurrentPackageFullName.restype = w.LONG
        length = w.UINT()
        if kernel.GetCurrentPackageFullName(ctypes.byref(length), None) != 122:
            fail("package_identity_missing")
        package = ctypes.create_unicode_buffer(length.value)
        if kernel.GetCurrentPackageFullName(ctypes.byref(length), package) != 0:
            fail("package_identity_missing")
        kernel.GetCurrentProcess.argtypes = []; kernel.GetCurrentProcess.restype = w.HANDLE
        kernel.GetApplicationUserModelId.argtypes = [w.HANDLE, ctypes.POINTER(w.UINT), w.LPWSTR]
        kernel.GetApplicationUserModelId.restype = w.LONG
        length = w.UINT()
        if kernel.GetApplicationUserModelId(kernel.GetCurrentProcess(), ctypes.byref(length), None) != 122:
            fail("application_identity_missing")
        app = ctypes.create_unicode_buffer(length.value)
        if kernel.GetApplicationUserModelId(kernel.GetCurrentProcess(), ctypes.byref(length), app) != 0:
            fail("application_identity_missing")
        kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
        kernel.CreateFileW.restype = w.HANDLE
        kernel.CloseHandle.argtypes = [w.HANDLE]; kernel.CloseHandle.restype = w.BOOL
        handle = kernel.CreateFileW(desktop, 0x20000000, 7, None, 3, 0, None)
        if handle is None or handle == ctypes.c_void_p(-1).value:
            fail("desktop_execute_access_denied")
        if not kernel.CloseHandle(handle):
            fail("desktop_access_handle_close_failed")
        return {"packageFullName": package.value, "applicationUserModelId": app.value,
                "executeAccess": True, "accessHandleClosed": True}

    def create_desktop(self, config, manifest):
        environment = os.environ.copy()
        environment.pop("CODEX_APP_SERVER_WS_URL", None)
        environment.pop("CODEX_APP_SERVER_FORCE_CLI", None)
        environment["CODEX_CLI_PATH"] = manifest["executable"]
        process = subprocess.Popen([config["oldDesktop"]["path"]], cwd=config["cwd"], env=environment,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   shell=False, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            return {"pid": process.pid, **self._handle_identity(int(process._handle))}
        except Exception:
            fail("created_desktop_identity_uncertain", uncertain=True)

    def invoke_package(self, config, request_path):
        quote = lambda text: "'" + str(text).replace("'", "''") + "'"
        arguments = subprocess.list2cmdline([config["source"]["path"], "--wrapper", str(request_path)])
        command = ("$ErrorActionPreference='Stop'; Invoke-CommandInDesktopPackage -PackageFamilyName "
                   + quote(config["package"]["familyName"]) + " -AppId " + quote(config["package"]["appId"])
                   + " -Command " + quote(config["pythonw"]["path"]) + " -Args " + quote(arguments) + " -PreventBreakaway")
        process = subprocess.Popen([POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        return process


def result_path(request_path):
    return Path(request_path).with_name("result.json")


def invoke_once(config, config_path, role, tracked, runtime, *, backend_state=None, sleep=time.sleep, clock=time.monotonic):
    if role == "launch" and "oldBackend" in config:
        if backend_state is None:
            fail("old_backend_tracking_required")
        backend_tracker(config, backend_state)
    elif backend_state is not None:
        fail("unexpected_old_backend_tracking")
    directory = Path(config["stateDir"]) / ("launch" if role == "launch" else "probe-" + uuid.uuid4().hex)
    directory.mkdir(parents=True, exist_ok=False)
    request_path = directory / "request.json"
    request = {"schema": "codex-desktop-owned-launch-request-v1", "requestId": uuid.uuid4().hex,
               "configPath": str(Path(config_path).resolve()), "configSha256": sha(config_path),
               "role": role, "tracked": tracked, "createdAt": utc()}
    if backend_state is not None:
        request["backendTracking"] = backend_state
    exclusive(request_path, request)
    # Request existence is the durable reservation for this cmdlet attempt.
    try:
        process = runtime.invoke_package(config, request_path)
    except Exception:
        fail("package_invocation_uncertain", uncertain=True)
    deadline = clock() + config.get("invocationWaitSeconds", 30)
    while not result_path(request_path).exists() and clock() < deadline:
        sleep(0.1)
    if not result_path(request_path).exists():
        fail("package_result_timeout_uncertain", uncertain=True)
    try:
        result = load(result_path(request_path))
    except Exception:
        fail("package_result_unreadable", uncertain=True)
    if (result.get("requestId") != request["requestId"] or result.get("configSha256") != request["configSha256"]
            or result.get("role") != role or result.get("schema") != "codex-desktop-owned-launch-result-v1"):
        fail("package_result_mismatch", uncertain=True)
    if result.get("status") != "success":
        fail("package_wrapper_refused", uncertain=result.get("launchReserved") is True,
             details=result.get("error", {}).get("details"))
    if (result.get("packageFullName") != config["package"]["fullName"]
            or result.get("applicationUserModelId") != config["package"]["familyName"] + "!" + config["package"]["appId"]
            or result.get("executeAccess") is not True or result.get("accessHandleClosed") is not True
            or result.get("applicationExecuted") is not (role == "launch")
            or result.get("launchReserved") is not (role == "launch")):
        fail("package_result_proof_invalid", uncertain=True)
    if role == "launch":
        identity(result.get("desktop"))
        if canonical(result["desktop"]["path"]) != canonical(config["oldDesktop"]["path"]):
            fail("launched_path_mismatch", uncertain=True)
    return result


def arm_and_wait(config, config_path, runtime, *, sleep=time.sleep, clock=time.monotonic):
    validate_config(config, computer=os.environ.get("COMPUTERNAME", ""))
    tracker = QuitTracker(config["oldDesktop"])
    backend = backend_tracker(config)
    observe_with_rechecks(runtime, lambda snapshot: observe_owned_trees(config, snapshot, tracker, backend), sleep=sleep, clock=clock)
    directory = Path(config["stateDir"])
    directory.mkdir(parents=True, exist_ok=True)
    reservation = {"schema": SCHEMA, "configSha256": sha(config_path), "armedAt": utc(),
                   "automaticRetry": False, "initialTracked": list(tracker.tracked.values())}
    if backend:
        reservation["initialBackendTracking"] = backend.checkpoint()
    try:
        exclusive(directory / "arm-reservation.json", reservation)
    except FileExistsError:
        fail("already_armed_no_retry", uncertain=True)
    deadline = clock() + config.get("waitSeconds", 3600)
    idle_deadline = None
    def tracking_fields():
        return {"tracked": list(tracker.tracked.values()),
                **({"backendTracking": backend.checkpoint()} if backend else {})}
    try:
        while clock() < (idle_deadline if idle_deadline is not None else deadline):
            drained, snapshot = observe_with_rechecks(runtime,
                lambda current: observe_owned_trees(config, current, tracker, backend), sleep=sleep, clock=clock)
            if not drained:
                wait_status(directory, "waiting_for_normal_quit", remainingOldProcesses=tracker.remaining, **tracking_fields())
                sleep(config.get("pollSeconds", 5))
                continue
            if "oldBackend" in config and idle_deadline is None:
                # Native unloaded-thread retirement may take thirty minutes.
                # This separate, >=45-minute budget begins only after Quit.
                idle_deadline = clock() + config.get("oldBackendWaitSeconds", 3600)
            remaining = old_backend_count(config, runtime, tracker=backend)
            if remaining == 0:
                validate_config(config, computer=os.environ.get("COMPUTERNAME", ""))
                snapshot = runtime.snapshot()
                if backend is not None:
                    backend_drained, snapshot = observe_with_rechecks(runtime, backend.observe, snapshot=snapshot, sleep=sleep, clock=clock)
                if backend is None or backend_drained:
                    observe_with_rechecks(runtime, lambda current: final_process_gate(config, list(tracker.tracked.values()), current, backend=backend),
                                          snapshot=snapshot, sleep=sleep, clock=clock)
                    wait_status(directory, "package_launch_attempt_reserved", **tracking_fields())
                    result = invoke_once(config, config_path, "launch", list(tracker.tracked.values()), runtime,
                                         backend_state=backend.checkpoint() if backend else None, sleep=sleep, clock=clock)
                    wait_status(directory, "desktop_launch_reported", desktop=result["desktop"], **tracking_fields())
                    return result
            wait_status(directory, "waiting_for_old_backend_idle", remainingLoadedThreads=remaining,
                        remainingBackendDescendants=backend.remaining if backend else 0,
                        idleSecondsRemaining=max(0, round(idle_deadline - clock(), 1)), **tracking_fields())
            sleep(config.get("pollSeconds", 5))
        fail("old_backend_idle_deadline_no_launch" if idle_deadline is not None else "wait_deadline_no_launch")
    except Exception as error:
        details = {"details": error.details} if isinstance(error, LaunchError) and error.details else {}
        wait_status(directory, "blocked", code=getattr(error, "code", "wait_failed"), uncertain=getattr(error, "uncertain", False), **details, **tracking_fields())
        publish(directory / "wait-outcome.json", {"status": "stopped", "code": getattr(error, "code", "wait_failed"),
                "uncertain": getattr(error, "uncertain", False), "automaticRetry": False, "recordedAt": utc(), **details, **tracking_fields()})
        raise


def run_wrapper(request_path, runtime=None):
    request_path = Path(request_path).resolve()
    request = load(request_path)
    if (set(request) - {"backendTracking"} != {"schema", "requestId", "configPath", "configSha256", "role", "tracked", "createdAt"}
            or request.get("schema") != "codex-desktop-owned-launch-request-v1"
            or request.get("role") not in ("probe", "launch") or not re.fullmatch(r"[a-f0-9]{32}", request.get("requestId", ""))):
        fail("invalid_wrapper_request")
    pin({"path": request["configPath"], "sha256": request["configSha256"]}, "launcher_config")
    config = load(request["configPath"])
    manifest = validate_config(config, computer=os.environ.get("COMPUTERNAME", ""))
    if canonical(request_path.parent.parent) != canonical(config["stateDir"]) or request_path.name != "request.json":
        fail("wrapper_request_location_mismatch")
    expected_name = "launch" if request["role"] == "launch" else r"probe-[a-f0-9]{32}"
    if not re.fullmatch(expected_name, request_path.parent.name):
        fail("wrapper_request_role_mismatch")
    if not isinstance(request["tracked"], list):
        fail("invalid_tracked_processes")
    for item in request["tracked"]:
        identity(item)
    needs_backend = request["role"] == "launch" and "oldBackend" in config
    if needs_backend != ("backendTracking" in request):
        fail("old_backend_tracking_required" if needs_backend else "unexpected_old_backend_tracking")
    if needs_backend and request["backendTracking"] is None:
        fail("invalid_old_backend_tracking")
    backend = backend_tracker(config, request["backendTracking"]) if needs_backend else None
    if request["role"] == "launch":
        reservation = load(Path(config["stateDir"]) / "arm-reservation.json")
        if reservation.get("configSha256") != request["configSha256"] or not any(same(item, config["oldDesktop"]) for item in request["tracked"]):
            fail("arm_reservation_mismatch")
        if backend:
            initial = reservation.get("initialBackendTracking")
            if initial is None:
                fail("initial_old_backend_tracking_required")
            initial_backend = backend_tracker(config, initial)
            if any(not same(backend.tracked.get(pid), item) for pid, item in initial_backend.tracked.items()):
                fail("initial_old_backend_tracking_missing")
    if result_path(request_path).exists():
        fail("wrapper_already_completed", uncertain=True)
    try:
        exclusive(request_path.with_name("wrapper-reservation.json"), {"requestId": request["requestId"], "wrapperPid": os.getpid(), "createdAt": utc()})
    except FileExistsError:
        fail("wrapper_already_reserved", uncertain=True)
    result = {"schema": "codex-desktop-owned-launch-result-v1", "requestId": request["requestId"],
              "configSha256": request["configSha256"], "role": request["role"], "wrapperPid": os.getpid(),
              "launchReserved": False, "applicationExecuted": False, "status": "failed", "recordedAt": utc()}
    try:
        runtime = runtime or WindowsRuntime()
        if canonical(sys.executable) != canonical(config["pythonw"]["path"]) and isinstance(runtime, WindowsRuntime):
            fail("wrong_wrapper_interpreter")
        result.update(runtime.package_access(config["oldDesktop"]["path"]))
        if (result["packageFullName"] != config["package"]["fullName"]
                or result["applicationUserModelId"] != config["package"]["familyName"] + "!" + config["package"]["appId"]
                or result.get("executeAccess") is not True or result.get("accessHandleClosed") is not True):
            fail("package_access_proof_mismatch")
        if request["role"] == "launch":
            observe_with_rechecks(runtime, lambda current: final_process_gate(config, request["tracked"], current, backend=backend))
            if not old_backend_empty(config, runtime, tracker=backend):
                fail("old_backend_has_loaded_threads")
            validate_config(config, computer=os.environ.get("COMPUTERNAME", ""))
            observe_with_rechecks(runtime, lambda current: final_process_gate(config, request["tracked"], current, backend=backend))
            exclusive(request_path.with_name("desktop-launch-reservation.json"), {"requestId": request["requestId"],
                      "configSha256": request["configSha256"], "outcome": "uncertain_until_result", "automaticRetry": False, "reservedAt": utc()})
            result["launchReserved"] = True
            result["desktop"] = runtime.create_desktop(config, manifest)
            result["applicationExecuted"] = True
        result["status"] = "success"
    except Exception as error:
        result["error"] = {"code": getattr(error, "code", "wrapper_operation_failed"), "type": type(error).__name__}
        if isinstance(error, LaunchError) and error.details:
            result["error"]["details"] = error.details
    if backend:
        result["backendTracking"] = backend.checkpoint()
    publish(result_path(request_path), result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--arm", action="store_true")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--wrapper")
    arguments = parser.parse_args(argv)
    try:
        if arguments.wrapper:
            if any((arguments.config, arguments.check, arguments.probe, arguments.arm, arguments.wait)):
                fail("wrapper_arguments_conflict")
            result = run_wrapper(arguments.wrapper)
        else:
            if not arguments.config or not absolute(arguments.config):
                fail("absolute_configuration_required")
            if arguments.arm != arguments.wait or sum((arguments.check, arguments.probe, arguments.arm)) > 1:
                fail("explicit_arm_and_wait_required")
            config = load(arguments.config)
            manifest = validate_config(config, computer=os.environ.get("COMPUTERNAME", ""))
            if arguments.arm:
                result = arm_and_wait(config, arguments.config, WindowsRuntime())
            elif arguments.probe:
                result = invoke_once(config, arguments.config, "probe", [], WindowsRuntime())
            else:
                result = {"schema": SCHEMA, "status": "check_only", "pinsValid": True, "applicationExecuted": False,
                          "alreadyArmed": (Path(config["stateDir"]) / "arm-reservation.json").exists(),
                          "managerDisabledAcknowledged": config["managerDisabledAcknowledged"],
                          "oldBackendGateConfigured": "oldBackend" in config, "candidate": manifest["executable"]}
        if not arguments.wrapper:
            print(json.dumps(result, sort_keys=True))
        return 0 if result.get("status") != "failed" else 1
    except Exception as error:
        if not arguments.wrapper:
            print(json.dumps({"status": "blocked", "code": getattr(error, "code", "launcher_error"),
                              "uncertain": getattr(error, "uncertain", False), "automaticRetry": False}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
