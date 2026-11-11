using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Siemens.Engineering;
#if TIA_API_CROSS_REFERENCE
using Siemens.Engineering.CrossReference;
#endif
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
#if TIA_API_BLOCK_INTERFACE
using Siemens.Engineering.SW.Blocks.Interface;
#endif
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;

[assembly: AssemblyTitle("TiaLiveReadCore")]
[assembly: AssemblyProduct("TIA Portal MCP Live Read Core")]
[assembly: AssemblyDescription("Attached-only Siemens TIA Portal V20 read/query and explicit navigation companion")]
[assembly: AssemblyCompany("Local TIA MCP")]
[assembly: AssemblyVersion("0.27.0.0")]
[assembly: AssemblyFileVersion("0.27.0.0")]
[assembly: AssemblyInformationalVersion("0.27.0")]

// TIA Portal V20 resident query core.
//
// Safety boundary:
// - Attaches only to an exact existing TIA process and exact already-open project of the build target's version.
// - Never opens, closes, saves, compiles, imports, downloads, goes online, or
//   changes an engineering object.
// - The only UI-state action is an explicit navigate_object request with
//   confirmNavigation=true, implemented with the fixed ShowInEditor APIs below.
// - Never disposes TiaPortalProcess. Disposing an attached TiaPortal object only
//   disconnects this additional Openness session.
internal static class TiaLiveReadCore
{
    private const int ProtocolVersion = 1;
    private const int MaxRequestBytes = 64 * 1024;
    private const int MaxResponseBytes = 40 * 1000 * 1000;
    private const int HandshakeTimeoutMs = 10000;
    // One instance serves the current request; one more listens so the next
    // client queues instead of finding no pipe between connections.
    private const int MaxPipeInstances = 2;
    private const int DefaultTimeoutMs = 60000;
    private const int MinTimeoutMs = 1000;
    private const int MaxTimeoutMs = 60000;
    private const int DefaultMaxXmlBytes = 15 * 1000 * 1000;
    private const int AbsoluteMaxXmlBytes = 25 * 1000 * 1000;
    private const int AbsoluteMaxSources = 1000;
    private const int AbsoluteMaxReferences = 10000;
    private const int AbsoluteMaxLocations = 20000;
    private const int AbsoluteMaxDepth = 30;
    private const int AbsoluteMaxInterfaceMembers = 5000;
    private const int InventoryTtlSeconds = 60;
    private const int SnapshotStagingMaxAgeHours = 24;
    private const string SnapshotStagingPrefix = ".tia-snapshot-staging-";
    private const string DefaultApiPath = @"C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20\Siemens.Engineering.dll";

    private static readonly DateTime CoreStartedUtc = DateTime.UtcNow;
    private static readonly Assembly CoreAssembly = Assembly.GetExecutingAssembly();
    private static readonly string CoreVersion = ReadInformationalVersion();
    private static readonly string CoreBinaryPath = CoreAssembly.Location;
    private static readonly string CoreBinarySha256 = TryReadFileSha256(CoreBinaryPath);
    private static readonly JavaScriptSerializer Json = CreateSerializer();
    private static readonly object SessionGate = new object();
    private static readonly HashSet<string> SnapshotInventoryTraversalErrors =
        new HashSet<string>(StringComparer.Ordinal);
    private static readonly HashSet<string> SnapshotInventorySoftwareKeys =
        new HashSet<string>(StringComparer.Ordinal);
    private static string _apiPath = DefaultApiPath;
    private static string[] _resolveDirectories = new string[0];
    private static string _pipeSecurityStatus = "not_initialized";
    private static int _idleTimeoutMs = 3600000;
    private static string _staleTempCleanupStatus = "not_run";
    private static int _staleTempDirectoriesRemoved;
    private static SessionState _session;
    private static bool _keepRunning = true;
    private static bool _snapshotInventoryAuditActive;

    [MTAThread]
    private static int Main(string[] args)
    {
        // Redirected JSON is consumed as UTF-8 by Node, independent of the Windows code page.
        ConfigureUtf8StandardOutput();
        string pipeName = BuildDefaultPipeName();
        bool selfTest = false;
        bool exportSnapshotCandidateV1 = false;
        bool snapshotCandidateContractV1 = false;
        int snapshotProcessId = 0;
        string snapshotProjectPath = null;
        string snapshotProcessStartTimeUtc = null;
        long? snapshotProcessStartUtcTicks = null;
        string snapshotOutputRoot = null;
        bool snapshotNoReuse = false;

        try
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--api" && i + 1 < args.Length) _apiPath = args[++i];
                else if (args[i] == "--pipe" && i + 1 < args.Length) pipeName = args[++i];
                else if (args[i] == "--serve") { }
                else if (args[i] == "--idle-timeout" && i + 1 < args.Length)
                {
                    int parsedIdle;
                    if (!Int32.TryParse(args[++i], out parsedIdle) || parsedIdle < 30000 || parsedIdle > 86400000)
                        throw new ProtocolException("invalid_argument", "--idle-timeout must be 30000..86400000 milliseconds.");
                    _idleTimeoutMs = parsedIdle;
                }
                else if (args[i] == "--self-test") selfTest = true;
                else if (args[i] == "--no-reuse") snapshotNoReuse = true;
                else if (args[i] == "--export-snapshot-candidate-v1") exportSnapshotCandidateV1 = true;
                else if (args[i] == "--snapshot-candidate-contract-v1") snapshotCandidateContractV1 = true;
                else if (args[i] == "--process-id" && i + 1 < args.Length)
                {
                    if (!Int32.TryParse(args[++i], out snapshotProcessId) || snapshotProcessId <= 0)
                        throw new ProtocolException("invalid_argument", "--process-id must be a positive integer.");
                }
                else if (args[i] == "--project-path" && i + 1 < args.Length)
                    snapshotProjectPath = args[++i];
                else if (args[i] == "--process-start-time-utc" && i + 1 < args.Length)
                    snapshotProcessStartTimeUtc = args[++i];
                else if (args[i] == "--process-start-utc-ticks" && i + 1 < args.Length)
                {
                    long parsedTicks;
                    if (!Int64.TryParse(args[++i], out parsedTicks) || parsedTicks <= 0)
                        throw new ProtocolException("invalid_argument", "--process-start-utc-ticks must be a positive 64-bit integer.");
                    snapshotProcessStartUtcTicks = parsedTicks;
                }
                else if ((args[i] == "--output" || args[i] == "--output-root") && i + 1 < args.Length)
                    snapshotOutputRoot = args[++i];
                else if (args[i] == "--help")
                {
                    Console.WriteLine(
                        "TiaLiveReadCore.exe [--api path] [--pipe name] [--self-test]\n" +
                        "TiaLiveReadCore.exe [--api path] --snapshot-candidate-contract-v1\n" +
                        "TiaLiveReadCore.exe --api path --export-snapshot-candidate-v1 --process-id PID " +
                        "--project-path project" + TiaNativeTarget.ProjectExtension + " (--process-start-time-utc ISO | --process-start-utc-ticks TICKS) " +
                        "--output-root directory [--no-reuse]");
                    return 0;
                }
                else
                {
                    Console.Error.WriteLine("Unknown or incomplete argument: " + args[i]);
                    return 2;
                }
            }

            int selectedModes =
                (selfTest ? 1 : 0) +
                (exportSnapshotCandidateV1 ? 1 : 0) +
                (snapshotCandidateContractV1 ? 1 : 0);
            if (selectedModes > 1)
                throw new ProtocolException("invalid_argument", "Self-test, snapshot contract probe, and snapshot candidate export are mutually exclusive.");
            if (snapshotCandidateContractV1)
            {
                if (snapshotProcessId != 0 ||
                    !String.IsNullOrWhiteSpace(snapshotProjectPath) ||
                    !String.IsNullOrWhiteSpace(snapshotProcessStartTimeUtc) ||
                    snapshotProcessStartUtcTicks.HasValue ||
                    !String.IsNullOrWhiteSpace(snapshotOutputRoot))
                {
                    throw new ProtocolException(
                        "invalid_argument",
                        "--snapshot-candidate-contract-v1 accepts no export/session/output arguments.");
                }
                Console.WriteLine(Serialize(SnapshotCandidateContractMap()));
                return 0;
            }
            if (!exportSnapshotCandidateV1) ValidatePipeName(pipeName);
            ConfigureAssemblyResolution(_apiPath);

            if (selfTest) return RunSelfTest();
            if (exportSnapshotCandidateV1)
            {
                try
                {
                    SnapshotCliOptions snapshotOptions = BuildSnapshotCliOptions(
                        snapshotProcessId,
                        snapshotProjectPath,
                        snapshotProcessStartTimeUtc,
                        snapshotProcessStartUtcTicks,
                        snapshotOutputRoot);
                    snapshotOptions.ReuseUnchanged = !snapshotNoReuse;
                    return RunSnapshotExport(snapshotOptions);
                }
                catch (Exception ex)
                {
                    Dictionary<string, object> failed = BasicResponse(
                        "snapshot-export",
                        false,
                        ex is ProtocolException
                            ? ((ProtocolException)ex).Status
                            : "snapshot_export_failed",
                        SafeError(ex));
                    failed["mode"] = "one_shot_export_snapshot";
                    failed["safety"] = SnapshotSafetyMap();
                    Console.WriteLine(Serialize(failed));
                    return 2;
                }
            }
            CleanupStaleTemporaryDirectories();

            bool created;
            string mutexName = @"Local\TiaLiveReadCore." + Sha256Hex(Encoding.UTF8.GetBytes(pipeName)).Substring(0, 24);
            using (Mutex singleton = new Mutex(false, mutexName, out created))
            {
                if (!created)
                {
                    Console.WriteLine(Serialize(BasicResponse(null, false, "already_running", "A resident core already owns this pipe name.")));
                    return 17;
                }

                Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs)
                {
                    // Do not make Openness calls on the console event thread.
                    eventArgs.Cancel = false;
                    _keepRunning = false;
                };

