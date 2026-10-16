"""Offline tests: no desktop, package cmdlet, native process inspection or backend."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).with_name("desktop-owned-launch.py")
SPEC = importlib.util.spec_from_file_location("desktop_owned_launch", SOURCE)
launch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launch)


def proof(path):
    return {"path": str(path), "sha256": launch.sha(path)}


def process(pid, ticks, path, ppid=1):
    return {"pid": pid, "createdTicks": ticks, "path": str(path), "ppid": ppid, "name": Path(path).name}


def exact(value):
    return {key: value[key] for key in ("pid", "createdTicks", "path")}


class Clock:
    def __init__(self): self.value = 0
    def __call__(self): return self.value
    def sleep(self, seconds): self.value += seconds


class MockRuntime:
    def __init__(self, config, snapshots=None):
        self.config = config
        self.snapshots = list(snapshots or [{}])
        self.last = self.snapshots[-1]
        self.invocations = []
        self.launches = []
        self.accesses = 0
        self.loaded = []
        self.loaded_default = True
        self.listener = {config.get("oldBackend", {}).get("server", {}).get("pid", 55)}
        self.wrong_package = False
        self.no_result = False
        self.query_error = False
        self.launch_error = False

    def snapshot(self):
        if self.snapshots:
            self.last = self.snapshots.pop(0)
        return self.last

    def listener_owners(self, port): return self.listener

    def loaded_thread_count(self, backend):
        if self.query_error: raise OSError("fixture query failure")
        value = self.loaded.pop(0) if self.loaded else self.loaded_default
        return (0 if value else 1) if type(value) is bool else value

    def package_access(self, desktop):
        self.accesses += 1
        p = self.config["package"]
        return {"packageFullName": "wrong" if self.wrong_package else p["fullName"],
                "applicationUserModelId": p["familyName"] + "!" + p["appId"],
                "executeAccess": True, "accessHandleClosed": True}

    def create_desktop(self, config, manifest):
        self.launches.append(manifest["executable"])
        if self.launch_error: raise OSError("fixture ambiguous creation")
        return {"pid": 88, "createdTicks": 888, "path": config["oldDesktop"]["path"]}

    def invoke_package(self, config, request_path):
        self.invocations.append(request_path)
        if not self.no_result:
            launch.run_wrapper(request_path, self)
        return object()


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="desktop-launch-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        package = self.root / "OpenAI.Codex_1_x64__fixture" / "app"
        package.mkdir(parents=True)
        self.desktop = package / "ChatGPT.exe"
        self.desktop.write_bytes(b"synthetic desktop; never executed")
        self.old = process(10, 100, self.desktop)
        self.backend = process(55, 55, self.root / "real-cli.exe")
        self.files = {}
        for name in ("pythonw.exe", "shim.exe", "node.exe", "real-cli.exe", "bridge.mjs", "transport.py"):
            filename = self.root / name
            filename.write_bytes(("synthetic " + name).encode())
            self.files[name] = filename
        bridge_path = self.root / "shim.exe.json"
        bridge_path.write_text(json.dumps({"nodePath": str(self.files["node.exe"]), "realCliPath": str(self.files["real-cli.exe"]), "bridgePath": str(self.files["bridge.mjs"])}))
        self.manifest_path = self.root / "candidate-manifest.json"
        mapping = {"shim": self.files["shim.exe"], "bridge": self.files["node.exe"], "server": self.files["real-cli.exe"], "script": self.files["bridge.mjs"], "config": bridge_path}
        self.manifest = {"schema": "codex-desktop-owned-candidate-v1", "activated": False,
                         "executable": str(self.files["shim.exe"]), "configFile": str(bridge_path),
                         "expectedHashes": {key: launch.sha(value) for key, value in mapping.items()},
                         "files": [proof(value) for value in mapping.values()]}
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.config = {"schema": launch.SCHEMA, "computerName": "FIXTURE", "oldDesktop": exact(self.old),
                       "desktopSha256": launch.sha(self.desktop), "candidateManifest": proof(self.manifest_path),
                       "pythonw": proof(self.files["pythonw.exe"]), "source": proof(SOURCE),
                       "package": {"fullName": package.parent.name, "familyName": "OpenAI.Codex_fixture", "appId": "App"},
                       "expectedOtherFiles": [], "stateDir": str(self.root / "state"), "cwd": str(self.root),
                       "managerDisabledAcknowledged": True, "waitSeconds": 1, "pollSeconds": .05, "invocationWaitSeconds": 1}
        self.config_path = self.root / "launch-config.json"
        self.save()
        self.clock = Clock()
        self.env = patch.dict(os.environ, {"COMPUTERNAME": "FIXTURE"})
        self.env.start(); self.addCleanup(self.env.stop)

    def save(self): self.config_path.write_text(json.dumps(self.config))

    def arm(self, runtime):
        return launch.arm_and_wait(self.config, self.config_path, runtime, sleep=self.clock.sleep, clock=self.clock)

    def old_backend(self):
        self.config["oldBackend"] = {"endpoint": "ws://127.0.0.1:4501", "transportPath": str(self.files["transport.py"]),
                                     "pinnedSha256": launch.sha(self.files["transport.py"]), "server": exact(self.backend),
                                     "admissionClosedAcknowledged": True}
        self.save()

    def test_default_is_readonly_check_without_runtime(self):
        with patch.object(launch, "WindowsRuntime", side_effect=AssertionError("No process inspection on default check")), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(launch.main(["--config", str(self.config_path)]), 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "check_only")
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_arm_requires_explicit_wait_and_matching_machine(self):
        for flags in (["--arm"], ["--wait"], ["--probe", "--arm", "--wait"]):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(launch.main(["--config", str(self.config_path), *flags]), 1)
        with self.assertRaisesRegex(launch.LaunchError, "wrong_computer"):
            launch.validate_config(self.config, computer="OTHER")
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_changed_candidate_or_dependency_refuses_before_arming(self):
        self.files["bridge.mjs"].write_text("changed")
        with self.assertRaisesRegex(launch.LaunchError, "pin_mismatch_candidate_file"):
            self.arm(MockRuntime(self.config, [{10: self.old}]))
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_manifest_hash_mapping_cannot_swap_pinned_files(self):
        self.manifest["expectedHashes"]["shim"] = self.manifest["expectedHashes"]["server"]
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.config["candidateManifest"] = proof(self.manifest_path)
        with self.assertRaisesRegex(launch.LaunchError, "candidate_hash_mapping_mismatch"):
            launch.validate_config(self.config)

    def test_initial_old_desktop_must_match_exact_birth_and_path(self):
        for old in ({}, {10: {**self.old, "createdTicks": 101}}, {10: {**self.old, "path": str(self.files["shim.exe"])}}):
            with self.assertRaisesRegex(launch.LaunchError, "old_desktop_not_exactly_present"):
                self.arm(MockRuntime(self.config, [old]))
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_old_descendants_must_drain_and_new_descendants_are_tracked(self):
        tracker = launch.QuitTracker(exact(self.old))
        child = process(11, 110, self.files["real-cli.exe"], 10)
        grandchild = process(12, 120, self.files["node.exe"], 11)
        self.assertFalse(tracker.observe({10: self.old, 11: child}))
        self.assertFalse(tracker.observe({10: self.old, 11: child, 12: grandchild}))
        self.assertFalse(tracker.observe({12: grandchild}))
        self.assertTrue(tracker.observe({}))

    def test_new_desktop_and_pid_reuse_fail_closed(self):
        for replacement in (process(20, 200, self.desktop), {**self.old, "createdTicks": 200}):
            tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
            with self.assertRaises(launch.LaunchError): tracker.observe({replacement["pid"]: replacement})

    def test_provably_newer_unrelated_pid_incarnation_retires_old_identity(self):
        tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
        replacement = process(10, 200, self.files["node.exe"])
        self.assertTrue(tracker.observe({10: replacement}))
        launch.final_process_gate(self.config, list(tracker.tracked.values()), {10: replacement})
        with self.assertRaisesRegex(launch.LaunchError, "retired_identity_reappeared"):
            tracker.observe({10: self.old})

    def test_unreadable_pid_replacement_remains_ambiguous(self):
        tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
        with self.assertRaisesRegex(launch.LaunchError, "tracked_process_replaced_or_unreadable"):
            tracker.observe({10: {"pid": 10, "ppid": 1, "name": "other.exe"}})

    def unreadable(self, pid=10, ppid=1):
        return {"pid": pid, "ppid": ppid, "name": "exiting.exe",
                "identityError": {"phase": "OpenProcess", "win32Error": 87}}

    def recheck(self, runtime, observe):
        return launch.observe_with_rechecks(runtime, observe, sleep=self.clock.sleep, clock=self.clock)

    def test_enumerated_desktop_exits_before_identity_read_then_launches_once(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {10: self.unreadable()}, {}])
        self.assertEqual(self.arm(runtime)["status"], "success")
        self.assertEqual(len(runtime.invocations), 1)
        self.assertEqual(len(runtime.launches), 1)

    def test_unavailable_tracked_child_can_resolve_same_or_proven_newer(self):
        self.old_backend()
        child = process(56, 60, self.files["node.exe"], 55)
        for resolved in (child, process(56, 200, self.files["pythonw.exe"])):
            with self.subTest(resolved=resolved):
                tracker = launch.backend_tracker(self.config)
                tracker.observe({55: self.backend, 56: child})
                runtime = MockRuntime(self.config, [{55: self.backend, 56: self.unreadable(56, 55)}, {55: self.backend, 56: resolved}])
                drained, _ = self.recheck(runtime, tracker.observe)
                self.assertEqual(drained, resolved is not child)
                self.assertEqual(tracker.tracked[56], exact(child))
                if resolved is not child:
                    restored = launch.backend_tracker(self.config, tracker.checkpoint())
                    self.assertEqual(restored.retired_at, {56: 200})

    def test_persistent_missing_birth_is_bounded_durable_and_never_launches(self):
        unknown = {**self.unreadable(), "path": str(self.files["node.exe"])}
        runtime = MockRuntime(self.config, [{10: self.old}, {10: unknown}])
        with self.assertRaisesRegex(launch.LaunchError, "tracked_process_replaced_or_unreadable"):
            self.arm(runtime)
        self.assertEqual(runtime.invocations, [])
        self.assertEqual(runtime.launches, [])
        for name in ("wait-status.json", "wait-outcome.json"):
            details = launch.load(Path(self.config["stateDir"]) / name)["details"]
            self.assertEqual(details["pid"], 10)
            self.assertEqual(details["expected"], exact(self.old))
            self.assertEqual(details["observed"]["identityError"], {"phase": "OpenProcess", "win32Error": 87})
            self.assertEqual(details["identityObservations"], 3)
        self.assertAlmostEqual(self.clock.value, .1)

    def test_readable_identity_mismatch_is_not_retried(self):
        tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
        changed = {**self.old, "path": str(self.files["node.exe"])}
        runtime = MockRuntime(self.config, [{10: changed}, {}])
        with self.assertRaises(launch.LaunchError) as caught:
            self.recheck(runtime, tracker.observe)
        self.assertFalse(caught.exception.identity_unavailable)
        self.assertEqual(runtime.snapshots, [{}])
        self.assertEqual(self.clock.value, 0)

    def test_readable_orphan_is_retained_across_identity_recheck(self):
        child = process(11, 110, self.files["node.exe"], 10)
        for snapshots in ([{10: self.unreadable(), 11: child}, {}],
                          [{10: self.unreadable()}, {11: child}, {}]):
            with self.subTest(snapshots=snapshots):
                tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
                runtime = MockRuntime(self.config, snapshots)
                drained, snapshot = self.recheck(runtime, tracker.observe)
                self.assertEqual(tracker.tracked[11], exact(child))
                self.assertEqual(drained, 11 not in snapshot)
                self.assertTrue(tracker.observe({}))

    def test_recheck_preserves_new_descendants_from_other_owned_tree(self):
        self.old_backend(); tracker = launch.QuitTracker(exact(self.old)); backend = launch.backend_tracker(self.config)
        initial = {10: self.old, 55: self.backend}
        launch.observe_owned_trees(self.config, initial, tracker, backend)
        child = process(56, 60, self.files["node.exe"], 55)
        runtime = MockRuntime(self.config, [{10: self.unreadable(), 55: self.backend, 56: child}, {55: self.backend}])
        self.recheck(runtime, lambda snapshot: launch.observe_owned_trees(self.config, snapshot, tracker, backend))
        self.assertEqual(backend.tracked[56], exact(child))

    def test_final_gate_rechecks_unavailable_tracked_identity_but_not_orphan(self):
        callback = lambda snapshot: launch.final_process_gate(self.config, [exact(self.old)], snapshot)
        runtime = MockRuntime(self.config, [{10: {**self.unreadable(), "name": self.desktop.name}}, {}])
        self.recheck(runtime, callback)
        child = process(11, 110, self.files["node.exe"], 10)
        runtime = MockRuntime(self.config, [{10: self.unreadable(), 11: child}, {}])
        with self.assertRaisesRegex(launch.LaunchError, "unobserved_descendant_after_parent_exit"):
            self.recheck(runtime, callback)
        self.assertEqual(runtime.snapshots, [{}])

    def test_final_gate_new_parent_incarnation_does_not_hide_older_or_unknown_child(self):
        replacement = process(10, 200, self.files["node.exe"])
        for child in (process(11, 110, self.files["real-cli.exe"], 10), self.unreadable(11, 10)):
            with self.subTest(child=child), self.assertRaisesRegex(launch.LaunchError, "historical_backend_parentage_ambiguous"):
                launch.final_process_gate(self.config, [exact(self.old)], {10: replacement, 11: child})
        launch.final_process_gate(self.config, [exact(self.old)],
                                  {10: replacement, 11: process(11, 210, self.files["real-cli.exe"], 10)})

    def test_wrapper_persistent_identity_failure_is_durable_before_launch_reservation(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}])
        invoke = runtime.invoke_package
        def race(config, request_path):
            runtime.last = {10: self.unreadable()}
            return invoke(config, request_path)
        runtime.invoke_package = race
        with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
            self.arm(runtime)
        result = launch.load(launch.result_path(runtime.invocations[0]))
        self.assertEqual(result["error"]["details"]["identityObservations"], 3)
        self.assertEqual(result["error"]["details"]["pid"], 10)
        self.assertEqual(runtime.launches, [])
        self.assertFalse(runtime.invocations[0].with_name("desktop-launch-reservation.json").exists())

    def test_win32_identity_failure_preserves_phase_and_error_without_inferred_exit(self):
        runtime = object.__new__(launch.WindowsRuntime); runtime.kernel = Mock()
        runtime.kernel.OpenProcess.return_value = 0
        with patch.object(launch.ctypes, "get_last_error", return_value=87, create=True):
            self.assertEqual(runtime._process_identity(10), {"identityError": {"phase": "OpenProcess", "win32Error": 87}})
        runtime.kernel.OpenProcess.return_value = 123
        runtime.kernel.CloseHandle.return_value = True
        error = launch.LaunchError("process_identity_unavailable", details={"phase": "GetProcessTimes", "win32Error": 5})
        with patch.object(runtime, "_handle_identity", side_effect=error):
            self.assertEqual(runtime._process_identity(10), {"identityError": error.details})
        runtime.kernel.CloseHandle.assert_called_once_with(123)

    def test_child_discovered_after_parent_exit_blocks_until_it_drains(self):
        tracker = launch.QuitTracker(exact(self.old)); tracker.observe({10: self.old})
        child = process(11, 110, self.files["node.exe"], 10)
        self.assertFalse(tracker.observe({11: child}))
        self.assertEqual(tracker.tracked[11], exact(child))
        self.assertTrue(tracker.observe({}))

    def test_readable_orphan_and_later_grandchild_must_drain_before_launch(self):
        child = process(11, 110, self.files["node.exe"], 10)
        grandchild = process(12, 120, self.files["node.exe"], 11)
        runtime = MockRuntime(self.config, [{10: self.old}, {11: child}, {12: grandchild}, {}])
        self.assertEqual(self.arm(runtime)["status"], "success")
        request = launch.load(runtime.invocations[0])
        self.assertEqual({row["pid"] for row in request["tracked"]}, {10, 11, 12})
        self.assertEqual(len(runtime.launches), 1)
        self.assertGreaterEqual(self.clock.value, 2 * self.config["pollSeconds"])

    def test_unreadable_new_orphan_is_refused_with_safe_durable_parentage(self):
        child = {**self.unreadable(11, 10), "CommandLine": "must not be recorded"}
        runtime = MockRuntime(self.config, [{10: self.old}, {11: child}])
        with self.assertRaisesRegex(launch.LaunchError, "descendant_identity_ambiguous"):
            self.arm(runtime)
        details = launch.load(Path(self.config["stateDir"]) / "wait-outcome.json")["details"]
        self.assertEqual(details["parent"], exact(self.old))
        self.assertIsNone(details["observedParent"])
        self.assertEqual(details["child"]["pid"], 11)
        self.assertEqual(details["child"]["identityError"]["win32Error"], 87)
        self.assertNotIn("CommandLine", details["child"])
        self.assertEqual(runtime.invocations, [])

    def test_live_manager_or_missing_ack_cannot_arm(self):
        self.config["managerDisabledAcknowledged"] = False
        with self.assertRaisesRegex(launch.LaunchError, "manager_disable_acknowledgment"):
            self.arm(MockRuntime(self.config, [{10: self.old}]))
        self.config["managerDisabledAcknowledged"] = True
        manager = process(90, 90, self.files["pythonw.exe"])
        self.config["oldManager"] = exact(manager); self.save()
        with self.assertRaisesRegex(launch.LaunchError, "old_manager_still_present"):
            self.arm(MockRuntime(self.config, [{10: self.old, 90: manager}]))
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_normal_quit_launches_once_and_rearm_cannot_repeat(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {10: self.old}, {}, {}, {}, {}])
        result = self.arm(runtime)
        self.assertEqual(result["status"], "success")
        self.assertEqual(len(runtime.invocations), 1); self.assertEqual(len(runtime.launches), 1)
        runtime.snapshots = [{10: self.old}]
        with self.assertRaisesRegex(launch.LaunchError, "already_armed_no_retry"):
            self.arm(runtime)
        self.assertEqual(len(runtime.launches), 1)
        with self.assertRaisesRegex(launch.LaunchError, "wrapper_already_completed"):
            launch.run_wrapper(runtime.invocations[0], runtime)

    def test_wait_timeout_is_durable_and_no_launch(self):
        runtime = MockRuntime(self.config, [{10: self.old}])
        with self.assertRaisesRegex(launch.LaunchError, "wait_deadline_no_launch"):
            self.arm(runtime)
        self.assertEqual(runtime.launches, [])
        self.assertTrue((Path(self.config["stateDir"]) / "wait-outcome.json").exists())

    def test_new_desktop_in_wrapper_race_blocks_launch(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}, {20: process(20, 200, self.desktop)}])
        with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
            self.arm(runtime)
        self.assertEqual(len(runtime.invocations), 1); self.assertEqual(runtime.launches, [])

    def test_probe_proves_package_access_without_desktop_operation(self):
        runtime = MockRuntime(self.config)
        result = launch.invoke_once(self.config, self.config_path, "probe", [], runtime, sleep=self.clock.sleep, clock=self.clock)
        self.assertEqual(result["status"], "success")
        self.assertFalse(result["applicationExecuted"]); self.assertFalse(result["launchReserved"])
        self.assertEqual(runtime.accesses, 1); self.assertEqual(runtime.launches, [])
        self.assertFalse((Path(self.config["stateDir"]) / "arm-reservation.json").exists())

    def test_wrong_package_context_refuses_before_desktop_reservation(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}, {}]); runtime.wrong_package = True
        with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
            self.arm(runtime)
        self.assertEqual(runtime.launches, [])
        self.assertFalse(runtime.invocations[0].with_name("desktop-launch-reservation.json").exists())

    def test_cmdlet_timeout_is_uncertain_and_never_reinvoked(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}]); runtime.no_result = True
        with self.assertRaises(launch.LaunchError) as caught: self.arm(runtime)
        self.assertTrue(caught.exception.uncertain)
        self.assertEqual(caught.exception.code, "package_result_timeout_uncertain")
        runtime.snapshots = [{10: self.old}]
        with self.assertRaises(launch.LaunchError): self.arm(runtime)
        self.assertEqual(len(runtime.invocations), 1)

    def test_creation_exception_remains_reserved_and_uncertain(self):
        runtime = MockRuntime(self.config, [{10: self.old}, {}, {}, {}, {}]); runtime.launch_error = True
        with self.assertRaises(launch.LaunchError) as caught: self.arm(runtime)
        self.assertTrue(caught.exception.uncertain)
        self.assertEqual(len(runtime.launches), 1)
        self.assertTrue(runtime.invocations[0].with_name("desktop-launch-reservation.json").exists())

    def test_old_backend_is_gated_after_quit_and_busy_threads_wait(self):
        self.old_backend()
        alive = {10: self.old, 55: self.backend}; drained = {55: self.backend}
        runtime = MockRuntime(self.config, [alive, alive, drained]); runtime.loaded = [False, True, True]
        result = self.arm(runtime)
        self.assertEqual(result["status"], "success")
        self.assertEqual(runtime.loaded, []); self.assertEqual(len(runtime.launches), 1)

    def test_backend_busy_in_wrapper_race_does_not_launch(self):
        self.old_backend()
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend}])
        runtime.loaded = [True, False]
        with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
            self.arm(runtime)
        self.assertEqual(runtime.launches, [])

    def test_backend_wait_has_separate_long_deadline_and_durable_count(self):
        self.old_backend()
        self.config["oldBackendWaitSeconds"] = 2700
        self.config["pollSeconds"] = 30
        self.config["waitSeconds"] = 1
        self.save()
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend}])
        runtime.loaded = [7, 7, 0, 0]
        statuses = []
        original = self.clock.sleep
        def inspect_sleep(seconds):
            status = Path(self.config["stateDir"]) / "wait-status.json"
            if status.exists(): statuses.append(launch.load(status))
            original(seconds)
        result = launch.arm_and_wait(self.config, self.config_path, runtime, sleep=inspect_sleep, clock=self.clock)
        self.assertEqual(result["status"], "success")
        self.assertGreater(self.clock.value, self.config["waitSeconds"])
        self.assertEqual([item["remainingLoadedThreads"] for item in statuses], [7, 7])
        self.assertTrue(all(item["state"] == "waiting_for_old_backend_idle" for item in statuses))

    def test_nonempty_old_backend_times_out_without_package_invocation(self):
        self.old_backend(); self.config["oldBackendWaitSeconds"] = 2700; self.config["pollSeconds"] = 30; self.save()
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend}])
        runtime.loaded_default = False
        with self.assertRaisesRegex(launch.LaunchError, "old_backend_idle_deadline_no_launch"):
            self.arm(runtime)
        self.assertEqual(runtime.invocations, []); self.assertEqual(runtime.launches, [])
        self.assertEqual(launch.load(Path(self.config["stateDir"]) / "wait-status.json")["state"], "blocked")

    def test_backend_listener_replacement_and_query_failures_block(self):
        self.old_backend()
        for problem in ("pid", "listener", "query"):
            with self.subTest(problem=problem):
                runtime = MockRuntime(self.config, [{55: self.backend}])
                if problem == "pid": runtime.snapshots = [{55: {**self.backend, "createdTicks": 999}}]
                if problem == "listener": runtime.listener = {99}
                if problem == "query": runtime.query_error = True
                with self.assertRaises(launch.LaunchError): launch.old_backend_empty(self.config, runtime)
                self.assertEqual(runtime.launches, [])

    def test_backend_descendants_and_orphan_grandchild_must_naturally_drain(self):
        self.old_backend()
        child = process(56, 60, self.files["node.exe"], 55)
        grandchild = process(57, 70, self.files["real-cli.exe"], 56)
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend, 56: child, 57: grandchild}])
        statuses = []
        def advance(seconds):
            self.assertEqual(runtime.invocations, [])
            statuses.append(launch.load(Path(self.config["stateDir"]) / "wait-status.json"))
            runtime.last = {55: self.backend, 57: grandchild} if len(statuses) == 1 else {55: self.backend}
            self.clock.sleep(seconds)
        result = launch.arm_and_wait(self.config, self.config_path, runtime, sleep=advance, clock=self.clock)
        self.assertEqual(result["status"], "success")
        self.assertEqual(len(runtime.launches), 1)
        self.assertEqual(statuses[1]["remainingLoadedThreads"], 0)
        self.assertEqual(statuses[1]["remainingBackendDescendants"], 1)
        request = launch.load(runtime.invocations[0])
        self.assertEqual({item["pid"] for item in request["backendTracking"]["tracked"]}, {55, 56, 57})
        self.assertEqual(runtime.last, {55: self.backend})  # Retained root was never terminated.

    def test_backend_must_be_exactly_alive_at_arm_and_never_retired(self):
        self.old_backend()
        for snapshot in ({10: self.old}, {10: self.old, 55: {**self.backend, "createdTicks": 999}}):
            with self.assertRaisesRegex(launch.LaunchError, "old_backend_identity_changed"):
                self.arm(MockRuntime(self.config, [snapshot]))
        self.assertFalse(Path(self.config["stateDir"]).exists())
        tracker = launch.backend_tracker(self.config)
        self.assertTrue(tracker.observe({55: self.backend}))
        with self.assertRaisesRegex(launch.LaunchError, "old_backend_identity_changed"):
            tracker.observe({55: {**self.backend, "createdTicks": 999}})
        self.assertEqual(tracker.retired, set())

    def test_waiter_inside_either_old_tree_refuses_before_arm(self):
        self.old_backend()
        for parent, code in ((10, "old_desktop_tree"), (55, "old_backend_tree")):
            waiter = process(91, 150, self.files["pythonw.exe"], parent)
            with self.subTest(parent=parent), patch.object(launch.os, "getpid", return_value=91):
                with self.assertRaisesRegex(launch.LaunchError, code):
                    self.arm(MockRuntime(self.config, [{10: self.old, 55: self.backend, 91: waiter}]))
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_overlapping_retained_backend_and_desktop_trees_refuse(self):
        self.old_backend()
        desktop = {**self.old, "ppid": 55}
        with self.assertRaisesRegex(launch.LaunchError, "trees_overlap"):
            self.arm(MockRuntime(self.config, [{10: desktop, 55: self.backend}]))
        self.assertFalse(Path(self.config["stateDir"]).exists())

    def test_readable_backend_orphan_after_parent_exit_is_retained(self):
        self.old_backend()
        child = process(56, 60, self.files["node.exe"], 55)
        orphan = process(57, 70, self.files["real-cli.exe"], 56)
        tracker = launch.backend_tracker(self.config)
        tracker.observe({55: self.backend, 56: child})
        self.assertFalse(tracker.observe({55: self.backend, 57: orphan}))
        restored = launch.backend_tracker(self.config, tracker.checkpoint())
        self.assertEqual(restored.tracked[57], exact(orphan))
        self.assertFalse(restored.observe({55: self.backend, 57: orphan}))
        self.assertTrue(restored.observe({55: self.backend}))

    def test_backend_retirement_cutoff_survives_restore_and_later_reuse(self):
        self.old_backend()
        child = process(56, 60, self.files["node.exe"], 55)
        known = process(57, 70, self.files["real-cli.exe"], 56)
        replacement = process(56, 200, self.files["pythonw.exe"])
        tracker = launch.backend_tracker(self.config)
        tracker.observe({55: self.backend, 56: child, 57: known})
        self.assertFalse(tracker.observe({55: self.backend, 56: replacement, 57: known}))
        tracker = launch.backend_tracker(self.config, tracker.checkpoint())
        newer_child = process(58, 210, self.files["node.exe"], 56)
        self.assertFalse(tracker.observe({55: self.backend, 57: known, 58: newer_child}))
        self.assertTrue(tracker.observe({55: self.backend, 58: newer_child}))
        self.assertNotIn(58, tracker.tracked)
        self.assertTrue(tracker.observe({55: self.backend, 56: {**replacement, "createdTicks": 300}, 58: newer_child}))
        self.assertEqual(tracker.retired_at[56], 200)
        older_orphan = process(59, 100, self.files["real-cli.exe"], 56)
        self.assertFalse(tracker.observe({55: self.backend, 59: older_orphan}))
        self.assertEqual(tracker.tracked[59], exact(older_orphan))
        self.assertEqual(tracker.retired_at[56], 200)
        with self.assertRaisesRegex(launch.LaunchError, "historical_backend_parentage_ambiguous"):
            tracker.observe({55: self.backend, 60: {"pid": 60, "ppid": 56, "name": "unknown.exe"}})

    def test_retired_parent_cutoff_keeps_future_old_orphans_and_excludes_later_children(self):
        self.old_backend()
        parent = process(56, 60, self.files["node.exe"], 55)
        tracker = launch.backend_tracker(self.config); tracker.observe({55: self.backend, 56: parent})
        tracker.observe({55: self.backend, 56: process(56, 200, self.files["pythonw.exe"])})
        tracker = launch.backend_tracker(self.config, tracker.checkpoint())
        old_orphan = process(57, 150, self.files["node.exe"], 56)
        later_child = process(58, 200, self.files["node.exe"], 56)
        self.assertFalse(tracker.observe({55: self.backend, 57: old_orphan, 58: later_child}))
        self.assertIn(57, tracker.tracked); self.assertNotIn(58, tracker.tracked)
        self.assertTrue(tracker.observe({55: self.backend, 58: later_child}))
        tracker = launch.backend_tracker(self.config, tracker.checkpoint())
        another_old_orphan = process(59, 190, self.files["node.exe"], 56)
        self.assertFalse(tracker.observe({55: self.backend, 59: another_old_orphan}))
        self.assertEqual(tracker.retired_at[56], 200)

    def test_orphan_pid_generation_collision_refuses_without_replacing_history(self):
        self.old_backend()
        child = process(56, 60, self.files["node.exe"], 55)
        parent = process(57, 70, self.files["node.exe"], 55)
        tracker = launch.backend_tracker(self.config); tracker.observe({55: self.backend, 56: child, 57: parent})
        replacement = process(56, 90, self.files["real-cli.exe"], 57)
        with self.assertRaisesRegex(launch.LaunchError, "replacement_is_new_old_tree_descendant") as caught:
            tracker.observe({55: self.backend, 56: replacement})
        self.assertEqual(tracker.tracked[56], exact(child))
        self.assertEqual(caught.exception.details["parent"], exact(parent))
        self.assertEqual(caught.exception.details["child"]["createdTicks"], 90)

    def test_backend_checkpoint_rejects_duplicate_root_retirement_and_unknown_cutoff(self):
        self.old_backend()
        state = launch.backend_tracker(self.config).checkpoint()
        invalid = [
            {**state, "tracked": state["tracked"] * 2},
            {**state, "retiredPids": [55], "retiredAtTicks": {"55": 200}},
            {**state, "retiredAtTicks": {"99": 200}},
            {"tracked": state["tracked"], "retiredPids": []},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(launch.LaunchError, "invalid_old_backend_tracking"):
                launch.backend_tracker(self.config, value)

    def test_new_backend_child_in_wrapper_blocks_before_launch_reservation(self):
        self.old_backend()
        child = process(56, 60, self.files["node.exe"], 55)
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend}])
        invoke = runtime.invoke_package
        def race(config, request_path):
            runtime.last = {55: self.backend, 56: child}
            return invoke(config, request_path)
        runtime.invoke_package = race
        with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
            self.arm(runtime)
        self.assertEqual(runtime.launches, [])
        result = launch.load(launch.result_path(runtime.invocations[0]))
        self.assertEqual(result["error"]["code"], "old_backend_descendants_still_present")
        self.assertEqual({item["pid"] for item in result["backendTracking"]["tracked"]}, {55, 56})
        self.assertFalse(runtime.invocations[0].with_name("desktop-launch-reservation.json").exists())

    def test_backend_child_during_loaded_query_or_final_snapshot_blocks(self):
        self.old_backend()
        child = process(56, 60, self.files["node.exe"], 55)
        for at_snapshot in (3, 4):  # Post-query verification, then the last wrapper gate.
            with self.subTest(at_snapshot=at_snapshot):
                self.config["stateDir"] = str(self.root / ("race-" + str(at_snapshot))); self.save()
                runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend}])
                original_invoke = runtime.invoke_package
                def race(config, request_path):
                    observations = [0]
                    def snapshot():
                        observations[0] += 1
                        return {55: self.backend, **({56: child} if observations[0] >= at_snapshot else {})}
                    runtime.snapshot = snapshot
                    return original_invoke(config, request_path)
                runtime.invoke_package = race
                with self.assertRaisesRegex(launch.LaunchError, "package_wrapper_refused"):
                    self.arm(runtime)
                self.assertEqual(runtime.launches, [])
                self.assertFalse(runtime.invocations[0].with_name("desktop-launch-reservation.json").exists())

    def test_backend_launch_requires_new_complete_tracking_evidence(self):
        self.old_backend()
        runtime = MockRuntime(self.config, [{55: self.backend}])
        with self.assertRaisesRegex(launch.LaunchError, "old_backend_tracking_required"):
            launch.invoke_once(self.config, self.config_path, "launch", [exact(self.old)], runtime)
        self.assertFalse(Path(self.config["stateDir"]).exists())
        directory = Path(self.config["stateDir"]) / "launch"; directory.mkdir(parents=True)
        launch.exclusive(directory.parent / "arm-reservation.json", {"configSha256": launch.sha(self.config_path)})
        request = {"schema": "codex-desktop-owned-launch-request-v1", "requestId": "a" * 32,
                   "configPath": str(self.config_path), "configSha256": launch.sha(self.config_path),
                   "role": "launch", "tracked": [exact(self.old)], "createdAt": launch.utc()}
        request_path = directory / "request.json"
        request_path.write_text(json.dumps(request))
        with self.assertRaisesRegex(launch.LaunchError, "old_backend_tracking_required"):
            launch.run_wrapper(request_path, runtime)
        request["backendTracking"] = None
        request_path.write_text(json.dumps(request))
        with self.assertRaisesRegex(launch.LaunchError, "invalid_old_backend_tracking"):
            launch.run_wrapper(request_path, runtime)
        request["backendTracking"] = launch.backend_tracker(self.config).checkpoint()
        request_path.write_text(json.dumps(request))
        with self.assertRaisesRegex(launch.LaunchError, "initial_old_backend_tracking_required"):
            launch.run_wrapper(request_path, runtime)
        self.assertFalse(request_path.with_name("wrapper-reservation.json").exists())
        self.assertEqual(runtime.launches, [])

    def test_wrapper_cannot_drop_original_backend_descendant_identity(self):
        self.old_backend()
        child = process(56, 60, self.files["node.exe"], 55)
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend, 56: child}, {55: self.backend}])
        invoke = runtime.invoke_package
        caught = []
        def drop(config, request_path):
            request = launch.load(request_path)
            request["backendTracking"]["tracked"] = [exact(self.backend)]
            request_path.write_text(json.dumps(request))
            try:
                return invoke(config, request_path)
            except launch.LaunchError as error:
                caught.append(error.code)
                raise
        runtime.invoke_package = drop
        with self.assertRaises(launch.LaunchError): self.arm(runtime)
        self.assertEqual(caught, ["initial_old_backend_tracking_missing"])
        self.assertEqual(runtime.launches, [])

    def test_backend_timeout_persists_children_discovered_after_arm(self):
        self.old_backend(); self.config["oldBackendWaitSeconds"] = 2700; self.config["pollSeconds"] = 30; self.save()
        child = process(56, 60, self.files["node.exe"], 55)
        runtime = MockRuntime(self.config, [{10: self.old, 55: self.backend}, {55: self.backend, 56: child}])
        with self.assertRaisesRegex(launch.LaunchError, "old_backend_idle_deadline_no_launch"):
            self.arm(runtime)
        directory = Path(self.config["stateDir"])
        self.assertEqual(len(launch.load(directory / "arm-reservation.json")["initialBackendTracking"]["tracked"]), 1)
        for name in ("wait-status.json", "wait-outcome.json"):
            self.assertEqual({item["pid"] for item in launch.load(directory / name)["backendTracking"]["tracked"]}, {55, 56})
        self.assertEqual(runtime.invocations, [])

    def test_desktop_child_environment_only_changes_three_public_overrides(self):
        captured = {}
        class FakeProcess:
            pid = 123; _handle = 456
        def spawn(args, **kwargs): captured.update(args=args, **kwargs); return FakeProcess()
        runtime = object.__new__(launch.WindowsRuntime)
        with patch.object(launch.subprocess, "Popen", side_effect=spawn), patch.object(launch.subprocess, "CREATE_NO_WINDOW", 0, create=True), patch.object(runtime, "_handle_identity", return_value={"createdTicks": 789, "path": str(self.desktop)}), patch.dict(os.environ, {"CODEX_APP_SERVER_WS_URL": "fixture", "CODEX_APP_SERVER_FORCE_CLI": "fixture", "CODEX_CLI_PATH": "old", "OPAQUE_FIXTURE": "keep"}):
            runtime.create_desktop(self.config, self.manifest)
        self.assertNotIn("CODEX_APP_SERVER_WS_URL", captured["env"])
        self.assertNotIn("CODEX_APP_SERVER_FORCE_CLI", captured["env"])
        self.assertEqual(captured["env"]["CODEX_CLI_PATH"], self.manifest["executable"])
        self.assertEqual(captured["env"]["OPAQUE_FIXTURE"], "keep")
        self.assertFalse(captured["shell"])


if __name__ == "__main__":
    unittest.main()
