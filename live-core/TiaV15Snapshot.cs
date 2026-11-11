using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

[assembly: AssemblyVersion("0.22.0.0")]
[assembly: AssemblyDescription("Attached-only, read-only TIA V15.1 PLC snapshot adapter")]

// V15.1 has a separate API and no V20 query/write fallback. Reflection below
// invokes only fixed public getters, GetProcesses, GetService, Attach and Export.
// The shared TypeScript publisher verifies every XML/hash and owns current.json.
internal static class TiaV15Snapshot
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4000000, RecursionLimit = 80 };
    private static Assembly Api;
    private static string ApiPath;
    private static int ProcessId;
    private static long StartTicks;
    private static string ProjectPath;
    private static object Portal;
    private static object Project;
    private static readonly HashSet<object> SeenSoftware = new HashSet<object>();
    private static readonly List<string> SoftwareKeys = new List<string>();
    private static readonly HashSet<string> ObjectKeys = new HashSet<string>(StringComparer.Ordinal);
    private static Dictionary<string, object> CurrentExportObject;
    private static string UnpublishedStaging;
    private static readonly List<Dictionary<string, object>> InconsistentObjects = new List<Dictionary<string, object>>();

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            if (args.Length == 1 && args[0] == "--snapshot-candidate-contract-v1") {
                Print(Map("contractVersion", 1, "candidateOnly", true, "currentPointerWrittenByNative", false));
                return 0;
            }
            Dictionary<string, string> options = Options(args);
            LoadApi(Required(options, "--api"));
            if (options.ContainsKey("--self-test")) {
                Print(Map("ok", true, "status", "self_test_passed", "apiAssemblyVersion", Api.GetName().Version.ToString(),
                    "apiDllPath", ApiPath, "apiDllSha256", HashFile(ApiPath), "projectAccessed", false, "plcAccessed", false,
                    "target", TiaNativeTarget.Target(), "capabilities", new[] { "snapshot_export" }));
                return 0;
            }
            if (!options.ContainsKey("--export-snapshot-candidate-v1")) throw new InvalidOperationException("Only read-only snapshot export is supported.");
            ProcessId = Int32.Parse(Required(options, "--process-id"), CultureInfo.InvariantCulture);
            StartTicks = DateTime.Parse(Required(options, "--process-start-time-utc"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToUniversalTime().Ticks;
            ProjectPath = Canonical(Required(options, "--project-path"));
            if (!TiaNativeTarget.IsProjectPath(ProjectPath) || !File.Exists(ProjectPath))
                throw new InvalidOperationException("The exact existing " + TiaNativeTarget.ProjectExtension + " project is required.");
            string outputRoot = Canonical(Required(options, "--output-root"));
            VerifyProcess();
            object descriptor = Descriptor();
            // Never dispose the process descriptor: Siemens uses that to close Portal.
            Console.Error.WriteLine("V15.1 snapshot phase: attach exact session");
            Portal = Call(descriptor, "Attach");
            object[] matches = Items(Get(Portal, "Projects")).Where(p => Same(PathValue(Get(p, "Path")), ProjectPath)).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("Exact attached project mismatch.");
            Project = matches[0];
            VerifySession();
            Export(outputRoot);
            return 0;
        }
        catch (Exception ex) {
            while (ex is TargetInvocationException && ex.InnerException != null) ex = ex.InnerException;
            // A failed export never published its staging tree; leave no partial XML behind.
            if (UnpublishedStaging != null) {
                try { Directory.Delete(UnpublishedStaging, true); }
                catch (Exception cleanup) { Console.Error.WriteLine("Staging cleanup failed: " + cleanup.Message); }
            }
            Print(Map("protocolVersion", 1, "requestId", "snapshot-export", "ok", false, "status", "snapshot_export_failed",
                "mode", "one_shot_export_snapshot", "error", ex.Message, "safety", Safety(),
                "diagnostics", Map("failedObject", CurrentExportObject, "inconsistentObjectCount", InconsistentObjects.Count,
                    "inconsistentObjects", InconsistentObjects.Take(100).ToArray())));
            return 2;
        }
        finally {
            // Dispose only this extra engineering connection; never close/save Project.
            IDisposable connection = Portal as IDisposable;
            if (connection != null) { try { connection.Dispose(); } catch { } }
        }
    }

    private static Dictionary<string, string> Options(string[] args)
    {
        Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.Ordinal);
        HashSet<string> values = new HashSet<string>(new[] { "--api", "--process-id", "--process-start-time-utc", "--project-path", "--output-root" });
        foreach (string arg in args) { if (arg == null) throw new InvalidOperationException("Null argument."); }
        for (int i = 0; i < args.Length; i++) {
            string key = args[i];
            if (result.ContainsKey(key)) throw new InvalidOperationException("Duplicate argument: " + key);
            if (key == "--self-test" || key == "--export-snapshot-candidate-v1") result.Add(key, "true");
            else if (values.Contains(key) && i + 1 < args.Length) result.Add(key, args[++i]);
            else throw new InvalidOperationException("Unknown or incomplete argument: " + key);
        }
        if (result.ContainsKey("--self-test") && result.Count != 2) throw new InvalidOperationException("Self-test accepts only --api.");
        return result;
    }

    private static void LoadApi(string apiPath)
    {
        ApiPath = Canonical(apiPath);
        AssemblyName identity = AssemblyName.GetAssemblyName(ApiPath);
        TiaNativeTarget.RequireApi(identity, "The Siemens.Engineering " + TiaNativeTarget.PortalVersion + " API is required; no cross-version fallback.");
        string apiDirectory = Path.GetDirectoryName(ApiPath);
        string portalDirectory = Path.GetFullPath(Path.Combine(apiDirectory, "..", ".."));
        string[] roots = { apiDirectory, Path.Combine(portalDirectory, "Bin", "PublicAPI"), Path.Combine(portalDirectory, "Bin") };
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e) {
            string name = new AssemblyName(e.Name).Name + ".dll";
            foreach (string root in roots) {
                string candidate = Path.Combine(root, name);
                if (File.Exists(candidate)) return Assembly.LoadFrom(candidate);
            }
            return null;
        };
        Api = Assembly.LoadFrom(ApiPath);
        Api.GetType("Siemens.Engineering.TiaPortal", true);
        Api.GetType("Siemens.Engineering.ExportOptions", true);
    }

    private static object Descriptor()
    {
        VerifyProcess();
        Type portalType = Api.GetType("Siemens.Engineering.TiaPortal", true);
        MethodInfo getter = portalType.GetMethod("GetProcesses", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
        if (getter == null) throw new MissingMethodException("TiaPortal.GetProcesses");
        object[] descriptors = Items(getter.Invoke(null, null)).Where(p => Convert.ToInt32(Get(p, "Id"), CultureInfo.InvariantCulture) == ProcessId).ToArray();
        if (descriptors.Length != 1 || !Same(PathValue(Get(descriptors[0], "ProjectPath")), ProjectPath))
            throw new InvalidOperationException("PID/project descriptor mismatch.");
        VerifyProcess();
        return descriptors[0];
    }

    private static void VerifyProcess()
    {
        using (Process process = Process.GetProcessById(ProcessId)) {
            if (process.StartTime.ToUniversalTime().Ticks != StartTicks) throw new InvalidOperationException("OS process-start identity mismatch.");
        }
    }

    private static void VerifySession()
    {
        Descriptor();
        if (!Same(PathValue(Get(Project, "Path")), ProjectPath)) throw new InvalidOperationException("Attached project identity changed.");
        object[] projects = Items(Get(Portal, "Projects"));
        if (projects.Count(p => Same(PathValue(Get(p, "Path")), ProjectPath)) != 1) throw new InvalidOperationException("Attached project collection changed.");
    }

    private sealed class Record
    {
        public object Value;
        public string Kind, BlockKind, Name, SoftwarePath, GroupPath, Key, State;
        public Dictionary<string, object> Metadata;
    }

    private static List<Record> Inventory()
    {
        SeenSoftware.Clear(); SoftwareKeys.Clear(); ObjectKeys.Clear();
        List<Record> records = new List<Record>();
        foreach (object group in Items(Get(Project, "DeviceGroups"))) DeviceGroup(group, "", 0, records);
        foreach (object device in Items(Get(Project, "Devices"))) Device(device, "", records);
        if (SoftwareKeys.Count == 0 || records.Count == 0) throw new InvalidOperationException("No complete PLC program inventory was found.");
        return records.OrderBy(r => r.Key, StringComparer.Ordinal).ToList();
    }

    private static void DeviceGroup(object group, string parent, int depth, List<Record> records)
    {
        Depth(depth);
        string groupPath = Join(parent, Text(Get(group, "Name")));
        foreach (object device in Items(Get(group, "Devices"))) Device(device, groupPath, records);
        foreach (object child in Items(Get(group, "Groups"))) DeviceGroup(child, groupPath, depth + 1, records);
    }

    private static void Device(object device, string parent, List<Record> records)
    {
        string devicePath = Join(parent, Text(Get(device, "Name")));
        foreach (object item in Items(Get(device, "DeviceItems"))) DeviceItem(item, devicePath, 0, records);
    }

    private static void DeviceItem(object item, string parent, int depth, List<Record> records)
    {
        Depth(depth);
        string itemPath = Join(parent, Text(Get(item, "Name")));
        Type provider = Api.GetType("Siemens.Engineering.IEngineeringServiceProvider", true);
        Type containerType = Api.GetType("Siemens.Engineering.HW.Features.SoftwareContainer", true);
        MethodInfo serviceMethod = provider.GetMethods().Single(m => m.Name == "GetService" && m.IsGenericMethodDefinition && m.GetParameters().Length == 0);
        object container = serviceMethod.MakeGenericMethod(containerType).Invoke(item, null);
        if (container != null) {
            object software = Get(container, "Software");
            if (software != null && IsType(software, "Siemens.Engineering.SW.PlcSoftware") && SeenSoftware.Add(software)) {
                string softwarePath = Join(itemPath, Text(Get(software, "Name")));
                SoftwareKeys.Add(softwarePath);
                Group(Get(software, "BlockGroup"), "block", softwarePath, "", 0, records);
                foreach (object systemGroup in Items(Get(Get(software, "BlockGroup"), "SystemBlockGroups")))
                    Group(systemGroup, "block", softwarePath, "", 0, records);
                Group(Get(software, "TypeGroup"), "plc_type", softwarePath, "", 0, records);
                foreach (object systemGroup in Items(Get(Get(software, "TypeGroup"), "SystemTypeGroups")))
                    Group(systemGroup, "plc_type", softwarePath, "", 0, records, false);
                Group(Get(software, "TagTableGroup"), "tag_table", softwarePath, "", 0, records);
            }
        }
        foreach (object child in Items(Get(item, "DeviceItems"))) DeviceItem(child, itemPath, depth + 1, records);
    }

    private static void Group(object group, string kind, string softwarePath, string parent, int depth, List<Record> records, bool recurse = true)
    {
        Depth(depth);
        string groupPath = Join(parent, Text(Get(group, "Name")));
        string property = kind == "block" ? "Blocks" : kind == "plc_type" ? "Types" : "TagTables";
        foreach (object value in Items(Get(group, property))) {
            string name = Text(Get(value, "Name"));
            object number = kind == "block" ? Get(value, "Number") : null;
            string blockKind = kind == "block" ? BlockKind(value) : kind == "plc_type" ? "PlcType" : "Tag.PlcTagTable";
            string key = Json.Serialize(new object[] { softwarePath, groupPath, kind, blockKind, number, name });
            if (!ObjectKeys.Add(key)) throw new InvalidOperationException("Ambiguous duplicate program object: " + name);
            Dictionary<string, object> metadata = Map("resourceKind", kind, "kind", blockKind, "blockKind", blockKind,
                "name", name, "number", number, "softwarePath", softwarePath, "groupPath", groupPath,
                "programmingLanguage", kind == "block" ? Text(Get(value, "ProgrammingLanguage")) : "");
            // Required modification getters fail closed; absent evidence cannot certify consistency.
            string state = kind == "tag_table" ? Text(Get(value, "ModifiedTimeStamp")) : Text(Get(value, "ModifiedDate"));
            if (kind != "tag_table") {
                metadata["isConsistent"] = Get(value, "IsConsistent");
                metadata["isKnowHowProtected"] = Get(value, "IsKnowHowProtected");
                state += "|" + Text(metadata["isConsistent"]) + "|" + Text(metadata["isKnowHowProtected"]);
            }
            if (kind == "block") state += "|" + Text(Get(value, "CodeModifiedDate")) + "|" + Text(Get(value, "InterfaceModifiedDate"));
            if (kind == "plc_type") state += "|" + Text(Get(value, "InterfaceModifiedDate"));
            records.Add(new Record { Value = value, Kind = kind, BlockKind = blockKind, Name = name, SoftwarePath = softwarePath,
                GroupPath = groupPath, Key = key, State = state, Metadata = metadata });
        }
        if (recurse) foreach (object child in Items(Get(group, "Groups"))) Group(child, kind, softwarePath, groupPath, depth + 1, records);
    }

    private static string BlockKind(object value)
    {
        foreach (string name in new[] { "OB", "FB", "FC", "GlobalDB", "InstanceDB", "ArrayDB" })
            if (IsType(value, "Siemens.Engineering.SW.Blocks." + name)) return name;
        throw new InvalidOperationException("Unsupported PLC block runtime type: " + value.GetType().FullName);
    }

    private static void Export(string root)
    {
        Directory.CreateDirectory(root); PlainPath(root);
        string currentPath = Path.Combine(root, "current.json");
        bool previousExists = File.Exists(currentPath);
        string previousId = "", previousHash = "", previousPath = "";
        if (previousExists) {
            PlainPath(currentPath);
            if (new FileInfo(currentPath).Length > 1000000) throw new IOException("Oversized previous current pointer.");
            Dictionary<string, object> previous = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(currentPath, Encoding.UTF8));
            previousId = Text(previous["snapshotId"]); previousHash = Text(previous["manifestSha256"]);
            previousPath = Canonical(Path.Combine(root, Text(previous["publishedPath"])));
            if (!previousPath.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || previousHash.Length != 64)
                throw new IOException("Invalid previous current-pointer identity.");
            PlainPath(previousPath);
            string oldManifest = Path.Combine(previousPath, "manifest.json"); PlainPath(oldManifest);
            if (HashFile(oldManifest) != previousHash) throw new IOException("Previous current manifest hash mismatch.");
        }
        VerifySession();
        bool modifiedBefore = Convert.ToBoolean(Get(Project, "IsModified"), CultureInfo.InvariantCulture);
        string fileBefore = FileState(ProjectPath);
        Console.Error.WriteLine("V15.1 snapshot phase: read complete PLC inventory");
        List<Record> before = Inventory();
        InconsistentObjects.AddRange(before.Where(r => r.Metadata.ContainsKey("isConsistent") && Object.Equals(r.Metadata["isConsistent"], false)).Select(r => r.Metadata));
        string softwareBefore = SoftwareFingerprint();
        int softwareCount = SoftwareKeys.Count;
        string inventoryBefore = InventoryFingerprint(before);
        string staging = Path.Combine(root, ".tia-snapshot-staging-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging); PlainPath(staging);
        UnpublishedStaging = staging;
        List<object> entries = new List<object>();
        Type exportOptions = Api.GetType("Siemens.Engineering.ExportOptions", true);
        object withDefaults = Enum.Parse(exportOptions, "WithDefaults");
        foreach (Record record in before) {
            CurrentExportObject = record.Metadata;
            VerifySession();
            string category = record.Kind == "block" ? "blocks" : record.Kind == "plc_type" ? "types" : "tag-tables";
            string relative = "objects/" + category + "/" + (entries.Count + 1).ToString("D6") + "-" + HashText(record.Key).Substring(0, 16) + ".xml";
            string destination = Path.Combine(staging, relative.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)); PlainPath(Path.GetDirectoryName(destination));
            Call(record.Value, "Export", new FileInfo(destination), withDefaults);
            PlainPath(destination);
            FileInfo file = new FileInfo(destination);
            if (file.Length <= 0) throw new IOException("Export returned empty XML: " + record.Name);
            record.Metadata["relativePath"] = relative; record.Metadata["bytes"] = file.Length;
            record.Metadata["sha256"] = HashFile(destination); record.Metadata["status"] = "exported";
            entries.Add(record.Metadata);
        }
        CurrentExportObject = null;
        Console.Error.WriteLine("V15.1 snapshot phase: verify final project and inventory state");
        List<Record> after = Inventory();
        VerifySession();
        if (modifiedBefore != Convert.ToBoolean(Get(Project, "IsModified"), CultureInfo.InvariantCulture) || fileBefore != FileState(ProjectPath) ||
            inventoryBefore != InventoryFingerprint(after) || softwareBefore != SoftwareFingerprint())
            throw new InvalidOperationException("Project identity, file, modification state or inventory changed during export; current pointer preserved.");
        string snapshotId = DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffffffZ", CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N").Substring(0, 12);
        Dictionary<string, object> inventoryState = Map("plcSoftwareCount", softwareCount, "traversalErrorCount", 0, "fingerprint", inventoryBefore);
        Dictionary<string, object> manifest = Map("schemaVersion", "1.0", "snapshotKind", "tia_openness_full_plc_snapshot",
            "status", "consistent_complete", "complete", true, "publicationState", "candidate_not_current", "snapshotId", snapshotId,
            "createdAtUtc", DateTime.UtcNow.ToString("o"), "project", Map("canonicalProjectPath", ProjectPath, "name", Text(Get(Project, "Name")),
                "processId", ProcessId, "processStartTimeUtc", new DateTime(StartTicks, DateTimeKind.Utc).ToString("o"), "isModified", modifiedBefore),
            "openness", Map("attachCount", 1, "apiAssemblyVersion", Api.GetName().Version.ToString(), "apiDllPath", ApiPath, "apiDllSha256", HashFile(ApiPath)),
            "inventory", Map("before", inventoryState, "after", inventoryState),
            "consistency", Map("consistent", true, "publishAllowed", true, "plcSoftwareIdentityMatches", true, "inventoryTraversalComplete", true),
            "objects", entries, "summary", Map("exportedCount", entries.Count, "exportableCount", entries.Count, "exportErrorCount", 0), "safety", Safety());
        string manifestPath = Path.Combine(staging, "manifest.json");
        File.WriteAllText(manifestPath, Json.Serialize(manifest), new UTF8Encoding(false));
        string manifestHash = HashFile(manifestPath);
        string snapshots = Path.Combine(root, "snapshots"); Directory.CreateDirectory(snapshots); PlainPath(snapshots);
        string published = Path.Combine(snapshots, snapshotId);
        Directory.Move(staging, published);
        UnpublishedStaging = null;
        Print(Map("protocolVersion", 1, "requestId", "snapshot-export", "ok", true, "status", "consistent_complete", "mode", "one_shot_export_snapshot",
            "snapshot", Map("publishedPath", published, "manifestPath", Path.Combine(published, "manifest.json"), "manifestSha256", manifestHash,
                "snapshotId", snapshotId, "complete", true, "publicationState", "candidate_not_current", "currentPointerUpdated", false,
                "currentPointerPath", currentPath, "previousCurrentExists", previousExists, "previousCurrentSnapshotId", previousId,
                "previousCurrentManifestSha256", previousHash, "previousPublishedPath", previousPath, "exportedCount", entries.Count, "errorCount", 0), "safety", Safety()));
    }

    private static string InventoryFingerprint(List<Record> records) { return HashText(String.Join("\n", records.Select(r => r.Key + "|" + r.State))); }
    private static string SoftwareFingerprint() { return HashText(String.Join("\n", SoftwareKeys.OrderBy(k => k, StringComparer.Ordinal))); }
    private static string FileState(string file) {
        // Portal locks its project container exclusively, so match V20's file
        // metadata check. Official object timestamps and every exported XML hash
        // provide the source consistency evidence without opening the container.
        FileInfo info = new FileInfo(file);
        return info.Length + "|" + info.LastWriteTimeUtc.Ticks + "|" + info.CreationTimeUtc.Ticks;
    }
    private static Dictionary<string, object> Safety() { return Map("projectMutation", false, "plcAccessed", false, "saveCompileDownload", false); }
    private static void Depth(int depth) { if (depth > 40) throw new InvalidOperationException("Engineering hierarchy exceeds bounded depth."); }
    private static string Required(Dictionary<string, string> options, string key) { string value; if (!options.TryGetValue(key, out value) || String.IsNullOrWhiteSpace(value)) throw new ArgumentException("Required: " + key); return value; }
    private static string Canonical(string value) { return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar); }
    private static bool Same(string left, string right) { return String.Equals(Canonical(left), Canonical(right), StringComparison.OrdinalIgnoreCase); }
    private static string PathValue(object value) { FileSystemInfo file = value as FileSystemInfo; return file == null ? Text(value) : file.FullName; }
    private static string Text(object value) {
        if (value is DateTime) return ((DateTime)value).ToString("o", CultureInfo.InvariantCulture);
        if (value is DateTimeOffset) return ((DateTimeOffset)value).ToString("o", CultureInfo.InvariantCulture);
        return Convert.ToString(value, CultureInfo.InvariantCulture);
    }
    private static string Join(string left, string right) { return String.IsNullOrEmpty(left) ? right : left + "\\" + right; }
    private static bool IsType(object value, string name) { for (Type type = value.GetType(); type != null; type = type.BaseType) if (type.FullName == name) return true; return false; }
    private static object[] Items(object value) { if (!(value is IEnumerable)) throw new InvalidOperationException("Expected a public engineering composition."); return ((IEnumerable)value).Cast<object>().ToArray(); }
    private static object Get(object value, string property) {
        if (value == null) throw new InvalidOperationException("Missing engineering object for " + property);
        PropertyInfo getter = value.GetType().GetProperty(property, BindingFlags.Public | BindingFlags.Instance);
        if (getter == null || !getter.CanRead || getter.GetIndexParameters().Length != 0) throw new MissingMemberException(value.GetType().FullName, property);
        return getter.GetValue(value, null);
    }
    private static object Call(object value, string method, params object[] args) {
        MethodInfo member = value.GetType().GetMethod(method, BindingFlags.Public | BindingFlags.Instance, null, args.Select(a => a.GetType()).ToArray(), null);
        if (member == null) throw new MissingMethodException(value.GetType().FullName, method);
        return member.Invoke(value, args);
    }
    private static void PlainPath(string path) {
        string current = Path.GetFullPath(path);
        while (!String.IsNullOrEmpty(current)) {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Snapshot path contains a reparse point.");
            current = Path.GetDirectoryName(current);
        }
    }
    private static string HashFile(string path) {
        using (Stream stream = File.OpenRead(path))
        using (SHA256 hash = SHA256.Create()) return Hex(hash.ComputeHash(stream));
    }
    private static string HashText(string text) { using (SHA256 hash = SHA256.Create()) return Hex(hash.ComputeHash(Encoding.UTF8.GetBytes(text))); }
    private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    private static Dictionary<string, object> Map(params object[] pairs) { Dictionary<string, object> map = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) map.Add((string)pairs[i], pairs[i + 1]); return map; }
    private static void Print(object value) { Console.WriteLine(Json.Serialize(value)); }
}