                // Keep one listening instance ready while a request is served, so a
                // concurrent client queues on the pipe instead of seeing ENOENT in the
                // gap between connections and launching a redundant core. Requests are
                // still handled strictly one at a time on this thread.
                NamedPipeServerStream next = CreatePipe(pipeName);
                try
                {
                    while (_keepRunning)
                    {
                        NamedPipeServerStream pipe = next;
                        next = null;
                        using (pipe)
                        {
                            bool connected;
                            try
                            {
                                connected = WaitForConnectionWithIdleTimeout(pipe, _idleTimeoutMs);
                            }
                            catch (IOException)
                            {
                                // A queued client may close before this instance is
                                // accepted (ERROR_NO_DATA). Drop only that instance.
                                next = CreatePipe(pipeName);
                                continue;
                            }
                            if (!connected)
                            {
                                _keepRunning = false;
                                break;
                            }
                            next = CreatePipe(pipeName);
                            HandlePipeConnection(pipe);
                        }
                    }
                }
                finally
                {
                    if (next != null) next.Dispose();
                }
            }

            DisconnectAttachedSession();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(SafeError(ex));
            return 1;
        }
    }

    private static void ConfigureUtf8StandardOutput()
    {
        // Console.OutputEncoding requires a console handle and throws IOException
        // when the resident core is launched detached (no console). Wrapping the
        // raw standard output stream works with and without a console.
        try
        {
            StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            writer.AutoFlush = true;
            Console.SetOut(TextWriter.Synchronized(writer));
        }
        catch
        {
            // Keep the default writer; the resident pipe protocol does not use stdout.
        }
        try
        {
            StreamWriter errorWriter = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
            errorWriter.AutoFlush = true;
            Console.SetError(TextWriter.Synchronized(errorWriter));
        }
        catch
        {
            // Keep the default error writer.
        }
    }

    private static JavaScriptSerializer CreateSerializer()
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        // The wire byte limit is enforced after serialization. Allow enough
        // character headroom for bounded XML plus bounded cross references so
        // an oversized result can be replaced by a small protocol envelope.
        serializer.MaxJsonLength = MaxResponseBytes * 2;
        serializer.RecursionLimit = 128;
        return serializer;
    }

    private static void HandlePipeConnection(Stream pipe)
    {
        Dictionary<string, object> request = null;
        string requestId = null;
        Timer watchdog = null;
        try
        {
            watchdog = new Timer(delegate(object state)
            {
                // A client that connects but never completes one bounded JSON
                // line must not hold the only serial pipe connection forever.
                try { Process.GetCurrentProcess().Kill(); }
                catch { Environment.FailFast("TiaLiveReadCore handshake watchdog expired."); }
            }, null, HandshakeTimeoutMs, Timeout.Infinite);

            string requestLine = ReadBoundedLine(pipe, MaxRequestBytes);
            request = Json.DeserializeObject(requestLine) as Dictionary<string, object>;
            if (request == null) throw new ProtocolException("invalid_request", "The request must be one JSON object.");
            requestId = GetString(request, "requestId", GetString(request, "id", null));

            int timeoutMs = GetRequestTimeoutMs(request);
            // A request may wait queued on the second pipe instance. If its client
            // deadline already passed, the client has given up: do not run it.
            long deadlineUnixMs = GetLong(request, "deadlineUnixMs", 0);
            if (deadlineUnixMs > 0 && UnixMillisecondsNow() > deadlineUnixMs)
                throw new ProtocolException("deadline_expired", "The client deadline passed while the request was queued; it was not executed.");
            // Replace only the callback behavior after the line is complete by
            // recreating the timer; a request timeout has different semantics.
            watchdog.Dispose();
            watchdog = new Timer(delegate(object state)
            {
                // A blocked Openness call cannot be safely aborted. Terminate this
                // helper process only; the attached Portal process/project is not owned.
                try { Process.GetCurrentProcess().Kill(); }
                catch { Environment.FailFast("TiaLiveReadCore request watchdog expired."); }
            }, null, timeoutMs, Timeout.Infinite);

            Dictionary<string, object> response = Dispatch(request, requestId);
            WriteBoundedResponse(pipe, response, requestId);
        }
        catch (ProtocolException ex)
        {
            WriteBoundedResponse(pipe, ProtocolErrorResponse(requestId, ex), requestId);
        }
        catch (Exception ex)
        {
            WriteBoundedResponse(pipe, BasicResponse(requestId, false, "error", SafeError(ex)), requestId);
        }
        finally
        {
            if (watchdog != null) watchdog.Dispose();
        }
    }

    private static Dictionary<string, object> Dispatch(Dictionary<string, object> request, string requestId)
    {
        if (GetInt(request, "protocolVersion", 0) != ProtocolVersion)
            throw new ProtocolException("protocol_mismatch", "protocolVersion must equal 1.");
        string operation = GetString(request, "operation", GetString(request, "op", ""));
        operation = NormalizeOperation(operation);
        if (operation == "ping") return HandlePing(requestId);
        if (operation == "verify_session") return HandleVerifySession(request, requestId);
        if (operation == "export_blocks_for_signature") return HandleSignatureExport(request, requestId);
        if (operation == "attach_session") return HandleAttachSession(request, requestId);
        if (operation == "query_object") return HandleQueryObject(request, requestId);
        if (operation == "search_objects") return HandleSearchObjects(request, requestId);
        if (operation == "read_engineering") return HandleReadEngineering(request, requestId);
        if (operation == "list_hmi_targets" || operation == "read_hmi") return HandleHmi(request, requestId, operation == "read_hmi");
        if (operation == "navigate_object") return HandleNavigateObject(request, requestId);
        if (operation == "shutdown") return HandleShutdown(requestId);
        throw new ProtocolException("unsupported_operation", "Supported operations: ping, attach_session, query_object, read_engineering, navigate_object, shutdown.");
    }

    private static Dictionary<string, object> HandleVerifySession(Dictionary<string, object> request, string requestId)
    {
        try {
            SessionUse use = EnsureAttachedSession(ParseSessionRequest(PreparedVerificationRequest(request)), false, null, false, false);
            Dictionary<string, object> response = BasicResponse(requestId, true, "session_verified", null);
            response["session"] = BuildSessionMap(use.Session, true, true);
            return response;
        } catch (Exception ex) {
            lock (SessionGate) { DisconnectAttachedSession(); }
            return BasicResponse(requestId, false, "session_not_prepared", SafeError(ex));
        }
    }

    // Bootstrap only the identity of an already prepared connection. EnsureAttachedSession
    // must still verify both OS start time and TiaPortal.GetProcess.ProjectPath before returning it.
    private static Dictionary<string, object> PreparedVerificationRequest(Dictionary<string, object> request)
    {
        lock (SessionGate) {
            if (_session == null || GetInt(request, "processId", 0) != _session.ProcessId)
                throw new ProtocolException("session_not_prepared", "No prepared session for the requested PID.");
            string requestedPath = GetString(request, "projectPath", _session.CanonicalProjectPath);
            if (!PathEquals(requestedPath, _session.CanonicalProjectPath))
                throw new ProtocolException("session_not_prepared", "Requested project differs from the prepared session.");
            Dictionary<string, object> verified = new Dictionary<string, object>(request);
            verified["projectPath"] = requestedPath;
            if (!verified.ContainsKey("processStartTimeUtc") && !verified.ContainsKey("expectedProcessStartUtcTicks"))
                verified["processStartTimeUtc"] = Utc(new DateTime(_session.ProcessStartUtcTicks, DateTimeKind.Utc));
            return verified;
        }
    }

    private static Dictionary<string, object> HandleSignatureExport(Dictionary<string, object> request, string requestId)
    {
        SessionRequest identity = ParseSessionRequest(request);
        object raw;
        object[] targets = request.TryGetValue("targets", out raw) ? raw as object[] : null;
        if (targets == null || targets.Length < 1 || targets.Length > 100)
            throw new ProtocolException("invalid_targets", "Provide between 1 and 100 exact block targets.");
        string directory = Path.Combine(TemporaryRoot(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try {
            List<object> result = null;
            SessionUse use = null;
            RetrySignatureExport(delegate {
                // Imported blocks are new objects: resolve from a fresh inventory on every attempt.
                use = RefreshSignatureSession(identity);
                result = new List<object>();
                for (int i = 0; i < targets.Length; i++) {
                    Dictionary<string, object> target = targets[i] as Dictionary<string, object>;
                    if (target == null) throw new ProtocolException("invalid_targets", "Invalid block target.");
                    string kind = GetString(target, "kind", ""), name = GetString(target, "name", ""), number = GetString(target, "number", "");
                    ObjectRecord selected = FindSignatureTarget(use.Session.Inventory, kind, name, number);
                    string file = Path.Combine(directory, i.ToString(CultureInfo.InvariantCulture) + ".xml");
                    if (File.Exists(file)) File.Delete(file);
                    ((PlcBlock)selected.Value).Export(new FileInfo(file), ExportOptions.WithDefaults);
                    result.Add(Map("kind", kind, "name", name, "number", number, "path", file,
                        "sha256", FileSha256(file), "softwarePath", selected.SoftwarePath, "groupPath", selected.GroupPath));
                }
            });
            EnsureAttachedSession(identity, false, null, false, false);
            Dictionary<string, object> response = BasicResponse(requestId, true, "blocks_exported", null);
            response["session"] = BuildSessionMap(use.Session, true, false);
            response["directory"] = directory;
            response["items"] = result;
            return response;
        } catch {
            try { Directory.Delete(directory, true); } catch { }
            throw;
        }
    }

    private static bool _signatureInventoryActive;

    private static SessionUse RefreshSignatureSession(SessionRequest identity)
    {
        _signatureInventoryActive = true;
        try { return EnsureAttachedSession(identity, true, ObjectKind.Block, true, false); }
        finally { _signatureInventoryActive = false; }
    }

    private static void RetrySignatureExport(Action action)
    {
        for (int attempt = 0; attempt < 2; attempt++) {
            try { action(); return; }
            catch (ProtocolException) { throw; }
            catch { if (attempt == 1) throw; }
        }
    }

    private static ObjectRecord FindSignatureTarget(List<ObjectRecord> inventory, string kind, string name, string number)
    {
        List<ObjectRecord> matches = new List<ObjectRecord>();
        foreach (ObjectRecord record in inventory)
            if (record.Kind == ObjectKind.Block && !record.IsSystemBlock && record.Name == name &&
                record.BlockKind == kind && record.Number.HasValue &&
                record.Number.Value.ToString(CultureInfo.InvariantCulture) == number) matches.Add(record);
        if (matches.Count != 1)
            throw new ProtocolException("target_ambiguous_or_missing", "Target block is absent or ambiguous across PLCs/groups.");
        return matches[0];
    }

    private static string NormalizeOperation(string operation)
    {
        if (String.Equals(operation, "queryObject", StringComparison.Ordinal)) return "query_object";
        if (String.Equals(operation, "navigateObject", StringComparison.Ordinal)) return "navigate_object";
        if (String.Equals(operation, "attachSession", StringComparison.Ordinal)) return "attach_session";
        return operation == null ? "" : operation.Trim().ToLowerInvariant();
    }

    private static Dictionary<string, object> HandlePing(string requestId)
    {
        Dictionary<string, object> response = BasicResponse(requestId, true, "ready", null);
        response["core"] = Map(
            "processId", Process.GetCurrentProcess().Id,
            "version", CoreVersion,
            "startedAtUtc", Utc(CoreStartedUtc),
            "uptimeMs", (long)(DateTime.UtcNow - CoreStartedUtc).TotalMilliseconds,
            "architecture", Environment.Is64BitProcess ? "x64" : "not_x64",
            "pipeSecurity", _pipeSecurityStatus,
            "staleTempCleanup", _staleTempCleanupStatus,
            "staleTempDirectoriesRemoved", _staleTempDirectoriesRemoved,
            "resident", true,
            "serialRequests", true,
            "binaryPath", CoreBinaryPath,
            "binarySha256", CoreBinarySha256,
            "apiPath", _apiPath,
            "apiAssemblyVersion", ReadApiAssemblyVersion());
        response["safety"] = SafetyMap();
        lock (SessionGate)
        {
            response["session"] = _session == null ? null : BuildSessionMap(_session, true, true);
        }
        return response;
    }

    private static Dictionary<string, object> HandleAttachSession(
        Dictionary<string, object> request,
        string requestId)
    {
        Stopwatch total = Stopwatch.StartNew();
        SessionRequest sessionRequest = ParseSessionRequest(request);
        SessionUse sessionUse = EnsureAttachedSession(sessionRequest, false, null, false, true);
        Dictionary<string, object> response = BasicResponse(requestId, true, "attached", null);
        response["session"] = BuildSessionMap(sessionUse.Session, sessionUse.SessionReused, true);
        response["timings"] = Map(
            "attach", sessionUse.AttachMilliseconds,
            "identityVerification", total.ElapsedMilliseconds - sessionUse.AttachMilliseconds,
            "inventory", 0,
            "total", total.ElapsedMilliseconds);
        response["safety"] = SafetyMap();
        response["provenance"] = Map(
            "operation", "attach_existing_exact_session",
            "inventoryBuilt", false,
            "projectMutation", false,
            "plcAccessed", false);
        return response;
    }

    private static Dictionary<string, object> HandleShutdown(string requestId)
    {
        DisconnectAttachedSession();
        _keepRunning = false;
        Dictionary<string, object> response = BasicResponse(requestId, true, "shutting_down", null);
        response["session"] = null;
        response["provenance"] = Map(
            "operation", "resident_core_control",
            "projectMutation", false,
            "portalProcessDisposed", false);
        return response;
    }

    private static SnapshotCliOptions BuildSnapshotCliOptions(
        int processId,
        string projectPath,
        string processStartTimeUtc,
        long? processStartUtcTicks,
        string outputRoot)
    {
        if (processId <= 0)
            throw new ProtocolException("invalid_argument", "--process-id is required for --export-snapshot-candidate-v1.");
        if (String.IsNullOrWhiteSpace(projectPath))
            throw new ProtocolException("invalid_argument", "--project-path is required for --export-snapshot-candidate-v1.");
        if (String.IsNullOrWhiteSpace(outputRoot))
            throw new ProtocolException("invalid_argument", "--output-root is required for --export-snapshot-candidate-v1.");
        if (!String.IsNullOrWhiteSpace(processStartTimeUtc) && processStartUtcTicks.HasValue)
            throw new ProtocolException("invalid_argument", "Specify exactly one of --process-start-time-utc or --process-start-utc-ticks.");
        if (String.IsNullOrWhiteSpace(processStartTimeUtc) && !processStartUtcTicks.HasValue)
            throw new ProtocolException("invalid_argument", "An exact process start identity is required.");

        Dictionary<string, object> sessionMap = Map(
            "processId", processId,
            "projectPath", projectPath);
        if (processStartUtcTicks.HasValue)
            sessionMap["expectedProcessStartUtcTicks"] = processStartUtcTicks.Value;
        else
            sessionMap["processStartTimeUtc"] = processStartTimeUtc;

        SessionRequest request = ParseSessionRequest(Map("session", sessionMap));
        return new SnapshotCliOptions(request, CanonicalSnapshotOutputRoot(outputRoot));
    }

    private static Dictionary<string, object> SnapshotCandidateContractMap()
    {
        return Map(
            "contractVersion", 1,
            "candidateOnly", true,
            "currentPointerWrittenByNative", false);
    }

    private static int RunSnapshotExport(SnapshotCliOptions options)
    {
        string stagingDirectory = null;
        Dictionary<string, object> consistency = null;
        Dictionary<string, object> staleStagingCleanup = null;
        PreviousSnapshotPointerState previousCurrent = null;
        DateTime startedUtc = DateTime.UtcNow;
        try
        {
            Directory.CreateDirectory(options.OutputRoot);
            EnsureSnapshotPlainDirectory(
                options.OutputRoot,
                "invalid_output_root",
                "The snapshot output root");
            string currentPointerPath = Path.Combine(options.OutputRoot, "current.json");
            previousCurrent = ReadPreviousSnapshotPointerStrict(
                currentPointerPath,
                options.OutputRoot);
            string previousPublishedPath = previousCurrent.PublishedPath;
            staleStagingCleanup = CleanupStaleSnapshotStaging(options.OutputRoot);
            stagingDirectory = Path.Combine(
                options.OutputRoot,
                SnapshotStagingPrefix + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stagingDirectory);
            EnsureSnapshotOwnedStagingDirectory(options.OutputRoot, stagingDirectory);
            Directory.CreateDirectory(Path.Combine(stagingDirectory, "objects"));
            EnsureSnapshotTreeHasNoReparsePoints(stagingDirectory);

            Stopwatch phase = Stopwatch.StartNew();
            Dictionary<string, object> timingsMs = new Dictionary<string, object>(StringComparer.Ordinal);
            SessionUse sessionUse = EnsureAttachedSession(
                options.Session,
                true,
                null,
                false,
                true);
            SessionState session = sessionUse.Session;
            timingsMs["attach"] = phase.ElapsedMilliseconds; phase.Restart();
            VerifyExactSnapshotSession(session, options.Session, "before_enumeration");
            BuildSnapshotExportInventory(session);
            timingsMs["inventoryBefore"] = phase.ElapsedMilliseconds; phase.Restart();
            VerifyExactSnapshotSession(
                session,
                options.Session,
                "after_enumeration_before_export");

            bool projectModifiedBefore = ReadProjectModified(session, "before_enumeration");
            SnapshotProjectFileState projectFileBefore =
                CaptureSnapshotProjectFileState(session.CanonicalProjectPath);
            SnapshotInventoryState inventoryBefore = CaptureSnapshotInventory(session.Inventory);
            List<ObjectRecord> exportRecords = SnapshotExportRecords(session.Inventory);
            timingsMs["fingerprintsBefore"] = phase.ElapsedMilliseconds; phase.Restart();
            SnapshotReuseSource reuseSource = LoadSnapshotReuseSource(previousCurrent, session.CanonicalProjectPath);
            SnapshotObjectTimings objectTimings = new SnapshotObjectTimings();
            Dictionary<ObjectRecord, Dictionary<string, object>> prepared = new Dictionary<ObjectRecord, Dictionary<string, object>>();
            Dictionary<ObjectRecord, string> dependencyHashes = new Dictionary<ObjectRecord, string>();
            bool oldFilesValid = true;
            for (int i = 0; i < exportRecords.Count; i++) {
                ObjectRecord record = exportRecords[i];
                string key = Sha256Hex(Encoding.UTF8.GetBytes(SnapshotRecordKey(record)));
                Dictionary<string, object> previous = null;
                if (reuseSource != null) reuseSource.EntriesByRecordKey.TryGetValue(key, out previous);
                bool unchanged = options.ReuseUnchanged && SnapshotEntryReusable(previous,
                    GetString(BuildSnapshotModifiedStateMap(record), "fingerprint", null), true, DateTime.UtcNow);
                if (record.Kind != ObjectKind.TagTable && unchanged) {
                    try { dependencyHashes[record] = PreviousDependencyHash(record, previous, reuseSource); }
                    catch { oldFilesValid = false; unchanged = false; }
                }
                // The first export remains the installed-product/export-format canary.
                if (!unchanged || i == 0) {
                    Dictionary<string, object> entry = ExportSnapshotObject(record, i + 1, stagingDirectory, null, false, objectTimings);
                    prepared[record] = entry;
                    SetDependencyHash(record, entry, stagingDirectory, dependencyHashes);
                }
            }
            string dependencyStamp = SnapshotDependencyStamp(session, exportRecords, dependencyHashes);
            bool dependenciesUnchanged = options.ReuseUnchanged && oldFilesValid && reuseSource != null &&
                dependencyStamp != null && String.Equals(reuseSource.DependencyStamp, dependencyStamp, StringComparison.Ordinal);
            string canaryResult = null;
            if (dependenciesUnchanged && exportRecords.Count > 0) {
                canaryResult = SnapshotCanaryMatches(prepared[exportRecords[0]], stagingDirectory, reuseSource) ? "matches" : "differs";
                if (canaryResult != "matches") dependenciesUnchanged = false;
            }
            timingsMs["dependencyStamp"] = phase.ElapsedMilliseconds; phase.Restart();

            List<object> objectEntries = new List<object>();
            List<string> contentFingerprintLines = new List<string>();
            int exportedCount = 0;
            int exportErrorCount = 0;
            int reusedCount = 0;
            int ordinal = 0;
            foreach (ObjectRecord record in exportRecords)
            {
                ordinal++;
                Dictionary<string, object> entry;
                if (!prepared.TryGetValue(record, out entry))
                    entry = ExportSnapshotObject(record, ordinal, stagingDirectory, reuseSource, dependenciesUnchanged, objectTimings);
                SetDependencyHash(record, entry, stagingDirectory, dependencyHashes);
                objectEntries.Add(entry);
                if (GetBool(entry, "success", false)) exportedCount++;
                else exportErrorCount++;
                if (GetString(entry, "reusedFrom", null) != null) reusedCount++;
                contentFingerprintLines.Add(
                    FingerprintField(GetString(entry, "relativePath", "")) +
                    FingerprintField(GetString(entry, "sha256", "")) +
                    FingerprintField(GetString(entry, "status", "")) +
                    FingerprintField(GetString(entry, "error", "")));
            }
            dependencyStamp = SnapshotDependencyStamp(session, exportRecords, dependencyHashes);
            contentFingerprintLines.Sort(StringComparer.Ordinal);
            string contentFingerprint = Sha256Hex(Encoding.UTF8.GetBytes(
                String.Join("\n", contentFingerprintLines.ToArray())));

            timingsMs["objects"] = phase.ElapsedMilliseconds; phase.Restart();
            timingsMs["objectState"] = objectTimings.Milliseconds(objectTimings.State);
            timingsMs["objectDirectories"] = objectTimings.Milliseconds(objectTimings.Directories);
            timingsMs["objectReuseCopy"] = objectTimings.Milliseconds(objectTimings.ReuseCopy);
            timingsMs["objectFreshExport"] = objectTimings.Milliseconds(objectTimings.FreshExport);
            VerifyExactSnapshotSession(session, options.Session, "after_export_before_inventory");
            BuildSnapshotExportInventory(session);
            timingsMs["inventoryAfter"] = phase.ElapsedMilliseconds; phase.Restart();
            SnapshotInventoryState inventoryAfter = CaptureSnapshotInventory(session.Inventory);
            timingsMs["fingerprintsAfter"] = phase.ElapsedMilliseconds; phase.Restart();
            bool projectModifiedAfter = ReadProjectModified(session, "after_inventory");
            SnapshotProjectFileState projectFileAfter =
                CaptureSnapshotProjectFileState(session.CanonicalProjectPath);
            VerifyExactSnapshotSession(session, options.Session, "after_inventory");

            bool inventoryIdentityMatches = String.Equals(
                inventoryBefore.IdentityFingerprint,
                inventoryAfter.IdentityFingerprint,
                StringComparison.Ordinal);
            bool modifiedStateMatches = String.Equals(
                inventoryBefore.ModifiedStateFingerprint,
                inventoryAfter.ModifiedStateFingerprint,
                StringComparison.Ordinal);
            bool plcSoftwareIdentityMatches =
                inventoryBefore.PlcSoftwareCount == inventoryAfter.PlcSoftwareCount &&
                String.Equals(
                    inventoryBefore.PlcSoftwareIdentityFingerprint,
                    inventoryAfter.PlcSoftwareIdentityFingerprint,
                    StringComparison.Ordinal);
            bool inventoryTraversalComplete =
                inventoryBefore.TraversalErrorCount == 0 &&
                inventoryAfter.TraversalErrorCount == 0;
            bool projectModifiedStateMatches =
                projectModifiedBefore == projectModifiedAfter;
            bool projectFileStateMatches =
                projectFileBefore.EqualsState(projectFileAfter);
            bool consistent =
                inventoryIdentityMatches &&
                modifiedStateMatches &&
                plcSoftwareIdentityMatches &&
                inventoryTraversalComplete &&
                projectModifiedStateMatches &&
                projectFileStateMatches;
            bool publishAllowed = SnapshotPublishAllowed(
                consistent,
                exportErrorCount);

            consistency = Map(
                "consistent", consistent,
                "inventoryIdentityMatches", inventoryIdentityMatches,
                "modifiedStateMatches", modifiedStateMatches,
                "plcSoftwareIdentityMatches", plcSoftwareIdentityMatches,
                "inventoryTraversalComplete", inventoryTraversalComplete,
                "projectModifiedStateMatches", projectModifiedStateMatches,
                "projectFileStateMatches", projectFileStateMatches,
                "processIdentityVerifiedBeforeAndAfter", true,
                "publishAllowed", publishAllowed);

            string status = !consistent
                ? "snapshot_inconsistent"
                : exportErrorCount == 0
                    ? "consistent_complete"
                    : "snapshot_export_incomplete";
            bool complete = publishAllowed;
            DateTime completedUtc = DateTime.UtcNow;
            string snapshotId =
                completedUtc.ToString("yyyyMMddTHHmmssfffffffZ", CultureInfo.InvariantCulture) +
                "-" + contentFingerprint.Substring(0, 12);
            string relativePublishedPath = "snapshots/" + snapshotId;

            Dictionary<string, object> manifest = Map(
                "schemaVersion", "1.0",
                "snapshotKind", "tia_openness_full_plc_snapshot",
                "status", status,
                "complete", complete,
                "createdAtUtc", Utc(startedUtc),
                "completedAtUtc", Utc(completedUtc),
                "snapshotId", snapshotId,
                "publishedRelativePath", relativePublishedPath,
                "publicationState", "candidate_not_current",
                "previousPublishedPath", previousPublishedPath,
                "staleStagingCleanup", staleStagingCleanup,
                "project", BuildSnapshotProjectMap(
                    session,
                    projectModifiedBefore,
                    projectModifiedAfter,
                    projectFileBefore,
                    projectFileAfter),
                "openness", Map(
                    "api", "Siemens TIA Portal Openness " + TiaNativeTarget.PortalVersion + " public API",
                    "apiAssemblyPath", _apiPath,
                    "apiAssemblyVersion", ReadApiAssemblyVersion(),
                    "attachCount", 1,
                    "exportOptions", "ExportOptions.WithDefaults",
                    "projectMutation", false,
                    "plcAccessed", false),
                "inventory", Map(
                    "before", inventoryBefore.ToMap(),
                    "after", inventoryAfter.ToMap()),
                "consistency", consistency,
                "objects", objectEntries,
                "reuse", Map(
                    "mode", !options.ReuseUnchanged ? "full_requested" : reuseSource == null
                        ? "full_no_previous"
                        : dependenciesUnchanged ? "incremental"
                            : canaryResult == "differs" ? "full_export_header_changed" : "full_dependencies_changed",
                    "dependencyStamp", dependencyStamp,
                    "dependencyStampMode", dependencyStamp == null ? "unavailable" : "content_v3",
                    "canary", canaryResult,
                    "maxReuseAgeHours", SnapshotMaxReuseAgeHours,
                    "fromSnapshotId", reuseSource == null ? null : reuseSource.SnapshotId,
                    "reusedCount", reusedCount,
                    "freshExportCount", exportedCount - reusedCount,
                    "timingsMs", timingsMs),
                "summary", BuildSnapshotSummary(
                    inventoryBefore,
                    exportRecords.Count,
                    exportedCount,
                    exportErrorCount,
                    contentFingerprint),
                "safety", SnapshotSafetyMap());

            ValidateSnapshotManifestContract(manifest);
            string stagedManifestPath = Path.Combine(stagingDirectory, "manifest.json");
            WriteJsonFile(stagedManifestPath, manifest);

            if (!publishAllowed)
            {
                bool incompleteExport = consistent && exportErrorCount > 0;
                Dictionary<string, object> failed = BasicResponse(
                    "snapshot-export",
                    false,
                    incompleteExport
                        ? "snapshot_export_incomplete"
                        : "snapshot_inconsistent",
                    incompleteExport
                        ? "One or more engineering objects failed official Openness export. The previous complete snapshot and current.json were preserved."
                        : "The project identity, inventory, object modification state, or " + TiaNativeTarget.ProjectExtension + " file state changed during export. No snapshot was published.");
                failed["mode"] = "one_shot_export_snapshot";
                failed["consistency"] = consistency;
                failed["summary"] = manifest["summary"];
                failed["staleStagingCleanup"] = staleStagingCleanup;
                if (incompleteExport)
                    failed["exportErrors"] = BuildSnapshotExportErrorReport(objectEntries);
                failed["snapshot"] = previousCurrent.ToResponseMap();
                failed["safety"] = SnapshotSafetyMap();
                Console.WriteLine(Serialize(failed));
                return incompleteExport ? 21 : 20;
            }

            EnsureSnapshotPlainDirectory(
                options.OutputRoot,
                "invalid_output_root",
                "The snapshot output root");
            EnsureSnapshotOwnedStagingDirectory(options.OutputRoot, stagingDirectory);
            EnsureSnapshotTreeHasNoReparsePoints(stagingDirectory);
            string snapshotsDirectory = EnsureSnapshotDirectChildDirectory(
                options.OutputRoot,
                "snapshots");
            string publishedDirectory = Path.Combine(snapshotsDirectory, snapshotId);
            if (Directory.Exists(publishedDirectory) || File.Exists(publishedDirectory))
                throw new IOException("The immutable snapshot destination already exists: " + publishedDirectory);
            Directory.Move(stagingDirectory, publishedDirectory);
            stagingDirectory = null;
            EnsureSnapshotTreeHasNoReparsePoints(publishedDirectory);

            string manifestPath = Path.Combine(publishedDirectory, "manifest.json");
            string manifestSha256 = FileSha256(manifestPath);

            Dictionary<string, object> response = BasicResponse(
                "snapshot-export",
                true,
                status,
                null);
            response["mode"] = "one_shot_export_snapshot";
            response["snapshot"] = Map(
                "snapshotId", snapshotId,
                "publishedPath", publishedDirectory,
                "manifestPath", manifestPath,
                "currentPointerPath", currentPointerPath,
                "previousPublishedPath", previousPublishedPath,
                "previousCurrentExists", previousCurrent.Exists,
                "previousCurrentSnapshotId", previousCurrent.SnapshotId,
                "previousCurrentManifestSha256", previousCurrent.ManifestSha256,
                "manifestSha256", manifestSha256,
                "complete", complete,
                "publicationState", "candidate_not_current",
                "currentPointerUpdated", false,
                "exportedCount", exportedCount,
                "reusedCount", reusedCount,
                "errorCount", exportErrorCount);
            response["reuse"] = manifest["reuse"];
            response["consistency"] = consistency;
            response["staleStagingCleanup"] = staleStagingCleanup;
            response["safety"] = SnapshotSafetyMap();
            Console.WriteLine(Serialize(response));
            return 0;
        }
        catch (Exception ex)
        {
            Dictionary<string, object> failed = BasicResponse(
                "snapshot-export",
                false,
                ex is ProtocolException ? ((ProtocolException)ex).Status : "snapshot_export_failed",
                SafeError(ex));
            failed["mode"] = "one_shot_export_snapshot";
            ProtocolException protocolError = ex as ProtocolException;
            if (protocolError != null && protocolError.Details != null)
                failed["diagnostics"] = protocolError.Details;
            if (consistency != null) failed["consistency"] = consistency;
            if (staleStagingCleanup != null)
                failed["staleStagingCleanup"] = staleStagingCleanup;
            if (previousCurrent != null)
                failed["snapshot"] = previousCurrent.ToResponseMap();
            failed["safety"] = SnapshotSafetyMap();
            Console.WriteLine(Serialize(failed));
            return 1;
        }
        finally
        {
            DisconnectAttachedSession();
            if (!String.IsNullOrWhiteSpace(stagingDirectory))
                DeleteOwnedSnapshotStaging(options.OutputRoot, stagingDirectory);
        }
    }

    private static void VerifyExactSnapshotSession(
        SessionState session,
        SessionRequest requested,
        string phase)
    {
        if (session == null || session.Portal == null || session.Project == null)
            throw new ProtocolException("session_mismatch", "The attached session is unavailable at " + phase + ".");
        long processStartTicks = GetProcessStartUtcTicks(requested.ProcessId);
        if (processStartTicks != session.ProcessStartUtcTicks ||
            processStartTicks != requested.ExpectedProcessStartUtcTicks.Value)
        {
            throw new ProtocolException("session_mismatch", "The TIA OS process identity changed at " + phase + ".");
        }

        TiaPortalProcess descriptor = TiaPortal.GetProcess(requested.ProcessId, 10000);
        if (descriptor == null)
            throw new ProtocolException("process_not_found", "The exact TIA process disappeared at " + phase + ".");
        string descriptorPath = descriptor.ProjectPath == null
            ? null
            : CanonicalProjectPath(descriptor.ProjectPath.FullName, false);
        if (String.IsNullOrEmpty(descriptorPath) ||
            !PathEquals(descriptorPath, session.CanonicalProjectPath))
        {
            throw ProjectMismatch(phase, requested.ProcessId, session.CanonicalProjectPath, descriptorPath, null);
        }

        string attachedPath = CanonicalProjectPath(session.Project.Path.FullName, false);
        if (!PathEquals(attachedPath, session.CanonicalProjectPath))
            throw ProjectMismatch(phase, requested.ProcessId, session.CanonicalProjectPath, descriptorPath, new List<string> { attachedPath }, false);
        int exactProjectCount = 0;
        List<string> observedPaths = new List<string>();
        foreach (Project project in session.Portal.Projects)
        {
            string projectPath = CanonicalProjectPath(project.Path.FullName, false);
            observedPaths.Add(projectPath);
            if (PathEquals(projectPath, session.CanonicalProjectPath))
                exactProjectCount++;
        }
        if (exactProjectCount != 1)
            throw ProjectMismatch(phase, requested.ProcessId, session.CanonicalProjectPath, descriptorPath, observedPaths);
        session.LastVerifiedUtc = DateTime.UtcNow;
    }

    private static bool ReadProjectModified(SessionState session, string phase)
    {
        try { return session.Project.IsModified; }
        catch (Exception ex)
        {
            throw new ProtocolException(
                "snapshot_consistency_unavailable",
                "Project.IsModified could not be read at " + phase + ": " + SafeError(ex));
        }
    }

    private static SnapshotProjectFileState CaptureSnapshotProjectFileState(string projectPath)
    {
        FileInfo file = new FileInfo(projectPath);
        file.Refresh();
        if (!file.Exists)
            throw new ProtocolException("project_not_found", "The canonical " + TiaNativeTarget.ProjectExtension + " file disappeared during snapshot export.");
        return new SnapshotProjectFileState(file.Length, file.LastWriteTimeUtc.Ticks);
    }

    private static void BuildSnapshotExportInventory(SessionState session)
    {
        // Export tag tables as whole official objects. Do not enumerate or
        // export individual PlcTag points; each PlcTagTable XML already carries
        // all of its tags and constants.
        session.Inventory = new List<ObjectRecord>();
        session.InventoryKinds = new HashSet<ObjectKind>();
        session.InventoryBuiltAtByKind = new Dictionary<ObjectKind, DateTime>();
        SnapshotInventoryTraversalErrors.Clear();
        SnapshotInventorySoftwareKeys.Clear();
        ResetSnapshotBulkStateChecks();
        _snapshotInventoryAuditActive = true;
        try
        {
            // One walk of the device tree for all three kinds (each walk calls GetService on every
            // device item). The inventory was just emptied, so nothing of another kind is kept.
            BuildInventory(session, new ObjectKind[] { ObjectKind.Block, ObjectKind.PlcType, ObjectKind.TagTable });
        }
        finally
        {
            _snapshotInventoryAuditActive = false;
        }
        ValidateSnapshotInventoryAudit();
    }

    private static void RecordSnapshotInventoryTraversalError(
        string location,
        Exception error)
    {
        if (!_snapshotInventoryAuditActive) return;
        SnapshotInventoryTraversalErrors.Add(
            (location ?? "unknown") + ": " + SafeError(error));
    }

    private static void ValidateSnapshotInventoryAudit()
    {
        if (SnapshotInventoryTraversalErrors.Count > 0)
        {
            List<string> errors = new List<string>(SnapshotInventoryTraversalErrors);
            errors.Sort(StringComparer.Ordinal);
            const int maximumReported = 5;
            if (errors.Count > maximumReported)
                errors.RemoveRange(maximumReported, errors.Count - maximumReported);
            throw new ProtocolException(
                "snapshot_inventory_incomplete",
                "One or more PLC software-container lookups failed; no complete snapshot was published. " +
                String.Join(" | ", errors.ToArray()));
        }
        if (SnapshotInventorySoftwareKeys.Count == 0)
        {
            throw new ProtocolException(
                "snapshot_plc_software_not_found",
                "No PlcSoftware container was discovered in the exact project; refusing to publish an empty result as a complete PLC program-source snapshot.");
        }
    }

    private static SnapshotInventoryState CaptureSnapshotInventory(List<ObjectRecord> inventory)
    {
        List<string> identityLines = new List<string>();
        List<string> modifiedLines = new List<string>();
        Dictionary<string, int> counts = new Dictionary<string, int>(StringComparer.Ordinal);
        if (inventory != null)
        {
            foreach (ObjectRecord record in inventory)
            {
                string key = SnapshotRecordKey(record);
                identityLines.Add(key);
                modifiedLines.Add(key + FingerprintField(SnapshotRecordModifiedState(record, true)));
                int count;
                counts.TryGetValue(record.KindName, out count);
                counts[record.KindName] = count + 1;
            }
        }
        identityLines.Sort(StringComparer.Ordinal);
        modifiedLines.Sort(StringComparer.Ordinal);
        List<string> softwareLines = new List<string>(SnapshotInventorySoftwareKeys);
        softwareLines.Sort(StringComparer.Ordinal);
        return new SnapshotInventoryState(
            identityLines.Count,
            Sha256Hex(Encoding.UTF8.GetBytes(String.Join("\n", identityLines.ToArray()))),
            Sha256Hex(Encoding.UTF8.GetBytes(String.Join("\n", modifiedLines.ToArray()))),
            counts,
            softwareLines.Count,
            Sha256Hex(Encoding.UTF8.GetBytes(String.Join("\n", softwareLines.ToArray()))),
            SnapshotInventoryTraversalErrors.Count);
    }

    private static List<ObjectRecord> SnapshotExportRecords(List<ObjectRecord> inventory)
    {
        List<ObjectRecord> result = new List<ObjectRecord>();
        if (inventory != null)
        {
            foreach (ObjectRecord record in inventory)
            {
                if (record.Kind == ObjectKind.Block ||
                    record.Kind == ObjectKind.PlcType ||
                    record.Kind == ObjectKind.TagTable)
                {
                    result.Add(record);
                }
            }
        }
        result.Sort(delegate(ObjectRecord left, ObjectRecord right)
        {
            return StringComparer.Ordinal.Compare(
                SnapshotRecordKey(left),
                SnapshotRecordKey(right));
        });
        return result;
    }

    private static Dictionary<string, object> ExportSnapshotObject(
        ObjectRecord record,
        int ordinal,
        string stagingDirectory,
        SnapshotReuseSource reuseSource,
        bool dependenciesUnchanged,
        SnapshotObjectTimings timings)
    {
        long started = Stopwatch.GetTimestamp();
        string resourceKind = record.KindName;
        string blockKind = SnapshotBlockKind(record);
        string programmingLanguage = SnapshotProgrammingLanguage(record);
        Dictionary<string, object> modifiedState = BuildSnapshotModifiedStateMap(record);
        started = timings.Add(ref timings.State, started);
        string categoryDirectory = record.Kind == ObjectKind.Block
            ? "blocks"
            : record.Kind == ObjectKind.PlcType
                ? "types"
                : "tag-tables";
        string namePart = SanitizeSnapshotFileName(record.Name, 72);
        string recordKey = Sha256Hex(Encoding.UTF8.GetBytes(SnapshotRecordKey(record)));
        string keyHash = recordKey.Substring(0, 12);
        string fileName =
            ordinal.ToString("D6", CultureInfo.InvariantCulture) +
            "-" + namePart + "-" + keyHash + ".xml";
        string relativePath = "objects/" + categoryDirectory + "/" + fileName;
        string absolutePath = Path.Combine(
            stagingDirectory,
            relativePath.Replace('/', Path.DirectorySeparatorChar));
        started = Stopwatch.GetTimestamp();
        Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
        EnsureSnapshotPlainDirectory(
            stagingDirectory,
            "snapshot_staging_unsafe",
            "The snapshot staging directory");
        EnsureSnapshotPlainDirectory(
            Path.Combine(stagingDirectory, "objects"),
            "snapshot_staging_unsafe",
            "The snapshot objects directory");
        EnsureSnapshotPlainDirectory(
            Path.GetDirectoryName(absolutePath),
            "snapshot_staging_unsafe",
            "The snapshot object category directory");
        started = timings.Add(ref timings.Directories, started);

        Dictionary<string, object> entry = Map(
            "resourceKind", resourceKind,
            "kind", blockKind ?? resourceKind,
            "blockKind", blockKind,
            "name", record.Name,
            "number", record.Number.HasValue ? (object)record.Number.Value : null,
            "programmingLanguage", programmingLanguage,
            "namespace", record.Namespace,
            "softwareName", record.SoftwareName,
            "softwarePath", record.SoftwarePath,
            "groupPath", record.GroupPath,
            "runtimeType", record.RuntimeType,
            "relativePath", relativePath,
            "sha256", null,
            "bytes", 0,
            "status", "not_started",
            "success", false,
            "error", null,
            "modifiedState", modifiedState,
            "api", SnapshotExportApi(record),
            "recordKey", recordKey,
            "exportedAtUtc", null,
            "reusedFrom", null);

        started = Stopwatch.GetTimestamp();
        bool reused = TryReuseSnapshotObject(
            record,
            recordKey,
            entry,
            absolutePath,
            reuseSource,
            dependenciesUnchanged);
        started = timings.Add(ref timings.ReuseCopy, started);
        if (reused) return entry;

        try
        {
            FileInfo destination = new FileInfo(absolutePath);
            if (record.Kind == ObjectKind.Block)
                ((PlcBlock)record.Value).Export(destination, ExportOptions.WithDefaults);
            else if (record.Kind == ObjectKind.PlcType)
                ((PlcType)record.Value).Export(destination, ExportOptions.WithDefaults);
            else if (record.Kind == ObjectKind.TagTable)
                ((PlcTagTable)record.Value).Export(destination, ExportOptions.WithDefaults);
            else
                throw new InvalidOperationException("The snapshot exporter received an unsupported object kind.");

            destination.Refresh();
            if (!destination.Exists)
                throw new IOException("The Openness Export call returned without creating its XML file.");
            if (destination.Length <= 0)
                throw new IOException("The Openness Export call created an empty XML file.");
            entry["bytes"] = destination.Length;
            entry["sha256"] = FileSha256(destination.FullName);
            entry["status"] = "exported";
            entry["success"] = true;
            entry["exportedAtUtc"] = Utc(DateTime.UtcNow);
            timings.Add(ref timings.FreshExport, started);
        }
        catch (Exception ex)
        {
            timings.Add(ref timings.FreshExport, started);
            entry["status"] = "export_error";
            entry["success"] = false;
            entry["error"] = SafeError(ex);
            try
            {
                if (File.Exists(absolutePath)) File.Delete(absolutePath);
            }
            catch (Exception cleanupError)
            {
                entry["cleanupError"] = SafeError(cleanupError);
            }
        }
        return entry;
    }

    // Where the export loop spends its time, summed over all objects (Stopwatch ticks).
    private sealed class SnapshotObjectTimings
    {
        public long State;
        public long Directories;
        public long ReuseCopy;
        public long FreshExport;

        // Adds the time since startedTicks to the counter and returns the current timestamp.
        public long Add(ref long counter, long startedTicks)
        {
            long now = Stopwatch.GetTimestamp();
            counter += now - startedTicks;
            return now;
        }

        public long Milliseconds(long ticks)
        {
            return ticks * 1000L / Stopwatch.Frequency;
        }
    }

    // What other objects' exports can depend on: every object's identity, the interface of code blocks
    // (callers list their parameters; instance DBs expand them) and the whole state of DBs, PLC types and
    // tag tables (code exports name their members and tags). When this is unchanged since the previous
    // snapshot, an object whose own modified state is unchanged exports to the same XML and is copied.
    // Also in the stamp: the Portal and API file versions, the project languages (every text export has
    // one item per project language) and each tag's name, type and address.
    private static string SnapshotDependencyStamp(SessionState session, List<ObjectRecord> records, Dictionary<ObjectRecord, string> hashes)
    {
        try { return SnapshotDependencyStampOrThrow(session, records, hashes); }
        catch { return null; }
    }

    private static string SnapshotDependencyStampOrThrow(SessionState session, List<ObjectRecord> records, Dictionary<ObjectRecord, string> hashes)
    {
        List<string> lines = new List<string>();
        // The Portal binaries next to the API (<root>\PublicAPI\V20\..\..\Bin); no process handle needed.
        string portalExe = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(_apiPath), "..", "..", "Bin", "Siemens.Automation.Portal.exe"));
        lines.Add("portal|" + (File.Exists(portalExe) ? FileVersionInfo.GetVersionInfo(portalExe).FileVersion : "absent"));
        lines.Add("api|" + TrySnapshotValue(delegate { return (object)FileVersionInfo.GetVersionInfo(_apiPath).FileVersion; }));
        lines.Add("languages|" + TrySnapshotValue(delegate {
            LanguageSettings languages = session.Project.LanguageSettings;
            List<string> active = new List<string>();
            foreach (Language language in languages.ActiveLanguages) active.Add(language.Culture.Name);
            active.Sort(StringComparer.Ordinal);
            return (object)(String.Join(",", active.ToArray()) + "|" + languages.EditingLanguage.Culture.Name + "|" + languages.ReferenceLanguage.Culture.Name);
        }));
        foreach (ObjectRecord record in records)
        {
            if (record.Kind != ObjectKind.TagTable) continue;
            PlcTagTable table = (PlcTagTable)record.Value;
            lines.Add("tags|" + SnapshotRecordKey(record) + TrySnapshotValue(delegate {
                StringBuilder tags = new StringBuilder();
                foreach (PlcTag tag in table.Tags)
                    tags.Append(FingerprintField(tag.Name)).Append(FingerprintField(tag.DataTypeName)).Append(FingerprintField(tag.LogicalAddress));
                return (object)tags.ToString();
            }));
        }
        foreach (ObjectRecord record in records)
        {
            string state;
            if (record.Kind == ObjectKind.TagTable) state = SnapshotRecordModifiedState(record, false);
            else if (!hashes.TryGetValue(record, out state) || !IsSha256Hex(state))
                throw new InvalidDataException("Missing semantic dependency hash.");
            lines.Add(SnapshotRecordKey(record) + FingerprintField(state));
        }
        lines.Sort(StringComparer.Ordinal);
        return Sha256Hex(Encoding.UTF8.GetBytes(
            "v3\n" + TiaNativeTarget.PortalVersion + "\nExportOptions.WithDefaults\n" +
            String.Join("\n", lines.ToArray())));
    }

    private static string DependencyHash(string file, string kind)
    {
        System.Xml.XmlDocument xml = new System.Xml.XmlDocument();
        xml.PreserveWhitespace = true;
        xml.XmlResolver = null;
        System.Xml.XmlReaderSettings settings = new System.Xml.XmlReaderSettings();
        settings.DtdProcessing = System.Xml.DtdProcessing.Prohibit;
        settings.XmlResolver = null;
        using (System.Xml.XmlReader reader = System.Xml.XmlReader.Create(file, settings)) xml.Load(reader);
        if (kind == "FB" || kind == "FC" || kind == "OB") {
            System.Xml.XmlNode node = xml.SelectSingleNode("/*/*[local-name()='SW.Blocks." + kind + "']/*[local-name()='AttributeList']/*[local-name()='Interface']");
            if (node == null) throw new InvalidDataException("Block interface missing from dependency export.");
            return Sha256Hex(Encoding.UTF8.GetBytes(node.OuterXml));
        }
        foreach (System.Xml.XmlNode created in xml.SelectNodes("/*/*[local-name()='DocumentInfo']/*[local-name()='Created']"))
            created.ParentNode.RemoveChild(created);
        return Sha256Hex(Encoding.UTF8.GetBytes(xml.OuterXml));
    }

    private static string PreviousDependencyHash(ObjectRecord record, Dictionary<string, object> previous, SnapshotReuseSource source)
    {
        string saved = GetString(previous, "dependencyHash", null);
        if (IsSha256Hex(saved)) return saved;
        string relative = GetString(previous, "relativePath", "");
        string file = Path.GetFullPath(Path.Combine(source.PublishedPath, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!file.StartsWith(source.PublishedPath.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Previous XML escaped snapshot.");
        EnsureSnapshotTreeHasNoReparsePoints(source.PublishedPath);
        if (!String.Equals(FileSha256(file), GetString(previous, "sha256", ""), StringComparison.Ordinal))
            throw new InvalidDataException("Previous XML SHA-256 differs from manifest.");
        return DependencyHash(file, SnapshotBlockKind(record));
    }

    private static void SetDependencyHash(ObjectRecord record, Dictionary<string, object> entry, string directory, Dictionary<ObjectRecord, string> hashes)
    {
        if (record.Kind == ObjectKind.TagTable) return;
        try {
            string hash;
            if (GetString(entry, "reusedFrom", null) == null || !hashes.TryGetValue(record, out hash))
                hash = DependencyHash(Path.Combine(directory, GetString(entry, "relativePath", "").Replace('/', Path.DirectorySeparatorChar)), SnapshotBlockKind(record));
            hashes[record] = hash;
            entry["dependencyHash"] = hash;
        } catch { hashes.Remove(record); }
    }

    private static SnapshotReuseSource LoadSnapshotReuseSource(
        PreviousSnapshotPointerState previous,
        string canonicalProjectPath)
    {
        if (previous == null || !previous.Exists || String.IsNullOrWhiteSpace(previous.PublishedPath)) return null;
        try
        {
            string manifestPath = Path.Combine(previous.PublishedPath, "manifest.json");
            if (!String.Equals(FileSha256(manifestPath), previous.ManifestSha256, StringComparison.Ordinal)) return null;
            Dictionary<string, object> manifest =
                Json.DeserializeObject(File.ReadAllText(manifestPath, Encoding.UTF8)) as Dictionary<string, object>;
            if (manifest == null ||
                !GetBool(manifest, "complete", false) ||
                !String.Equals(GetString(manifest, "status", null), "consistent_complete", StringComparison.Ordinal))
                return null;
            Dictionary<string, object> project = manifest.ContainsKey("project")
                ? manifest["project"] as Dictionary<string, object>
                : null;
            if (project == null || !PathEquals(GetString(project, "canonicalProjectPath", ""), canonicalProjectPath))
                return null;
            Dictionary<string, object> reuse = manifest.ContainsKey("reuse")
                ? manifest["reuse"] as Dictionary<string, object>
                : null;
            Dictionary<string, Dictionary<string, object>> entries =
                new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            System.Collections.IEnumerable objects = manifest.ContainsKey("objects")
                ? manifest["objects"] as System.Collections.IEnumerable
                : null;
            if (objects == null) return null;
            foreach (object value in objects)
            {
                Dictionary<string, object> entry = value as Dictionary<string, object>;
                string key = entry == null ? null : GetString(entry, "recordKey", null);
                if (!IsSha256Hex(key)) continue;
                if (entries.ContainsKey(key)) return null;
                entries[key] = entry;
            }
            return new SnapshotReuseSource(
                previous.SnapshotId,
                Path.GetFullPath(previous.PublishedPath),
                reuse == null ? null : GetString(reuse, "dependencyStamp", null),
                entries);
        }
        catch
        {
            return null;
        }
    }

    // Decides whether a previous entry may stand in for a fresh export. Pure, so the self-test covers it.
    // Copies are refreshed at least this often, whatever changed without moving a fingerprint.
    private const int SnapshotMaxReuseAgeHours = 24;

    private static bool SnapshotEntryReusable(
        Dictionary<string, object> previous,
        string modifiedFingerprint,
        bool dependenciesUnchanged,
        DateTime nowUtc)
    {
        if (previous == null || !dependenciesUnchanged) return false;
        DateTime exportedAt;
        if (!DateTime.TryParse(GetString(previous, "exportedAtUtc", null), CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out exportedAt) ||
            exportedAt > nowUtc.AddMinutes(5) ||
            nowUtc - exportedAt > TimeSpan.FromHours(SnapshotMaxReuseAgeHours))
            return false;
        if (!String.Equals(GetString(previous, "status", null), "exported", StringComparison.Ordinal)) return false;
        if (!GetBool(previous, "success", false)) return false;
        if (!IsSha256Hex(GetString(previous, "sha256", null))) return false;
        Dictionary<string, object> state = previous.ContainsKey("modifiedState")
            ? previous["modifiedState"] as Dictionary<string, object>
            : null;
        string previousFingerprint = state == null ? null : GetString(state, "fingerprint", null);
        if (!IsSha256Hex(previousFingerprint) ||
            !String.Equals(previousFingerprint, modifiedFingerprint, StringComparison.Ordinal))
            return false;
        string relative = GetString(previous, "relativePath", null);
        return !String.IsNullOrWhiteSpace(relative) &&
            relative.StartsWith("objects/", StringComparison.Ordinal) &&
            relative.EndsWith(".xml", StringComparison.OrdinalIgnoreCase) &&
            relative.IndexOf("..", StringComparison.Ordinal) < 0 &&
            !Path.IsPathRooted(relative);
    }

    // The export header without its creation time: installed products and versions.
    private static string SnapshotExportHeader(string path)
    {
        string text = File.ReadAllText(path, Encoding.UTF8);
        System.Text.RegularExpressions.Match header = System.Text.RegularExpressions.Regex.Match(text, "<DocumentInfo>[\\s\\S]*?</DocumentInfo>");
        return header.Success ? System.Text.RegularExpressions.Regex.Replace(header.Value, "<Created>[^<]*</Created>", "") : "";
    }

    private static bool SnapshotCanaryMatches(
        Dictionary<string, object> freshEntry,
        string stagingDirectory,
        SnapshotReuseSource reuseSource)
    {
        try
        {
            if (reuseSource == null || !GetBool(freshEntry, "success", false)) return false;
            Dictionary<string, object> previous = null;
            foreach (Dictionary<string, object> candidate in reuseSource.EntriesByRecordKey.Values)
            {
                previous = candidate;
                break;
            }
            if (previous == null) return false;
            string relative = GetString(previous, "relativePath", null);
            if (String.IsNullOrWhiteSpace(relative) || relative.IndexOf("..", StringComparison.Ordinal) >= 0) return false;
            string oldPath = Path.GetFullPath(Path.Combine(reuseSource.PublishedPath, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!oldPath.StartsWith(reuseSource.PublishedPath.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                (File.GetAttributes(oldPath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
                !String.Equals(FileSha256(oldPath), (GetString(previous, "sha256", "") ?? "").ToLowerInvariant(), StringComparison.Ordinal))
                return false;
            string fresh = SnapshotExportHeader(Path.Combine(stagingDirectory, GetString(freshEntry, "relativePath", "").Replace('/', Path.DirectorySeparatorChar)));
            string old = SnapshotExportHeader(oldPath);
            return fresh.Length > 0 && String.Equals(fresh, old, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private static bool TryReuseSnapshotObject(
        ObjectRecord record,
        string recordKey,
        Dictionary<string, object> entry,
        string destinationPath,
        SnapshotReuseSource reuseSource,
        bool dependenciesUnchanged)
    {
        if (reuseSource == null) return false;
        Dictionary<string, object> previous;
        if (!reuseSource.EntriesByRecordKey.TryGetValue(recordKey, out previous)) return false;
        Dictionary<string, object> state = entry["modifiedState"] as Dictionary<string, object>;
        string fingerprint = state == null ? null : GetString(state, "fingerprint", null);
        if (!SnapshotEntryReusable(previous, fingerprint, dependenciesUnchanged, DateTime.UtcNow))
            return false;
        string relative = GetString(previous, "relativePath", null);
        string expectedSha256 = GetString(previous, "sha256", null).ToLowerInvariant();
        try
        {
            string source = Path.GetFullPath(Path.Combine(
                reuseSource.PublishedPath,
                relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!source.StartsWith(
                reuseSource.PublishedPath.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase))
                return false;
            FileAttributes attributes = File.GetAttributes(source);
            if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
            string sha256 = CopySnapshotFileHashed(source, destinationPath);
            if (!String.Equals(sha256, expectedSha256, StringComparison.Ordinal))
            {
                File.Delete(destinationPath);
                return false;
            }
            entry["bytes"] = new FileInfo(destinationPath).Length;
            entry["sha256"] = sha256;
            entry["status"] = "exported";
            entry["success"] = true;
            entry["exportedAtUtc"] = GetString(previous, "exportedAtUtc", null);
            entry["reusedFrom"] = reuseSource.SnapshotId + "/" + relative;
            return true;
        }
        catch
        {
            try { if (File.Exists(destinationPath)) File.Delete(destinationPath); } catch { }
            return false;
        }
    }

    // Copies source to a new destination and returns the SHA-256 of the bytes written, in one pass. The
    // source is opened deny-write, so the bytes hashed are the bytes copied. Hashing the source rather
    // than re-reading the new file avoids the scan Windows runs on the first read of a just-written file
    // (about 10 ms per file); the copy stays a separate file, so the snapshots never share content.
    private static string CopySnapshotFileHashed(string source, string destinationPath)
    {
        using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (FileStream output = new FileStream(destinationPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (SHA256 sha = SHA256.Create())
        {
            byte[] buffer = new byte[81920];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                sha.TransformBlock(buffer, 0, read, null, 0);
                output.Write(buffer, 0, read);
            }
            sha.TransformFinalBlock(buffer, 0, 0);
            output.Flush();
            if (output.Length != input.Length)
                throw new IOException("The reused snapshot file was not copied completely.");
            StringBuilder hex = new StringBuilder(64);
            foreach (byte b in sha.Hash) hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            return hex.ToString();
        }
    }

    private static string SnapshotExportApi(ObjectRecord record)
    {
        if (record.Kind == ObjectKind.Block)
            return "PlcBlock.Export(FileInfo, ExportOptions.WithDefaults)";
        if (record.Kind == ObjectKind.PlcType)
            return "PlcType.Export(FileInfo, ExportOptions.WithDefaults)";
        return "PlcTagTable.Export(FileInfo, ExportOptions.WithDefaults)";
    }

    private static string SnapshotRecordKey(ObjectRecord record)
    {
        return FingerprintField(record.KindName) +
            FingerprintField(record.SoftwarePath) +
            FingerprintField(record.SoftwareName) +
            FingerprintField(record.GroupPath) +
            FingerprintField(record.Name) +
            FingerprintField(record.Namespace) +
            FingerprintField(record.Number.HasValue
                ? record.Number.Value.ToString(CultureInfo.InvariantCulture)
                : null) +
            FingerprintField(record.BlockKind) +
            FingerprintField(record.RuntimeType) +
            FingerprintField(record.ParentTable == null ? null : record.ParentTable.Name);
    }

    // Value order (also used by the state map and the dependency stamp):
    //   block:     ProgrammingLanguage, IsConsistent, IsKnowHowProtected, ModifiedDate, CodeModifiedDate,
    //              InterfaceModifiedDate, ParameterModified, StructureModified
    //   PLC type:  IsConsistent, IsKnowHowProtected, ModifiedDate, InterfaceModifiedDate
    //   tag table: ModifiedTimeStamp, Tags.Count, SystemConstants.Count, UserConstants.Count
    //   tag:       DataTypeName, LogicalAddress, ExternalAccessible, ExternalVisible, ExternalWritable, IsSafety
    // fresh=true always reads the objects (and keeps the values on the record); fresh=false returns the
    // values kept by the last fresh read of this record, reading only when there are none.
    private static string[] SnapshotRecordStateValues(ObjectRecord record, bool fresh)
    {
        if (!fresh && record.SnapshotStateValues != null) return record.SnapshotStateValues;
        string[] values;
        if (record.Kind == ObjectKind.Block)
        {
            PlcBlock block = (PlcBlock)record.Value;
            values = SnapshotBulkStateValues(block, SnapshotBlockStateAttributes, ref _snapshotBulkBlockState,
                delegate { return SnapshotTypedBlockState(block); });
        }
        else if (record.Kind == ObjectKind.PlcType)
        {
            PlcType plcType = (PlcType)record.Value;
            values = SnapshotBulkStateValues(plcType, SnapshotTypeStateAttributes, ref _snapshotBulkTypeState,
                delegate { return SnapshotTypedTypeState(plcType); });
        }
        else if (record.Kind == ObjectKind.TagTable)
        {
            PlcTagTable table = (PlcTagTable)record.Value;
            values = new string[] {
                TrySnapshotValue(delegate { return (object)table.ModifiedTimeStamp; }),
                TrySnapshotValue(delegate { return (object)table.Tags.Count; }),
                TrySnapshotValue(delegate { return (object)table.SystemConstants.Count; }),
                TrySnapshotValue(delegate { return (object)table.UserConstants.Count; }) };
        }
        else
        {
            PlcTag tag = (PlcTag)record.Value;
            values = new string[] {
                TrySnapshotValue(delegate { return (object)tag.DataTypeName; }),
                TrySnapshotValue(delegate { return (object)tag.LogicalAddress; }),
                TrySnapshotValue(delegate { return (object)tag.ExternalAccessible; }),
                TrySnapshotValue(delegate { return (object)tag.ExternalVisible; }),
                TrySnapshotValue(delegate { return (object)tag.ExternalWritable; }),
                TrySnapshotValue(delegate { return (object)LiveCoreApi.IsSafety(tag); }) };
        }
        record.SnapshotStateValues = values;
        return values;
    }

    private static string[] SnapshotTypedBlockState(PlcBlock block)
    {
        return new string[] {
            TrySnapshotValue(delegate { return (object)block.ProgrammingLanguage; }),
            TrySnapshotValue(delegate { return (object)block.IsConsistent; }),
            TrySnapshotValue(delegate { return (object)block.IsKnowHowProtected; }),
            TrySnapshotValue(delegate { return (object)block.ModifiedDate; }),
            TrySnapshotValue(delegate { return (object)block.CodeModifiedDate; }),
            TrySnapshotValue(delegate { return (object)block.InterfaceModifiedDate; }),
            TrySnapshotValue(delegate { return (object)block.ParameterModified; }),
            TrySnapshotValue(delegate { return (object)block.StructureModified; }) };
    }

    private static string[] SnapshotTypedTypeState(PlcType plcType)
    {
        return new string[] {
            TrySnapshotValue(delegate { return (object)plcType.IsConsistent; }),
            TrySnapshotValue(delegate { return (object)plcType.IsKnowHowProtected; }),
            TrySnapshotValue(delegate { return (object)plcType.ModifiedDate; }),
            TrySnapshotValue(delegate { return (object)plcType.InterfaceModifiedDate; }) };
    }

    // Attribute names in the value order above; GetAttributes reads them in one call into the Portal.
    private static readonly string[] SnapshotBlockStateAttributes = new string[] {
        "ProgrammingLanguage", "IsConsistent", "IsKnowHowProtected", "ModifiedDate", "CodeModifiedDate",
        "InterfaceModifiedDate", "ParameterModified", "StructureModified" };
    private static readonly string[] SnapshotTypeStateAttributes = new string[] {
        "IsConsistent", "IsKnowHowProtected", "ModifiedDate", "InterfaceModifiedDate" };
    // Per inventory pass and kind: 0 = not checked yet, 1 = the bulk read matched the single reads on the
    // first object, -1 = it did not, so the single reads are used for the rest of the pass.
    private static int _snapshotBulkBlockState;
    private static int _snapshotBulkTypeState;

    private static void ResetSnapshotBulkStateChecks()
    {
        _snapshotBulkBlockState = 0;
        _snapshotBulkTypeState = 0;
    }

    private static string[] SnapshotBulkStateValues(
        object value,
        string[] attributeNames,
        ref int check,
        Func<string[]> typedRead)
    {
        string[] bulk = check >= 0 ? SnapshotBulkAttributes(value, attributeNames) : null;
        if (bulk == null) return typedRead();
        if (check == 0)
        {
            string[] typed = typedRead();
            check = SnapshotModifiedStateText(typed) == SnapshotModifiedStateText(bulk) ? 1 : -1;
            if (check < 0) return typed;
        }
        return bulk;
    }

    // Null when the object is not an engineering object, the call fails, or any attribute is missing;
    // the caller then reads the properties one by one.
    private static string[] SnapshotBulkAttributes(object value, string[] attributeNames)
    {
        IEngineeringObject engineeringObject = value as IEngineeringObject;
        if (engineeringObject == null) return null;
        try
        {
            IList<object> read = engineeringObject.GetAttributes(attributeNames);
            if (read == null || read.Count != attributeNames.Length) return null;
            string[] values = new string[attributeNames.Length];
            for (int i = 0; i < values.Length; i++)
            {
                if (read[i] == null) return null;
                values[i] = FormatSnapshotValue(read[i]);
            }
            return values;
        }
        catch
        {
            return null;
        }
    }

    // The fingerprint text; the same format as before the values were kept, so older manifests still match.
    private static string SnapshotModifiedStateText(string[] values)
    {
        StringBuilder text = new StringBuilder();
        foreach (string value in values) text.Append(FingerprintField(value));
        return text.ToString();
    }

    private static string SnapshotRecordModifiedState(ObjectRecord record, bool fresh)
    {
        return SnapshotModifiedStateText(SnapshotRecordStateValues(record, fresh));
    }

    // Built from the values kept by the "before" pass. Whatever changes after that pass is caught by the
    // "after" pass, which reads every object again and refuses to publish on any difference.
    private static Dictionary<string, object> BuildSnapshotModifiedStateMap(ObjectRecord record)
    {
        string[] values = SnapshotRecordStateValues(record, false);
        Dictionary<string, object> state = Map(
            "fingerprint", Sha256Hex(Encoding.UTF8.GetBytes(SnapshotModifiedStateText(values))));
        if (record.Kind == ObjectKind.Block)
        {
            state["modifiedDate"] = values[3];
            state["codeModifiedDate"] = values[4];
            state["interfaceModifiedDate"] = values[5];
            state["isConsistent"] = values[1];
            state["isKnowHowProtected"] = values[2];
        }
        else if (record.Kind == ObjectKind.PlcType)
        {
            state["modifiedDate"] = values[2];
            state["interfaceModifiedDate"] = values[3];
            state["isConsistent"] = values[0];
            state["isKnowHowProtected"] = values[1];
        }
        else
        {
            state["modifiedTimeStamp"] = values[0];
            state["tagCount"] = values[1];
        }
        return state;
    }

    private static string TrySnapshotValue(Func<object> getter)
    {
        try
        {
            return FormatSnapshotValue(getter());
        }
        catch (Exception ex)
        {
            throw new ProtocolException(
                "snapshot_consistency_unavailable",
                "A required engineering-object consistency property could not be read: " +
                SafeError(ex));
        }
    }

    private static string FormatSnapshotValue(object value)
    {
        if (value == null) return "null";
        if (value is DateTime) return Utc((DateTime)value);
        IFormattable formattable = value as IFormattable;
        return formattable == null
            ? Convert.ToString(value)
            : formattable.ToString(null, CultureInfo.InvariantCulture);
    }

    private static string SnapshotProgrammingLanguage(ObjectRecord record)
    {
        if (record.Kind != ObjectKind.Block) return null;
        if (record.SnapshotStateValues != null) return record.SnapshotStateValues[0];
        try { return ((PlcBlock)record.Value).ProgrammingLanguage.ToString(); }
        catch { return null; }
    }

    private static string SnapshotBlockKind(ObjectRecord record)
    {
        if (record.Kind != ObjectKind.Block) return null;
        string kind = record.BlockKind ?? "";
        if (kind.IndexOf("OrganizationBlock", StringComparison.OrdinalIgnoreCase) >= 0) return "OB";
        if (kind.IndexOf("FunctionBlock", StringComparison.OrdinalIgnoreCase) >= 0) return "FB";
        if (kind.IndexOf("InstanceDB", StringComparison.OrdinalIgnoreCase) >= 0) return "DB";
        if (kind.IndexOf("DataBlock", StringComparison.OrdinalIgnoreCase) >= 0) return "DB";
        if (String.Equals(kind, "Function", StringComparison.OrdinalIgnoreCase) ||
            kind.EndsWith(".Function", StringComparison.OrdinalIgnoreCase)) return "FC";
        return kind;
    }

    private static string FingerprintField(string value)
    {
        string text = value ?? "";
        return text.Length.ToString(CultureInfo.InvariantCulture) + ":" + text;
    }

    private static string SanitizeSnapshotFileName(string value, int maximumLength)
    {
        string source = String.IsNullOrWhiteSpace(value) ? "unnamed" : value.Trim();
        StringBuilder result = new StringBuilder();
        foreach (char character in source)
        {
            bool ascii = (character >= 'A' && character <= 'Z') ||
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') || character == '-' || character == '_';
            if (ascii) result.Append(character);
            else if (result.Length == 0 || result[result.Length - 1] != '_') result.Append('_');
            if (result.Length >= maximumLength) break;
        }
        string safe = result.ToString().Trim('_');
        return safe.Length == 0 ? "unnamed" : safe;
    }

    private static Dictionary<string, object> BuildSnapshotProjectMap(
        SessionState session,
        bool projectModifiedBefore,
        bool projectModifiedAfter,
        SnapshotProjectFileState fileBefore,
        SnapshotProjectFileState fileAfter)
    {
        string projectName = null;
        try { projectName = session.Project.Name; }
        catch { }
        return Map(
            "name", projectName,
            "canonicalProjectPath", session.CanonicalProjectPath,
            "processId", session.ProcessId,
            "processStartUtcTicks", session.ProcessStartUtcTicks,
            "processStartTimeUtc", new DateTime(
                session.ProcessStartUtcTicks,
                DateTimeKind.Utc).ToString("o"),
            "isModifiedBefore", projectModifiedBefore,
            "isModifiedAfter", projectModifiedAfter,
            "fileBefore", fileBefore.ToMap(),
            "fileAfter", fileAfter.ToMap());
    }

    private static Dictionary<string, object> BuildSnapshotSummary(
        SnapshotInventoryState inventory,
        int exportableCount,
        int exportedCount,
        int exportErrorCount,
        string contentFingerprint)
    {
        return Map(
            "inventoryCount", inventory.Count,
            "inventoryByKind", inventory.CountsMap(),
            "exportableCount", exportableCount,
            "exportedCount", exportedCount,
            "exportErrorCount", exportErrorCount,
            "contentFingerprint", contentFingerprint,
            "tagTablesContainAllTags", true);
    }

    private static bool SnapshotPublishAllowed(
        bool consistent,
        int exportErrorCount)
    {
        return consistent && exportErrorCount == 0;
    }

    private static Dictionary<string, object> BuildSnapshotExportErrorReport(
        List<object> objectEntries)
    {
        const int maximumReportedErrors = 100;
        List<object> errors = new List<object>();
        int total = 0;
        foreach (object value in objectEntries)
        {
            Dictionary<string, object> entry = value as Dictionary<string, object>;
            if (entry == null || GetBool(entry, "success", false)) continue;
            total++;
            if (errors.Count >= maximumReportedErrors) continue;
            errors.Add(Map(
                "resourceKind", GetString(entry, "resourceKind", null),
                "kind", GetString(entry, "kind", null),
                "name", GetString(entry, "name", null),
                "softwarePath", GetString(entry, "softwarePath", null),
                "relativePath", GetString(entry, "relativePath", null),
                "status", GetString(entry, "status", null),
                "error", GetString(entry, "error", null)));
        }
        return Map(
            "count", total,
            "reportedCount", errors.Count,
            "truncated", total > errors.Count,
            "items", errors);
    }

    private static Dictionary<string, object> SnapshotSafetyMap()
    {
        return Map(
            "attachExistingExactSessionOnly", true,
            "projectMutation", false,
            "saveProject", false,
            "compile", false,
            "import", false,
            "download", false,
            "online", false,
            "plcAccessed", false,
            "forceValues", false,
            "persistentPcExport", true,
            "singleAttach", true,
            "currentPointerUpdatedByNative", false);
    }

    private static void ValidateSnapshotManifestContract(
        Dictionary<string, object> manifest)
    {
        RequireSnapshotKeys(
            manifest,
            "manifest",
            new string[] {
                "schemaVersion", "snapshotKind", "status", "complete",
                "createdAtUtc", "completedAtUtc", "snapshotId",
                "publishedRelativePath", "publicationState", "previousPublishedPath",
                "staleStagingCleanup", "project", "openness", "inventory",
                "consistency", "objects", "summary", "safety"
            });
        Dictionary<string, object> project = manifest["project"] as Dictionary<string, object>;
        RequireSnapshotKeys(
            project,
            "manifest.project",
            new string[] {
                "name", "canonicalProjectPath", "processId",
                "processStartUtcTicks", "processStartTimeUtc",
                "isModifiedBefore", "isModifiedAfter", "fileBefore", "fileAfter"
            });
        Dictionary<string, object> inventory = manifest["inventory"] as Dictionary<string, object>;
        RequireSnapshotKeys(inventory, "manifest.inventory", new string[] { "before", "after" });
        RequireSnapshotInventoryState(
            inventory == null ? null : inventory["before"] as Dictionary<string, object>,
            "manifest.inventory.before");
        RequireSnapshotInventoryState(
            inventory == null ? null : inventory["after"] as Dictionary<string, object>,
            "manifest.inventory.after");
        Dictionary<string, object> consistency = manifest["consistency"] as Dictionary<string, object>;
        RequireSnapshotKeys(
            consistency,
            "manifest.consistency",
            new string[] {
                "consistent", "inventoryIdentityMatches", "modifiedStateMatches",
                "plcSoftwareIdentityMatches", "inventoryTraversalComplete",
                "projectModifiedStateMatches", "projectFileStateMatches",
                "processIdentityVerifiedBeforeAndAfter", "publishAllowed"
            });
        Dictionary<string, object> summary = manifest["summary"] as Dictionary<string, object>;
        RequireSnapshotKeys(
            summary,
            "manifest.summary",
            new string[] {
                "inventoryCount", "inventoryByKind", "exportableCount",
                "exportedCount", "exportErrorCount", "contentFingerprint",
                "tagTablesContainAllTags"
            });

        List<object> objects = manifest["objects"] as List<object>;
        if (objects == null)
            throw new ProtocolException("invalid_snapshot_manifest", "manifest.objects must be a list.");
        foreach (object value in objects)
        {
            Dictionary<string, object> entry = value as Dictionary<string, object>;
            RequireSnapshotKeys(
                entry,
                "manifest.objects[]",
                new string[] {
                    "resourceKind", "kind", "blockKind", "name", "number",
                    "programmingLanguage", "softwarePath", "relativePath",
                    "sha256", "bytes", "status", "error"
                });
        }
    }

    private static void RequireSnapshotInventoryState(
        Dictionary<string, object> state,
        string location)
    {
        RequireSnapshotKeys(
            state,
            location,
            new string[] {
                "count", "identityFingerprint", "modifiedStateFingerprint", "byKind",
                "plcSoftwareCount", "plcSoftwareIdentityFingerprint",
                "traversalErrorCount"
            });
    }

    private static void RequireSnapshotKeys(
        Dictionary<string, object> map,
        string location,
        string[] keys)
    {
        if (map == null)
            throw new ProtocolException("invalid_snapshot_manifest", location + " must be an object.");
        foreach (string key in keys)
        {
            if (!map.ContainsKey(key))
                throw new ProtocolException(
                    "invalid_snapshot_manifest",
                    location + " is missing required field " + key + ".");
        }
    }

    private static void WriteJsonFile(string path, object value)
    {
        File.WriteAllText(path, Serialize(value), new UTF8Encoding(false));
    }

    private static void AtomicWriteJson(string targetPath, object value)
    {
        string directory = Path.GetDirectoryName(targetPath);
        Directory.CreateDirectory(directory);
        string tempPath = Path.Combine(
            directory,
            "." + Path.GetFileName(targetPath) + ".tmp-" + Guid.NewGuid().ToString("N"));
        string backupPath = Path.Combine(
            directory,
            "." + Path.GetFileName(targetPath) + ".backup-" + Guid.NewGuid().ToString("N"));
        try
        {
            WriteJsonFile(tempPath, value);
            if (File.Exists(targetPath))
            {
                File.Replace(tempPath, targetPath, backupPath, true);
                if (File.Exists(backupPath)) File.Delete(backupPath);
            }
            else
            {
                File.Move(tempPath, targetPath);
            }
        }
        finally
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); }
            catch { }
            try { if (File.Exists(backupPath)) File.Delete(backupPath); }
            catch { }
        }
    }

    private static PreviousSnapshotPointerState ReadPreviousSnapshotPointerStrict(
        string currentPointerPath,
        string outputRoot)
    {
        FileAttributes pointerAttributes;
        try
        {
            pointerAttributes = File.GetAttributes(currentPointerPath);
        }
        catch (FileNotFoundException)
        {
            return PreviousSnapshotPointerState.Absent();
        }
        catch (DirectoryNotFoundException)
        {
            return PreviousSnapshotPointerState.Absent();
        }
        catch (Exception ex)
        {
            throw new ProtocolException(
                "current_pointer_read_failed",
                "Cannot inspect current.json before snapshot export: " +
                SafeError(ex));
        }

        try
        {
            if ((pointerAttributes & FileAttributes.Directory) != 0)
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json is a directory.");
            if ((pointerAttributes & FileAttributes.ReparsePoint) != 0)
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json is a filesystem reparse point.");
            FileInfo pointerFile = new FileInfo(currentPointerPath);
            pointerFile.Refresh();
            if (!pointerFile.Exists)
                throw new ProtocolException(
                    "current_pointer_read_failed",
                    "current.json disappeared while it was being inspected.");
            if (pointerFile.Length <= 0 || pointerFile.Length > 1024 * 1024)
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json must be 1..1048576 bytes.");

            Dictionary<string, object> pointer =
                Json.DeserializeObject(File.ReadAllText(currentPointerPath, Encoding.UTF8))
                as Dictionary<string, object>;
            if (pointer == null)
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json must contain one JSON object.");
            string schemaVersion = GetString(pointer, "schemaVersion", null);
            if (!String.Equals(schemaVersion, "1.0", StringComparison.Ordinal))
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json has an unsupported schemaVersion.");
            string snapshotId = GetString(pointer, "snapshotId", null);
            if (String.IsNullOrWhiteSpace(snapshotId) ||
                snapshotId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                snapshotId == "." ||
                snapshotId == "..")
            {
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json has an invalid snapshotId.");
            }
            string manifestSha256 =
                GetString(pointer, "manifestSha256", null);
            if (!IsSha256Hex(manifestSha256))
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json has an invalid manifestSha256.");
            manifestSha256 = manifestSha256.ToLowerInvariant();

            string relative = GetString(pointer, "snapshotRelativePath", null);
            if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative))
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json has an invalid snapshotRelativePath.");
            string manifestRelative =
                GetString(pointer, "manifestRelativePath", null);
            if (String.IsNullOrWhiteSpace(manifestRelative) ||
                Path.IsPathRooted(manifestRelative))
            {
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json has an invalid manifestRelativePath.");
            }

            string root = Path.GetFullPath(outputRoot).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            string snapshotsDirectory = Path.GetFullPath(Path.Combine(
                root,
                "snapshots"));
            string combined = Path.GetFullPath(Path.Combine(
                root,
                relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!String.Equals(
                Path.GetDirectoryName(combined),
                snapshotsDirectory,
                StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(
                    Path.GetFileName(combined),
                    snapshotId,
                    StringComparison.Ordinal))
            {
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json does not bind snapshotId to one direct snapshots child.");
            }
            EnsureSnapshotPlainDirectory(
                snapshotsDirectory,
                "current_pointer_invalid",
                "The current snapshot parent directory");
            EnsureSnapshotPlainDirectory(
                combined,
                "current_pointer_invalid",
                "The current snapshot directory");

            string expectedManifestPath = Path.Combine(combined, "manifest.json");
            string manifestPath = Path.GetFullPath(Path.Combine(
                root,
                manifestRelative.Replace('/', Path.DirectorySeparatorChar)));
            if (!String.Equals(
                manifestPath,
                expectedManifestPath,
                StringComparison.OrdinalIgnoreCase))
            {
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "current.json manifestRelativePath does not identify the snapshot manifest.");
            }
            FileAttributes manifestAttributes = File.GetAttributes(manifestPath);
            if ((manifestAttributes & FileAttributes.Directory) != 0 ||
                (manifestAttributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "The current snapshot manifest is not one ordinary file.");
            }
            string actualManifestSha256 = FileSha256(manifestPath);
            if (!String.Equals(
                actualManifestSha256,
                manifestSha256,
                StringComparison.Ordinal))
            {
                throw new ProtocolException(
                    "current_pointer_invalid",
                    "The current snapshot manifest SHA-256 does not match current.json.");
            }
            return new PreviousSnapshotPointerState(
                true,
                snapshotId,
                manifestSha256,
                combined);
        }
        catch (ProtocolException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new ProtocolException(
                "current_pointer_read_failed",
                "Cannot read or verify current.json before snapshot export: " +
                SafeError(ex));
        }
    }

    private static bool IsSha256Hex(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length != 64) return false;
        foreach (char character in value)
        {
            bool digit = character >= '0' && character <= '9';
            bool lower = character >= 'a' && character <= 'f';
            bool upper = character >= 'A' && character <= 'F';
            if (!digit && !lower && !upper) return false;
        }
        return true;
    }

    private static string FileSha256(string path)
    {
        using (FileStream stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read))
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(stream);
            StringBuilder builder = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest) builder.Append(value.ToString("x2"));
            return builder.ToString();
        }
    }

    private static string CanonicalSnapshotOutputRoot(string outputRoot)
    {
        string full;
        try { full = Path.GetFullPath(outputRoot.Trim()); }
        catch (Exception ex)
        {
            throw new ProtocolException(
                "invalid_output_root",
                "Cannot canonicalize --output-root: " + SafeError(ex));
        }
        string volumeRoot = Path.GetPathRoot(full);
        if (String.Equals(
            full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            volumeRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
            StringComparison.OrdinalIgnoreCase))
        {
            throw new ProtocolException("invalid_output_root", "A filesystem root cannot be used as the snapshot output root.");
        }
        return full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static void EnsureSnapshotPlainDirectory(
        string directoryPath,
        string status,
        string label)
    {
        if (String.IsNullOrWhiteSpace(directoryPath) ||
            !Directory.Exists(directoryPath))
        {
            throw new ProtocolException(
                status,
                (label ?? "Snapshot directory") + " does not exist as a directory.");
        }
        FileAttributes attributes;
        try { attributes = File.GetAttributes(directoryPath); }
        catch (Exception ex)
        {
            throw new ProtocolException(
                status,
                "Cannot inspect " + (label ?? "snapshot directory") + ": " +
                SafeError(ex));
        }
        if ((attributes & FileAttributes.Directory) == 0)
        {
            throw new ProtocolException(
                status,
                (label ?? "Snapshot path") + " is not a directory.");
        }
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new ProtocolException(
                status,
                (label ?? "Snapshot directory") +
                " is a filesystem reparse point; refusing to follow it.");
        }
    }

    private static string EnsureSnapshotDirectChildDirectory(
        string outputRoot,
        string childName)
    {
        string root = Path.GetFullPath(outputRoot).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar);
        EnsureSnapshotPlainDirectory(
            root,
            "invalid_output_root",
            "The snapshot output root");
        string child = Path.GetFullPath(Path.Combine(root, childName)).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar);
        if (!String.Equals(
            Path.GetDirectoryName(child),
            root,
            StringComparison.OrdinalIgnoreCase))
        {
            throw new ProtocolException(
                "invalid_output_root",
                "The snapshot child directory escaped the output root.");
        }
        if (File.Exists(child) && !Directory.Exists(child))
        {
            throw new ProtocolException(
                "invalid_output_root",
                "The snapshot child path is occupied by a file: " + childName);
        }
        Directory.CreateDirectory(child);
        EnsureSnapshotPlainDirectory(
            child,
            "invalid_output_root",
            "The snapshot " + childName + " directory");
        return child;
    }

    private static void EnsureSnapshotOwnedStagingDirectory(
        string outputRoot,
        string stagingDirectory)
    {
        string root = Path.GetFullPath(outputRoot).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar);
        string staging = Path.GetFullPath(stagingDirectory).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar);
        if (!String.Equals(
            Path.GetDirectoryName(staging),
            root,
            StringComparison.OrdinalIgnoreCase) ||
            !SnapshotStagingDirectoryNameIsOwned(Path.GetFileName(staging)))
        {
            throw new ProtocolException(
                "snapshot_staging_unsafe",
                "The snapshot staging directory is not one owned direct child of the output root.");
        }
        EnsureSnapshotPlainDirectory(
            staging,
            "snapshot_staging_unsafe",
            "The snapshot staging directory");
    }

    private static void EnsureSnapshotTreeHasNoReparsePoints(
        string directoryPath)
    {
        EnsureSnapshotPlainDirectory(
            directoryPath,
            "snapshot_staging_unsafe",
            "The snapshot tree directory");
        foreach (string childPath in Directory.GetFileSystemEntries(directoryPath))
        {
            FileAttributes attributes = File.GetAttributes(childPath);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new ProtocolException(
                    "snapshot_staging_unsafe",
                    "A filesystem reparse point was found inside the snapshot tree.");
            }
            if ((attributes & FileAttributes.Directory) != 0)
                EnsureSnapshotTreeHasNoReparsePoints(childPath);
        }
    }

    private static Dictionary<string, object> CleanupStaleSnapshotStaging(
        string outputRoot)
    {
        DateTime cutoffUtc = DateTime.UtcNow.AddHours(-SnapshotStagingMaxAgeHours);
        List<object> errors = new List<object>();
        int scanned = 0;
        int removed = 0;
        int skippedRecent = 0;
        int skippedReparsePoint = 0;
        int skippedUnsafe = 0;
        try
        {
            string root = Path.GetFullPath(outputRoot).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            string[] candidates = Directory.GetDirectories(
                root,
                SnapshotStagingPrefix + "*",
                SearchOption.TopDirectoryOnly);
            Array.Sort(candidates, StringComparer.OrdinalIgnoreCase);
            foreach (string candidate in candidates)
            {
                scanned++;
                string reason;
                if (!SnapshotStagingTreeEligibleForCleanup(
                    root,
                    candidate,
                    cutoffUtc,
                    out reason))
                {
                    if (reason == "recent") skippedRecent++;
                    else if (reason == "reparse_point") skippedReparsePoint++;
                    else
                    {
                        skippedUnsafe++;
                        if (reason != "unsafe_name" &&
                            reason != "unsafe_path" &&
                            errors.Count < 20)
                        {
                            errors.Add(Map(
                                "directoryName", Path.GetFileName(candidate),
                                "error", reason));
                        }
                    }
                    continue;
                }

                try
                {
                    DeleteSnapshotTreeWithoutFollowingReparsePoints(candidate);
                    if (Directory.Exists(candidate))
                        throw new IOException("The stale staging directory still exists after bounded deletion.");
                    removed++;
                }
                catch (Exception ex)
                {
                    skippedUnsafe++;
                    if (errors.Count < 20)
                    {
                        errors.Add(Map(
                            "directoryName", Path.GetFileName(candidate),
                            "error", SafeError(ex)));
                    }
                }
            }
        }
        catch (Exception ex)
        {
            errors.Add(Map("directoryName", null, "error", SafeError(ex)));
        }
        return Map(
            "status", errors.Count == 0 ? "completed" : "partial_error",
            "prefix", SnapshotStagingPrefix,
            "minimumAgeHours", SnapshotStagingMaxAgeHours,
            "cutoffUtc", Utc(cutoffUtc),
            "scanned", scanned,
            "removed", removed,
            "skippedRecent", skippedRecent,
            "skippedReparsePoint", skippedReparsePoint,
            "skippedUnsafe", skippedUnsafe,
            "errors", errors,
            "directChildrenOnly", true,
            "reparsePointsFollowed", false);
    }

    private static bool SnapshotStagingTreeEligibleForCleanup(
        string canonicalOutputRoot,
        string candidatePath,
        DateTime cutoffUtc,
        out string reason)
    {
        try
        {
            string candidate = Path.GetFullPath(candidatePath).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            if (!String.Equals(
                Path.GetDirectoryName(candidate),
                canonicalOutputRoot,
                StringComparison.OrdinalIgnoreCase))
            {
                reason = "unsafe_path";
                return false;
            }
            string name = Path.GetFileName(candidate);
            if (!SnapshotStagingDirectoryNameIsOwned(name))
            {
                reason = "unsafe_name";
                return false;
            }

            Stack<string> pending = new Stack<string>();
            pending.Push(candidate);
            string candidatePrefix = candidate + Path.DirectorySeparatorChar;
            while (pending.Count > 0)
            {
                string current = Path.GetFullPath(pending.Pop()).TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar);
                if (!String.Equals(current, candidate, StringComparison.OrdinalIgnoreCase) &&
                    !current.StartsWith(candidatePrefix, StringComparison.OrdinalIgnoreCase))
                {
                    reason = "unsafe_path";
                    return false;
                }
                FileAttributes currentAttributes = File.GetAttributes(current);
                if ((currentAttributes & FileAttributes.ReparsePoint) != 0)
                {
                    reason = "reparse_point";
                    return false;
                }
                if (File.GetLastWriteTimeUtc(current) > cutoffUtc)
                {
                    reason = "recent";
                    return false;
                }

                foreach (string childPath in Directory.GetFileSystemEntries(current))
                {
                    string child = Path.GetFullPath(childPath);
                    if (!String.Equals(
                        Path.GetDirectoryName(child),
                        current,
                        StringComparison.OrdinalIgnoreCase))
                    {
                        reason = "unsafe_path";
                        return false;
                    }
                    FileAttributes attributes = File.GetAttributes(child);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        reason = "reparse_point";
                        return false;
                    }
                    if (File.GetLastWriteTimeUtc(child) > cutoffUtc)
                    {
                        reason = "recent";
                        return false;
                    }
                    if ((attributes & FileAttributes.Directory) != 0)
                        pending.Push(child);
                }
            }
            reason = "eligible";
            return true;
        }
        catch (Exception ex)
        {
            reason = "inspection_error:" + SafeError(ex);
            return false;
        }
    }

    private static bool SnapshotStagingDirectoryNameIsOwned(string name)
    {
        if (String.IsNullOrEmpty(name) ||
            !name.StartsWith(SnapshotStagingPrefix, StringComparison.Ordinal))
        {
            return false;
        }
        string suffix = name.Substring(SnapshotStagingPrefix.Length);
        Guid parsed;
        return Guid.TryParseExact(suffix, "N", out parsed);
    }

    private static void DeleteSnapshotTreeWithoutFollowingReparsePoints(
        string directoryPath)
    {
        FileAttributes rootAttributes = File.GetAttributes(directoryPath);
        if ((rootAttributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Refusing to delete a staging reparse point.");
        if ((rootAttributes & FileAttributes.Directory) == 0)
            throw new IOException("The staging cleanup target is not a directory.");

        foreach (string childPath in Directory.GetFileSystemEntries(directoryPath))
        {
            FileAttributes attributes = File.GetAttributes(childPath);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Refusing to follow a reparse point inside staging.");
            if ((attributes & FileAttributes.Directory) != 0)
                DeleteSnapshotTreeWithoutFollowingReparsePoints(childPath);
            else
                File.Delete(childPath);
        }
        Directory.Delete(directoryPath, false);
    }

    private static void DeleteOwnedSnapshotStaging(string outputRoot, string stagingDirectory)
    {
        try
        {
            string root = Path.GetFullPath(outputRoot).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            string staging = Path.GetFullPath(stagingDirectory).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            string parent = Path.GetDirectoryName(staging);
            string name = Path.GetFileName(staging);
            if (!String.Equals(parent, root, StringComparison.OrdinalIgnoreCase) ||
                !SnapshotStagingDirectoryNameIsOwned(name))
            {
                return;
            }
            if (Directory.Exists(staging))
                DeleteSnapshotTreeWithoutFollowingReparsePoints(staging);
        }
        catch
        {
            // A failed cleanup is bounded to this invocation's uniquely named
            // staging directory. Never broaden the deletion target.
        }
    }

    private static Dictionary<string, object> HandleReadEngineering(Dictionary<string, object> request, string requestId)
    {
        SessionRequest identity = ParseSessionRequest(request);
        SessionUse use = EnsureAttachedSession(identity, false, null, false, false);
        EngineeringReader reader = new EngineeringReader(
            Math.Max(1, Math.Min(20000, GetInt(request, "maxObjects", 5000))),
            GetBool(request, "includeScreens", false), use.Session.IdentifierProvider);
        reader.Visit(use.Session.Project, null, "Project", 0);
        // Recheck the exact process/project after traversal, without attaching or refreshing inventory.
        EnsureAttachedSession(identity, false, null, false, false);
        Dictionary<string, object> result = BasicResponse(requestId, true,
            reader.Issues.Count == 0 ? "read" : "partial", null);
        result["session"] = BuildSessionMap(use.Session, true, true);
        result["engineering"] = Map(
            "schemaVersion", 1,
            "capturedAtUtc", Utc(DateTime.UtcNow),
            "records", reader.Records,
            "issues", reader.Issues,
            "truncated", reader.Truncated,
            "includeScreens", reader.IncludeScreens,
            "consistency", "identity_rechecked_non_atomic_engineering_observation",
            "scope", "hardware_network_hmi_and_plc_tag_tables",
            "limitations", new string[] {
                "No PLC runtime values, online discovery, compile or project changes.",
                "PLC DB members and program bodies are not traversed; use exact block queries for those references.",
                "Only allowlisted readable attributes are returned; scripts, expressions and screen behavior are not executed or validated.",
                "Missing alarm collections on classic HMI targets are unsupported, not evidence of zero alarms."
            });
        result["safety"] = SafetyMap();
        return result;
    }

    private sealed class HmiTargetRecord
    {
        internal IEngineeringObject Software;
        internal string Name;
        internal string Path;
        internal object Identity() { return Map("name", Name, "path", Path, "type", Software.GetType().FullName); }
    }

    private static void FindHmiItems(DeviceItem item, string path, int depth, List<HmiTargetRecord> targets, HashSet<IEngineeringObject> seen)
    {
        if (depth > 40) throw new ProtocolException("inventory_too_deep", "HMI device hierarchy exceeds 40 levels.");
        SoftwareContainer container = item.GetService<SoftwareContainer>();
        if (container != null && container.Software != null &&
            container.Software.GetType().FullName.StartsWith("Siemens.Engineering.Hmi", StringComparison.Ordinal) && seen.Add(container.Software))
            targets.Add(new HmiTargetRecord { Software = container.Software, Name = container.Software.Name, Path = path });
        foreach (DeviceItem child in item.DeviceItems) FindHmiItems(child, JoinPath(path, child.Name), depth + 1, targets, seen);
    }

    private static void FindHmiDevice(Device device, string parent, List<HmiTargetRecord> targets, HashSet<IEngineeringObject> seen)
    {
        foreach (DeviceItem item in device.DeviceItems) FindHmiItems(item, JoinPath(JoinPath(parent, device.Name), item.Name), 0, targets, seen);
    }

    private static void FindHmiGroup(DeviceUserGroup group, string parent, int depth, List<HmiTargetRecord> targets, HashSet<IEngineeringObject> seen)
    {
        if (depth > 40) throw new ProtocolException("inventory_too_deep", "HMI group hierarchy exceeds 40 levels.");
        string path = JoinPath(parent, group.Name);
        foreach (Device device in group.Devices) FindHmiDevice(device, path, targets, seen);
        foreach (DeviceUserGroup child in group.Groups) FindHmiGroup(child, path, depth + 1, targets, seen);
    }

    private static Dictionary<string, object> HandleHmi(Dictionary<string, object> request, string requestId, bool read)
    {
        SessionRequest identity = ParseSessionRequest(request);
        SessionUse use = EnsureAttachedSession(identity, false, null, false, false);
        List<HmiTargetRecord> targets = new List<HmiTargetRecord>();
        HashSet<IEngineeringObject> seen = new HashSet<IEngineeringObject>(ReferenceComparer.Instance);
        foreach (DeviceUserGroup group in use.Session.Project.DeviceGroups) FindHmiGroup(group, "", 0, targets, seen);
        foreach (Device device in use.Session.Project.Devices) FindHmiDevice(device, "", targets, seen);
        string name = GetString(request, "hmiName", "");
        string path = GetString(request, "hmiPath", "");
        List<HmiTargetRecord> matches = targets.FindAll(t =>
            (String.IsNullOrEmpty(name) || String.Equals(t.Name, name, StringComparison.Ordinal)) &&
            (String.IsNullOrEmpty(path) || String.Equals(t.Path, path, StringComparison.Ordinal)));
        Dictionary<string, object> result = BasicResponse(requestId, !read || matches.Count == 1,
            !read ? "listed" : matches.Count == 0 ? "not_found" : matches.Count > 1 ? "ambiguous" : "read", null);
        result["targets"] = targets.ConvertAll<object>(t => t.Identity());
        result["session"] = BuildSessionMap(use.Session, true, false);
        if (read && matches.Count == 1) {
            string sectionString = GetString(request, "hmiSections", "alarms,tags,connections,screens,scripts");
            HashSet<string> sections = new HashSet<string>(sectionString.Split(','), StringComparer.Ordinal);
            foreach (string section in sections)
                if (section != "alarms" && section != "tags" && section != "connections" && section != "screens" && section != "scripts")
                    throw new ProtocolException("invalid_selector", "Unsupported HMI section.");
            EngineeringReader reader = new EngineeringReader(
                Math.Max(1, Math.Min(20000, GetInt(request, "maxObjects", 10000))), sections.Contains("screens"), use.Session.IdentifierProvider, sections);
            reader.Visit(matches[0].Software, null, "HmiSoftware", 0);
            result["target"] = matches[0].Identity();
            result["hmi"] = Map("schemaVersion", 1, "records", reader.Records, "issues", reader.Issues,
                "truncated", reader.Truncated, "sections", sectionString,
                "coverage", reader.HmiCoverage(),
                "consistency", "identity_rechecked_non_atomic_engineering_observation");
            result["status"] = reader.Issues.Count == 0 && !reader.Truncated ? "read" : "partial";
        }
        EnsureAttachedSession(identity, false, null, false, false);
        result["safety"] = SafetyMap();
        return result;
    }

    private sealed class EngineeringReader
    {
        internal readonly List<object> Records = new List<object>();
        internal readonly List<object> Issues = new List<object>();
        internal readonly bool IncludeScreens;
        internal bool Truncated;
        private readonly int Limit;
        private readonly Dictionary<IEngineeringObject, string> Ids =
            new Dictionary<IEngineeringObject, string>(ReferenceComparer.Instance);
        private readonly HashSet<string> Visited = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, string> OfficialIds = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly ObjectIdentifierProvider IdentifierProvider;
        private readonly HashSet<string> HmiSections;
        private readonly HashSet<string> HmiSectionsSeen = new HashSet<string>(StringComparer.Ordinal);
        private bool UnifiedReadUsed;
        // Unified GetAttributeInfos can abort Portal while resolving an unrelated
        // ConfirmationType property, before any attribute filter or catch runs.
        // Do not discover metadata or arbitrary scalar properties on this path.
        private static readonly string[] UnifiedAttributes = {
            "Name", "ScreenNumber", "Width", "Height", "Left", "Top", "BackColor", "ForeColor",
            "Size", "Text", "Culture", "DataType", "HmiDataType", "TagType", "ArraySize", "StartValue",
            "Connection", "PlcTag", "Station", "Partner", "Tag", "ReadOnly", "UseIndirectAddressing",
            "PropertyName", "EventType", "ScriptCode", "GlobalDefinitionAreaScriptCode", "Async",
            "Id", "AlarmClass", "Priority", "RaisedStateTag", "RaisedStateTagBitNumber", "TriggerMode"
        };
        private static readonly string[] UnifiedChildren = {
            "Screens", "ScreenGroups", "Groups", "ScreenItems", "TagTables", "TagGroups", "Tags",
            "Connections", "AlarmClasses", "DiscreteAlarms", "AnalogAlarms", "ScriptModules", "Functions",
            "Parameters", "EventHandlers", "Script", "Dynamizations", "Text", "Font", "Items",
            "EventText", "InfoText", "Comment"
        };
        private static readonly HashSet<string> Attributes = new HashSet<string>(new string[] {
            "Name", "TypeIdentifier", "OrderNumber", "FirmwareVersion", "PositionNumber",
            "Address", "SubnetMask", "RouterAddress", "UseRouter", "PnDeviceName", "DeviceName",
            "NodeId", "NodeType", "ConnectedSubnet", "ConnectedToIoSystem", "Number", "NetworkType",
            "IoType", "StartAddress", "Length", "DataTypeName", "DataType", "LogicalAddress",
            "Connection", "ConnectionName", "PlcTag", "PLCName", "PlcName", "Partner", "PartnerName",
            "PartnerAddress", "PartnerIPAddress", "Interface", "AcquisitionCycle", "AcquisitionMode",
            "ArraySize", "ArrayDimensions", "StartValue", "Id", "AlarmClass", "AlarmClassName",
            "TriggerTag", "TriggerBit", "TriggerMode", "RaisedStateTag", "RaisedStateTagBitNumber",
            "Node", "Station", "InitialAddress", "CommunicationDriver", "DisabledAtStartup",
            "AcknowledgmentControlTag", "AcknowledgmentControlTagBitNumber", "AcknowledgmentStateTag", "AcknowledgmentStateTagBitNumber",
            "HmiDataType", "TagType", "TagTableName", "PlcStartValue", "PlcEndValue", "HmiStartValue", "HmiEndValue", "LinearScaling",
            "AcknowledgementTag", "AcknowledgementBit", "AcknowledgementBitNumber",
            "AcknowledgementPlcTag", "AcknowledgementHmiTag", "AcknowledgementPlcBit", "AcknowledgementHmiBit",
            "Limit", "LimitValue", "LimitMode", "Deadband", "Priority", "EventText", "AlarmText", "InfoText",
            "Text", "Culture", "Language", "Tag", "TagName", "ProcessValue", "ReadOnly",
            "UpdateTime", "WatchdogTime", "IoSystem", "Comment"
        }, StringComparer.Ordinal);
        private static readonly HashSet<string> HardwareCompositions = new HashSet<string>(new string[] {
            "Devices", "DeviceGroups", "Groups", "DeviceItems", "Subnets", "Nodes",
            "Addresses", "IoControllers", "IoConnectors", "IoSystems"
        }, StringComparer.Ordinal);
        private static readonly HashSet<string> PlcCompositions = new HashSet<string>(new string[] {
            "TagTableGroup", "TagTableGroups", "Groups", "TagTables", "Tags"
        }, StringComparer.Ordinal);

        internal EngineeringReader(int limit, bool screens, ObjectIdentifierProvider provider, HashSet<string> hmiSections = null)
        { Limit = limit; IncludeScreens = screens; IdentifierProvider = provider; HmiSections = hmiSections; }

        private static bool SensitiveHmiField(string name)
        {
            return System.Text.RegularExpressions.Regex.IsMatch(name, "password|secret|credential|privatekey|certificate|usermanagement|useradministration|audit", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        }

        private static string HmiSection(string name)
        {
            if (name.IndexOf("Alarm", StringComparison.OrdinalIgnoreCase) >= 0) return "alarms";
            if (name.IndexOf("Tag", StringComparison.OrdinalIgnoreCase) >= 0) return "tags";
            if (name.IndexOf("Connection", StringComparison.OrdinalIgnoreCase) >= 0) return "connections";
            if (name.IndexOf("Screen", StringComparison.OrdinalIgnoreCase) >= 0) return "screens";
            if (name.IndexOf("Script", StringComparison.OrdinalIgnoreCase) >= 0) return "scripts";
            return null;
        }

        internal object HmiCoverage()
        {
            List<object> sections = new List<object>();
            foreach (string section in HmiSections) sections.Add(Map("section", section,
                "state", HmiSectionsSeen.Contains(section) ? "exposed" : "unavailable",
                "meaning", "Only public API objects and readable properties; absence of an exposed collection is not zero configured objects."));
            return Map("sections", sections, "completeEngineeringBackup", false,
                "unifiedReadMode", UnifiedReadUsed ? "explicit_public_property_allowlist" : null,
                "buttonBehaviorVerified", false, "scriptsExecuted", false,
                "limitations", new string[] { "Not an importable WinCC project archive.",
                    "Event handlers, dynamic bindings and script text are included only when exposed by the installed API; omitted/unreadable attributes remain explicit.",
                    "No PLC runtime or physical behavior verification." });
        }

        private string Id(IEngineeringObject value, bool unified = false)
        {
            string id;
            if (!Ids.TryGetValue(value, out id)) {
                string official = null;
                try { if (!unified && IdentifierProvider != null) official = IdentifierProvider.GetIdentifier(value); } catch { }
                if (String.IsNullOrEmpty(official) || !OfficialIds.TryGetValue(official, out id)) {
                    id = "e" + (Ids.Count + 1);
                    if (!String.IsNullOrEmpty(official)) OfficialIds[official] = id;
                }
                Ids.Add(value, id);
            }
            return id;
        }

        private void Issue(string path, string status, string detail)
        {
            if (Issues.Count < 200) Issues.Add(Map("path", path, "status", status, "detail", detail));
        }

        private object Value(object value, string path, bool unified = false)
        {
            if (value == null) return null;
            IEngineeringObject target = value as IEngineeringObject;
            if (target != null) return Map("refId", Id(target, unified), "type", target.GetType().FullName);
            Type type = value.GetType();
            if (value is string) {
                string text = (string)value;
                int textLimit = HmiSections == null ? 2000 : 100000;
                if (text.Length > textLimit) { Issue(path, "text_truncated", "Attribute exceeds the bounded text limit."); return text.Substring(0, textLimit); }
                return text;
            }
            if (type.IsEnum || value is CultureInfo || value is Guid) return Convert.ToString(value, CultureInfo.InvariantCulture);
            if (type.IsPrimitive || value is decimal) return value;
            Issue(path, "unsupported_value", type.FullName);
            return Map("unsupportedType", type.FullName);
        }

        private void ReadUnified(IEngineeringObject obj, string id, int depth,
            Dictionary<string, object> attributes, List<string> unreadable, List<string> collections)
        {
            if (!UnifiedReadUsed) {
                UnifiedReadUsed = true;
                Issue(id, "unified_property_coverage_limited",
                    "Unified uses an explicit public-property allowlist to avoid Portal metadata-enumeration crashes. Other attributes and collections were not inspected.");
            }
            Dictionary<string, object> values = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (string name in UnifiedAttributes) {
                PropertyInfo property = obj.GetType().GetProperty(name);
                if (property == null || !property.CanRead || property.GetIndexParameters().Length != 0) continue;
                try {
                    object value = property.GetValue(obj, null);
                    values[name] = value;
                    attributes[name] = Value(value, id + "." + name, true);
                }
                catch (Exception ex) { unreadable.Add(name); Issue(id + "." + name, "property_unreadable", SafeError(ex)); }
            }
            foreach (string name in UnifiedChildren) {
                if (Truncated) break;
                string section = HmiSection(name);
                if (!IncludeScreens && section == "screens") continue;
                if (HmiSections != null && depth == 0 && (section == null || !HmiSections.Contains(section))) continue;
                PropertyInfo property = obj.GetType().GetProperty(name);
                if (property == null || !property.CanRead || property.GetIndexParameters().Length != 0) continue;
                collections.Add(name);
                try {
                    object value;
                    if (!values.TryGetValue(name, out value)) value = property.GetValue(obj, null);
                    // A getter that failed does not establish an exposed section.
                    if (HmiSections != null && depth == 0 && section != null) HmiSectionsSeen.Add(section);
                    IEngineeringObject child = value as IEngineeringObject;
                    if (child != null) Visit(child, id, name, depth + 1, true);
                    else if (!(value is string) && value is System.Collections.IEnumerable) {
                        foreach (object item in (System.Collections.IEnumerable)value) {
                            Visit(item as IEngineeringObject, id, name, depth + 1, true);
                            if (Truncated) break;
                        }
                    }
                } catch (Exception ex) { Issue(id + "/" + name, "collection_unreadable", SafeError(ex)); }
            }
        }

        internal void Visit(IEngineeringObject obj, string parent, string relation, int depth, bool unified = false)
        {
            if (obj == null) return;
            unified = unified || obj.GetType().FullName.StartsWith("Siemens.Engineering.HmiUnified.", StringComparison.Ordinal);
            string id = Id(obj, unified);
            if (Visited.Contains(id)) return;
            if (Records.Count >= Limit || depth > 40) {
                Truncated = true; Issue(parent, "truncated", "Object or depth limit reached; narrow scope or raise maxObjects."); return;
            }
            Visited.Add(id);
            string type = obj.GetType().FullName;
            Dictionary<string, object> attributes = new Dictionary<string, object>();
            List<string> unreadable = new List<string>();
            List<string> omitted = new List<string>();
            List<string> collections = new List<string>();
            Dictionary<string, object> record = Map("id", id, "parentId", parent,
                "relation", relation, "type", type, "attributes", attributes,
                "unreadableAttributes", unreadable, "omittedAttributes", omitted,
                "collections", collections);
            Records.Add(record);
            // Propagate the safe path to shared multilingual/script child types,
            // not just classes whose namespace happens to contain HmiUnified.
            if (unified) {
                record["attributeReadMode"] = "explicit_public_property_allowlist";
                ReadUnified(obj, id, depth, attributes, unreadable, collections);
                return;
            }
            try {
                foreach (EngineeringAttributeInfo info in obj.GetAttributeInfos()) {
                    if (HmiSections == null ? !Attributes.Contains(info.Name) : SensitiveHmiField(info.Name)) { omitted.Add(info.Name); continue; }
                    if ((info.AccessMode & EngineeringAttributeAccessMode.Read) == 0) continue;
                    try { attributes[info.Name] = Value(obj.GetAttribute(info.Name), id + "." + info.Name); }
                    catch (Exception ex) { unreadable.Add(info.Name); Issue(id + "." + info.Name, "attribute_unreadable", SafeError(ex)); }
                }
            } catch (Exception ex) { Issue(id, "attributes_unavailable", SafeError(ex)); }

            foreach (string name in Attributes) {
                if (attributes.ContainsKey(name) || unreadable.Contains(name)) continue;
                PropertyInfo property = obj.GetType().GetProperty(name);
                if (property == null || !property.CanRead || property.GetIndexParameters().Length != 0) continue;
                try { attributes[name] = Value(property.GetValue(obj, null), id + "." + name); }
                catch (Exception ex) { unreadable.Add(name); Issue(id + "." + name, "property_unreadable", SafeError(ex)); }
            }

            if (HmiSections != null) foreach (PropertyInfo property in obj.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance)) {
                string name = property.Name;
                if (attributes.ContainsKey(name) || unreadable.Contains(name) || SensitiveHmiField(name) ||
                    !property.CanRead || property.GetIndexParameters().Length != 0) continue;
                Type valueType = property.PropertyType;
                if (!(valueType.IsPrimitive || valueType.IsEnum || valueType == typeof(string) ||
                    valueType == typeof(decimal) || valueType == typeof(CultureInfo))) continue;
                try { attributes[name] = Value(property.GetValue(obj, null), id + "." + name); }
                catch (Exception ex) { unreadable.Add(name); Issue(id + "." + name, "property_unreadable", SafeError(ex)); }
            }

            bool hmi = type.StartsWith("Siemens.Engineering.Hmi", StringComparison.Ordinal);
            bool plc = type.StartsWith("Siemens.Engineering.SW", StringComparison.Ordinal);
            try {
                foreach (EngineeringCompositionInfo info in obj.GetCompositionInfos()) {
                    collections.Add(info.Name);
                    bool screen = info.Name.IndexOf("Screen", StringComparison.OrdinalIgnoreCase) >= 0;
                    bool allowed = HmiSections != null
                        ? !SensitiveHmiField(info.Name) && (depth > 0 || HmiSection(info.Name) != null && HmiSections.Contains(HmiSection(info.Name)))
                        : hmi
                        ? (IncludeScreens || !screen) && info.Name.IndexOf("Script", StringComparison.OrdinalIgnoreCase) < 0 &&
                          info.Name.IndexOf("User", StringComparison.OrdinalIgnoreCase) < 0 &&
                          info.Name.IndexOf("Audit", StringComparison.OrdinalIgnoreCase) < 0
                        : plc ? PlcCompositions.Contains(info.Name)
                        : type.StartsWith("Siemens.Engineering.MultilingualText", StringComparison.Ordinal) ? info.Name == "Items"
                        : HardwareCompositions.Contains(info.Name);
                    if (!allowed) continue;
                    if (HmiSections != null && depth == 0 && HmiSection(info.Name) != null) HmiSectionsSeen.Add(HmiSection(info.Name));
                    try {
                        object composition = obj.GetComposition(info.Name);
                        IEngineeringObject single = composition as IEngineeringObject;
                        System.Collections.IEnumerable children = composition as System.Collections.IEnumerable;
                        if (single != null) Visit(single, id, info.Name, depth + 1);
                        else if (children != null) foreach (object child in children) {
                            Visit(child as IEngineeringObject, id, info.Name, depth + 1);
                            if (Truncated) break;
                        }
                        else if (composition != null) Issue(id + "/" + info.Name, "composition_unavailable", composition.GetType().FullName);
                    } catch (Exception ex) { Issue(id + "/" + info.Name, "collection_unreadable", SafeError(ex)); }
                    if (Truncated) break;
                }
            } catch (Exception ex) { Issue(id, "collections_unavailable", SafeError(ex)); }

            // Single child properties and services are not necessarily compositions.
            string[] properties = hmi ? new string[] { "TagFolder", "ScreenFolder", "ScreenTemplateFolder", "ScreenPopupFolder", "ScreenSlideinFolder" }
                : plc ? new string[] { "TagTableGroup" }
                : obj is Project ? new string[] { "UngroupedDevicesGroup" } : new string[0];
            foreach (string name in properties) {
                if (!IncludeScreens && name.StartsWith("Screen", StringComparison.Ordinal)) continue;
                if (HmiSections != null && depth == 0 && (HmiSection(name) == null || !HmiSections.Contains(HmiSection(name)))) continue;
                PropertyInfo property = obj.GetType().GetProperty(name);
                if (property == null) continue;
                if (HmiSections != null && depth == 0) HmiSectionsSeen.Add(HmiSection(name));
                try { Visit(property.GetValue(obj, null) as IEngineeringObject, id, name, depth + 1); }
                catch (Exception ex) { Issue(id + "/" + name, "property_unreadable", SafeError(ex)); }
            }
            foreach (string name in new string[] { "EventText", "AlarmText", "InfoText", "Comment", "EventText1", "EventText2", "EventText3", "EventText4", "EventText5", "EventText6", "EventText7", "EventText8", "EventText9" }) {
                PropertyInfo property = obj.GetType().GetProperty(name);
                if (property == null || !property.CanRead || property.GetIndexParameters().Length != 0) continue;
                try { Visit(property.GetValue(obj, null) as IEngineeringObject, id, name, depth + 1); }
                catch (Exception ex) { Issue(id + "/" + name, "text_unreadable", SafeError(ex)); }
            }
            DeviceItem item = obj as DeviceItem;
            if (item != null && !Truncated) {
                try {
                    SoftwareContainer software = item.GetService<SoftwareContainer>();
                    if (software != null) Visit(software.Software, id, "Software", depth + 1);
                } catch (Exception ex) { Issue(id, "software_unreadable", SafeError(ex)); }
                try { Visit(item.GetService<NetworkInterface>(), id, "NetworkInterface", depth + 1); }
                catch (Exception ex) { Issue(id, "network_unreadable", SafeError(ex)); }
            }
            if (type == "Siemens.Engineering.Hmi.HmiTarget" && !collections.Contains("DiscreteAlarms"))
                Issue(id, "classic_hmi_alarms_unsupported", "This HmiTarget API does not expose an alarm collection; alarm analysis requires a separate engineering export.");
        }
    }

    private static Dictionary<string, object> HandleSearchObjects(Dictionary<string, object> request, string requestId)
    {
        Stopwatch timer = Stopwatch.StartNew();
        ObjectKind? kind = ParseObjectKind(GetString(request, "resourceKind", "block"));
        if (!kind.HasValue) throw new ProtocolException("invalid_selector", "A valid resourceKind is required.");
        SessionUse use = EnsureAttachedSession(ParseSessionRequest(request), GetBool(request, "refreshInventory", false), kind, true, false);
        string query = GetString(request, "query", "");
        string softwarePath = GetString(request, "softwarePath", "");
        string blockKind = GetString(request, "blockKind", "");
        int? number = GetNullableInt(request, "number");
        int offset = Bound(GetInt(request, "offset", 0), 0, 1000000);
        int limit = Bound(GetInt(request, "maxResults", 50), 1, 200);
        List<object> matches = new List<object>();
        int count = 0;
        foreach (ObjectRecord record in use.Session.Inventory)
        {
            if (record.Kind != kind.Value) continue;
            if (!String.IsNullOrEmpty(softwarePath) && !String.Equals(record.SoftwarePath, softwarePath, StringComparison.OrdinalIgnoreCase)) continue;
            if (!String.IsNullOrEmpty(blockKind) && !BlockKindMatches(record, blockKind)) continue;
            if (number.HasValue && record.Number != number) continue;
            if (!String.IsNullOrEmpty(query) && record.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0 &&
                (record.GroupPath ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (count++ < offset || matches.Count >= limit) continue;
            matches.Add(BuildRecordIdentity(use.Session, record));
        }
        Dictionary<string, object> result = BasicResponse(requestId, true, "searched", null);
        result["session"] = BuildSessionMap(use.Session, use.SessionReused, use.InventoryReused);
        result["matches"] = matches;
        result["totalMatches"] = count;
        result["nextOffset"] = offset + matches.Count < count ? (object)(offset + matches.Count) : null;
        result["searchScope"] = "inventory names and group paths; no program-body or comment scan";
        result["timings"] = Map("inventory", use.InventoryMilliseconds, "total", timer.ElapsedMilliseconds);
        return result;
    }

    private static Dictionary<string, object> HandleQueryObject(Dictionary<string, object> request, string requestId)
    {
        Stopwatch total = Stopwatch.StartNew();
        Dictionary<string, object> timings = new Dictionary<string, object>();
        SessionRequest sessionRequest = ParseSessionRequest(request);
        QueryOptions options = ParseOptions(request);
        ObjectSelector selector = ParseObjectSelector(request);

        Stopwatch phase = Stopwatch.StartNew();
        SessionUse sessionUse = EnsureAttachedSession(sessionRequest, options.RefreshInventory, selector.Kind, true, false);
        long sessionValidationMilliseconds = phase.ElapsedMilliseconds;
        long inventoryMilliseconds = sessionUse.InventoryMilliseconds;
        timings["sessionValidationAndAttach"] = sessionValidationMilliseconds;
        timings["attach"] = sessionUse.AttachMilliseconds;
        timings["inventory"] = inventoryMilliseconds;

        phase.Restart();
        List<ObjectRecord> matches = ResolveObject(sessionUse.Session, selector);
        long resolveMilliseconds = phase.ElapsedMilliseconds;
        bool notFoundRefreshAttempted = false;

        // A hot lookup may have used a still-fresh cached inventory immediately
        // before Portal changed. On a cache miss, rebuild only this resource kind
        // once and resolve once more. A newly built/stale-TTL-refreshed inventory
        // is never rebuilt again by the same request.
        if (
            matches.Count == 0 &&
            options.RetryNotFoundWithRefresh &&
            sessionUse.InventoryReused)
        {
            notFoundRefreshAttempted = true;
            phase.Restart();
            SessionUse refreshedSessionUse = EnsureAttachedSession(
                sessionRequest,
                true,
                selector.Kind,
                true,
                false);
            sessionValidationMilliseconds += phase.ElapsedMilliseconds;
            inventoryMilliseconds += refreshedSessionUse.InventoryMilliseconds;
            sessionUse = refreshedSessionUse;

            phase.Restart();
            matches = ResolveObject(sessionUse.Session, selector);
            resolveMilliseconds += phase.ElapsedMilliseconds;
        }
        timings["sessionValidationAndAttach"] = sessionValidationMilliseconds;
        timings["inventory"] = inventoryMilliseconds;
        timings["resolve"] = resolveMilliseconds;
        timings["notFoundRefreshAttempted"] = notFoundRefreshAttempted;
        bool inventoryRefreshForced =
            options.RefreshInventory ||
            notFoundRefreshAttempted;

        if (matches.Count == 0)
        {
            Dictionary<string, object> missing = BasicResponse(requestId, false, "not_found", "No exact object matched in the verified project inventory.");
            missing["session"] = BuildSessionMap(sessionUse.Session, sessionUse.SessionReused, sessionUse.InventoryReused);
            missing["objectResolution"] = BuildResolutionMap(selector, matches);
            missing["inventoryRefreshedAfterMiss"] = notFoundRefreshAttempted;
            missing["inventoryRefreshForced"] = inventoryRefreshForced;
            timings["total"] = total.ElapsedMilliseconds;
            missing["timings"] = timings;
            return missing;
        }
        if (matches.Count > 1)
        {
            Dictionary<string, object> ambiguous = BasicResponse(requestId, false, "ambiguous", "The selector matched more than one object; add softwarePath, namespace, or number.");
            ambiguous["session"] = BuildSessionMap(sessionUse.Session, sessionUse.SessionReused, sessionUse.InventoryReused);
            ambiguous["objectResolution"] = BuildResolutionMap(selector, matches);
            ambiguous["matches"] = BuildMatchList(sessionUse.Session, matches, 50);
            ambiguous["inventoryRefreshedAfterMiss"] = notFoundRefreshAttempted;
            ambiguous["inventoryRefreshForced"] = inventoryRefreshForced;
            timings["total"] = total.ElapsedMilliseconds;
            ambiguous["timings"] = timings;
            return ambiguous;
        }

        ObjectRecord record = matches[0];
        Dictionary<string, object> objectResult = new Dictionary<string, object>();
        objectResult["identity"] = BuildRecordIdentity(sessionUse.Session, record);

        phase.Restart();
        objectResult["attributes"] = ReadAllowlistedAttributes(record);
        timings["attributes"] = phase.ElapsedMilliseconds;

        phase.Restart();
        objectResult["interface"] = options.IncludeInterface
            ? ReadDirectInterface(record, options.MaxInterfaceMembers)
            : Map("available", false, "status", "not_requested");
        timings["interface"] = phase.ElapsedMilliseconds;

        Dictionary<string, object> response = BasicResponse(requestId, true, "resolved", null);
        response["session"] = BuildSessionMap(sessionUse.Session, sessionUse.SessionReused, sessionUse.InventoryReused);
        response["objectResolution"] = BuildResolutionMap(selector, matches);
        response["object"] = objectResult;
        response["inventoryRefreshedAfterMiss"] = notFoundRefreshAttempted;
        response["inventoryRefreshForced"] = inventoryRefreshForced;

        phase.Restart();
        Dictionary<string, object> crossReferenceResult = options.IncludeCrossReferences
            ? ReadCrossReferences(sessionUse.Session, record, options)
            : Map("included", false, "status", "not_requested");
        response["crossReferences"] = crossReferenceResult;
        timings["crossReferences"] = phase.ElapsedMilliseconds;

        phase.Restart();
        Dictionary<string, object> interfaceResult = (Dictionary<string, object>)objectResult["interface"];
        bool interfaceReadDirectly = String.Equals(
            GetString(interfaceResult, "status", null),
            "direct_public_property",
            StringComparison.Ordinal);
        bool interfaceTruncated = GetBool(interfaceResult, "truncated", false);
        bool interfaceRequiresFullSchemaExport = GetBool(
            interfaceResult,
            "fullDatatypeAndStartValueSchemaRequiresExport",
            false);
        bool interfaceNeedsBlockXmlFallback =
            options.IncludeInterface &&
            record.Kind == ObjectKind.Block &&
            (!interfaceReadDirectly || interfaceTruncated || interfaceRequiresFullSchemaExport);
        bool exportBlockXml = options.IncludeXml || interfaceNeedsBlockXmlFallback;
        Dictionary<string, object> blockXmlResult = exportBlockXml
            ? ExportOneBlockTemporarily(record, options.MaxXmlBytes)
            : options.IncludeInterface && interfaceReadDirectly
                ? Map(
                    "included", false,
                    "status", interfaceTruncated ? "not_used_direct_interface_truncated" : "not_needed_direct_interface",
                    "reason", interfaceTruncated
                        ? "DataBlock.Interface.Members was read directly but reached maxInterfaceMembers; no implicit DB XML export was performed."
                        : "DataBlock.Interface.Members completed directly and no program body or explicit block XML was requested.")
                : Map("included", false, "status", "not_requested");
        response["blockXml"] = blockXmlResult;
        timings["blockXml"] = phase.ElapsedMilliseconds;

        Dictionary<string, object> completeness = BuildQueryCompleteness(
            options,
            interfaceResult,
            crossReferenceResult,
            blockXmlResult);
        bool requestedActionCompleted = GetBool(completeness, "requestedActionCompleted", false);
        response["status"] = requestedActionCompleted ? "resolved" : "partial";
        response["requestedActionCompleted"] = requestedActionCompleted;
        response["completeness"] = completeness;

        response["provenance"] = Map(
            "sessionSelection", "exact TiaPortal.GetProcess(pid, timeout) plus exact canonical Project.Path verification",
            "inventory", "direct " + TiaNativeTarget.PortalVersion + " public object compositions, cached only for the exact attached session",
            "attributes", "fixed allowlisted public getters only",
            "interface", options.IncludeInterface
                ? "direct DataBlock.Interface.Members plus one-block XML when the requested full schema is not public"
                : "not requested",
            "crossReferences", options.IncludeCrossReferences ? "CrossReferenceService.GetCrossReferences(AllObjects)" : "not requested",
            "blockXml", exportBlockXml
                ? interfaceNeedsBlockXmlFallback && !options.IncludeXml
                    ? "one-block temporary XML fallback because the requested complete block interface is not fully available from public typed properties"
                    : "single PlcBlock.Export to a unique temporary file, inlined then deleted"
                : options.IncludeInterface && interfaceReadDirectly
                    ? interfaceTruncated
                        ? "skipped because DataBlock.Interface.Members was available directly; bounded truncation is reported as partial"
                        : "skipped because DataBlock.Interface.Members completed directly"
                    : "not requested",
            "blockXmlExported", exportBlockXml,
            "interfaceXmlFallback", interfaceNeedsBlockXmlFallback,
            "preGeneratedIndex", false,
            "persistentExport", false);
        response["limits"] = options.ToMap();
        response["safety"] = SafetyMap();
        timings["total"] = total.ElapsedMilliseconds;
        response["timings"] = timings;
        return response;
    }

    private static Dictionary<string, object> BuildQueryCompleteness(
        QueryOptions options,
        Dictionary<string, object> interfaceResult,
        Dictionary<string, object> crossReferenceResult,
        Dictionary<string, object> blockXmlResult)
    {
        List<object> incomplete = new List<object>();
        bool xmlIncluded = GetBool(blockXmlResult, "included", false) &&
            String.Equals(GetString(blockXmlResult, "status", null), "included", StringComparison.Ordinal);

        if (options.IncludeInterface)
        {
            string interfaceStatus = GetString(interfaceResult, "status", "unknown");
            bool interfaceDirect = String.Equals(interfaceStatus, "direct_public_property", StringComparison.Ordinal);
            bool interfaceTruncated = GetBool(interfaceResult, "truncated", false);
            bool interfaceRequiresFullSchemaExport = GetBool(
                interfaceResult,
                "fullDatatypeAndStartValueSchemaRequiresExport",
                false);
            bool interfaceComplete =
                xmlIncluded ||
                (interfaceDirect && !interfaceTruncated && !interfaceRequiresFullSchemaExport);
            if (!interfaceComplete)
            {
                incomplete.Add(Map(
                    "component", "interface",
                    "status", interfaceTruncated ? "truncated" : interfaceStatus,
                    "reason", GetString(
                        interfaceResult,
                        "reason",
                        GetString(
                            interfaceResult,
                            "error",
                            interfaceRequiresFullSchemaExport
                                ? "The direct DB member-name list is incomplete and the required one-block XML schema was not included."
                                : interfaceTruncated
                                    ? "DataBlock.Interface.Members exceeded maxInterfaceMembers and no complete one-block XML schema was included."
                                    : "No direct public interface and no included one-object XML fallback."))));
            }
        }

        if (options.IncludeCrossReferences)
        {
            string crossStatus = GetString(crossReferenceResult, "status", "unknown");
            Dictionary<string, object> crossTruncation = GetMap(crossReferenceResult, "truncated");
            bool crossReferencesTruncated =
                GetBool(crossTruncation, "sources", false) ||
                GetBool(crossTruncation, "references", false) ||
                GetBool(crossTruncation, "locations", false) ||
                GetBool(crossTruncation, "depth", false);
            if (String.Equals(crossStatus, "queried", StringComparison.Ordinal) && crossReferencesTruncated)
            {
                incomplete.Add(Map(
                    "component", "crossReferences",
                    "status", "truncated",
                    "reason", "Cross-reference traversal reached one or more requested safety bounds.",
                    "details", crossTruncation));
            }
            else if (!String.Equals(crossStatus, "queried", StringComparison.Ordinal))
            {
                incomplete.Add(Map(
                    "component", "crossReferences",
                    "status", crossStatus,
                    "reason", GetString(crossReferenceResult, "error", "CrossReferenceService did not complete the requested query.")));
            }
        }

        if (options.IncludeXml)
        {
            string xmlStatus = GetString(blockXmlResult, "status", "unknown");
            if (!xmlIncluded)
            {
                incomplete.Add(Map(
                    "component", options.IncludeProgramBody ? "programBody" : "blockXml",
                    "status", xmlStatus,
                    "reason", GetString(blockXmlResult, "reason", GetString(blockXmlResult, "error", "The requested one-object XML was not included."))));
            }
        }

        return Map(
            "objectResolved", true,
            "requestedActionCompleted", incomplete.Count == 0,
            "incompleteComponents", incomplete,
            "requested", Map(
                "interface", options.IncludeInterface,
                "crossReferences", options.IncludeCrossReferences,
                "programBody", options.IncludeProgramBody,
                "blockXml", options.IncludeXml));
    }

    private static Dictionary<string, object> HandleNavigateObject(Dictionary<string, object> request, string requestId)
    {
        Stopwatch total = Stopwatch.StartNew();
        Dictionary<string, object> timings = new Dictionary<string, object>();
        Dictionary<string, object> optionsMap = GetMap(request, "options");
        bool confirmed = GetBool(
            request,
            "confirmNavigation",
            GetBool(optionsMap, "confirmNavigation", false));
        if (!confirmed)
        {
            Dictionary<string, object> denied = BasicResponse(requestId, false, "confirmation_required", "navigate_object requires confirmNavigation=true.");
            denied["navigation"] = Map(
                "openedObject", false,
                "openedRequestedObject", false,
                "actualOpenedResourceKind", null,
                "locatedNetwork", false,
                "locationApplied", false,
                "projectMutation", false);
            return denied;
        }

        SessionRequest sessionRequest = ParseSessionRequest(request);
        ObjectSelector selector = ParseObjectSelector(request);
        Stopwatch phase = Stopwatch.StartNew();
        // Navigation is a UI-state action. Rebuild the current typed inventory
        // immediately before resolving so stale names cannot bypass ambiguity.
        SessionUse sessionUse = EnsureAttachedSession(sessionRequest, true, selector.Kind, true, false);
        timings["sessionValidationAndAttach"] = phase.ElapsedMilliseconds;
        timings["attach"] = sessionUse.AttachMilliseconds;
        timings["inventory"] = sessionUse.InventoryMilliseconds;

        phase.Restart();
        List<ObjectRecord> matches = ResolveObject(sessionUse.Session, selector);
        timings["resolve"] = phase.ElapsedMilliseconds;
        if (matches.Count == 0)
        {
            Dictionary<string, object> missing = BasicResponse(requestId, false, "not_found", "No exact object matched in the verified project inventory.");
            missing["session"] = BuildSessionMap(sessionUse.Session, sessionUse.SessionReused, sessionUse.InventoryReused);
            missing["objectResolution"] = BuildResolutionMap(selector, matches);
            return missing;
        }
        if (matches.Count > 1)
        {
            Dictionary<string, object> ambiguous = BasicResponse(requestId, false, "ambiguous", "Navigation refused because the selector is ambiguous.");
            ambiguous["session"] = BuildSessionMap(sessionUse.Session, sessionUse.SessionReused, sessionUse.InventoryReused);
            ambiguous["objectResolution"] = BuildResolutionMap(selector, matches);
            ambiguous["matches"] = BuildMatchList(sessionUse.Session, matches, 50);
            return ambiguous;
        }

        ObjectRecord record = matches[0];
        string requestedLocation = GetString(optionsMap, "referenceLocation", GetString(request, "referenceLocation", null));
        phase.Restart();
        Dictionary<string, object> navigation;
        string status;

        if (record.Kind == ObjectKind.Block)
        {
            ((PlcBlock)record.Value).ShowInEditor();
            bool partial = !String.IsNullOrWhiteSpace(requestedLocation);
            status = partial ? "partial" : "opened_object";
            navigation = NavigationResult(record, record, true, "object", partial, requestedLocation);
            navigation["programmingLanguage"] = ((PlcBlock)record.Value).ProgrammingLanguage.ToString();
        }
        else if (record.Kind == ObjectKind.PlcType)
        {
            // V20 exposes the fixed public method on PlcType, even though this
            // class is not advertised as IShowable by reflection.
            ((PlcType)record.Value).ShowInEditor();
            bool partial = !String.IsNullOrWhiteSpace(requestedLocation);
            status = partial ? "partial" : "opened_object";
            navigation = NavigationResult(record, record, true, "object", partial, requestedLocation);
        }
        else if (record.Kind == ObjectKind.TagTable)
        {
            ((PlcTagTable)record.Value).ShowInEditor();
            bool partial = !String.IsNullOrWhiteSpace(requestedLocation);
            status = partial ? "partial" : "opened_object";
            navigation = NavigationResult(record, record, true, "tag_table", partial, requestedLocation);
        }
        else if (record.Kind == ObjectKind.PlcTag && record.ParentTable != null)
        {
            record.ParentTable.ShowInEditor();
            ObjectRecord parentRecord = FindRecordForValue(sessionUse.Session, record.ParentTable);
            status = "partial";
            navigation = NavigationResult(record, parentRecord, true, "tag_table", true, requestedLocation);
            navigation["reason"] = "V20 has no PlcTag.ShowInEditor; the exact parent tag table was opened, but no tag row was claimed.";
            navigation["exactTagSelectionSupported"] = false;
        }
        else
        {
            status = "unsupported";
            navigation = Map(
                "openedObject", false,
                "openedRequestedObject", false,
                "actualOpenedResourceKind", null,
                "locatedNetwork", false,
                "locationApplied", false,
                "requestedObject", BuildRecordIdentity(sessionUse.Session, record),
                "reason", "The resolved object has no allowlisted official ShowInEditor path.");
        }
        timings["showInEditor"] = phase.ElapsedMilliseconds;
        timings["total"] = total.ElapsedMilliseconds;

        Dictionary<string, object> response = BasicResponse(requestId, status != "unsupported", status, null);
        response["session"] = BuildSessionMap(sessionUse.Session, sessionUse.SessionReused, sessionUse.InventoryReused);
        response["objectResolution"] = BuildResolutionMap(selector, matches);
        response["navigation"] = navigation;
        response["timings"] = timings;
        response["provenance"] = Map(
            "action", "fixed public ShowInEditor API only",
            "confirmation", "confirmNavigation=true",
            "networkOrLineApi", "not available in the allowlisted V20 path",
            "uiAutomation", false,
            "projectMutation", false);
        response["safety"] = SafetyMap();
        return response;
    }

    private static Dictionary<string, object> NavigationResult(
        ObjectRecord requested,
        ObjectRecord opened,
        bool openedObject,
        string granularity,
        bool partial,
        string requestedLocation)
    {
        Dictionary<string, object> result = Map(
            "openedObject", openedObject,
            "openedRequestedObject", openedObject && Object.ReferenceEquals(requested, opened),
            "actualOpenedResourceKind", opened == null ? null : opened.KindName,
            "objectGranularity", granularity,
            "locatedNetwork", false,
            "locationApplied", false,
            "partial", partial,
            "requestedReferenceLocation", requestedLocation,
            "projectMutation", false,
            "saveCompileDownload", false);
        result["requestedObject"] = BuildRecordIdentity(_session, requested);
        result["openedObjectIdentity"] = opened == null ? null : BuildRecordIdentity(_session, opened);
        if (partial && !String.IsNullOrWhiteSpace(requestedLocation))
            result["reason"] = "The object was opened, but V20 exposes no allowlisted exact network/line navigation API; the raw location was not applied.";
        return result;
    }

    private static SessionUse EnsureAttachedSession(
        SessionRequest requested,
        bool forceInventoryRefresh,
        ObjectKind? requiredKind,
        bool requireInventory,
        bool allowAttach)
    {
        Stopwatch attachWatch = new Stopwatch();
        Stopwatch inventoryWatch = new Stopwatch();
        string canonicalPath = CanonicalProjectPath(requested.ProjectPath, true);
        long processStartTicks = GetProcessStartUtcTicks(requested.ProcessId);
        if (requested.ExpectedProcessStartUtcTicks.HasValue &&
            requested.ExpectedProcessStartUtcTicks.Value != processStartTicks)
        {
            throw new ProtocolException("session_mismatch", "The OS process start time does not match expectedProcessStartUtcTicks.");
        }

        lock (SessionGate)
        {
            bool sameSession = _session != null &&
                _session.ProcessId == requested.ProcessId &&
                _session.ProcessStartUtcTicks == processStartTicks &&
                PathEquals(_session.CanonicalProjectPath, canonicalPath);
            if (_session != null && !sameSession)
                DisconnectAttachedSession();

            TiaPortalProcess descriptor = TiaPortal.GetProcess(requested.ProcessId, 10000);
            if (descriptor == null)
                throw new ProtocolException("process_not_found", "TiaPortal.GetProcess returned no exact process for the requested PID.");

            // TiaPortalProcess is only a descriptor. Never call Dispose on it:
            // Siemens documents that operation as closing the Portal process.
            string descriptorPath = descriptor.ProjectPath == null
                ? null
                : CanonicalProjectPath(descriptor.ProjectPath.FullName, false);
            if (String.IsNullOrEmpty(descriptorPath) || !PathEquals(descriptorPath, canonicalPath))
                throw ProjectMismatch("before_attach", requested.ProcessId, canonicalPath, descriptorPath, null);

            if (sameSession)
            {
                string attachedProjectPath = null;
                try { attachedProjectPath = CanonicalProjectPath(_session.Project.Path.FullName, false); }
                catch
                {
                    DisconnectAttachedSession();
                    sameSession = false;
                }
                if (sameSession && !PathEquals(attachedProjectPath, canonicalPath))
                {
                    DisconnectAttachedSession();
                    sameSession = false;
                }
                if (sameSession)
                {
                    long recheckedStartTicks = GetProcessStartUtcTicks(requested.ProcessId);
                    if (recheckedStartTicks != processStartTicks)
                    {
                        DisconnectAttachedSession();
                        throw new ProtocolException("session_mismatch", "The TIA OS process identity changed during session verification.");
                    }
                    _session.LastVerifiedUtc = DateTime.UtcNow;
                    bool inventoryReused =
                        !forceInventoryRefresh &&
                        (!requireInventory || InventoryIncludesFreshKind(_session, requiredKind));
                    if (requireInventory && !inventoryReused)
                    {
                        inventoryWatch.Start();
                        BuildInventory(_session, requiredKind);
                        inventoryWatch.Stop();
                    }
                    return new SessionUse(_session, true, inventoryReused, 0, inventoryWatch.ElapsedMilliseconds);
                }
            }

            if (!allowAttach)
            {
                DisconnectAttachedSession();
                throw new ProtocolException(
                    "session_not_prepared",
                    "No valid prepared resident session exists. Use attach_session after the user is ready to approve the Siemens Portal authorization prompt.");
            }

            DisconnectAttachedSession();
            attachWatch.Start();
            TiaPortal portal = descriptor.Attach();
            attachWatch.Stop();
            if (portal == null)
                throw new ProtocolException("attach_failed", "Attach returned no TiaPortal session.");

            Project exactProject = null;
            int exactProjectCount = 0;
            try
            {
                long postAttachStartTicks = GetProcessStartUtcTicks(requested.ProcessId);
                if (postAttachStartTicks != processStartTicks)
                    throw new ProtocolException("session_mismatch", "The TIA OS process identity changed while attaching.");

                List<string> observedPaths = new List<string>();
                foreach (Project project in portal.Projects)
                {
                    string attachedPath = CanonicalProjectPath(project.Path.FullName, false);
                    observedPaths.Add(attachedPath);
                    if (!PathEquals(attachedPath, canonicalPath)) continue;
                    exactProject = project;
                    exactProjectCount++;
                }
                if (exactProjectCount != 1 || exactProject == null)
                {
                    ProtocolException mismatch = ProjectMismatch("after_attach", requested.ProcessId, canonicalPath, descriptorPath, observedPaths);
                    // Supplemental reads must never replace the original identity failure.
                    try { mismatch.Details["reportedProjectCount"] = portal.Projects.Count; }
                    catch (Exception ex) { mismatch.Details["projectCountReadError"] = SafeError(ex); }
                    try { mismatch.Details["localSessionCount"] = LiveCoreApi.LocalSessionCount(portal); }
                    catch (Exception ex) { mismatch.Details["localSessionCountReadError"] = SafeError(ex); }
                    mismatch.Details["opennessAssembly"] = typeof(TiaPortal).Assembly.FullName;
                    throw mismatch;
                }

                SessionState state = new SessionState();
                state.Portal = portal;
                state.Project = exactProject;
                state.ProcessId = requested.ProcessId;
                state.ProcessStartUtcTicks = processStartTicks;
                state.CanonicalProjectPath = canonicalPath;
                state.AttachedAtUtc = DateTime.UtcNow;
                state.LastVerifiedUtc = state.AttachedAtUtc;
                try { state.IdentifierProvider = LiveCoreApi.IdentifierProvider(exactProject); }
                catch { state.IdentifierProvider = null; }
                state.Inventory = new List<ObjectRecord>();
                state.InventoryKinds = new HashSet<ObjectKind>();
                state.InventoryBuiltAtByKind = new Dictionary<ObjectKind, DateTime>();

                if (requireInventory)
                {
                    inventoryWatch.Start();
                    BuildInventory(state, requiredKind);
                    inventoryWatch.Stop();
                }
                _session = state;
                return new SessionUse(state, false, false, attachWatch.ElapsedMilliseconds, inventoryWatch.ElapsedMilliseconds);
            }
            catch
            {
                try { portal.Dispose(); }
                catch { }
                throw;
            }
        }
    }

    private static void DisconnectAttachedSession()
    {
        lock (SessionGate)
        {
            SessionState prior = _session;
            _session = null;
            if (prior == null || prior.Portal == null) return;
            try
            {
                // This disconnects only the extra attached Openness session.
                // It does not close or save the already-open project.
                prior.Portal.Dispose();
            }
            catch { }
        }
    }

    private static long GetProcessStartUtcTicks(int processId)
    {
        if (processId <= 0) throw new ProtocolException("invalid_session", "session.processId must be a positive exact PID.");
        try
        {
            using (Process process = Process.GetProcessById(processId))
            {
                return process.StartTime.ToUniversalTime().Ticks;
            }
        }
        catch (Exception ex)
        {
            throw new ProtocolException("process_not_found", "Cannot verify the requested OS process and start time: " + SafeError(ex));
        }
    }

    private static bool InventoryIncludesFreshKind(SessionState state, ObjectKind? requiredKind)
    {
        if (
            state == null ||
            state.InventoryKinds == null ||
            state.InventoryBuiltAtByKind == null)
        {
            return false;
        }
        DateTime nowUtc = DateTime.UtcNow;
        if (requiredKind.HasValue)
            return InventoryKindIsFresh(state, requiredKind.Value, nowUtc);
        return
            InventoryKindIsFresh(state, ObjectKind.Block, nowUtc) &&
            InventoryKindIsFresh(state, ObjectKind.PlcType, nowUtc) &&
            InventoryKindIsFresh(state, ObjectKind.TagTable, nowUtc) &&
            InventoryKindIsFresh(state, ObjectKind.PlcTag, nowUtc);
    }

    private static bool InventoryKindIsFresh(
        SessionState state,
        ObjectKind kind,
        DateTime nowUtc)
    {
        if (!state.InventoryKinds.Contains(kind)) return false;
        DateTime builtAtUtc;
        if (!state.InventoryBuiltAtByKind.TryGetValue(kind, out builtAtUtc))
            return false;
        TimeSpan age = nowUtc - builtAtUtc;
        return age >= TimeSpan.Zero && age <= TimeSpan.FromSeconds(InventoryTtlSeconds);
    }

    private static bool WantsKind(ObjectKind[] kinds, ObjectKind kind)
    {
        return kinds == null || Array.IndexOf(kinds, kind) >= 0;
    }

    private static void BuildInventory(SessionState state, ObjectKind? requiredKind)
    {
        BuildInventory(state, requiredKind.HasValue ? new ObjectKind[] { requiredKind.Value } : null);
    }

    // kinds == null rebuilds every kind; otherwise only the listed kinds are rebuilt (in one walk of the
    // device tree) and the records of other kinds are kept.
    private static void BuildInventory(SessionState state, ObjectKind[] kinds)
    {
        List<ObjectRecord> records = new List<ObjectRecord>();
        if (state.Inventory != null && kinds != null)
        {
            foreach (ObjectRecord existing in state.Inventory)
            {
                if (!WantsKind(kinds, existing.Kind)) records.Add(existing);
            }
        }
        HashSet<IEngineeringObject> seenSoftwareObjects =
            new HashSet<IEngineeringObject>(ReferenceComparer.Instance);
        HashSet<string> seenSoftwareFallback =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Device user groups are a separate Project collection in Openness.
        // Traverse them first so a grouped PLC keeps its group-qualified path,
        // then enumerate Project.Devices as the root/fallback collection.
        foreach (DeviceUserGroup group in state.Project.DeviceGroups)
            CollectDeviceGroup(group, "", 0, kinds, records, seenSoftwareObjects, seenSoftwareFallback);
        foreach (Device device in state.Project.Devices)
            CollectDevice(device, "", kinds, records, seenSoftwareObjects, seenSoftwareFallback);

        // Match the importer traversal, including ungrouped devices; partial inventories cannot prove uniqueness.
        if (_signatureInventoryActive)
            foreach (Device device in state.Project.UngroupedDevicesGroup.Devices)
                CollectDevice(device, "", kinds, records, seenSoftwareObjects, seenSoftwareFallback);

        state.Inventory = records;
        state.InventoryBuiltUtc = DateTime.UtcNow;
        if (state.InventoryKinds == null) state.InventoryKinds = new HashSet<ObjectKind>();
        if (state.InventoryBuiltAtByKind == null)
            state.InventoryBuiltAtByKind = new Dictionary<ObjectKind, DateTime>();
        if (kinds != null)
        {
            foreach (ObjectKind kind in kinds)
            {
                state.InventoryKinds.Add(kind);
                state.InventoryBuiltAtByKind[kind] = state.InventoryBuiltUtc;
            }
        }
        else
        {
            state.InventoryKinds.Add(ObjectKind.Block);
            state.InventoryKinds.Add(ObjectKind.PlcType);
            state.InventoryKinds.Add(ObjectKind.TagTable);
            state.InventoryKinds.Add(ObjectKind.PlcTag);
            state.InventoryBuiltAtByKind[ObjectKind.Block] = state.InventoryBuiltUtc;
            state.InventoryBuiltAtByKind[ObjectKind.PlcType] = state.InventoryBuiltUtc;
            state.InventoryBuiltAtByKind[ObjectKind.TagTable] = state.InventoryBuiltUtc;
            state.InventoryBuiltAtByKind[ObjectKind.PlcTag] = state.InventoryBuiltUtc;
        }
        state.OfficialIdMap = new Dictionary<string, ObjectRecord>(StringComparer.Ordinal);
        state.ObjectReferenceMap = new Dictionary<IEngineeringObject, ObjectRecord>(ReferenceComparer.Instance);
        foreach (ObjectRecord record in records)
        {
            IEngineeringObject engineeringObject = record.Value as IEngineeringObject;
            if (engineeringObject != null && !state.ObjectReferenceMap.ContainsKey(engineeringObject))
                state.ObjectReferenceMap.Add(engineeringObject, record);
            if (!String.IsNullOrEmpty(record.OfficialIdentifier) &&
                !state.OfficialIdMap.ContainsKey(record.OfficialIdentifier))
                state.OfficialIdMap.Add(record.OfficialIdentifier, record);
        }
    }

    private static void CollectDeviceGroup(
        DeviceUserGroup group,
        string parentPath,
        int depth,
        ObjectKind[] kinds,
        List<ObjectRecord> records,
        HashSet<IEngineeringObject> seenSoftwareObjects,
        HashSet<string> seenSoftwareFallback)
    {
        if (group == null) return;
        if (depth > 40) throw new ProtocolException("inventory_too_deep", "Device group hierarchy exceeds the safe depth limit.");

        string groupPath = JoinPath(parentPath, group.Name);
        foreach (Device device in group.Devices)
            CollectDevice(device, groupPath, kinds, records, seenSoftwareObjects, seenSoftwareFallback);
        foreach (DeviceUserGroup child in group.Groups)
            CollectDeviceGroup(child, groupPath, depth + 1, kinds, records, seenSoftwareObjects, seenSoftwareFallback);
    }

    private static void CollectDevice(
        Device device,
        string parentPath,
        ObjectKind[] kinds,
        List<ObjectRecord> records,
        HashSet<IEngineeringObject> seenSoftwareObjects,
        HashSet<string> seenSoftwareFallback)
    {
        if (device == null) return;
        string devicePath = JoinPath(parentPath, device.Name);
        foreach (DeviceItem item in device.DeviceItems)
        {
            CollectSoftwareFromDeviceItem(
                item,
                JoinPath(devicePath, item.Name),
                0,
                kinds,
                records,
                seenSoftwareObjects,
                seenSoftwareFallback);
        }
    }

    private static void CollectSoftwareFromDeviceItem(
        DeviceItem item,
        string devicePath,
        int depth,
        ObjectKind[] kinds,
        List<ObjectRecord> records,
        HashSet<IEngineeringObject> seenSoftwareObjects,
        HashSet<string> seenSoftwareFallback)
    {
        if (depth > 40) throw new ProtocolException("inventory_too_deep", "Device hierarchy exceeds the safe depth limit.");

        SoftwareContainer container = null;
        try { container = item.GetService<SoftwareContainer>(); }
        catch (Exception ex)
        {
            if (_signatureInventoryActive) throw;
            RecordSnapshotInventoryTraversalError(
                "DeviceItem " + (devicePath ?? "<unknown>") + " GetService<SoftwareContainer>",
                ex);
            container = null;
        }

        PlcSoftware software = container == null ? null : container.Software as PlcSoftware;
        if (software != null)
        {
            string softwareKey = devicePath + "|" + software.Name;
            if (_snapshotInventoryAuditActive)
                SnapshotInventorySoftwareKeys.Add(softwareKey);
            IEngineeringObject softwareObject = software as IEngineeringObject;
            bool isNew = softwareObject != null
                ? seenSoftwareObjects.Add(softwareObject)
                : seenSoftwareFallback.Add(softwareKey);
            if (isNew)
            {
                if (WantsKind(kinds, ObjectKind.Block))
                {
                    CollectBlockGroup(software.BlockGroup, software.Name, devicePath, "", 0, records);
                    foreach (PlcSystemBlockGroup systemGroup in software.BlockGroup.SystemBlockGroups)
                        CollectSystemBlockGroup(systemGroup, software.Name, devicePath, "", 0, records);
                }
                if (WantsKind(kinds, ObjectKind.PlcType))
                {
                    CollectTypeGroup(software.TypeGroup, software.Name, devicePath, "", 0, records);
                    foreach (PlcSystemTypeGroup systemGroup in software.TypeGroup.SystemTypeGroups)
                        CollectSystemTypeGroup(systemGroup, software.Name, devicePath, "", records);
                }
                if (WantsKind(kinds, ObjectKind.TagTable) || WantsKind(kinds, ObjectKind.PlcTag))
                {
                    CollectTagTableGroup(
                        software.TagTableGroup,
                        software.Name,
                        devicePath,
                        "",
                        0,
                        kinds,
                        records);
                }
            }
        }

        foreach (DeviceItem child in item.DeviceItems)
        {
            CollectSoftwareFromDeviceItem(
                child,
                JoinPath(devicePath, child.Name),
                depth + 1,
                kinds,
                records,
                seenSoftwareObjects,
                seenSoftwareFallback);
        }
    }

    private static void CollectBlockGroup(
        PlcBlockGroup group,
        string softwareName,
        string softwarePath,
        string parentGroupPath,
        int depth,
        List<ObjectRecord> records)
    {
        if (group == null) return;
        if (depth > 40) throw new ProtocolException("inventory_too_deep", "PLC block group hierarchy exceeds the safe depth limit.");
        string groupPath = JoinSlash(parentGroupPath, group.Name);
        foreach (PlcBlock block in group.Blocks)
            records.Add(ObjectRecord.ForBlock(block, softwareName, softwarePath, groupPath));
        foreach (PlcBlockUserGroup child in group.Groups)
            CollectBlockGroup(child, softwareName, softwarePath, groupPath, depth + 1, records);
    }

    private static void CollectSystemBlockGroup(
        PlcSystemBlockGroup group,
        string softwareName,
        string softwarePath,
        string parentGroupPath,
        int depth,
        List<ObjectRecord> records)
    {
        if (group == null) return;
        if (depth > 40) throw new ProtocolException("inventory_too_deep", "System block group hierarchy exceeds the safe depth limit.");
        string groupPath = JoinSlash(parentGroupPath, group.Name);
        foreach (PlcBlock block in group.Blocks) {
            ObjectRecord record = ObjectRecord.ForBlock(block, softwareName, softwarePath, groupPath);
            record.IsSystemBlock = true;
            records.Add(record);
        }
        foreach (PlcSystemBlockGroup child in group.Groups)
            CollectSystemBlockGroup(child, softwareName, softwarePath, groupPath, depth + 1, records);
    }

    private static void CollectTypeGroup(
        PlcTypeGroup group,
        string softwareName,
        string softwarePath,
        string parentGroupPath,
        int depth,
        List<ObjectRecord> records)
    {
        if (group == null) return;
        if (depth > 40) throw new ProtocolException("inventory_too_deep", "PLC type group hierarchy exceeds the safe depth limit.");
        string groupPath = JoinSlash(parentGroupPath, group.Name);
        foreach (PlcType plcType in group.Types)
            records.Add(ObjectRecord.ForType(plcType, softwareName, softwarePath, groupPath));
        foreach (PlcTypeUserGroup child in group.Groups)
            CollectTypeGroup(child, softwareName, softwarePath, groupPath, depth + 1, records);
    }

    private static void CollectSystemTypeGroup(
        PlcSystemTypeGroup group,
        string softwareName,
        string softwarePath,
        string parentGroupPath,
        List<ObjectRecord> records)
    {
        if (group == null) return;
        string groupPath = JoinSlash(parentGroupPath, group.Name);
        foreach (PlcType plcType in group.Types)
            records.Add(ObjectRecord.ForType(plcType, softwareName, softwarePath, groupPath));
    }

    private static void CollectTagTableGroup(
        PlcTagTableGroup group,
        string softwareName,
        string softwarePath,
        string parentGroupPath,
        int depth,
        ObjectKind[] kinds,
        List<ObjectRecord> records)
    {
        if (group == null) return;
        if (depth > 40) throw new ProtocolException("inventory_too_deep", "PLC tag table group hierarchy exceeds the safe depth limit.");
        string groupPath = JoinSlash(parentGroupPath, group.Name);
        foreach (PlcTagTable table in group.TagTables)
        {
            if (WantsKind(kinds, ObjectKind.TagTable))
                records.Add(ObjectRecord.ForTagTable(table, softwareName, softwarePath, groupPath));
            if (WantsKind(kinds, ObjectKind.PlcTag))
            {
                foreach (PlcTag tag in table.Tags)
                    records.Add(ObjectRecord.ForTag(tag, table, softwareName, softwarePath, groupPath));
            }
        }
        foreach (PlcTagTableUserGroup child in group.Groups)
            CollectTagTableGroup(child, softwareName, softwarePath, groupPath, depth + 1, kinds, records);
    }

    private static List<ObjectRecord> ResolveObject(SessionState state, ObjectSelector selector)
    {
        List<ObjectRecord> result = new List<ObjectRecord>();
        if (!String.IsNullOrEmpty(selector.OfficialIdentifier))
        {
            ObjectRecord bound;
            if (state.OfficialIdMap.TryGetValue(selector.OfficialIdentifier, out bound) &&
                SelectorMatches(bound, selector, false))
            {
                result.Add(bound);
                return result;
            }
            foreach (ObjectRecord candidate in state.Inventory)
            {
                if (!SelectorMatches(candidate, selector, false)) continue;
                string identifier = EnsureOfficialIdentifier(state, candidate);
                if (!String.Equals(identifier, selector.OfficialIdentifier, StringComparison.Ordinal)) continue;
                result.Add(candidate);
                break;
            }
            return result;
        }

        foreach (ObjectRecord record in state.Inventory)
        {
            if (SelectorMatches(record, selector, true)) result.Add(record);
        }
        return result;
    }

    private static bool SelectorMatches(ObjectRecord record, ObjectSelector selector, bool requireName)
    {
        if (selector.Kind.HasValue && record.Kind != selector.Kind.Value) return false;
        if (requireName && String.IsNullOrWhiteSpace(selector.Name)) return false;
        if (!String.IsNullOrWhiteSpace(selector.Name) &&
            !String.Equals(record.Name, selector.Name, StringComparison.OrdinalIgnoreCase)) return false;
        if (selector.Number.HasValue && record.Number != selector.Number) return false;
        if (!String.IsNullOrWhiteSpace(selector.Namespace) &&
            !String.Equals(record.Namespace, selector.Namespace, StringComparison.OrdinalIgnoreCase)) return false;
        if (!String.IsNullOrWhiteSpace(selector.SoftwarePath) &&
            !String.Equals(record.SoftwarePath, selector.SoftwarePath, StringComparison.OrdinalIgnoreCase)) return false;
        if (!String.IsNullOrWhiteSpace(selector.BlockKind) && !BlockKindMatches(record, selector.BlockKind)) return false;
        if (!String.IsNullOrWhiteSpace(selector.TagTableName))
        {
            if (record.Kind != ObjectKind.PlcTag || record.ParentTable == null) return false;
            if (!String.Equals(record.ParentTable.Name, selector.TagTableName, StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    private static bool BlockKindMatches(ObjectRecord record, string requestedKind)
    {
        if (record.Kind != ObjectKind.Block) return false;
        if (String.Equals(record.BlockKind, requestedKind, StringComparison.OrdinalIgnoreCase)) return true;
        if (String.Equals(requestedKind, "DB", StringComparison.OrdinalIgnoreCase))
            return record.Value is DataBlock;
        return false;
    }

    private static ObjectRecord FindRecordForValue(SessionState state, object value)
    {
        if (state == null || value == null) return null;
        foreach (ObjectRecord record in state.Inventory)
        {
            if (Object.ReferenceEquals(record.Value, value)) return record;
        }
        return null;
    }

    private static Dictionary<string, object> ReadAllowlistedAttributes(ObjectRecord record)
    {
        Dictionary<string, object> attributes = new Dictionary<string, object>();
        if (record.Kind == ObjectKind.Block)
        {
            PlcBlock block = (PlcBlock)record.Value;
            AddField(attributes, "name", delegate { return (object)block.Name; }, "PlcBlock.Name");
            AddField(attributes, "namespace", delegate { return (object)LiveCoreApi.RequireNamespace(block); }, "PlcBlock.Namespace");
            AddField(attributes, "number", delegate { return (object)block.Number; }, "PlcBlock.Number");
            AddField(attributes, "runtimeType", delegate { return (object)block.GetType().FullName; }, "CLR runtime type");
            AddField(attributes, "programmingLanguage", delegate { return (object)block.ProgrammingLanguage.ToString(); }, "PlcBlock.ProgrammingLanguage");
            AddField(attributes, "autoNumber", delegate { return (object)block.AutoNumber; }, "PlcBlock.AutoNumber");
            AddField(attributes, "isConsistent", delegate { return (object)block.IsConsistent; }, "PlcBlock.IsConsistent");
            AddField(attributes, "isKnowHowProtected", delegate { return (object)block.IsKnowHowProtected; }, "PlcBlock.IsKnowHowProtected");
            AddField(attributes, "memoryLayout", delegate { return (object)block.MemoryLayout.ToString(); }, "PlcBlock.MemoryLayout");
            AddField(attributes, "creationDate", delegate { return (object)Utc(block.CreationDate); }, "PlcBlock.CreationDate");
            AddField(attributes, "modifiedDate", delegate { return (object)Utc(block.ModifiedDate); }, "PlcBlock.ModifiedDate");
            AddField(attributes, "codeModifiedDate", delegate { return (object)Utc(block.CodeModifiedDate); }, "PlcBlock.CodeModifiedDate");
            AddField(attributes, "interfaceModifiedDate", delegate { return (object)Utc(block.InterfaceModifiedDate); }, "PlcBlock.InterfaceModifiedDate");
            AddField(attributes, "compileDate", delegate { return (object)Utc(block.CompileDate); }, "PlcBlock.CompileDate");
            AddField(attributes, "parameterModified", delegate { return (object)Utc(block.ParameterModified); }, "PlcBlock.ParameterModified");
            AddField(attributes, "structureModified", delegate { return (object)Utc(block.StructureModified); }, "PlcBlock.StructureModified");
            AddField(attributes, "headerAuthor", delegate { return (object)block.HeaderAuthor; }, "PlcBlock.HeaderAuthor");
            AddField(attributes, "headerFamily", delegate { return (object)block.HeaderFamily; }, "PlcBlock.HeaderFamily");
            AddField(attributes, "headerName", delegate { return (object)block.HeaderName; }, "PlcBlock.HeaderName");
            AddField(attributes, "headerVersion", delegate { return block.HeaderVersion == null ? null : (object)block.HeaderVersion.ToString(); }, "PlcBlock.HeaderVersion");
            InstanceDB instance = block as InstanceDB;
            if (instance != null)
                AddField(attributes, "instanceOfName", delegate { return (object)instance.InstanceOfName; }, "InstanceDB.InstanceOfName");
        }
        else if (record.Kind == ObjectKind.PlcType)
        {
            PlcType plcType = (PlcType)record.Value;
            AddField(attributes, "name", delegate { return (object)plcType.Name; }, "PlcType.Name");
            AddField(attributes, "namespace", delegate { return (object)LiveCoreApi.RequireNamespace(plcType); }, "PlcType.Namespace");
            AddField(attributes, "runtimeType", delegate { return (object)plcType.GetType().FullName; }, "CLR runtime type");
            AddField(attributes, "isConsistent", delegate { return (object)plcType.IsConsistent; }, "PlcType.IsConsistent");
            AddField(attributes, "isKnowHowProtected", delegate { return (object)plcType.IsKnowHowProtected; }, "PlcType.IsKnowHowProtected");
            AddField(attributes, "creationDate", delegate { return (object)Utc(plcType.CreationDate); }, "PlcType.CreationDate");
            AddField(attributes, "modifiedDate", delegate { return (object)Utc(plcType.ModifiedDate); }, "PlcType.ModifiedDate");
            AddField(attributes, "interfaceModifiedDate", delegate { return (object)Utc(plcType.InterfaceModifiedDate); }, "PlcType.InterfaceModifiedDate");
        }
        else if (record.Kind == ObjectKind.TagTable)
        {
            PlcTagTable table = (PlcTagTable)record.Value;
            AddField(attributes, "name", delegate { return (object)table.Name; }, "PlcTagTable.Name");
            AddField(attributes, "runtimeType", delegate { return (object)table.GetType().FullName; }, "CLR runtime type");
            AddField(attributes, "isDefault", delegate { return (object)table.IsDefault; }, "PlcTagTable.IsDefault");
            AddField(attributes, "modifiedTimeStamp", delegate { return (object)Utc(table.ModifiedTimeStamp); }, "PlcTagTable.ModifiedTimeStamp");
            AddField(attributes, "tagCount", delegate { return (object)table.Tags.Count; }, "PlcTagTable.Tags.Count");
            AddField(attributes, "systemConstantCount", delegate { return (object)table.SystemConstants.Count; }, "PlcTagTable.SystemConstants.Count");
            AddField(attributes, "userConstantCount", delegate { return (object)table.UserConstants.Count; }, "PlcTagTable.UserConstants.Count");
        }
        else if (record.Kind == ObjectKind.PlcTag)
        {
            PlcTag tag = (PlcTag)record.Value;
            AddField(attributes, "name", delegate { return (object)tag.Name; }, "PlcTag.Name");
            AddField(attributes, "runtimeType", delegate { return (object)tag.GetType().FullName; }, "CLR runtime type");
            AddField(attributes, "dataTypeName", delegate { return (object)tag.DataTypeName; }, "PlcTag.DataTypeName");
            AddField(attributes, "logicalAddress", delegate { return (object)tag.LogicalAddress; }, "PlcTag.LogicalAddress");
            AddField(attributes, "externalAccessible", delegate { return (object)tag.ExternalAccessible; }, "PlcTag.ExternalAccessible");
            AddField(attributes, "externalVisible", delegate { return (object)tag.ExternalVisible; }, "PlcTag.ExternalVisible");
            AddField(attributes, "externalWritable", delegate { return (object)tag.ExternalWritable; }, "PlcTag.ExternalWritable");
            AddField(attributes, "isSafety", delegate { return (object)LiveCoreApi.IsSafety(tag); }, "PlcTag.IsSafety");
            attributes["comments"] = ReadTagComments(tag);
        }
        return attributes;
    }

    private static Dictionary<string, object> ReadTagComments(PlcTag tag)
    {
        List<object> comments = new List<object>();
        try
        {
            foreach (MultilingualTextItem item in tag.Comment.Items)
            {
                comments.Add(Map(
                    "language", item.Language == null || item.Language.Culture == null ? null : item.Language.Culture.Name,
                    "text", item.Text,
                    "fieldProvenance", Map(
                        "language", "MultilingualTextItem.Language.Culture.Name",
                        "text", "MultilingualTextItem.Text")));
            }
            return Map(
                "available", true,
                "items", comments,
                "provenance", "PlcTag.Comment.Items direct public composition");
        }
        catch (Exception ex)
        {
            return Map(
                "available", false,
                "items", comments,
                "error", SafeError(ex),
                "provenance", "PlcTag.Comment.Items direct public composition");
        }
    }

    private static Dictionary<string, object> ReadDirectInterface(ObjectRecord record, int maxMembers)
    {
        if (record.Kind != ObjectKind.Block)
        {
            return Map(
                "available", false,
                "status", "no_public_interface_property",
                "reason", "The resolved public " + TiaNativeTarget.PortalVersion + " type has no allowlisted strongly typed Interface property.",
                "exportRequiredForFullSchema", record.Kind == ObjectKind.PlcType);
        }

        DataBlock dataBlock = record.Value as DataBlock;
        if (dataBlock == null)
        {
            return Map(
                "available", false,
                "status", "no_public_interface_property",
#if TIA_API_BLOCK_INTERFACE
                "reason", TiaNativeTarget.PortalVersion + " exposes DataBlock.Interface, but no strongly typed Interface property on this code block class.",
#else
                "reason", "The TIA Portal " + TiaNativeTarget.PortalVersion + " public API has no block Interface property; request the block XML for its interface.",
#endif
                "exportRequiredForFullSchema", true);
        }

#if TIA_API_BLOCK_INTERFACE
        List<object> members = new List<object>();
        try
        {
            PlcBlockInterface blockInterface = dataBlock.Interface;
            int total = blockInterface.Members.Count;
            int count = 0;
            foreach (Member member in blockInterface.Members)
            {
                if (count >= maxMembers) break;
                members.Add(Map(
                    "name", member.Name,
                    "fieldProvenance", Map("name", "Member.Name direct public property")));
                count++;
            }
            return Map(
                "available", true,
                "status", "direct_public_property",
                "publicProperty", "DataBlock.Interface.Members",
                "memberCount", total,
                "returnedMembers", members.Count,
                "truncated", members.Count < total,
                "members", members,
                "fullDatatypeAndStartValueSchemaRequiresExport", true);
        }
        catch (Exception ex)
        {
            return Map(
                "available", false,
                "status", "read_failed",
                "publicProperty", "DataBlock.Interface.Members",
                "error", SafeError(ex),
                "fullDatatypeAndStartValueSchemaRequiresExport", true);
        }
#else
        return Map(
            "available", false,
            "status", "not_available_in_portal_version",
            "reason", "DataBlock.Interface is not in the TIA Portal " + TiaNativeTarget.PortalVersion + " public API; request the block XML for its interface.",
            "exportRequiredForFullSchema", true);
#endif
    }

    private static void AddField(
        Dictionary<string, object> target,
        string name,
        Func<object> getter,
        string apiMember)
    {
        try
        {
            target[name] = Map(
                "available", true,
                "value", getter(),
                "provenance", apiMember,
                "readMode", "direct_public_getter",
                "exportRequired", false);
        }
        catch (Exception ex)
        {
            target[name] = Map(
                "available", false,
                "value", null,
                "error", SafeError(ex),
                "provenance", apiMember,
                "readMode", "direct_public_getter",
                "exportRequired", false);
        }
    }

    private static Dictionary<string, object> ReadCrossReferences(
        SessionState session,
        ObjectRecord record,
        QueryOptions options)
    {
#if TIA_API_CROSS_REFERENCE
        CrossReferenceService service = null;
        try
        {
            IServiceProvider provider = record.Value as IServiceProvider;
            if (provider != null)
                service = provider.GetService(typeof(CrossReferenceService)) as CrossReferenceService;
        }
        catch (Exception ex)
        {
            return Map(
                "included", true,
                "supported", false,
                "status", "service_lookup_failed",
                "error", SafeError(ex),
                "api", "IServiceProvider.GetService(typeof(CrossReferenceService))");
        }

        if (service == null)
        {
            return Map(
                "included", true,
                "supported", false,
                "status", "service_unavailable",
                "api", "CrossReferenceService.GetCrossReferences(AllObjects)");
        }

        try
        {
            CrossReferenceResult result = service.GetCrossReferences(CrossReferenceFilter.AllObjects);
            CrossReferenceBuildState build = new CrossReferenceBuildState(options);
            List<object> sources = new List<object>();
            foreach (SourceObject source in result.Sources)
            {
                if (build.SourceCount >= options.MaxSources)
                {
                    build.SourcesTruncated = true;
                    break;
                }
                sources.Add(BuildCrossReferenceSource(session, source, 0, build));
            }
            return Map(
                "included", true,
                "supported", true,
                "status", "queried",
                "filter", "AllObjects",
                "api", "CrossReferenceService.GetCrossReferences(CrossReferenceFilter.AllObjects)",
                "sources", sources,
                "counts", Map(
                    "sources", build.SourceCount,
                    "references", build.ReferenceCount,
                    "locations", build.LocationCount,
                    "derivedCallEdges", build.CallEdgeCount),
                "truncated", Map(
                    "sources", build.SourcesTruncated,
                    "references", build.ReferencesTruncated,
                    "locations", build.LocationsTruncated,
                    "depth", build.DepthTruncated),
                "limits", Map(
                    "maxSources", options.MaxSources,
                    "maxReferences", options.MaxReferences,
                    "maxLocations", options.MaxLocations,
                    "maxDepth", options.MaxDepth),
                "directionSemantics", Map(
                    "Uses", "source uses reference",
                    "UsedBy", "source is used by reference",
                    "callerCalleeDerivation", "only when ReferenceType is Uses/UsedBy and Access is Call/UC/CC"));
        }
        catch (Exception ex)
        {
            return Map(
                "included", true,
                "supported", true,
                "status", "query_failed",
                "error", SafeError(ex),
                "filter", "AllObjects",
                "api", "CrossReferenceService.GetCrossReferences(CrossReferenceFilter.AllObjects)");
        }
#else
        return Map(
            "included", true,
            "supported", false,
            "status", "not_available_in_portal_version",
            "reason", "CrossReferenceService is not in the TIA Portal " + TiaNativeTarget.PortalVersion + " public API.",
            "error", "CrossReferenceService is not in the TIA Portal " + TiaNativeTarget.PortalVersion + " public API.",
            "api", "CrossReferenceService.GetCrossReferences(AllObjects)");
#endif
    }

#if TIA_API_CROSS_REFERENCE
    private static Dictionary<string, object> BuildCrossReferenceSource(
        SessionState session,
        SourceObject source,
        int depth,
        CrossReferenceBuildState build)
    {
        build.SourceCount++;
        Dictionary<string, object> sourceIdentity = Map(
            "name", Safe(delegate { return source.Name; }),
            "path", Safe(delegate { return source.Path; }),
            "typeName", Safe(delegate { return source.TypeName; }),
            "address", Safe(delegate { return source.Address; }),
            "device", Safe(delegate { return source.Device; }));
        sourceIdentity["underlyingObject"] = ReadEngineeringIdentity(
            session,
            delegate { return source.UnderlyingObject; },
            "SourceObject.UnderlyingObject");

        List<object> references = new List<object>();
        foreach (ReferenceObject reference in source.References)
        {
            if (build.ReferenceCount >= build.Options.MaxReferences)
            {
                build.ReferencesTruncated = true;
                break;
            }
            references.Add(BuildCrossReferenceReference(session, sourceIdentity, reference, build));
        }

        List<object> children = new List<object>();
        if (depth >= build.Options.MaxDepth)
        {
            foreach (SourceObject ignored in source.Children)
            {
                build.DepthTruncated = true;
                break;
            }
        }
        else
        {
            foreach (SourceObject child in source.Children)
            {
                if (build.SourceCount >= build.Options.MaxSources)
                {
                    build.SourcesTruncated = true;
                    break;
                }
                children.Add(BuildCrossReferenceSource(session, child, depth + 1, build));
            }
        }

        return Map(
            "depth", depth,
            "source", sourceIdentity,
            "references", references,
            "children", children,
            "fieldProvenance", Map(
                "name", "SourceObject.Name",
                "path", "SourceObject.Path",
                "typeName", "SourceObject.TypeName",
                "address", "SourceObject.Address",
                "device", "SourceObject.Device",
                "underlyingObject", "SourceObject.UnderlyingObject",
                "references", "SourceObject.References",
                "children", "SourceObject.Children"));
    }

    private static Dictionary<string, object> BuildCrossReferenceReference(
        SessionState session,
        Dictionary<string, object> sourceIdentity,
        ReferenceObject reference,
        CrossReferenceBuildState build)
    {
        build.ReferenceCount++;
        Dictionary<string, object> referenceIdentity = Map(
            "name", Safe(delegate { return reference.Name; }),
            "path", Safe(delegate { return reference.Path; }),
            "typeName", Safe(delegate { return reference.TypeName; }),
            "address", Safe(delegate { return reference.Address; }),
            "device", Safe(delegate { return reference.Device; }));
        referenceIdentity["underlyingObject"] = ReadEngineeringIdentity(
            session,
            delegate { return reference.UnderlyingObject; },
            "ReferenceObject.UnderlyingObject");

        List<object> locations = new List<object>();
        foreach (Location location in reference.Locations)
        {
            if (build.LocationCount >= build.Options.MaxLocations)
            {
                build.LocationsTruncated = true;
                break;
            }
            locations.Add(BuildCrossReferenceLocation(session, sourceIdentity, referenceIdentity, location, build));
        }

        return Map(
            "reference", referenceIdentity,
            "locations", locations,
            "fieldProvenance", Map(
                "name", "ReferenceObject.Name",
                "path", "ReferenceObject.Path",
                "typeName", "ReferenceObject.TypeName",
                "address", "ReferenceObject.Address",
                "device", "ReferenceObject.Device",
                "underlyingObject", "ReferenceObject.UnderlyingObject",
                "locations", "ReferenceObject.Locations"));
    }

    private static Dictionary<string, object> BuildCrossReferenceLocation(
        SessionState session,
        Dictionary<string, object> sourceIdentity,
        Dictionary<string, object> referenceIdentity,
        Location location,
        CrossReferenceBuildState build)
    {
        build.LocationCount++;
        string access = Safe(delegate { return location.Access.ToString(); });
        string referenceType = Safe(delegate { return location.ReferenceType.ToString(); });
        Dictionary<string, object> result = Map(
            "access", access,
            "referenceType", referenceType,
            "referenceLocation", Safe(delegate { return location.ReferenceLocation; }),
            "name", Safe(delegate { return location.Name; }),
            "address", Safe(delegate { return location.Address; }),
            "typeName", Safe(delegate { return location.TypeName; }),
            "referencedAsName", Safe(delegate { return location.ReferencedAsName; }),
            "referencedAs", ReadEngineeringIdentity(
                session,
                delegate { return location.ReferencedAs; },
                "Location.ReferencedAs"),
            "fieldProvenance", Map(
                "access", "Location.Access",
                "referenceType", "Location.ReferenceType",
                "referenceLocation", "Location.ReferenceLocation",
                "name", "Location.Name",
                "address", "Location.Address",
                "typeName", "Location.TypeName",
                "referencedAsName", "Location.ReferencedAsName",
                "referencedAs", "Location.ReferencedAs"));

        bool callAccess = String.Equals(access, "Call", StringComparison.Ordinal) ||
            String.Equals(access, "UC", StringComparison.Ordinal) ||
            String.Equals(access, "CC", StringComparison.Ordinal);
        if (callAccess && String.Equals(referenceType, "Uses", StringComparison.Ordinal))
        {
            result["callerCallee"] = Map(
                "derived", true,
                "caller", sourceIdentity,
                "callee", referenceIdentity,
                "evidence", Map("referenceType", referenceType, "access", access));
            build.CallEdgeCount++;
        }
        else if (callAccess && String.Equals(referenceType, "UsedBy", StringComparison.Ordinal))
        {
            result["callerCallee"] = Map(
                "derived", true,
                "caller", referenceIdentity,
                "callee", sourceIdentity,
                "evidence", Map("referenceType", referenceType, "access", access));
            build.CallEdgeCount++;
        }
        else
        {
            result["callerCallee"] = Map(
                "derived", false,
                "reason", "Insufficient Uses/UsedBy plus Call/UC/CC evidence.");
        }
        return result;
    }
#endif

    private static Dictionary<string, object> EngineeringIdentity(
        SessionState session,
        IEngineeringObject value,
        string provenance)
    {
        if (value == null)
        {
            return Map(
                "status", "null",
                "available", false,
                "officialIdentifier", null,
                "runtimeType", null,
                "provenance", provenance);
        }

        Dictionary<string, object> identity = Map(
            "status", "object_available",
            "available", true,
            "runtimeType", value.GetType().FullName,
            "provenance", provenance);
        if (session.IdentifierProvider == null)
        {
            identity["officialIdentifier"] = null;
            identity["identifierStatus"] = "service_unavailable";
            return identity;
        }

        try
        {
            string identifier = session.IdentifierProvider.GetIdentifier(value);
            identity["officialIdentifier"] = identifier;
            identity["identifierStatus"] = String.IsNullOrEmpty(identifier) ? "empty" : "resolved";
            ObjectRecord known = null;
            bool knownByReference = session.ObjectReferenceMap != null &&
                session.ObjectReferenceMap.TryGetValue(value, out known);
            if (knownByReference && !String.IsNullOrEmpty(identifier))
            {
                known.OfficialIdentifier = identifier;
                known.OfficialIdentifierAttempted = true;
                if (!session.OfficialIdMap.ContainsKey(identifier))
                    session.OfficialIdMap.Add(identifier, known);
            }
            identity["matchesCachedInventory"] = knownByReference ||
                (!String.IsNullOrEmpty(identifier) && session.OfficialIdMap.TryGetValue(identifier, out known));
        }
        catch (Exception ex)
        {
            identity["officialIdentifier"] = null;
            identity["identifierStatus"] = "error";
            identity["identifierError"] = SafeError(ex);
        }
        return identity;
    }

    private static Dictionary<string, object> ReadEngineeringIdentity(
        SessionState session,
        Func<IEngineeringObject> getter,
        string provenance)
    {
        try { return EngineeringIdentity(session, getter(), provenance); }
        catch (Exception ex)
        {
            return Map(
                "status", "read_error",
                "available", false,
                "officialIdentifier", null,
                "runtimeType", null,
                "provenance", provenance,
                "error", SafeError(ex));
        }
    }

    private static Dictionary<string, object> ExportOneBlockTemporarily(ObjectRecord record, int maxXmlBytes)
    {
        if (record.Kind != ObjectKind.Block)
        {
            return Map(
                "included", false,
                "status", "unsupported_object_kind",
                "reason", "Temporary XML is restricted to exactly one resolved PlcBlock.",
                "tempCleanup", Map("attempted", false, "deleted", true, "error", null));
        }

        PlcBlock block = (PlcBlock)record.Value;
        string tempRoot = TemporaryRoot();
        string tempDirectory = Path.Combine(tempRoot, Guid.NewGuid().ToString("N"));
        string tempPath = Path.Combine(tempDirectory, "block.xml");
        Dictionary<string, object> result = Map(
            "included", false,
            "status", "not_started",
            "encoding", "base64",
            "bytes", 0,
            "sha256", null,
            "base64", null,
            "temporary", true,
            "persistentExport", false,
            "api", "PlcBlock.Export(FileInfo, ExportOptions.WithDefaults)");
        Dictionary<string, object> cleanup = null;

        try
        {
            Directory.CreateDirectory(tempDirectory);
            block.Export(new FileInfo(tempPath), ExportOptions.WithDefaults);
            FileInfo file = new FileInfo(tempPath);
            if (!file.Exists)
                throw new IOException("PlcBlock.Export returned without creating the temporary XML file.");
            if (file.Length > maxXmlBytes)
            {
                result["status"] = "too_large";
                result["bytes"] = file.Length;
                result["maxXmlBytes"] = maxXmlBytes;
                result["reason"] = "The single block XML exceeds the bounded inline limit.";
            }
            else
            {
                byte[] bytes = File.ReadAllBytes(tempPath);
                if (bytes.Length > maxXmlBytes)
                    throw new IOException("The temporary XML grew beyond maxXmlBytes while being read.");
                result["included"] = true;
                result["status"] = "included";
                result["bytes"] = bytes.Length;
                result["sha256"] = Sha256Hex(bytes);
                result["base64"] = Convert.ToBase64String(bytes);
                result["maxXmlBytes"] = maxXmlBytes;
            }
        }
        catch (Exception ex)
        {
            if (String.Equals(Convert.ToString(result["status"]), "not_started", StringComparison.Ordinal))
                result["status"] = "export_failed";
            result["error"] = SafeError(ex);
        }
        finally
        {
            cleanup = DeleteTemporaryArtifacts(tempPath, tempDirectory);
            result["tempCleanup"] = cleanup;
            if (!(bool)cleanup["deleted"])
            {
                result["included"] = false;
                result["status"] = "cleanup_failed";
                result["base64"] = null;
                result["reason"] = "Inline XML was withheld because temporary-file deletion was not verified.";
            }
        }
        return result;
    }

    private static Dictionary<string, object> DeleteTemporaryArtifacts(string filePath, string directoryPath)
    {
        Dictionary<string, object> cleanup = Map(
            "attempted", true,
            "deleted", false,
            "fileDeleted", false,
            "directoryDeleted", false,
            "error", null);
        try
        {
            if (File.Exists(filePath)) File.Delete(filePath);
            cleanup["fileDeleted"] = !File.Exists(filePath);
            if (Directory.Exists(directoryPath)) Directory.Delete(directoryPath, false);
            cleanup["directoryDeleted"] = !Directory.Exists(directoryPath);
            cleanup["deleted"] = (bool)cleanup["fileDeleted"] && (bool)cleanup["directoryDeleted"];
        }
        catch (Exception ex)
        {
            cleanup["deleted"] = false;
            cleanup["error"] = SafeError(ex);
        }
        return cleanup;
    }

    private static string TemporaryRoot()
    {
        return Path.Combine(Path.GetTempPath(), "TiaLiveReadCore-v1");
    }

    private static void CleanupStaleTemporaryDirectories()
    {
        string root = TemporaryRoot();
        _staleTempDirectoriesRemoved = 0;
        try
        {
            if (!Directory.Exists(root))
            {
                _staleTempCleanupStatus = "root_absent";
                return;
            }
            string canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            DateTime cutoff = DateTime.UtcNow.AddHours(-24);
            foreach (string childPath in Directory.GetDirectories(root))
            {
                DirectoryInfo child = new DirectoryInfo(childPath);
                Guid parsed;
                if (!Guid.TryParseExact(child.Name, "N", out parsed)) continue;
                string canonicalChild = Path.GetFullPath(child.FullName);
                if (!canonicalChild.StartsWith(canonicalRoot, StringComparison.OrdinalIgnoreCase)) continue;
                if (child.LastWriteTimeUtc > cutoff) continue;
                Directory.Delete(canonicalChild, true);
                _staleTempDirectoriesRemoved++;
            }
            _staleTempCleanupStatus = "completed";
        }
        catch (Exception ex)
        {
            _staleTempCleanupStatus = "partial_error:" + SafeError(ex);
        }
    }

    private static Dictionary<string, object> BuildRecordIdentity(SessionState session, ObjectRecord record)
    {
        if (record == null) return null;
        string officialIdentifier = EnsureOfficialIdentifier(session, record);
        Dictionary<string, object> identity = Map(
            "resourceKind", record.KindName,
            "name", record.Name,
            "runtimeType", record.RuntimeType,
            "blockKind", record.BlockKind,
            "number", record.Number.HasValue ? record.Number.Value.ToString() : null,
            "namespace", record.Namespace,
            "softwareName", record.SoftwareName,
            "softwarePath", record.SoftwarePath,
            "groupPath", record.GroupPath,
            "officialIdentifier", officialIdentifier);
        if (record.Kind == ObjectKind.PlcTag && record.ParentTable != null)
            identity["tagTableName"] = record.ParentTable.Name;
        identity["fieldProvenance"] = Map(
            "resourceKind", "cached typed public " + TiaNativeTarget.PortalVersion + " inventory classification",
            "name", record.NameProvenance,
            "runtimeType", "CLR runtime type",
            "blockKind", "CLR PlcBlock subtype",
            "number", record.Number.HasValue ? "PlcBlock.Number" : "not applicable",
            "namespace", record.NamespaceProvenance,
            "softwareName", "PlcSoftware.Name",
            "softwarePath", "verified device hierarchy",
            "groupPath", "typed public group hierarchy",
            "officialIdentifier", "ObjectIdentifierProvider.GetIdentifier(IEngineeringObject)");
        return identity;
    }

    private static string EnsureOfficialIdentifier(SessionState session, ObjectRecord record)
    {
        if (session == null || record == null || session.IdentifierProvider == null) return null;
        if (record.OfficialIdentifierAttempted) return record.OfficialIdentifier;
        record.OfficialIdentifierAttempted = true;
        try
        {
            IEngineeringObject engineeringObject = record.Value as IEngineeringObject;
            if (engineeringObject == null) return null;
            string identifier = session.IdentifierProvider.GetIdentifier(engineeringObject);
            record.OfficialIdentifier = identifier;
            if (!String.IsNullOrEmpty(identifier) && !session.OfficialIdMap.ContainsKey(identifier))
                session.OfficialIdMap.Add(identifier, record);
            return identifier;
        }
        catch
        {
            record.OfficialIdentifier = null;
            return null;
        }
    }

    private static Dictionary<string, object> BuildResolutionMap(
        ObjectSelector selector,
        List<ObjectRecord> matches)
    {
        return Map(
            "selector", selector.ToMap(),
            "matchCount", matches.Count,
            "unique", matches.Count == 1,
            "matching", "exact kind/name/number/namespace/softwarePath/tagTableName filters across every PLC software inventory entry");
    }

    private static List<object> BuildMatchList(
        SessionState session,
        List<ObjectRecord> matches,
        int limit)
    {
        List<object> result = new List<object>();
        int count = 0;
        foreach (ObjectRecord match in matches)
        {
            if (count >= limit) break;
            result.Add(BuildRecordIdentity(session, match));
            count++;
        }
        return result;
    }

    private static Dictionary<string, object> BuildSessionMap(
        SessionState session,
        bool sessionReused,
        bool inventoryReused)
    {
        return Map(
            "processId", session.ProcessId,
            "canonicalProjectPath", session.CanonicalProjectPath,
            "processStartUtcTicks", session.ProcessStartUtcTicks,
            "processStartTimeUtc", new DateTime(session.ProcessStartUtcTicks, DateTimeKind.Utc).ToString("o"),
            "attachedAtUtc", Utc(session.AttachedAtUtc),
            "verifiedAtUtc", Utc(session.LastVerifiedUtc),
            "sessionReused", sessionReused,
            "inventoryReused", inventoryReused,
            "inventoryBuiltAtUtc", session.InventoryBuiltUtc == DateTime.MinValue
                ? null
                : (object)Utc(session.InventoryBuiltUtc),
            "inventoryCount", session.Inventory == null ? 0 : session.Inventory.Count,
            "inventoryByKind", BuildInventoryByKindMap(session),
            "objectIdentifierProviderAvailable", session.IdentifierProvider != null,
            "ownership", Map(
                "attachedByCore", true,
                "additionalOpennessSessionOnly", true,
                "portalProcessOwned", false,
                "projectOwned", false,
                "mayCloseProject", false,
                "maySaveProject", false,
                "descriptorDisposed", false));
    }

    private static Dictionary<string, object> BuildInventoryByKindMap(SessionState session)
    {
        Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal);
        ObjectKind[] kinds = new ObjectKind[]
        {
            ObjectKind.Block,
            ObjectKind.PlcType,
            ObjectKind.TagTable,
            ObjectKind.PlcTag
        };
        foreach (ObjectKind kind in kinds)
        {
            bool loaded = session.InventoryKinds != null && session.InventoryKinds.Contains(kind);
            int count = 0;
            if (loaded && session.Inventory != null)
            {
                foreach (ObjectRecord record in session.Inventory)
                {
                    if (record.Kind == kind) count++;
                }
            }
            DateTime builtAt = DateTime.MinValue;
            bool hasBuiltAt =
                session.InventoryBuiltAtByKind != null &&
                session.InventoryBuiltAtByKind.TryGetValue(kind, out builtAt);
            result[ObjectKindName(kind)] = Map(
                "loaded", loaded,
                "count", count,
                "builtAtUtc", hasBuiltAt ? (object)Utc(builtAt) : null);
        }
        return result;
    }

    private static string ObjectKindName(ObjectKind kind)
    {
        if (kind == ObjectKind.Block) return "block";
        if (kind == ObjectKind.PlcType) return "plc_type";
        if (kind == ObjectKind.TagTable) return "tag_table";
        return "plc_tag";
    }

    private static Dictionary<string, object> SafetyMap()
    {
        return Map(
            "queryDefault", "read_only",
            "openProject", false,
            "closeProject", false,
            "saveProject", false,
            "compile", false,
            "import", false,
            "download", false,
            "online", false,
            "engineeringWrites", false,
            "persistentExport", false,
            "portalProcessDispose", false,
            "uiActionRequiresExplicitOperationAndConfirmation", true);
    }

    private static SessionRequest ParseSessionRequest(Dictionary<string, object> request)
    {
        Dictionary<string, object> nested = GetMap(request, "session");
        int processId = GetInt(
            nested,
            "processId",
            GetInt(request, "processId", GetInt(request, "pid", 0)));
        string projectPath = GetString(
            nested,
            "projectPath",
            GetString(request, "projectPath", GetString(request, "project_path", null)));
        long? expectedTicks = GetNullableLong(nested, "expectedProcessStartUtcTicks");
        if (!expectedTicks.HasValue) expectedTicks = GetNullableLong(request, "expectedProcessStartUtcTicks");
        if (!expectedTicks.HasValue)
        {
            string expectedStart = GetString(
                nested,
                "processStartTimeUtc",
                GetString(request, "processStartTimeUtc", null));
            if (!String.IsNullOrWhiteSpace(expectedStart))
            {
                DateTimeOffset parsedStart;
                if (!DateTimeOffset.TryParse(
                    expectedStart,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out parsedStart))
                {
                    throw new ProtocolException("invalid_session", "processStartTimeUtc must be a valid UTC timestamp.");
                }
                expectedTicks = parsedStart.UtcDateTime.Ticks;
            }
        }
        if (processId <= 0) throw new ProtocolException("invalid_session", "An exact positive processId is required.");
        if (String.IsNullOrWhiteSpace(projectPath)) throw new ProtocolException("invalid_session", "An exact canonical " + TiaNativeTarget.ProjectExtension + " projectPath is required.");
        if (!expectedTicks.HasValue)
            throw new ProtocolException("invalid_session", "An exact caller-observed processStartTimeUtc is required with processId and projectPath.");
        return new SessionRequest(processId, projectPath, expectedTicks);
    }

    private static ObjectSelector ParseObjectSelector(Dictionary<string, object> request)
    {
        Dictionary<string, object> map = GetMap(request, "object");
        if (map.Count == 0) map = GetMap(request, "identity");
        string kindText = GetString(
            map,
            "kind",
            GetString(map, "resourceKind", GetString(request, "kind", null)));
        string officialIdentifier = GetString(map, "officialIdentifier", null);
        ObjectKind? kind = ParseObjectKind(kindText);
        if (!kind.HasValue && String.IsNullOrWhiteSpace(officialIdentifier))
            throw new ProtocolException("invalid_selector", "identity.resourceKind must be block, plc_type, tag_table, or plc_tag.");

        string name = GetString(map, "name", GetString(request, "name", null));
        if (String.IsNullOrWhiteSpace(name) && String.IsNullOrWhiteSpace(officialIdentifier))
            throw new ProtocolException("invalid_selector", "identity.name is required unless a session-bound officialIdentifier is supplied.");

        int? number = GetNullableInt(map, "number");
        string nameSpace = GetString(map, "namespace", null);
        string softwarePath = GetString(map, "softwarePath", GetString(map, "software", null));
        string blockKind = GetString(map, "blockKind", null);
        string tagTableName = GetString(map, "tagTableName", null);
        return new ObjectSelector(kind, name, number, nameSpace, softwarePath, officialIdentifier, blockKind, tagTableName);
    }

    private static ObjectKind? ParseObjectKind(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return null;
        string normalized = value.Trim().ToLowerInvariant().Replace("-", "_");
        if (normalized == "block" || normalized == "plcblock" || normalized == "db") return ObjectKind.Block;
        if (normalized == "plc_type" || normalized == "plctype" || normalized == "type" || normalized == "udt") return ObjectKind.PlcType;
        if (normalized == "tag_table" || normalized == "tagtable" || normalized == "plctagtable") return ObjectKind.TagTable;
        if (normalized == "plc_tag" || normalized == "plctag" || normalized == "tag") return ObjectKind.PlcTag;
        return null;
    }

    private static QueryOptions ParseOptions(Dictionary<string, object> request)
    {
        Dictionary<string, object> map = GetMap(request, "options");
        bool includeCrossReferences = GetBool(
            map,
            "includeCrossReferences",
            GetBool(request, "includeCrossReferences", false));
        bool includeInterface = GetBool(
            map,
            "includeInterface",
            GetBool(request, "includeInterface", false));
        bool includeProgramBody = GetBool(
            map,
            "includeProgramBody",
            GetBool(request, "includeProgramBody", false));
        bool includeXml = includeProgramBody || GetBool(
            map,
            "includeXml",
            GetBool(request, "includeBlockXml", GetBool(request, "includeXml", false)));
        bool refreshInventory = GetBool(
            map,
            "refreshInventory",
            GetBool(request, "refreshInventory", false));
        bool retryNotFoundWithRefresh = GetBool(
            map,
            "retryNotFoundWithRefresh",
            GetBool(request, "retryNotFoundWithRefresh", true));
        int maxResults = Bound(
            GetInt(request, "maxResults", GetInt(map, "maxResults", 500)),
            1,
            AbsoluteMaxReferences);
        int maxSources = Bound(GetInt(map, "maxSources", Math.Min(maxResults, AbsoluteMaxSources)), 1, AbsoluteMaxSources);
        int maxReferences = Bound(GetInt(map, "maxReferences", maxResults), 1, AbsoluteMaxReferences);
        int maxLocations = Bound(GetInt(map, "maxLocations", maxResults), 1, AbsoluteMaxLocations);
        int maxDepth = Bound(GetInt(map, "maxDepth", 20), 1, AbsoluteMaxDepth);
        int maxXmlBytes = GetInt(map, "maxXmlBytes", GetInt(request, "maxXmlBytes", DefaultMaxXmlBytes));
        if (maxXmlBytes < 100000 || maxXmlBytes > AbsoluteMaxXmlBytes)
            throw new ProtocolException("invalid_options", "maxXmlBytes must be within 100000..25000000; the core does not silently clamp it.");
        int maxInterfaceMembers = Bound(GetInt(map, "maxInterfaceMembers", 2000), 1, AbsoluteMaxInterfaceMembers);
        return new QueryOptions(
            includeCrossReferences,
            includeInterface,
            includeProgramBody,
            includeXml,
            refreshInventory,
            retryNotFoundWithRefresh,
            maxSources,
            maxReferences,
            maxLocations,
            maxDepth,
            maxXmlBytes,
            maxInterfaceMembers);
    }

    private static int GetRequestTimeoutMs(Dictionary<string, object> request)
    {
        Dictionary<string, object> options = GetMap(request, "options");
        int value = GetInt(options, "timeoutMs", GetInt(request, "timeoutMs", DefaultTimeoutMs));
        if (value < MinTimeoutMs || value > MaxTimeoutMs)
            throw new ProtocolException("invalid_options", "timeoutMs must be within 1000..60000; the core does not silently clamp it.");
        return value;
    }

    private static NamedPipeServerStream CreatePipe(string pipeName)
    {
        try
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            SecurityIdentifier sid = identity.User;
            if (sid == null) throw new InvalidOperationException("Current Windows identity has no SID.");
            PipeSecurity security = new PipeSecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(sid);
            security.AddAccessRule(new PipeAccessRule(
                sid,
                PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance,
                AccessControlType.Allow));
            _pipeSecurityStatus = "current_user_acl";
            return new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                MaxPipeInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                MaxRequestBytes,
                64 * 1024,
                security);
        }
        catch (Exception ex)
        {
            _pipeSecurityStatus = "current_user_acl_failed_closed";
            throw new InvalidOperationException(
                "Cannot create a current-user-only named pipe. The core refuses an unprotected fallback.",
                ex);
        }
    }

    private static bool WaitForConnectionWithIdleTimeout(NamedPipeServerStream pipe, int idleTimeoutMs)
    {
        IAsyncResult wait = pipe.BeginWaitForConnection(null, null);
        try
        {
            if (!wait.AsyncWaitHandle.WaitOne(idleTimeoutMs)) return false;
            pipe.EndWaitForConnection(wait);
            return true;
        }
        finally
        {
            wait.AsyncWaitHandle.Close();
        }
    }

    private static string ReadBoundedLine(Stream stream, int maximumBytes)
    {
        MemoryStream buffer = new MemoryStream();
        while (true)
        {
            int value = stream.ReadByte();
            if (value < 0) throw new ProtocolException("incomplete_request", "The pipe closed before a newline-delimited JSON request was complete.");
            if (value == 10) break;
            if (value == 13) continue;
            if (buffer.Length >= maximumBytes)
                throw new ProtocolException("request_too_large", "The newline JSON request exceeds the bounded protocol limit.");
            buffer.WriteByte((byte)value);
        }
        if (buffer.Length == 0) throw new ProtocolException("invalid_request", "The request line is empty.");
        try
        {
            return new UTF8Encoding(false, true).GetString(buffer.ToArray());
        }
        catch (DecoderFallbackException)
        {
            throw new ProtocolException("invalid_utf8", "The request must be valid UTF-8.");
        }
    }

    private static void WriteBoundedResponse(
        Stream stream,
        Dictionary<string, object> response,
        string requestId)
    {
        if (stream == null || !stream.CanWrite) return;
        try
        {
            string json;
            try
            {
                json = Serialize(response);
            }
            catch
            {
                json = Serialize(BasicResponse(
                    requestId,
                    false,
                    "response_too_large",
                    "The response could not be serialized within the bounded protocol envelope; lower maxResults or maxXmlBytes."));
            }
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(json);
            if (bytes.Length > MaxResponseBytes)
            {
                Dictionary<string, object> tooLarge = BasicResponse(
                    requestId,
                    false,
                    "response_too_large",
                    "The bounded response limit was exceeded; lower maxResults or maxXmlBytes.");
                bytes = Encoding.UTF8.GetBytes(Serialize(tooLarge));
            }
            stream.Write(bytes, 0, bytes.Length);
            stream.WriteByte(10);
            stream.Flush();
        }
        catch
        {
            // The client may have disconnected. Do not affect TIA or retry writes.
        }
    }

    private static Dictionary<string, object> BasicResponse(
        string requestId,
        bool ok,
        string status,
        string error)
    {
        Dictionary<string, object> response = Map(
            "protocolVersion", ProtocolVersion,
            "requestId", requestId,
            "ok", ok,
            "status", status);
        if (!String.IsNullOrEmpty(error)) response["error"] = error;
        return response;
    }

    private static string Serialize(object value)
    {
        return Json.Serialize(value);
    }

    private static Dictionary<string, object> Map(params object[] pairs)
    {
        Dictionary<string, object> map = new Dictionary<string, object>();
        for (int i = 0; i + 1 < pairs.Length; i += 2)
            map[Convert.ToString(pairs[i])] = pairs[i + 1];
        return map;
    }

    private static Dictionary<string, object> GetMap(Dictionary<string, object> map, string key)
    {
        if (map == null) return new Dictionary<string, object>();
        object value;
        if (!map.TryGetValue(key, out value) || value == null) return new Dictionary<string, object>();
        Dictionary<string, object> nested = value as Dictionary<string, object>;
        return nested ?? new Dictionary<string, object>();
    }

    private static string GetString(Dictionary<string, object> map, string key, string fallback)
    {
        if (map == null) return fallback;
        object value;
        if (!map.TryGetValue(key, out value) || value == null) return fallback;
        string text = Convert.ToString(value);
        return String.IsNullOrWhiteSpace(text) ? fallback : text.Trim();
    }

    private static bool GetBool(Dictionary<string, object> map, string key, bool fallback)
    {
        if (map == null) return fallback;
        object value;
        if (!map.TryGetValue(key, out value) || value == null) return fallback;
        if (value is bool) return (bool)value;
        bool parsed;
        return Boolean.TryParse(Convert.ToString(value), out parsed) ? parsed : fallback;
    }

    private static int GetInt(Dictionary<string, object> map, string key, int fallback)
    {
        if (map == null) return fallback;
        object value;
        if (!map.TryGetValue(key, out value) || value == null) return fallback;
        int parsed;
        if (Int32.TryParse(Convert.ToString(value), out parsed)) return parsed;
        try { return Convert.ToInt32(value); }
        catch { return fallback; }
    }

    private static long GetLong(Dictionary<string, object> map, string key, long fallback)
    {
        if (map == null) return fallback;
        object value;
        if (!map.TryGetValue(key, out value) || value == null) return fallback;
        long parsed;
        if (Int64.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
        try { return Convert.ToInt64(value, CultureInfo.InvariantCulture); }
        catch { return fallback; }
    }

    private static long UnixMillisecondsNow()
    {
        return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }

    private static int? GetNullableInt(Dictionary<string, object> map, string key)
    {
        if (map == null) return null;
        object value;
        if (!map.TryGetValue(key, out value) || value == null) return null;
        int parsed;
        if (Int32.TryParse(Convert.ToString(value), out parsed)) return parsed;
        try { return Convert.ToInt32(value); }
        catch { throw new ProtocolException("invalid_selector", key + " must be an integer."); }
    }

    private static long? GetNullableLong(Dictionary<string, object> map, string key)
    {
        if (map == null) return null;
        object value;
        if (!map.TryGetValue(key, out value) || value == null) return null;
        long parsed;
        if (Int64.TryParse(Convert.ToString(value), out parsed)) return parsed;
        try { return Convert.ToInt64(value); }
        catch { throw new ProtocolException("invalid_session", key + " must be a 64-bit integer."); }
    }

    private static int Bound(int value, int minimum, int maximum)
    {
        if (value < minimum) return minimum;
        if (value > maximum) return maximum;
        return value;
    }

    private static string CanonicalProjectPath(string path, bool requireExists)
    {
        if (String.IsNullOrWhiteSpace(path))
            throw new ProtocolException("invalid_project_path", "The project path is empty.");
        string full;
        try { full = Path.GetFullPath(path.Trim()); }
        catch (Exception ex)
        {
            throw new ProtocolException("invalid_project_path", "Cannot canonicalize projectPath: " + SafeError(ex));
        }
        if (!TiaNativeTarget.IsProjectPath(full))
            throw new ProtocolException("invalid_project_path", "The exact projectPath must end in " + TiaNativeTarget.ProjectExtension + ".");
        if (requireExists && !File.Exists(full))
            throw new ProtocolException("project_not_found", "The canonical " + TiaNativeTarget.ProjectExtension + " file does not exist.");
        return new FileInfo(full).FullName;
    }

    private static bool PathEquals(string left, string right)
    {
        return String.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    }

    private static string JoinPath(string left, string right)
    {
        if (String.IsNullOrWhiteSpace(left)) return right ?? "";
        if (String.IsNullOrWhiteSpace(right)) return left;
        return left + "\\" + right;
    }

    private static string JoinSlash(string left, string right)
    {
        if (String.IsNullOrWhiteSpace(left)) return right ?? "";
        if (String.IsNullOrWhiteSpace(right)) return left;
        return left + "/" + right;
    }

    private static string Utc(DateTime value)
    {
        if (value.Kind == DateTimeKind.Unspecified)
            return DateTime.SpecifyKind(value, DateTimeKind.Local).ToUniversalTime().ToString("o");
        return value.ToUniversalTime().ToString("o");
    }

    private static string Safe(Func<string> getter)
    {
        try { return getter(); }
        catch { return null; }
    }

    private static string SafeError(Exception ex)
    {
        if (ex == null) return "Unknown error.";
        Exception real = ex;
        while (real.InnerException != null &&
            (real.GetType().Name == "TargetInvocationException" || real.GetType().Name == "AggregateException"))
            real = real.InnerException;
        string message = real.GetType().Name + ": " + real.Message;
        message = message.Replace("\r", " ").Replace("\n", " ").Trim();
        if (message.Length > 1200) message = message.Substring(0, 1200);
        return message;
    }

    private static string ReadInformationalVersion()
    {
        try
        {
            object[] attributes = CoreAssembly.GetCustomAttributes(
                typeof(AssemblyInformationalVersionAttribute),
                false);
            if (attributes.Length > 0)
            {
                AssemblyInformationalVersionAttribute attribute =
                    attributes[0] as AssemblyInformationalVersionAttribute;
                if (attribute != null && !String.IsNullOrWhiteSpace(attribute.InformationalVersion))
                    return attribute.InformationalVersion;
            }
            return CoreAssembly.GetName().Version == null
                ? "unknown"
                : CoreAssembly.GetName().Version.ToString();
        }
        catch
        {
            return "unknown";
        }
    }

    private static string TryReadFileSha256(string filePath)
    {
        try
        {
            return String.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath)
                ? null
                : Sha256Hex(File.ReadAllBytes(filePath));
        }
        catch
        {
            return null;
        }
    }

    private static string ReadApiAssemblyVersion()
    {
        try
        {
            Version version = typeof(TiaPortal).Assembly.GetName().Version;
            return version == null ? "unknown" : version.ToString();
        }
        catch
        {
            return "unknown";
        }
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(bytes);
            StringBuilder builder = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest) builder.Append(value.ToString("x2"));
            return builder.ToString();
        }
    }

    private static string BuildDefaultPipeName()
    {
        string sid = "unknown";
        try
        {
            SecurityIdentifier currentSid = WindowsIdentity.GetCurrent().User;
            if (currentSid != null) sid = currentSid.Value;
        }
        catch { }
        return "tia-mcp-live-read-v1-" + Sha256Hex(Encoding.UTF8.GetBytes(sid)).Substring(0, 16);
    }

    private static void ValidatePipeName(string pipeName)
    {
        if (String.IsNullOrWhiteSpace(pipeName) || pipeName.Length > 128)
            throw new ProtocolException("invalid_pipe_name", "The pipe name must contain 1..128 safe characters.");
        foreach (char value in pipeName)
        {
            bool safe = Char.IsLetterOrDigit(value) || value == '_' || value == '-' || value == '.';
            if (!safe) throw new ProtocolException("invalid_pipe_name", "The pipe name contains an unsafe character.");
        }
    }

    private static void ConfigureAssemblyResolution(string apiPath)
    {
        _apiPath = Path.GetFullPath(apiPath);
        if (!File.Exists(_apiPath))
            throw new FileNotFoundException("Siemens.Engineering.dll was not found.", _apiPath);
        if (!String.Equals(Path.GetFileName(_apiPath), "Siemens.Engineering.dll", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("--api must point to Siemens.Engineering.dll.");
        AssemblyName apiAssemblyName = AssemblyName.GetAssemblyName(_apiPath);
        TiaNativeTarget.RequireApi(apiAssemblyName, "--api must point to " + TiaNativeTarget.ApiRequirement + ".");

        string apiDirectory = Path.GetDirectoryName(_apiPath);
        DirectoryInfo publicApi = Directory.GetParent(apiDirectory);
        DirectoryInfo portalRoot = publicApi == null ? null : publicApi.Parent;
        List<string> directories = new List<string>();
        directories.Add(apiDirectory);
        if (portalRoot != null)
        {
            directories.Add(Path.Combine(portalRoot.FullName, "Bin", "PublicAPI"));
            directories.Add(Path.Combine(portalRoot.FullName, "Bin"));
        }
        _resolveDirectories = directories.ToArray();

        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs eventArgs)
        {
            AssemblyName requested = new AssemblyName(eventArgs.Name);
            foreach (string directory in _resolveDirectories)
            {
                string candidate = Path.Combine(directory, requested.Name + ".dll");
                if (File.Exists(candidate)) return System.Reflection.Assembly.LoadFrom(candidate);
            }
            return null;
        };

        foreach (string directory in _resolveDirectories)
        {
            string contract = Path.Combine(directory, "Siemens.Engineering.Contract.dll");
            if (!File.Exists(contract)) continue;
            System.Reflection.Assembly.LoadFrom(contract);
            break;
        }
        System.Reflection.Assembly.LoadFrom(_apiPath);
    }

    // What this core implements for its build target; reported by --self-test.
    private static readonly string[] SelfTestCapabilities =
    {
        "snapshot_export", "live_query", "navigation", "engineering_inspect", "hmi_export"
    };

    private static int RunSelfTest()
    {
        List<object> checks = new List<object>();
        bool ok = true;
        string tempDirectory = Path.Combine(Path.GetTempPath(), "TiaLiveReadCoreSelfTest-" + Guid.NewGuid().ToString("N"));
        string projectPath = Path.Combine(tempDirectory, "synthetic" + TiaNativeTarget.ProjectExtension);
        string cleanupDirectory = Path.Combine(tempDirectory, Guid.NewGuid().ToString("N"));
        string cleanupPath = Path.Combine(cleanupDirectory, "cleanup.tmp");
        string snapshotOutputDirectory = Path.Combine(tempDirectory, "snapshot-output");
        try
        {
            Directory.CreateDirectory(tempDirectory);
            bool asciiSnapshotNamesOk =
                SanitizeSnapshotFileName("FC1 \u6d4b\u8bd5\u5757", 72) == "FC1" &&
                SanitizeSnapshotFileName("\u9ed8\u8ba4\u53d8\u91cf\u8868", 72) == "unnamed" &&
                SanitizeSnapshotFileName("../A:B", 72) == "A_B" &&
                SanitizeSnapshotFileName(new String('a', 100), 72).Length == 72;
            checks.Add(Map("name", "snapshot_ascii_file_names", "ok", asciiSnapshotNamesOk));
            ok = ok && asciiSnapshotNamesOk;
            File.WriteAllText(projectPath, "offline synthetic path test", new UTF8Encoding(false));
            string canonical = CanonicalProjectPath(projectPath, true);
            bool canonicalOk = PathEquals(canonical, new FileInfo(projectPath).FullName);
            checks.Add(Map("name", "canonical_" + TiaNativeTarget.ExtensionTag + "_path", "ok", canonicalOk));
            ok = ok && canonicalOk;

            List<string>[] mismatchPaths = new List<string>[] {
                null, new List<string>(), new List<string> { canonical + ".other" },
                new List<string> { canonical, canonical }
            };
            string[] mismatchReasons = new string[] {
                "descriptor_path_mismatch", "empty_project_collection",
                "attached_path_mismatch", "multiple_exact_matches"
            };
            bool mismatchDiagnosticsOk = true;
            for (int i = 0; i < mismatchPaths.Length; i++)
            {
                ProtocolException mismatch = ProjectMismatch("offline_test", 4242, canonical, canonical, mismatchPaths[i]);
                Dictionary<string, object> failure = ProtocolErrorResponse("mismatch-test", mismatch);
                Dictionary<string, object> details = failure["diagnostics"] as Dictionary<string, object>;
                mismatchDiagnosticsOk = mismatchDiagnosticsOk &&
                    !GetBool(failure, "ok", true) && GetString(failure, "status", null) == "project_mismatch" &&
                    GetString(details, "reason", null) == mismatchReasons[i] &&
                    GetString(details, "expectedProjectPath", null) == canonical &&
                    GetBool(details, "projectsEnumerated", false) == (i != 0) &&
                    (i != 0 || details["projectCount"] == null);
            }
            ProtocolException boundedMismatch = ProjectMismatch("offline_test", 4242, canonical, canonical,
                Enumerable.Repeat(canonical, 21).ToList());
            mismatchDiagnosticsOk = mismatchDiagnosticsOk &&
                GetInt(boundedMismatch.Details, "exactMatchCount", 0) == 21 &&
                ((string[])boundedMismatch.Details["observedProjectPaths"]).Length == 20 &&
                GetBool(boundedMismatch.Details, "pathsTruncated", false);
            checks.Add(Map("name", "project_mismatch_diagnostics", "ok", mismatchDiagnosticsOk));
            ok = ok && mismatchDiagnosticsOk;

            SnapshotCliOptions snapshotCli = BuildSnapshotCliOptions(
                4242,
                projectPath,
                null,
                638000000000000000L,
                snapshotOutputDirectory);
            bool snapshotCliOk =
                snapshotCli.Session.ProcessId == 4242 &&
                snapshotCli.Session.ExpectedProcessStartUtcTicks == 638000000000000000L &&
                PathEquals(
                    snapshotCli.OutputRoot,
                    Path.GetFullPath(snapshotOutputDirectory));
            checks.Add(Map("name", "snapshot_cli_exact_identity", "ok", snapshotCliOk));
            ok = ok && snapshotCliOk;

            bool snapshotCliAmbiguousStartRejected = false;
            try
            {
                BuildSnapshotCliOptions(
                    4242,
                    projectPath,
                    "2026-07-29T00:00:00Z",
                    638000000000000000L,
                    snapshotOutputDirectory);
            }
            catch (ProtocolException ex)
            {
                snapshotCliAmbiguousStartRejected = ex.Status == "invalid_argument";
            }
            checks.Add(Map(
                "name", "snapshot_cli_rejects_ambiguous_process_start",
                "ok", snapshotCliAmbiguousStartRejected));
            ok = ok && snapshotCliAmbiguousStartRejected;

            Dictionary<string, object> pingRequest = Map(
                "protocolVersion", ProtocolVersion,
                "requestId", "self-test-ping",
                "operation", "ping");
            Dictionary<string, object> ping = Dispatch(pingRequest, "self-test-ping");
            bool envelopeOk = GetBool(ping, "ok", false) &&
                GetInt(ping, "protocolVersion", 0) == ProtocolVersion &&
                String.Equals(GetString(ping, "requestId", null), "self-test-ping", StringComparison.Ordinal);
            checks.Add(Map("name", "protocol_envelope_and_ping", "ok", envelopeOk));
            ok = ok && envelopeOk;

            bool protocolMismatchOk = false;
            try { Dispatch(Map("protocolVersion", 2, "operation", "ping"), "wrong-version"); }
            catch (ProtocolException ex) { protocolMismatchOk = ex.Status == "protocol_mismatch"; }
            checks.Add(Map("name", "reject_protocol_version_mismatch", "ok", protocolMismatchOk));
            ok = ok && protocolMismatchOk;

            bool allowlistOk = false;
            try { Dispatch(Map("protocolVersion", ProtocolVersion, "operation", "save_project"), "bad"); }
            catch (ProtocolException ex) { allowlistOk = ex.Status == "unsupported_operation"; }
            checks.Add(Map("name", "readonly_operation_allowlist", "ok", allowlistOk));
            ok = ok && allowlistOk;

            Dictionary<string, object> navigation = Dispatch(
                Map("protocolVersion", ProtocolVersion, "operation", "navigate_object", "requestId", "nav-denied", "confirmNavigation", false),
                "nav-denied");
            bool navigationGateOk =
                !GetBool(navigation, "ok", true) &&
                String.Equals(GetString(navigation, "status", null), "confirmation_required", StringComparison.Ordinal);
            checks.Add(Map("name", "navigation_confirmation_gate", "ok", navigationGateOk));
            ok = ok && navigationGateOk;

            Directory.CreateDirectory(cleanupDirectory);
            File.WriteAllText(cleanupPath, "delete me", new UTF8Encoding(false));
            Dictionary<string, object> cleanup;
            try
            {
                // Synthetic work. Cleanup is deliberately in finally to test the
                // same invariant used by one-block export.
                throw new IOException("synthetic failure");
            }
            catch (IOException) { }
            finally
            {
                cleanup = DeleteTemporaryArtifacts(cleanupPath, cleanupDirectory);
            }
            bool cleanupOk = GetBool(cleanup, "deleted", false) &&
                !File.Exists(cleanupPath) &&
                !Directory.Exists(cleanupDirectory);
            checks.Add(Map("name", "temporary_file_finally_cleanup", "ok", cleanupOk));
            ok = ok && cleanupOk;

            bool invalidExtensionOk = false;
            try { CanonicalProjectPath(Path.Combine(tempDirectory, "bad" + TiaNativeTarget.ForeignExtension), false); }
            catch (ProtocolException ex) { invalidExtensionOk = ex.Status == "invalid_project_path"; }
            checks.Add(Map("name", "reject_non_" + TiaNativeTarget.ExtensionTag + "_path", "ok", invalidExtensionOk));
            ok = ok && invalidExtensionOk;

            bool xmlLimitOk = false;
            try { ParseOptions(Map("maxXmlBytes", AbsoluteMaxXmlBytes + 1)); }
            catch (ProtocolException ex) { xmlLimitOk = ex.Status == "invalid_options"; }
            checks.Add(Map("name", "reject_out_of_range_max_xml_bytes", "ok", xmlLimitOk));
            ok = ok && xmlLimitOk;

            QueryOptions defaultInventoryOptions = ParseOptions(Map());
            bool defaultInventoryOptionsOk =
                !defaultInventoryOptions.RefreshInventory &&
                defaultInventoryOptions.RetryNotFoundWithRefresh;
            checks.Add(Map(
                "name", "inventory_query_option_defaults",
                "ok", defaultInventoryOptionsOk));
            ok = ok && defaultInventoryOptionsOk;

            QueryOptions explicitInventoryOptions = ParseOptions(Map(
                "refreshInventory", true,
                "retryNotFoundWithRefresh", false));
            bool explicitInventoryOptionsOk =
                explicitInventoryOptions.RefreshInventory &&
                !explicitInventoryOptions.RetryNotFoundWithRefresh;
            checks.Add(Map(
                "name", "inventory_query_option_overrides",
                "ok", explicitInventoryOptionsOk));
            ok = ok && explicitInventoryOptionsOk;

            SessionState inventoryTtlState = new SessionState();
            inventoryTtlState.InventoryKinds = new HashSet<ObjectKind>();
            inventoryTtlState.InventoryBuiltAtByKind = new Dictionary<ObjectKind, DateTime>();
            inventoryTtlState.InventoryKinds.Add(ObjectKind.Block);
            inventoryTtlState.InventoryBuiltAtByKind[ObjectKind.Block] = DateTime.UtcNow;
            bool freshInventoryAccepted = InventoryIncludesFreshKind(
                inventoryTtlState,
                ObjectKind.Block);
            inventoryTtlState.InventoryBuiltAtByKind[ObjectKind.Block] =
                DateTime.UtcNow.AddSeconds(-(InventoryTtlSeconds + 1));
            bool staleInventoryRejected = !InventoryIncludesFreshKind(
                inventoryTtlState,
                ObjectKind.Block);
            bool absentKindRejected = !InventoryIncludesFreshKind(
                inventoryTtlState,
                ObjectKind.PlcType);
            bool inventoryTtlOk =
                freshInventoryAccepted &&
                staleInventoryRejected &&
                absentKindRejected;
            checks.Add(Map(
                "name", "per_kind_inventory_ttl",
                "ok", inventoryTtlOk,
                "ttlSeconds", InventoryTtlSeconds));
            ok = ok && inventoryTtlOk;

            QueryOptions interfaceOptions = new QueryOptions(
                false,
                true,
                false,
                false,
                false,
                true,
                10,
                10,
                10,
                5,
                DefaultMaxXmlBytes,
                100);
            Dictionary<string, object> shallowDirectInterface = Map(
                "available", true,
                "status", "direct_public_property",
                "truncated", false,
                "fullDatatypeAndStartValueSchemaRequiresExport", true);
            Dictionary<string, object> noCrossReferences = Map(
                "included", false,
                "status", "not_requested");
            Dictionary<string, object> noBlockXml = Map(
                "included", false,
                "status", "not_requested");
            Dictionary<string, object> shallowCompleteness = BuildQueryCompleteness(
                interfaceOptions,
                shallowDirectInterface,
                noCrossReferences,
                noBlockXml);
            bool shallowInterfaceRefusedAsComplete =
                !GetBool(shallowCompleteness, "requestedActionCompleted", true) &&
                ((List<object>)shallowCompleteness["incompleteComponents"]).Count == 1;
            checks.Add(Map(
                "name",
                "db_member_names_do_not_complete_full_interface",
                "ok",
                shallowInterfaceRefusedAsComplete));
            ok = ok && shallowInterfaceRefusedAsComplete;

            Dictionary<string, object> includedBlockXml = Map(
                "included", true,
                "status", "included");
            Dictionary<string, object> xmlCompleteness = BuildQueryCompleteness(
                interfaceOptions,
                shallowDirectInterface,
                noCrossReferences,
                includedBlockXml);
            bool blockXmlCompletesFullInterface =
                GetBool(xmlCompleteness, "requestedActionCompleted", false) &&
                ((List<object>)xmlCompleteness["incompleteComponents"]).Count == 0;
            checks.Add(Map(
                "name",
                "one_block_xml_completes_full_interface",
                "ok",
                blockXmlCompletesFullInterface));
            ok = ok && blockXmlCompletesFullInterface;

            string serialized = Serialize(ping);
            bool newlineOk = serialized.IndexOf('\n') < 0 && serialized.IndexOf('\r') < 0;
            checks.Add(Map("name", "newline_json_framing", "ok", newlineOk));
            ok = ok && newlineOk;

            Dictionary<string, object> candidateContract =
                SnapshotCandidateContractMap();
            bool snapshotCandidateContractOk =
                candidateContract.Count == 3 &&
                GetInt(candidateContract, "contractVersion", 0) == 1 &&
                GetBool(candidateContract, "candidateOnly", false) &&
                !GetBool(
                    candidateContract,
                    "currentPointerWrittenByNative",
                    true);
            checks.Add(Map(
                "name", "snapshot_candidate_contract_v1",
                "ok", snapshotCandidateContractOk));
            ok = ok && snapshotCandidateContractOk;

            Directory.CreateDirectory(snapshotOutputDirectory);
            string pointerPath = Path.Combine(snapshotOutputDirectory, "current.json");
            PreviousSnapshotPointerState absentPointer =
                ReadPreviousSnapshotPointerStrict(
                    pointerPath,
                    snapshotOutputDirectory);
            Dictionary<string, object> absentPointerMap =
                absentPointer.ToResponseMap();
            bool absentPointerOk =
                !absentPointer.Exists &&
                absentPointer.SnapshotId == null &&
                absentPointer.ManifestSha256 == null &&
                absentPointer.PublishedPath == null &&
                absentPointerMap.ContainsKey("previousCurrentExists") &&
                absentPointerMap.ContainsKey("previousCurrentSnapshotId") &&
                absentPointerMap.ContainsKey("previousCurrentManifestSha256") &&
                absentPointerMap["previousCurrentSnapshotId"] == null &&
                absentPointerMap["previousCurrentManifestSha256"] == null;

            string snapshotsDirectory = Path.Combine(
                snapshotOutputDirectory,
                "snapshots");
            string firstSnapshotDirectory = Path.Combine(
                snapshotsDirectory,
                "first");
            string secondSnapshotDirectory = Path.Combine(
                snapshotsDirectory,
                "second");
            Directory.CreateDirectory(firstSnapshotDirectory);
            Directory.CreateDirectory(secondSnapshotDirectory);
            string firstManifestPath = Path.Combine(
                firstSnapshotDirectory,
                "manifest.json");
            string secondManifestPath = Path.Combine(
                secondSnapshotDirectory,
                "manifest.json");
            WriteJsonFile(firstManifestPath, Map("snapshotId", "first"));
            WriteJsonFile(secondManifestPath, Map("snapshotId", "second"));
            string firstManifestSha256 = FileSha256(firstManifestPath);
            string secondManifestSha256 = FileSha256(secondManifestPath);
            AtomicWriteJson(pointerPath, Map(
                "schemaVersion", "1.0",
                "snapshotId", "first",
                "snapshotRelativePath", "snapshots/first",
                "manifestRelativePath", "snapshots/first/manifest.json",
                "manifestSha256", firstManifestSha256));
            AtomicWriteJson(pointerPath, Map(
                "schemaVersion", "1.0",
                "snapshotId", "second",
                "snapshotRelativePath", "snapshots/second",
                "manifestRelativePath", "snapshots/second/manifest.json",
                "manifestSha256", secondManifestSha256));
            Dictionary<string, object> pointer = Json.DeserializeObject(
                File.ReadAllText(pointerPath, Encoding.UTF8)) as Dictionary<string, object>;
            PreviousSnapshotPointerState previousPointer =
                ReadPreviousSnapshotPointerStrict(
                pointerPath,
                snapshotOutputDirectory);
            bool pointerAtomicOk =
                absentPointerOk &&
                pointer != null &&
                String.Equals(
                    GetString(pointer, "snapshotId", null),
                    "second",
                    StringComparison.Ordinal) &&
                previousPointer.Exists &&
                String.Equals(
                    previousPointer.SnapshotId,
                    "second",
                    StringComparison.Ordinal) &&
                String.Equals(
                    previousPointer.ManifestSha256,
                    secondManifestSha256,
                    StringComparison.Ordinal) &&
                PathEquals(
                    previousPointer.PublishedPath,
                    secondSnapshotDirectory) &&
                Directory.GetFiles(
                    snapshotOutputDirectory,
                    ".current.json.*",
                    SearchOption.TopDirectoryOnly).Length == 0;
            checks.Add(Map("name", "snapshot_pointer_atomic_replace", "ok", pointerAtomicOk));
            ok = ok && pointerAtomicOk;

            // Incremental reuse: only a verified, complete manifest of the same project is a source, and an
            // entry stands in for a fresh export only with an equal fingerprint and unchanged dependencies
            // (tag tables depend on nothing else).
            string reuseDirectory = Path.Combine(snapshotOutputDirectory, "snapshots", "reuse-src");
            Directory.CreateDirectory(Path.Combine(reuseDirectory, "objects", "blocks"));
            File.WriteAllText(Path.Combine(reuseDirectory, "objects", "blocks", "000001-FC1-aaaaaaaaaaaa.xml"), "<Document/>", new UTF8Encoding(false));
            string objectSha256 = FileSha256(Path.Combine(reuseDirectory, "objects", "blocks", "000001-FC1-aaaaaaaaaaaa.xml"));
            string fingerprintA = new String('a', 64);
            string recordKeyA = new String('b', 64);
            DateTime reuseNow = DateTime.UtcNow;
            Dictionary<string, object> reusableEntry = Map(
                "exportedAtUtc", Utc(reuseNow.AddHours(-1)),
                "recordKey", recordKeyA,
                "relativePath", "objects/blocks/000001-FC1-aaaaaaaaaaaa.xml",
                "sha256", objectSha256,
                "status", "exported",
                "success", true,
                "modifiedState", Map("fingerprint", fingerprintA));
            WriteJsonFile(Path.Combine(reuseDirectory, "manifest.json"), Map(
                "status", "consistent_complete",
                "complete", true,
                "project", Map("canonicalProjectPath", canonical),
                "reuse", Map("dependencyStamp", "stamp-1"),
                "objects", new List<object> { reusableEntry }));
            string reuseManifestSha256 = FileSha256(Path.Combine(reuseDirectory, "manifest.json"));
            SnapshotReuseSource loadedReuse = LoadSnapshotReuseSource(
                new PreviousSnapshotPointerState(true, "reuse-src", reuseManifestSha256, reuseDirectory),
                canonical);
            Dictionary<string, object> loadedEntry = null;
            bool reuseLoaded = loadedReuse != null &&
                loadedReuse.DependencyStamp == "stamp-1" &&
                loadedReuse.EntriesByRecordKey.TryGetValue(recordKeyA, out loadedEntry);
            bool reuseOtherProjectRejected = LoadSnapshotReuseSource(
                new PreviousSnapshotPointerState(true, "reuse-src", reuseManifestSha256, reuseDirectory),
                canonical + ".other") == null;
            bool reuseWrongShaRejected = LoadSnapshotReuseSource(
                new PreviousSnapshotPointerState(true, "reuse-src", new String('0', 64), reuseDirectory),
                canonical) == null;
            Dictionary<string, object> notExported = new Dictionary<string, object>(reusableEntry);
            notExported["status"] = "export_error";
            Dictionary<string, object> escaping = new Dictionary<string, object>(reusableEntry);
            escaping["relativePath"] = "objects/../manifest.xml";
            Dictionary<string, object> stale = new Dictionary<string, object>(reusableEntry);
            stale["exportedAtUtc"] = Utc(reuseNow.AddHours(-SnapshotMaxReuseAgeHours - 1));
            Dictionary<string, object> undated = new Dictionary<string, object>(reusableEntry);
            undated.Remove("exportedAtUtc");
            File.WriteAllText(Path.Combine(reuseDirectory, "header-a.xml"), "<Document><DocumentInfo><Created>2026-01-01T00:00:00Z</Created><InstalledProducts>U6</InstalledProducts></DocumentInfo></Document>", new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(reuseDirectory, "header-b.xml"), "<Document><DocumentInfo><Created>2026-02-02T00:00:00Z</Created><InstalledProducts>U6</InstalledProducts></DocumentInfo></Document>", new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(reuseDirectory, "header-c.xml"), "<Document><DocumentInfo><Created>2026-02-02T00:00:00Z</Created><InstalledProducts>U7</InstalledProducts></DocumentInfo></Document>", new UTF8Encoding(false));
            bool headersOk =
                SnapshotExportHeader(Path.Combine(reuseDirectory, "header-a.xml")) == SnapshotExportHeader(Path.Combine(reuseDirectory, "header-b.xml")) &&
                SnapshotExportHeader(Path.Combine(reuseDirectory, "header-a.xml")) != SnapshotExportHeader(Path.Combine(reuseDirectory, "header-c.xml"));
            // Kept state values: the export loop must use them without touching the object (Value is null
            // here), in the same fingerprint format the older manifests were written with.
            string[] keptValues = new string[] { "LAD", "True", "False", "d-mod", "d-code", "d-if", "False", "False" };
            ObjectRecord keptRecord = new ObjectRecord { Kind = ObjectKind.Block, SnapshotStateValues = keptValues };
            Dictionary<string, object> keptMap = BuildSnapshotModifiedStateMap(keptRecord);
            bool keptStateOk =
                SnapshotModifiedStateText(new string[] { "a", "", "bc" }) == "1:a0:2:bc" &&
                GetString(keptMap, "fingerprint", null) == Sha256Hex(Encoding.UTF8.GetBytes(SnapshotModifiedStateText(keptValues))) &&
                GetString(keptMap, "modifiedDate", null) == "d-mod" &&
                GetString(keptMap, "codeModifiedDate", null) == "d-code" &&
                GetString(keptMap, "interfaceModifiedDate", null) == "d-if" &&
                GetString(keptMap, "isConsistent", null) == "True" &&
                SnapshotProgrammingLanguage(keptRecord) == "LAD" &&
                Object.ReferenceEquals(SnapshotRecordStateValues(keptRecord, false), keptValues);
            // One-pass copy: the returned hash is the copied file's, and an existing target is never overwritten.
            string copySource = Path.Combine(reuseDirectory, "copy-source.xml");
            string copyTarget = Path.Combine(reuseDirectory, "copy-target.xml");
            File.WriteAllText(copySource, "<Document>" + new String('x', 200000) + "</Document>", new UTF8Encoding(false));
            bool copyOk = CopySnapshotFileHashed(copySource, copyTarget) == FileSha256(copyTarget) &&
                FileSha256(copyTarget) == FileSha256(copySource);
            bool copyRefusesOverwrite = false;
            try { CopySnapshotFileHashed(copySource, copyTarget); }
            catch (IOException) { copyRefusesOverwrite = true; }
            // Kind sets for the single inventory walk; a non-engineering object gets no bulk values.
            int bulkCheck = 0;
            string[] bulkFallback = SnapshotBulkStateValues(new object(), SnapshotTypeStateAttributes, ref bulkCheck,
                delegate { return new string[] { "t" }; });
            bool kindsOk =
                WantsKind(null, ObjectKind.PlcTag) &&
                WantsKind(new ObjectKind[] { ObjectKind.Block, ObjectKind.TagTable }, ObjectKind.TagTable) &&
                !WantsKind(new ObjectKind[] { ObjectKind.Block, ObjectKind.TagTable }, ObjectKind.PlcTag) &&
                SnapshotBulkAttributes(new object(), SnapshotBlockStateAttributes) == null &&
                bulkFallback.Length == 1 && bulkFallback[0] == "t" && bulkCheck == 0;
            keptStateOk = keptStateOk && copyOk && copyRefusesOverwrite && kindsOk;
            bool reuseRulesOk =
                reuseLoaded && reuseOtherProjectRejected && reuseWrongShaRejected && headersOk && keptStateOk &&
                SnapshotEntryReusable(loadedEntry, fingerprintA, true, reuseNow) &&
                !SnapshotEntryReusable(loadedEntry, fingerprintA, false, reuseNow) &&
                !SnapshotEntryReusable(loadedEntry, new String('c', 64), true, reuseNow) &&
                !SnapshotEntryReusable(notExported, fingerprintA, true, reuseNow) &&
                !SnapshotEntryReusable(escaping, fingerprintA, true, reuseNow) &&
                !SnapshotEntryReusable(stale, fingerprintA, true, reuseNow) &&
                !SnapshotEntryReusable(undated, fingerprintA, true, reuseNow) &&
                !SnapshotEntryReusable(null, fingerprintA, true, reuseNow);
            checks.Add(Map("name", "snapshot_incremental_reuse_rules", "ok", reuseRulesOk));
            ok = ok && reuseRulesOk;


            // Semantic dependencies ignore export creation time and executable body changes,
            // but preserve interface changes, DB values, UDT layout and installed-product metadata.
            string dependencyFile = Path.Combine(reuseDirectory, "dependency.xml");
            string dbText = "<Document><DocumentInfo><Created>old</Created><InstalledProducts>U6</InstalledProducts></DocumentInfo><SW.Blocks.GlobalDB><AttributeList><Interface><Value>1</Value></Interface></AttributeList></SW.Blocks.GlobalDB></Document>";
            File.WriteAllText(dependencyFile, dbText);
            string dbHash = DependencyHash(dependencyFile, "DB");
            File.WriteAllText(dependencyFile, dbText.Replace(">old<", ">new<"));
            bool semanticOk = dbHash == DependencyHash(dependencyFile, "DB");
            File.WriteAllText(dependencyFile, dbText.Replace(">1<", ">2<"));
            semanticOk = semanticOk && dbHash != DependencyHash(dependencyFile, "DB");
            foreach (string semanticKind in new string[] { "FB", "FC", "OB" }) {
                string code = "<Document><SW.Blocks." + semanticKind + "><AttributeList><Interface><Member Name=\"x\"/></Interface><ModifiedDate>old</ModifiedDate></AttributeList><ObjectList>old body</ObjectList></SW.Blocks." + semanticKind + "></Document>";
                File.WriteAllText(dependencyFile, code);
                string codeHash = DependencyHash(dependencyFile, semanticKind);
                File.WriteAllText(dependencyFile, code.Replace("old", "new"));
                semanticOk = semanticOk && codeHash == DependencyHash(dependencyFile, semanticKind);
                File.WriteAllText(dependencyFile, code.Replace("Name=\"x\"", "Name=\"y\""));
                semanticOk = semanticOk && codeHash != DependencyHash(dependencyFile, semanticKind);
            }
            checks.Add(Map("name", "dependency_v3_semantic_content", "ok", semanticOk));
            ok = ok && semanticOk;
            ObjectRecord dbRecord = new ObjectRecord { Kind = ObjectKind.Block, BlockKind = "GlobalDB" };
            File.WriteAllText(dependencyFile, dbText);
            Dictionary<string, object> oldDependencyEntry = Map("relativePath", "dependency.xml", "sha256", FileSha256(dependencyFile));
            bool legacyHashOk = PreviousDependencyHash(dbRecord, oldDependencyEntry, loadedReuse) == dbHash;
            File.WriteAllText(dependencyFile, dbText.Replace(">1<", ">2<"));
            bool badXmlRejected = false;
            try { PreviousDependencyHash(dbRecord, oldDependencyEntry, loadedReuse); }
            catch (InvalidDataException) { badXmlRejected = true; }
            oldDependencyEntry["dependencyHash"] = dbHash;
            legacyHashOk = legacyHashOk && badXmlRejected && PreviousDependencyHash(dbRecord, oldDependencyEntry, loadedReuse) == dbHash;
            checks.Add(Map("name", "dependency_v3_legacy_sha_guard", "ok", legacyHashOk));
            ok = ok && legacyHashOk;


            string verifyProject = Path.Combine(snapshotOutputDirectory, "verify.ap20");
            File.WriteAllText(verifyProject, "offline identity fixture");
            int verifyPid = Process.GetCurrentProcess().Id;
            long verifyStart = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks;
            _session = new SessionState { ProcessId = verifyPid, ProcessStartUtcTicks = verifyStart, CanonicalProjectPath = verifyProject };
            SessionRequest bootstrapped = ParseSessionRequest(PreparedVerificationRequest(Map("processId", verifyPid, "projectPath", verifyProject)));
            bool verifyGuardsOk = bootstrapped.ExpectedProcessStartUtcTicks == verifyStart && PathEquals(bootstrapped.ProjectPath, verifyProject);
            Dictionary<string, object> wrongProject = HandleVerifySession(Map("processId", verifyPid, "projectPath", verifyProject + ".other"), "offline");
            verifyGuardsOk = verifyGuardsOk && !GetBool(wrongProject, "ok", true) && GetString(wrongProject, "status", "") == "session_not_prepared" && _session == null;
            _session = new SessionState { ProcessId = verifyPid, ProcessStartUtcTicks = verifyStart - 1, CanonicalProjectPath = verifyProject };
            // Mismatch is rejected by the OS-start guard before TiaPortal.GetProcess or any attachment.
            Dictionary<string, object> restartedProcess = HandleVerifySession(Map("processId", verifyPid, "projectPath", verifyProject), "offline");
            verifyGuardsOk = verifyGuardsOk && !GetBool(restartedProcess, "ok", true) && _session == null;
            Dictionary<string, object> noPrepared = HandleVerifySession(Map("processId", verifyPid, "projectPath", verifyProject), "offline");
            verifyGuardsOk = verifyGuardsOk && GetString(noPrepared, "status", "") == "session_not_prepared";
            checks.Add(Map("name", "verify_session_cached_identity_guards", "ok", verifyGuardsOk));
            ok = ok && verifyGuardsOk;

            int staleAttempts = 0;
            RetrySignatureExport(delegate { if (++staleAttempts == 1) throw new InvalidOperationException("Invalidated Openness object"); });
            bool retryOk = staleAttempts == 2;
            staleAttempts = 0;
            try { RetrySignatureExport(delegate { staleAttempts++; throw new InvalidOperationException("Still invalid"); }); retryOk = false; }
            catch (InvalidOperationException) { retryOk = retryOk && staleAttempts == 2; }
            staleAttempts = 0;
            try { RetrySignatureExport(delegate { staleAttempts++; throw new ProtocolException("target_ambiguous_or_missing", "ambiguous"); }); retryOk = false; }
            catch (ProtocolException) { retryOk = retryOk && staleAttempts == 1; }
            checks.Add(Map("name", "signature_invalidated_object_retry", "ok", retryOk));
            ok = ok && retryOk;

            ObjectRecord targetA = new ObjectRecord { Kind = ObjectKind.Block, BlockKind = "FC", Name = "Exact", Number = 7, SoftwarePath = "PLC_A" };
            ObjectRecord targetB = new ObjectRecord { Kind = ObjectKind.Block, BlockKind = "FC", Name = "Exact", Number = 7, SoftwarePath = "PLC_B" };
            bool uniqueTargetOk = FindSignatureTarget(new List<ObjectRecord> { targetA }, "FC", "Exact", "7") == targetA;
            try { FindSignatureTarget(new List<ObjectRecord> { targetA, targetB }, "FC", "Exact", "7"); uniqueTargetOk = false; }
            catch (ProtocolException) { }
            targetB.IsSystemBlock = true;
            uniqueTargetOk = uniqueTargetOk && FindSignatureTarget(new List<ObjectRecord> { targetA, targetB }, "FC", "Exact", "7") == targetA;
            try { FindSignatureTarget(new List<ObjectRecord> { targetA }, "FC", "exact", "7"); uniqueTargetOk = false; }
            catch (ProtocolException) { }
            checks.Add(Map("name", "signature_targets_exact_unique", "ok", uniqueTargetOk));
            ok = ok && uniqueTargetOk;

            File.WriteAllText(
                pointerPath,
                "{",
                new UTF8Encoding(false));
            bool currentPointerReadFailsClosed = false;
            try
            {
                ReadPreviousSnapshotPointerStrict(
                    pointerPath,
                    snapshotOutputDirectory);
            }
            catch (ProtocolException ex)
            {
                currentPointerReadFailsClosed =
                    ex.Status == "current_pointer_read_failed";
            }
            checks.Add(Map(
                "name", "snapshot_current_pointer_read_fails_closed",
                "ok", currentPointerReadFailsClosed));
            ok = ok && currentPointerReadFailsClosed;
            AtomicWriteJson(pointerPath, Map(
                "schemaVersion", "1.0",
                "snapshotId", "second",
                "snapshotRelativePath", "snapshots/second",
                "manifestRelativePath", "snapshots/second/manifest.json",
                "manifestSha256", secondManifestSha256));

            bool snapshotPublishGateOk =
                SnapshotPublishAllowed(true, 0) &&
                !SnapshotPublishAllowed(true, 1) &&
                !SnapshotPublishAllowed(false, 0);
            checks.Add(Map(
                "name", "snapshot_publish_requires_zero_export_errors",
                "ok", snapshotPublishGateOk));
            ok = ok && snapshotPublishGateOk;

            bool snapshotRequiredStateReadFailsClosed = false;
            try
            {
                TrySnapshotValue(delegate
                {
                    throw new InvalidOperationException(
                        "synthetic required-state read failure");
                });
            }
            catch (ProtocolException ex)
            {
                snapshotRequiredStateReadFailsClosed =
                    ex.Status == "snapshot_consistency_unavailable";
            }
            checks.Add(Map(
                "name", "snapshot_required_state_read_fails_closed",
                "ok", snapshotRequiredStateReadFailsClosed));
            ok = ok && snapshotRequiredStateReadFailsClosed;

            SnapshotInventoryTraversalErrors.Clear();
            SnapshotInventorySoftwareKeys.Clear();
            SnapshotInventoryTraversalErrors.Add(
                "synthetic software-container traversal failure");
            bool traversalFailureRejected = false;
            try { ValidateSnapshotInventoryAudit(); }
            catch (ProtocolException ex)
            {
                traversalFailureRejected =
                    ex.Status == "snapshot_inventory_incomplete";
            }
            SnapshotInventoryTraversalErrors.Clear();
            bool emptyPlcInventoryRejected = false;
            try { ValidateSnapshotInventoryAudit(); }
            catch (ProtocolException ex)
            {
                emptyPlcInventoryRejected =
                    ex.Status == "snapshot_plc_software_not_found";
            }
            SnapshotInventorySoftwareKeys.Add("CPU/PLC|PLC_1");
            bool onePlcInventoryAccepted = true;
            try { ValidateSnapshotInventoryAudit(); }
            catch { onePlcInventoryAccepted = false; }
            SnapshotInventoryTraversalErrors.Clear();
            SnapshotInventorySoftwareKeys.Clear();
            bool snapshotInventoryAuditFailsClosed =
                traversalFailureRejected &&
                emptyPlcInventoryRejected &&
                onePlcInventoryAccepted;
            checks.Add(Map(
                "name", "snapshot_inventory_audit_fails_closed",
                "ok", snapshotInventoryAuditFailsClosed));
            ok = ok && snapshotInventoryAuditFailsClosed;

            string plainSnapshotChild = EnsureSnapshotDirectChildDirectory(
                snapshotOutputDirectory,
                "plain-child");
            bool plainSnapshotChildAccepted =
                Directory.Exists(plainSnapshotChild);
            string conflictingSnapshotChild = Path.Combine(
                snapshotOutputDirectory,
                "conflicting-child");
            File.WriteAllText(
                conflictingSnapshotChild,
                "not a directory",
                new UTF8Encoding(false));
            bool conflictingSnapshotChildRejected = false;
            try
            {
                EnsureSnapshotDirectChildDirectory(
                    snapshotOutputDirectory,
                    "conflicting-child");
            }
            catch (ProtocolException ex)
            {
                conflictingSnapshotChildRejected =
                    ex.Status == "invalid_output_root";
            }
            bool snapshotOutputLayoutFailsClosed =
                plainSnapshotChildAccepted &&
                conflictingSnapshotChildRejected;
            checks.Add(Map(
                "name", "snapshot_output_layout_fails_closed",
                "ok", snapshotOutputLayoutFailsClosed));
            ok = ok && snapshotOutputLayoutFailsClosed;

            DateTime staleTime = DateTime.UtcNow.AddHours(
                -(SnapshotStagingMaxAgeHours + 2));
            string staleOwnedDirectory = Path.Combine(
                snapshotOutputDirectory,
                SnapshotStagingPrefix + Guid.NewGuid().ToString("N"));
            string recentOwnedDirectory = Path.Combine(
                snapshotOutputDirectory,
                SnapshotStagingPrefix + Guid.NewGuid().ToString("N"));
            string prefixOnlyUnownedDirectory = Path.Combine(
                snapshotOutputDirectory,
                SnapshotStagingPrefix + "not-an-owned-guid");
            Directory.CreateDirectory(staleOwnedDirectory);
            string staleFile = Path.Combine(staleOwnedDirectory, "stale.tmp");
            File.WriteAllText(staleFile, "stale", new UTF8Encoding(false));
            File.SetLastWriteTimeUtc(staleFile, staleTime);
            Directory.SetLastWriteTimeUtc(staleOwnedDirectory, staleTime);
            Directory.CreateDirectory(recentOwnedDirectory);
            Directory.CreateDirectory(prefixOnlyUnownedDirectory);
            Directory.SetLastWriteTimeUtc(prefixOnlyUnownedDirectory, staleTime);

            Dictionary<string, object> staleCleanup =
                CleanupStaleSnapshotStaging(snapshotOutputDirectory);
            bool staleCleanupOk =
                !Directory.Exists(staleOwnedDirectory) &&
                Directory.Exists(recentOwnedDirectory) &&
                Directory.Exists(prefixOnlyUnownedDirectory) &&
                File.Exists(pointerPath) &&
                GetInt(staleCleanup, "removed", 0) == 1 &&
                GetInt(staleCleanup, "skippedRecent", 0) >= 1 &&
                GetInt(staleCleanup, "skippedUnsafe", 0) >= 1 &&
                !GetBool(staleCleanup, "reparsePointsFollowed", true);
            checks.Add(Map(
                "name", "snapshot_stale_staging_cleanup_is_bounded",
                "ok", staleCleanupOk));
            ok = ok && staleCleanupOk;

            Dictionary<string, object> syntheticInventoryState = Map(
                "count", 1,
                "identityFingerprint", "identity",
                "modifiedStateFingerprint", "modified",
                "byKind", Map("block", 1),
                "plcSoftwareCount", 1,
                "plcSoftwareIdentityFingerprint", "software",
                "traversalErrorCount", 0);
            List<object> syntheticObjects = new List<object>();
            syntheticObjects.Add(Map(
                "resourceKind", "block",
                "kind", "FC",
                "blockKind", "FC",
                "name", "Synthetic",
                "number", 1,
                "programmingLanguage", "LAD",
                "softwarePath", "CPU/PLC",
                "relativePath", "objects/blocks/000001-Synthetic.xml",
                "sha256", "abc",
                "bytes", 1,
                "status", "exported",
                "error", null));
            Dictionary<string, object> syntheticManifest = Map(
                "schemaVersion", "1.0",
                "snapshotKind", "tia_openness_full_plc_snapshot",
                "status", "consistent_complete",
                "complete", true,
                "createdAtUtc", Utc(DateTime.UtcNow),
                "completedAtUtc", Utc(DateTime.UtcNow),
                "snapshotId", "synthetic",
                "publishedRelativePath", "snapshots/synthetic",
                "publicationState", "candidate_not_current",
                "previousPublishedPath", null,
                "staleStagingCleanup", Map(
                    "status", "completed",
                    "removed", 0,
                    "reparsePointsFollowed", false),
                "project", Map(
                    "name", "synthetic",
                    "canonicalProjectPath", projectPath,
                    "processId", 4242,
                    "processStartUtcTicks", 638000000000000000L,
                    "processStartTimeUtc", "2022-09-28T22:13:20Z",
                    "isModifiedBefore", false,
                    "isModifiedAfter", false,
                    "fileBefore", Map(),
                    "fileAfter", Map()),
                "openness", Map(),
                "inventory", Map(
                    "before", syntheticInventoryState,
                    "after", syntheticInventoryState),
                "consistency", Map(
                    "consistent", true,
                "inventoryIdentityMatches", true,
                "modifiedStateMatches", true,
                "plcSoftwareIdentityMatches", true,
                "inventoryTraversalComplete", true,
                "projectModifiedStateMatches", true,
                    "projectFileStateMatches", true,
                    "processIdentityVerifiedBeforeAndAfter", true,
                    "publishAllowed", true),
                "objects", syntheticObjects,
                "summary", Map(
                    "inventoryCount", 1,
                    "inventoryByKind", Map("block", 1),
                    "exportableCount", 1,
                    "exportedCount", 1,
                    "exportErrorCount", 0,
                    "contentFingerprint", "content",
                    "tagTablesContainAllTags", true),
                "safety", SnapshotSafetyMap());
            bool manifestContractOk = true;
            try { ValidateSnapshotManifestContract(syntheticManifest); }
            catch { manifestContractOk = false; }
            ((Dictionary<string, object>)syntheticObjects[0]).Remove("relativePath");
            bool manifestMissingFieldRejected = false;
            try { ValidateSnapshotManifestContract(syntheticManifest); }
            catch (ProtocolException ex)
            {
                manifestMissingFieldRejected =
                    ex.Status == "invalid_snapshot_manifest";
            }
            bool snapshotManifestOk =
                manifestContractOk && manifestMissingFieldRejected;
            checks.Add(Map(
                "name", "snapshot_manifest_contract",
                "ok", snapshotManifestOk));
            ok = ok && snapshotManifestOk;
        }
        catch (Exception ex)
        {
            ok = false;
            checks.Add(Map("name", "self_test_exception", "ok", false, "error", SafeError(ex)));
        }
        finally
        {
            try { if (File.Exists(projectPath)) File.Delete(projectPath); }
            catch { ok = false; }
            try { if (File.Exists(cleanupPath)) File.Delete(cleanupPath); }
            catch { ok = false; }
            try { if (Directory.Exists(cleanupDirectory)) Directory.Delete(cleanupDirectory, true); }
            catch { ok = false; }
            try { if (Directory.Exists(snapshotOutputDirectory)) Directory.Delete(snapshotOutputDirectory, true); }
            catch { ok = false; }
            try { if (Directory.Exists(tempDirectory)) Directory.Delete(tempDirectory, false); }
            catch { ok = false; }
        }

        Dictionary<string, object> response = BasicResponse(
            "self-test",
            ok,
            ok ? "self_test_passed" : "self_test_failed",
            ok ? null : "One or more offline checks failed.");
        response["checks"] = checks;
        response["target"] = TiaNativeTarget.Target();
        response["capabilities"] = SelfTestCapabilities;
        // Exercise redirected Unicode JSON without requiring a Portal connection.
        response["utf8Probe"] = "\u8def\u5f84\u5757\u540d";
        response["tiaConnected"] = false;
        response["safety"] = SafetyMap();
        Console.WriteLine(Serialize(response));
        return ok ? 0 : 1;
    }

    private sealed class SnapshotCliOptions
    {
        public readonly SessionRequest Session;
        public readonly string OutputRoot;
        // Copy unchanged objects from the previous complete snapshot instead of exporting them again.
        public bool ReuseUnchanged = true;

        public SnapshotCliOptions(SessionRequest session, string outputRoot)
        {
            Session = session;
            OutputRoot = outputRoot;
        }
    }

    private sealed class SnapshotReuseSource
    {
        public readonly string SnapshotId;
        public readonly string PublishedPath;
        public readonly string DependencyStamp;
        public readonly Dictionary<string, Dictionary<string, object>> EntriesByRecordKey;

        public SnapshotReuseSource(
            string snapshotId,
            string publishedPath,
            string dependencyStamp,
            Dictionary<string, Dictionary<string, object>> entriesByRecordKey)
        {
            SnapshotId = snapshotId;
            PublishedPath = publishedPath;
            DependencyStamp = dependencyStamp;
            EntriesByRecordKey = entriesByRecordKey;
        }
    }

    private sealed class PreviousSnapshotPointerState
    {
        public readonly bool Exists;
        public readonly string SnapshotId;
        public readonly string ManifestSha256;
        public readonly string PublishedPath;

        public PreviousSnapshotPointerState(
            bool exists,
            string snapshotId,
            string manifestSha256,
            string publishedPath)
        {
            Exists = exists;
            SnapshotId = snapshotId;
            ManifestSha256 = manifestSha256;
            PublishedPath = publishedPath;
        }

        public static PreviousSnapshotPointerState Absent()
        {
            return new PreviousSnapshotPointerState(false, null, null, null);
        }

        public Dictionary<string, object> ToResponseMap()
        {
            return Map(
                "previousCurrentExists", Exists,
                "previousCurrentSnapshotId", SnapshotId,
                "previousCurrentManifestSha256", ManifestSha256,
                "previousPublishedPath", PublishedPath);
        }
    }

    private sealed class SnapshotInventoryState
    {
        public readonly int Count;
        public readonly string IdentityFingerprint;
        public readonly string ModifiedStateFingerprint;
        public readonly int PlcSoftwareCount;
        public readonly string PlcSoftwareIdentityFingerprint;
        public readonly int TraversalErrorCount;
        private readonly Dictionary<string, int> _counts;

        public SnapshotInventoryState(
            int count,
            string identityFingerprint,
            string modifiedStateFingerprint,
            Dictionary<string, int> counts,
            int plcSoftwareCount,
            string plcSoftwareIdentityFingerprint,
            int traversalErrorCount)
        {
            Count = count;
            IdentityFingerprint = identityFingerprint;
            ModifiedStateFingerprint = modifiedStateFingerprint;
            _counts = counts ?? new Dictionary<string, int>(StringComparer.Ordinal);
            PlcSoftwareCount = plcSoftwareCount;
            PlcSoftwareIdentityFingerprint = plcSoftwareIdentityFingerprint;
            TraversalErrorCount = traversalErrorCount;
        }

        public Dictionary<string, object> CountsMap()
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            List<string> keys = new List<string>(_counts.Keys);
            keys.Sort(StringComparer.Ordinal);
            foreach (string key in keys) result[key] = _counts[key];
            return result;
        }

        public Dictionary<string, object> ToMap()
        {
            return Map(
                "count", Count,
                "identityFingerprint", IdentityFingerprint,
                "modifiedStateFingerprint", ModifiedStateFingerprint,
                "byKind", CountsMap(),
                "plcSoftwareCount", PlcSoftwareCount,
                "plcSoftwareIdentityFingerprint", PlcSoftwareIdentityFingerprint,
                "traversalErrorCount", TraversalErrorCount);
        }
    }

    private sealed class SnapshotProjectFileState
    {
        public readonly long Bytes;
        public readonly long LastWriteTimeUtcTicks;

        public SnapshotProjectFileState(long bytes, long lastWriteTimeUtcTicks)
        {
            Bytes = bytes;
            LastWriteTimeUtcTicks = lastWriteTimeUtcTicks;
        }

        public bool EqualsState(SnapshotProjectFileState other)
        {
            return other != null &&
                Bytes == other.Bytes &&
                LastWriteTimeUtcTicks == other.LastWriteTimeUtcTicks;
        }

        public Dictionary<string, object> ToMap()
        {
            return Map(
                "bytes", Bytes,
                "lastWriteTimeUtcTicks", LastWriteTimeUtcTicks,
                "lastWriteTimeUtc", new DateTime(
                    LastWriteTimeUtcTicks,
                    DateTimeKind.Utc).ToString("o"));
        }
    }

    private enum ObjectKind
    {
        Block,
        PlcType,
        TagTable,
        PlcTag
    }

    private sealed class ObjectRecord
    {
        public ObjectKind Kind;
        public object Value;
        public string Name;
        public int? Number;
        public string Namespace;
        public string SoftwareName;
        public string SoftwarePath;
        public string GroupPath;
        public string RuntimeType;
        public string BlockKind;
        public PlcTagTable ParentTable;
        public string OfficialIdentifier;
        public bool OfficialIdentifierAttempted;
        // Snapshot only: the modified-state property values read by the "before" fingerprint pass, so the
        // export loop and dependency stamp do not read them again. Every snapshot builds new records.
        public string[] SnapshotStateValues;

        public string KindName
        {
            get
            {
                if (Kind == ObjectKind.Block) return "block";
                if (Kind == ObjectKind.PlcType) return "plc_type";
                if (Kind == ObjectKind.TagTable) return "tag_table";
                return "plc_tag";
            }
        }

        public string NameProvenance
        {
            get
            {
                if (Kind == ObjectKind.Block) return "PlcBlock.Name";
                if (Kind == ObjectKind.PlcType) return "PlcType.Name";
                if (Kind == ObjectKind.TagTable) return "PlcTagTable.Name";
                return "PlcTag.Name";
            }
        }

        public string NamespaceProvenance
        {
            get
            {
                if (Kind == ObjectKind.Block) return "PlcBlock.Namespace";
                if (Kind == ObjectKind.PlcType) return "PlcType.Namespace";
                return "not applicable";
            }
        }

        public bool IsSystemBlock;

        public static ObjectRecord ForBlock(
            PlcBlock value,
            string softwareName,
            string softwarePath,
            string groupPath)
        {
            return new ObjectRecord
            {
                Kind = ObjectKind.Block,
                Value = value,
                Name = value.Name,
                Number = value.Number,
                Namespace = LiveCoreApi.NamespaceOrNull(value),
                SoftwareName = softwareName,
                SoftwarePath = softwarePath,
                GroupPath = groupPath,
                RuntimeType = value.GetType().FullName,
                BlockKind = value.GetType().Name
            };
        }

        public static ObjectRecord ForType(
            PlcType value,
            string softwareName,
            string softwarePath,
            string groupPath)
        {
            return new ObjectRecord
            {
                Kind = ObjectKind.PlcType,
                Value = value,
                Name = value.Name,
                Namespace = LiveCoreApi.NamespaceOrNull(value),
                SoftwareName = softwareName,
                SoftwarePath = softwarePath,
                GroupPath = groupPath,
                RuntimeType = value.GetType().FullName
            };
        }

        public static ObjectRecord ForTagTable(
            PlcTagTable value,
            string softwareName,
            string softwarePath,
            string groupPath)
        {
            return new ObjectRecord
            {
                Kind = ObjectKind.TagTable,
                Value = value,
                Name = value.Name,
                SoftwareName = softwareName,
                SoftwarePath = softwarePath,
                GroupPath = groupPath,
                RuntimeType = value.GetType().FullName
            };
        }

        public static ObjectRecord ForTag(
            PlcTag value,
            PlcTagTable parent,
            string softwareName,
            string softwarePath,
            string groupPath)
        {
            return new ObjectRecord
            {
                Kind = ObjectKind.PlcTag,
                Value = value,
                Name = value.Name,
                SoftwareName = softwareName,
                SoftwarePath = softwarePath,
                GroupPath = groupPath,
                RuntimeType = value.GetType().FullName,
                ParentTable = parent
            };
        }
    }

    private sealed class SessionState
    {
        public TiaPortal Portal;
        public Project Project;
        public int ProcessId;
        public long ProcessStartUtcTicks;
        public string CanonicalProjectPath;
        public DateTime AttachedAtUtc;
        public DateTime LastVerifiedUtc;
        public DateTime InventoryBuiltUtc;
        public ObjectIdentifierProvider IdentifierProvider;
        public List<ObjectRecord> Inventory;
        public HashSet<ObjectKind> InventoryKinds;
        public Dictionary<ObjectKind, DateTime> InventoryBuiltAtByKind;
        public Dictionary<string, ObjectRecord> OfficialIdMap;
        public Dictionary<IEngineeringObject, ObjectRecord> ObjectReferenceMap;
    }

    private sealed class SessionUse
    {
        public readonly SessionState Session;
        public readonly bool SessionReused;
        public bool InventoryReused;
        public readonly long AttachMilliseconds;
        public readonly long InventoryMilliseconds;

        public SessionUse(
            SessionState session,
            bool sessionReused,
            bool inventoryReused,
            long attachMilliseconds,
            long inventoryMilliseconds)
        {
            Session = session;
            SessionReused = sessionReused;
            InventoryReused = inventoryReused;
            AttachMilliseconds = attachMilliseconds;
            InventoryMilliseconds = inventoryMilliseconds;
        }
    }

    private sealed class SessionRequest
    {
        public readonly int ProcessId;
        public readonly string ProjectPath;
        public readonly long? ExpectedProcessStartUtcTicks;

        public SessionRequest(int processId, string projectPath, long? expectedProcessStartUtcTicks)
        {
            ProcessId = processId;
            ProjectPath = projectPath;
            ExpectedProcessStartUtcTicks = expectedProcessStartUtcTicks;
        }
    }

    private sealed class ObjectSelector
    {
        public readonly ObjectKind? Kind;
        public readonly string Name;
        public readonly int? Number;
        public readonly string Namespace;
        public readonly string SoftwarePath;
        public readonly string OfficialIdentifier;
        public readonly string BlockKind;
        public readonly string TagTableName;

        public ObjectSelector(
            ObjectKind? kind,
            string name,
            int? number,
            string nameSpace,
            string softwarePath,
            string officialIdentifier,
            string blockKind,
            string tagTableName)
        {
            Kind = kind;
            Name = name;
            Number = number;
            Namespace = nameSpace;
            SoftwarePath = softwarePath;
            OfficialIdentifier = officialIdentifier;
            BlockKind = blockKind;
            TagTableName = tagTableName;
        }

        public Dictionary<string, object> ToMap()
        {
            return Map(
                "resourceKind", Kind.HasValue ? KindToName(Kind.Value) : null,
                "name", Name,
                "number", Number.HasValue ? Number.Value.ToString() : null,
                "namespace", Namespace,
                "softwarePath", SoftwarePath,
                "officialIdentifier", OfficialIdentifier,
                "blockKind", BlockKind,
                "tagTableName", TagTableName);
        }

        private static string KindToName(ObjectKind kind)
        {
            if (kind == ObjectKind.Block) return "block";
            if (kind == ObjectKind.PlcType) return "plc_type";
            if (kind == ObjectKind.TagTable) return "tag_table";
            return "plc_tag";
        }
    }

    private sealed class QueryOptions
    {
        public readonly bool IncludeCrossReferences;
        public readonly bool IncludeInterface;
        public readonly bool IncludeProgramBody;
        public readonly bool IncludeXml;
        public readonly bool RefreshInventory;
        public readonly bool RetryNotFoundWithRefresh;
        public readonly int MaxSources;
        public readonly int MaxReferences;
        public readonly int MaxLocations;
        public readonly int MaxDepth;
        public readonly int MaxXmlBytes;
        public readonly int MaxInterfaceMembers;

        public QueryOptions(
            bool includeCrossReferences,
            bool includeInterface,
            bool includeProgramBody,
            bool includeXml,
            bool refreshInventory,
            bool retryNotFoundWithRefresh,
            int maxSources,
            int maxReferences,
            int maxLocations,
            int maxDepth,
            int maxXmlBytes,
            int maxInterfaceMembers)
        {
            IncludeCrossReferences = includeCrossReferences;
            IncludeInterface = includeInterface;
            IncludeProgramBody = includeProgramBody;
            IncludeXml = includeXml;
            RefreshInventory = refreshInventory;
            RetryNotFoundWithRefresh = retryNotFoundWithRefresh;
            MaxSources = maxSources;
            MaxReferences = maxReferences;
            MaxLocations = maxLocations;
            MaxDepth = maxDepth;
            MaxXmlBytes = maxXmlBytes;
            MaxInterfaceMembers = maxInterfaceMembers;
        }

        public Dictionary<string, object> ToMap()
        {
            return Map(
                "includeCrossReferences", IncludeCrossReferences,
                "includeInterface", IncludeInterface,
                "includeProgramBody", IncludeProgramBody,
                "includeBlockXml", IncludeXml,
                "refreshInventory", RefreshInventory,
                "retryNotFoundWithRefresh", RetryNotFoundWithRefresh,
                "maxSources", MaxSources,
                "maxReferences", MaxReferences,
                "maxLocations", MaxLocations,
                "maxDepth", MaxDepth,
                "maxXmlBytes", MaxXmlBytes,
                "absoluteMaxXmlBytes", AbsoluteMaxXmlBytes,
                "maxInterfaceMembers", MaxInterfaceMembers);
        }
    }

#if TIA_API_CROSS_REFERENCE
    private sealed class CrossReferenceBuildState
    {
        public readonly QueryOptions Options;
        public int SourceCount;
        public int ReferenceCount;
        public int LocationCount;
        public int CallEdgeCount;
        public bool SourcesTruncated;
        public bool ReferencesTruncated;
        public bool LocationsTruncated;
        public bool DepthTruncated;

        public CrossReferenceBuildState(QueryOptions options)
        {
            Options = options;
        }
    }
#endif

    private static ProtocolException ProjectMismatch(string phase, int processId,
        string expectedPath, string descriptorPath, List<string> observedPaths, bool collectionEnumerated = true)
    {
        int matches = observedPaths == null ? 0 : observedPaths.Count(p => PathEquals(p, expectedPath));
        string reason = observedPaths == null ? "descriptor_path_mismatch"
            : observedPaths.Count == 0 ? "empty_project_collection"
            : matches > 1 ? "multiple_exact_matches" : "attached_path_mismatch";
        return new ProtocolException("project_mismatch",
            "Exact project identity verification failed at " + phase + ": " + reason + ".",
            Map("phase", phase, "reason", reason, "processId", processId,
                "expectedProjectPath", expectedPath, "descriptorProjectPath", descriptorPath,
                "projectsEnumerated", observedPaths != null && collectionEnumerated,
                "observedPathSource", observedPaths == null ? "descriptor" : collectionEnumerated ? "project_collection" : "selected_project",
                "projectCount", observedPaths == null || !collectionEnumerated ? (object)null : observedPaths.Count,
                "exactMatchCount", observedPaths == null || !collectionEnumerated ? (object)null : matches,
                "observedProjectPaths", observedPaths == null ? null : observedPaths.Take(20).ToArray(),
                "pathsTruncated", observedPaths != null && observedPaths.Count > 20));
    }

    private static Dictionary<string, object> ProtocolErrorResponse(string requestId, ProtocolException error)
    {
        Dictionary<string, object> response = BasicResponse(requestId, false, error.Status, error.Message);
        if (error.Details != null) response["diagnostics"] = error.Details;
        return response;
    }

    private sealed class ProtocolException : Exception
    {
        public readonly string Status;
        public readonly Dictionary<string, object> Details;

        public ProtocolException(string status, string message)
            : this(status, message, null) { }

        public ProtocolException(string status, string message, Dictionary<string, object> details)
            : base(message)
        {
            Status = status;
            Details = details;
        }
    }

    private sealed class ReferenceComparer : IEqualityComparer<IEngineeringObject>
    {
        public static readonly ReferenceComparer Instance = new ReferenceComparer();

        public bool Equals(IEngineeringObject left, IEngineeringObject right)
        {
            return Object.ReferenceEquals(left, right);
        }

        public int GetHashCode(IEngineeringObject value)
        {
            return System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(value);
        }
    }
}
