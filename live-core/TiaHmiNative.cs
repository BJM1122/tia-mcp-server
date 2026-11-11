using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Security.Cryptography;
using System.Xml;
using System.Xml.Linq;
using System.Web.Script.Serialization;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;

// HMI companion. Write requests are issued only by the MCP's
// immutable, single-use approval gate. No download or runtime control APIs.
internal static partial class TiaHmiNative
{
    static string api;
    static bool mutationAttempted;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 40000000 };
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        try {
            api = Path.GetFullPath(args[0]);
            AppDomain.CurrentDomain.AssemblyResolve += (sender, e) => {
                string file = Path.Combine(Path.GetDirectoryName(api), new AssemblyName(e.Name).Name + ".dll");
                return File.Exists(file) ? Assembly.LoadFrom(file) : null;
            };
            if (args.Length == 2 && args[1] == "--self-test") {
                Assembly a = Assembly.LoadFrom(api);
                Type screen = a.GetType("Siemens.Engineering.Hmi.Screen.Screen", true);
                if (!TiaNativeTarget.MatchesApi(a.GetName()) || screen.GetMethod("Export") == null) throw new Exception(TiaNativeTarget.PortalVersion + " screen export API unavailable.");
                foreach (string type in new string[] { "Screen.ScreenComposition", "Screen.ScreenTemplateComposition", "Tag.TagTableComposition", "RuntimeScripting.VBScriptComposition", "TextGraphicList.TextListComposition", "TextGraphicList.GraphicListComposition" }) {
                    Type composition = a.GetType("Siemens.Engineering.Hmi." + type, true);
                    if (composition.GetMethod("Import", new Type[] { typeof(FileInfo), a.GetType("Siemens.Engineering.ImportOptions", true) }) == null) throw new Exception("Import API unavailable: " + type);
                }
                string fixture = "<Document><DocumentInfo><Created>old</Created></DocumentInfo><Hmi.Screen.Screen ID=\"0\"><AttributeList><Name>Test</Name><Text> </Text></AttributeList></Hmi.Screen.Screen></Document>";
                if (ComparisonHash(fixture) != ComparisonHash(fixture.Replace("old", "new"))) throw new Exception("Export metadata normalization failed.");
                if (ComparisonHash(fixture) == ComparisonHash(fixture.Replace("<Text> </Text>", "<Text/>"))) throw new Exception("Significant native whitespace was discarded.");
                var requested = XElement.Parse("<Object ID=\"1\"><AttributeList><Name>Title</Name></AttributeList></Object>");
                var expanded = XElement.Parse("<Object ID=\"20\"><AttributeList><Name>Title</Name><Visible>true</Visible></AttributeList></Object>");
                if (!ContainsRequested(requested, expanded) || ContainsRequested(requested, XElement.Parse(expanded.ToString().Replace("Title", "Other")))) throw new Exception("Creation readback projection failed.");
                Type unifiedScreen = a.GetType("Siemens.Engineering.HmiUnified.UI.Screens.HmiScreenComposition",true);
                if(unifiedScreen.GetMethod("Create",new[]{typeof(string)})==null) throw new Exception("Unified screen creation API unavailable.");
                Type unifiedScript = a.GetType("Siemens.Engineering.HmiUnified.UI.Dynamization.Script.IHmiScript",true);
                if(!unifiedScript.GetProperty("ScriptCode").CanWrite) throw new Exception("Unified script API unavailable.");
                UnifiedOfflineCheck();
                Console.WriteLine(Json.Serialize(new { ok = true, mode = "offline_api_check", projectAccessed = false, target = TiaNativeTarget.Target(), capabilities = new[] { "hmi_export", "hmi_authoring" } }));
            } else Run(Json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd()));
            return 0;
        } catch (Exception ex) {
            Console.WriteLine(Json.Serialize(new { ok = false, error = ex.GetBaseException().Message, projectModified = mutationAttempted, status = mutationAttempted ? "write_outcome_requires_readback" : "blocked" }));
            return 1;
        }
    }
    static string S(Dictionary<string, object> r, string key) { return Convert.ToString(r[key]); }
    static void Items(DeviceItem item, string path, List<Tuple<object,string>> found) {
        SoftwareContainer c = item.GetService<SoftwareContainer>();
        if (c != null && c.Software != null && c.Software.GetType().FullName == "Siemens.Engineering.Hmi.HmiTarget") found.Add(Tuple.Create((object)c.Software, path));
        foreach (DeviceItem child in item.DeviceItems) Items(child, path + "/" + child.Name, found);
    }
    static void Devices(IEnumerable<Device> devices, string path, List<Tuple<object,string>> found) {
        foreach (Device d in devices) foreach (DeviceItem item in d.DeviceItems) Items(item, path + d.Name + "/" + item.Name, found);
    }
    static void Group(DeviceUserGroup group, string path, List<Tuple<object,string>> found) {
        string next = path + group.Name + "/";
        Devices(group.Devices, next, found);
        foreach (DeviceUserGroup child in group.Groups) Group(child, next, found);
    }
    static object Property(object o, string name) { return o.GetType().GetProperty(name).GetValue(o, null); }
    static void Objects(object folder, string kind, string path, List<Tuple<object,string>> found) {
        foreach (object o in (IEnumerable)Property(folder, kind)) found.Add(Tuple.Create(o, path + Convert.ToString(Property(o, "Name"))));
        foreach (object child in (IEnumerable)Property(folder, "Folders")) Objects(child, kind, path + Convert.ToString(Property(child, "Name")) + "/", found);
    }
    static string Hash(string text) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant(); }
    static XElement NativeRoot(string xml) {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 25000000 };
        XDocument doc;
        using (var reader = XmlReader.Create(new StringReader(xml), settings)) doc = XDocument.Load(reader, LoadOptions.PreserveWhitespace);
        if (doc.Root == null || doc.Root.Name != "Document") throw new Exception("Invalid native document.");
        var roots = doc.Root.Elements().Where(e => e.Name.LocalName != "Engineering" && e.Name.LocalName != "DocumentInfo").ToArray();
        string[] supported = { "Hmi.Screen.Screen", "Hmi.Screen.ScreenTemplate", "Hmi.Tag.TagTable", "Hmi.RuntimeScripting.VBScript", "Hmi.Globalization.MultiLingualGraphic", "Hmi.Communication.Connection", "Hmi.TextGraphicList.TextList", "Hmi.TextGraphicList.GraphicList" };
        if (roots.Length != 1 || !supported.Contains(roots[0].Name.LocalName) || roots[0].Name.NamespaceName != "") throw new Exception("Exactly one supported native object required.");
        // Remove only indentation between known structural nodes. Preserve whitespace
        // in text, scripts, values, rich text and unknown vendor extension payloads.
        foreach (XText text in roots[0].DescendantNodes().OfType<XText>().ToArray()) {
            string parent = text.Parent.Name.LocalName;
            if (String.IsNullOrWhiteSpace(text.Value) && text.Parent.HasElements &&
                (parent == "ObjectList" || parent == "AttributeList" || parent == "LinkList" || parent.StartsWith("Hmi.", StringComparison.Ordinal))) text.Remove();
        }
        return roots[0];
    }
    static string ComparisonHash(string xml) { return Hash(NativeRoot(xml).ToString(SaveOptions.DisableFormatting)); }
    static string Export(object selected) {
        string temp = Path.Combine(Path.GetTempPath(), "tia-hmi-" + Guid.NewGuid().ToString("N") + ".xml");
        try {
            selected.GetType().GetMethod("Export", new Type[] { typeof(FileInfo), typeof(ExportOptions) }).Invoke(selected, new object[] { new FileInfo(temp), ExportOptions.WithDefaults });
            if (new FileInfo(temp).Length > 25000000) throw new Exception("Native XML exceeds 25 MB.");
            return File.ReadAllText(temp);
        } finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    static void CheckIdentity(Project project, int pid, DateTime start, string expectedPath) {
        if (Process.GetProcessById(pid).StartTime.ToUniversalTime() != start || !String.Equals(Path.GetFullPath(project.Path.FullName), expectedPath, StringComparison.OrdinalIgnoreCase)) throw new Exception("Identity changed during operation.");
    }
    // Single() failures surface as "Sequence contains no matching element"; name the lookup instead.
    static T One<T>(IEnumerable<T> source, Func<T, bool> match, string what) {
        T[] found = source.Where(match).Take(2).ToArray();
        if (found.Length != 1) throw new Exception(what + (found.Length == 0 ? " was not found." : " is ambiguous."));
        return found[0];
    }
    static object Folder(object target, string kind) { return Property(target, kind == "screen" ? "ScreenFolder" : "ScreenTemplateFolder"); }
    static string Collection(string kind) { return kind == "screen" ? "Screens" : "ScreenTemplates"; }
    static object ResolveFolder(object target, string kind, string objectPath) {
        object folder = Folder(target, kind);
        string[] segments = objectPath.Split('/');
        for (int i = 0; i < segments.Length - 1; i++) folder = One(((IEnumerable)Property(folder, "Folders")).Cast<object>(), f => Convert.ToString(Property(f, "Name")) == segments[i], "HMI folder '" + segments[i] + "'");
        return folder;
    }
    static void Messages(CompilerResultMessageComposition source, List<object> messages, int depth) {
        if (depth > 40 || messages.Count >= 2000) return;
        foreach (CompilerResultMessage message in source) {
            if (messages.Count >= 2000) return;
            messages.Add(new { description = message.Description, path = message.Path, state = message.State.ToString(), errors = message.ErrorCount, warnings = message.WarningCount });
            Messages(message.Messages, messages, depth + 1);
        }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    static void Run(Dictionary<string, object> r) {
        TiaNativeTarget.RequireApi(typeof(TiaPortal).Assembly.GetName(), "Only " + TiaNativeTarget.PortalVersion + " is supported.");
        if (S(r, "operation") == "create_project") { CreateProject(r); return; }
        if (S(r, "operation") == "create_unified_project") { CreateUnifiedProject(r); return; }
        if (S(r, "operation") == "inspect_unified" || S(r, "operation") == "edit_unified") { AccessUnified(r); return; }
        int pid = Convert.ToInt32(r["processId"]);
        string expectedStart = S(r, "processStartTimeUtc");
        DateTime start = DateTime.Parse(expectedStart, null, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
        if (Process.GetProcessById(pid).StartTime.ToUniversalTime() != start) throw new Exception("Process identity mismatch.");
        string expectedPath = Path.GetFullPath(S(r, "projectPath"));
        TiaPortalProcess process = One(TiaPortal.GetProcesses(), p => p.Id == pid, "TIA Portal Openness process " + pid);
        using (TiaPortal portal = process.Attach()) {
            Project project = One(portal.Projects, p => String.Equals(Path.GetFullPath(p.Path.FullName), expectedPath, StringComparison.OrdinalIgnoreCase), "Open project " + expectedPath);
            List<Tuple<object,string>> targets = new List<Tuple<object,string>>();
            Devices(project.Devices, "", targets);
            foreach (DeviceUserGroup g in project.DeviceGroups) Group(g, "", targets);
            if (S(r, "operation") == "discover") {
                Console.WriteLine(Json.Serialize(new { ok = true, targets = targets.Select(t => new { path = t.Item2, name = Property(t.Item1, "Name"), adapter = "wincc-classic-v20" }).ToArray(), projectModified = false }));
                return;
            }
            if (S(r, "operation") != "export" && S(r, "operation") != "export_bundle" && S(r, "operation") != "import") throw new Exception("Unsupported operation.");
            object target = One(targets, t => t.Item2 == S(r, "targetPath"), "Classic HMI target '" + S(r, "targetPath") + "' (discover lists exact paths)").Item1;
            if (S(r, "operation") == "export_bundle") {
                var artifacts = new List<object>();
                long bytes = 0;
                foreach (string k in new string[] { "template", "screen" }) {
                    var rows = new List<Tuple<object,string>>();
                    Objects(Folder(target, k), Collection(k), "", rows);
                    if (rows.Count > 500) throw new Exception("Bundle object limit exceeded.");
                    foreach (var row in rows) {
                        string xml = Export(row.Item1); bytes += Encoding.UTF8.GetByteCount(xml);
                        if (bytes > 25000000) throw new Exception("Bundle exceeds 25 MB; export individual objects.");
                        artifacts.Add(new { kind = k, objectPath = row.Item2, xml = xml, sha256 = Hash(xml), comparisonSha256 = ComparisonHash(xml) });
                    }
                }
                foreach (string k in new string[] { "tagTable", "vbScript", "textList", "graphicList" }) {
                    var rows = new List<Tuple<object,string>>();
                    if (k == "tagTable" || k == "vbScript") Objects(Property(target, k == "tagTable" ? "TagFolder" : "VBScriptFolder"), k == "tagTable" ? "TagTables" : "VBScripts", "", rows);
                    else foreach (object item in (IEnumerable)Property(target, k == "textList" ? "TextLists" : "GraphicLists")) rows.Add(Tuple.Create(item, Convert.ToString(Property(item, "Name"))));
                    if (rows.Count > 500) throw new Exception("Dependency object limit exceeded.");
                    foreach (var row in rows) {
                        string xml = Export(row.Item1); bytes += Encoding.UTF8.GetByteCount(xml);
                        if (bytes > 25000000) throw new Exception("Bundle exceeds 25 MB.");
                        artifacts.Add(new { kind = k, objectPath = row.Item2, xml = xml, sha256 = Hash(xml) });
                    }
                }
                CheckIdentity(project, pid, start, expectedPath);
                foreach (object graphic in (IEnumerable)Property(project, "Graphics")) {
                    string xml = Export(graphic); bytes += Encoding.UTF8.GetByteCount(xml);
                    if (bytes > 25000000) throw new Exception("Bundle with project graphics exceeds 25 MB.");
                    artifacts.Add(new { kind = "projectGraphic", objectPath = Convert.ToString(Property(graphic, "Name")), xml = xml, sha256 = Hash(xml) });
                }
                foreach (object connection in (IEnumerable)Property(target, "Connections")) {
                    string xml = Export(connection); bytes += Encoding.UTF8.GetByteCount(xml);
                    if (bytes > 25000000) throw new Exception("Bundle with connections exceeds 25 MB.");
                    artifacts.Add(new { kind = "connection", objectPath = Convert.ToString(Property(connection, "Name")), xml = xml, sha256 = Hash(xml) });
                }
                CheckIdentity(project, pid, start, expectedPath);
                Console.WriteLine(Json.Serialize(new { ok = true, artifacts = artifacts, projectModified = false, dependencyClosure = "partial",
                    includedKinds = new string[] { "screen", "template", "tagTable", "vbScript", "textList", "graphicList", "projectGraphic", "connection" },
                    excludedKinds = new string[] { "alarms", "recipes", "libraryTypes" }, consistency = "non_atomic" }));
                return;
            }
            string kind = S(r, "kind");
            if (kind != "screen" && kind != "template") throw new Exception("Unsupported native object kind.");
            List<Tuple<object,string>> objects = new List<Tuple<object,string>>();
            Objects(Property(target, kind == "screen" ? "ScreenFolder" : "ScreenTemplateFolder"), kind == "screen" ? "Screens" : "ScreenTemplates", "", objects);
            if (String.IsNullOrEmpty(S(r, "objectPath"))) {
                Console.WriteLine(Json.Serialize(new { ok = true, objects = objects.Select(o => o.Item2).ToArray(), projectModified = false }));
                return;
            }
            if (S(r, "operation") == "import") {
                string candidate = S(r, "candidateXml");
                if (Hash(candidate) != S(r, "candidateSha256")) throw new Exception("Candidate digest mismatch.");
                XElement root = NativeRoot(candidate);
                string expectedType = kind == "screen" ? "Hmi.Screen.Screen" : "Hmi.Screen.ScreenTemplate";
                if (root.Name != expectedType || (string)root.Element("AttributeList").Element("Name") != S(r, "objectPath").Split('/').Last()) throw new Exception("Candidate identity mismatch.");
                using (ExclusiveAccess access = portal.ExclusiveAccess("Apply one explicitly reviewed HMI object")) {
                    CheckIdentity(project, pid, start, expectedPath);
                    // Re-enumerate under exclusive access; never trust the plan's earlier read.
                    objects.Clear(); Objects(Folder(target, kind), Collection(kind), "", objects);
                    var current = objects.Where(o => o.Item2 == S(r, "objectPath")).ToArray();
                    string baseline = S(r, "baselineComparisonSha256");
                    if (current.Length != 1) throw new Exception("Only replacement of one existing HMI object is supported.");
                    string original = Export(current[0].Item1);
                    if (ComparisonHash(original) != baseline) throw new Exception("Stale native baseline.");
                    string recovery = Path.GetFullPath(S(r, "recoveryDirectory"));
                    Directory.CreateDirectory(recovery);
                    string before = Path.Combine(recovery, "original.xml");
                    if (File.Exists(before)) throw new Exception("Recovery directory already used.");
                    File.WriteAllText(before, original, new UTF8Encoding(false));
                    string staged = Path.Combine(recovery, "candidate.xml");
                    File.WriteAllText(staged, candidate, new UTF8Encoding(false));
                    object composition = Property(ResolveFolder(target, kind, S(r, "objectPath")), Collection(kind));
                    MethodInfo import = composition.GetType().GetMethod("Import", new Type[] { typeof(FileInfo), typeof(ImportOptions) });
                    if (import == null) throw new Exception("Native import method unavailable.");
                    var compiler = ((IEngineeringServiceProvider)target).GetService<ICompilable>();
                    if (compiler == null) throw new Exception("HMI compile service unavailable.");
                    if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access cancelled before import.");
                    mutationAttempted = true;
                    import.Invoke(composition, new object[] { new FileInfo(staged), ImportOptions.Override });
                    CompilerResult compiled = compiler.Compile();
                    var messages = new List<object>(); Messages(compiled.Messages, messages, 0);
                    objects.Clear(); Objects(Folder(target, kind), Collection(kind), "", objects);
                    string readback = Export(objects.Single(o => o.Item2 == S(r, "objectPath")).Item1);
                    File.WriteAllText(Path.Combine(recovery, "readback.xml"), readback, new UTF8Encoding(false));
                    CheckIdentity(project, pid, start, expectedPath);
                    bool equal = ComparisonHash(readback) == ComparisonHash(candidate);
                    bool ok = compiled.ErrorCount == 0 && compiled.State != CompilerResultState.Error && equal;
                    if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access cancelled after import; readback required.");
                    // Save only after compile and strict readback success, as approved in the plan.
                    if (ok && Convert.ToBoolean(r["saveProject"])) project.Save();
                    Console.WriteLine(Json.Serialize(new { ok = ok, status = ok ? "applied" : "verification_failed", projectModified = true,
                        saved = ok && Convert.ToBoolean(r["saveProject"]), compile = new { state = compiled.State.ToString(), errors = compiled.ErrorCount, warnings = compiled.WarningCount, messages = messages },
                        readbackMatches = equal, readbackComparisonSha256 = ComparisonHash(readback), verificationMode = "same_session_strict_native_root", recoveryDirectory = recovery, rollbackAttempted = false }));
                    return;
                }
            }
            object selected = One(objects, o => o.Item2 == S(r, "objectPath"), "HMI " + kind + " '" + S(r, "objectPath") + "' (an empty objectPath lists exact paths)").Item1;
            string temp = Path.Combine(Path.GetTempPath(), "tia-hmi-" + Guid.NewGuid().ToString("N") + ".xml");
            try {
                selected.GetType().GetMethod("Export", new Type[] { typeof(FileInfo), typeof(ExportOptions) }).Invoke(selected, new object[] { new FileInfo(temp), ExportOptions.WithDefaults });
                if (new FileInfo(temp).Length > 25000000) throw new Exception("Native XML exceeds 25 MB.");
                string xml = File.ReadAllText(temp);
                if (Process.GetProcessById(pid).StartTime.ToUniversalTime() != start || !String.Equals(Path.GetFullPath(project.Path.FullName), expectedPath, StringComparison.OrdinalIgnoreCase)) throw new Exception("Identity changed during export.");
                Console.WriteLine(Json.Serialize(new { ok = true, xml = xml, comparisonSha256 = ComparisonHash(xml), projectModified = false, dependencyClosure = "not_exported", consistency = "non_atomic" }));
            } finally { if (File.Exists(temp)) File.Delete(temp); }
        }
    }
}
