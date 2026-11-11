using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Xml.Linq;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;

internal static partial class TiaHmiNative
{
    static string ResourceType(string kind) {
        switch (kind) {
            case "screen": return "Hmi.Screen.Screen";
            case "template": return "Hmi.Screen.ScreenTemplate";
            case "tagTable": return "Hmi.Tag.TagTable";
            case "vbScript": return "Hmi.RuntimeScripting.VBScript";
            case "projectGraphic": return "Hmi.Globalization.MultiLingualGraphic";
            case "connection": return "Hmi.Communication.Connection";
            case "textList": return "Hmi.TextGraphicList.TextList";
            case "graphicList": return "Hmi.TextGraphicList.GraphicList";
            default: throw new Exception("Unsupported native resource kind.");
        }
    }
    static object ResourceComposition(Project project, object target, string kind) {
        switch (kind) {
            case "screen": case "template": return Property(Folder(target, kind), Collection(kind));
            case "tagTable": return Property(Property(target, "TagFolder"), "TagTables");
            case "vbScript": return Property(Property(target, "VBScriptFolder"), "VBScripts");
            case "projectGraphic": return Property(project, "Graphics");
            case "connection": return Property(target, "Connections");
            case "textList": return Property(target, "TextLists");
            case "graphicList": return Property(target, "GraphicLists");
            default: throw new Exception("Unsupported native resource kind.");
        }
    }
    // Creation verification permits vendor defaults but checks every requested value.
    // Existing-object replacements continue to use strict whole-native-root comparison.
    static bool ContainsRequested(XElement expected, XElement actual) {
        if (expected.Name != actual.Name) return false;
        foreach (XAttribute a in expected.Attributes()) {
            if (a.Name == "ID") continue;
            if ((string)actual.Attribute(a.Name) != a.Value) return false;
        }
        if (!expected.HasElements) return expected.Value == actual.Value;
        foreach (var group in expected.Elements().GroupBy(e => e.Name)) {
            var candidates = actual.Elements(group.Key).ToList();
            foreach (XElement child in group) {
                var matches = candidates.Where(a => ContainsRequested(child, a)).ToArray();
                if (matches.Length != 1) return false;
                candidates.Remove(matches[0]);
            }
        }
        return true;
    }
    static object SingleClassicTarget(Project project) {
        var targets = new List<Tuple<object,string>>();
        Devices(project.Devices, "", targets);
        if (targets.Count != 1) throw new Exception("Catalog item must create exactly one classic WinCC HMI target.");
        return targets[0].Item1;
    }
    static object VerifyCreated(Project project, object target, Dictionary<string, object> artifact, string output, int index) {
        string kind = S(artifact, "kind"), name = S(artifact, "name");
        var selected = ((IEnumerable)ResourceComposition(project, target, kind)).Cast<object>().Single(o => Convert.ToString(Property(o,"Name")) == name);
        string xml = Export(selected);
        File.WriteAllText(Path.Combine(output, "readback-" + index + ".xml"), xml, new UTF8Encoding(false));
        if (!ContainsRequested(NativeRoot(S(artifact, "xml")), NativeRoot(xml))) throw new Exception("Created native object differs from requested values: " + name);
        return new { kind = kind, name = name, sha256 = Hash(xml), comparisonSha256 = ComparisonHash(xml), requestedValuesVerified = true };
    }
    static void CreateProject(Dictionary<string, object> r) {
        string parent = Path.GetFullPath(S(r, "outputParent")), name = S(r, "projectName");
        if (!Directory.Exists(parent) || String.IsNullOrWhiteSpace(name) || name != Path.GetFileName(name) || name == "." || name == ".." || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new Exception("Invalid new project destination.");
        string destination = Path.Combine(parent, name);
        if (Directory.Exists(destination) || File.Exists(destination)) throw new Exception("Project destination already exists; overwrite prohibited.");
        var artifacts = ((IEnumerable)r["artifacts"]).Cast<Dictionary<string, object>>().ToArray();
        if (artifacts.Length == 0 || artifacts.Length > 220) throw new Exception("Invalid artifact count.");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var artifact in artifacts) {
            string xml = S(artifact, "xml"), objectName = S(artifact, "name"), kind = S(artifact, "kind");
            XElement root = NativeRoot(xml);
            if (root.Name.LocalName != ResourceType(kind) ||
                (string)root.Element("AttributeList").Element("Name") != objectName || !names.Add(objectName) || Hash(xml) != S(artifact, "sha256")) throw new Exception("Invalid project artifact identity/hash.");
        }
        string lockPath = Path.Combine(parent, "." + name + ".hmi-build.lock");
        using (var buildLock = new FileStream(lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            string stage = "start", projectPath = null, evidence = null;
            try {
                if (Directory.Exists(destination)) throw new Exception("Destination appeared after planning.");
                using (var portal = new TiaPortal(TiaPortalMode.WithoutUserInterface)) {
                    stage = "create_project";
                    mutationAttempted = true;
                    Project project = portal.Projects.Create(new DirectoryInfo(parent), name);
                    projectPath = project.Path.FullName;
                    evidence = Path.Combine(destination, "hmi-authoring-evidence"); Directory.CreateDirectory(evidence);
                    // Generated candidates carry zh-CN texts and fonts; a new project's
                    // active languages follow the TIA install and may not include it.
                    stage = "configure_language";
                    UnifiedLanguage(project, "zh-CN", true);
                    stage = "create_device";
                    project.Devices.CreateWithItem(S(r, "typeIdentifier"), S(r, "deviceName"), S(r, "deviceName"));
                    object target = SingleClassicTarget(project);
                    stage = "create_skeletons";
                    for (int i = 0; i < artifacts.Length; i++) {
                        var a = artifacts[i]; string kind = S(a, "kind");
                        object composition = ResourceComposition(project, target, kind);
                        if (((IEnumerable)composition).Cast<object>().Any(o => Convert.ToString(Property(o,"Name")) == S(a,"name"))) throw new Exception("Generated name collides with a vendor-created default object.");
                        string file = Path.Combine(evidence, "skeleton-" + i + ".xml");
                        XElement skeleton = NativeRoot(S(a, "xml"));
                        if (kind == "screen" || kind == "template") foreach (var item in skeleton.Descendants().Where(e => (string)e.Attribute("CompositionName") == "ScreenItems").ToArray()) item.Remove();
                        File.WriteAllText(file, new XDocument(new XElement("Document", new XElement("Engineering", new XAttribute("version", TiaNativeTarget.PortalVersion)), skeleton)).ToString(), new UTF8Encoding(false));
                        composition.GetType().GetMethod("Import", new Type[] { typeof(FileInfo), typeof(ImportOptions) }).Invoke(composition, new object[] { new FileInfo(file), ImportOptions.None });
                    }
                    // All screen names exist before importing buttons with cyclic navigation.
                    stage = "import_candidates";
                    for (int i = 0; i < artifacts.Length; i++) {
                        var a = artifacts[i];
                        if (S(a, "kind") != "screen" && S(a, "kind") != "template") continue;
                        string file = Path.Combine(evidence, "candidate-" + i + ".xml");
                        File.WriteAllText(file, S(a, "xml"), new UTF8Encoding(false));
                        object composition = ResourceComposition(project, target, S(a, "kind"));
                        composition.GetType().GetMethod("Import", new Type[] { typeof(FileInfo), typeof(ImportOptions) }).Invoke(composition, new object[] { new FileInfo(file), ImportOptions.Override });
                    }
                    stage = "compile";
                    var compiler = ((IEngineeringServiceProvider)target).GetService<ICompilable>();
                    if (compiler == null) throw new Exception("HMI compiler unavailable.");
                    CompilerResult compile = compiler.Compile(); var messages = new List<object>(); Messages(compile.Messages, messages, 0);
                    File.WriteAllText(Path.Combine(evidence, "compile.json"), Json.Serialize(new { state = compile.State.ToString(), errors = compile.ErrorCount, warnings = compile.WarningCount, messages = messages }), new UTF8Encoding(false));
                    if (compile.ErrorCount != 0 || compile.State == CompilerResultState.Error) throw new Exception("New project HMI compile failed; inspect compile.json.");
                    stage = "verify_before_save";
                    for (int i = 0; i < artifacts.Length; i++) VerifyCreated(project, target, artifacts[i], evidence, i);
                    stage = "save"; project.Save(); project.Close();
                }
                stage = "independent_reopen";
                var verified = new List<object>();
                using (var portal = new TiaPortal(TiaPortalMode.WithoutUserInterface)) {
                    Project project = portal.Projects.Open(new FileInfo(projectPath));
                    object target = SingleClassicTarget(project);
                    for (int i = 0; i < artifacts.Length; i++) verified.Add(VerifyCreated(project, target, artifacts[i], evidence, i));
                    project.Close();
                }
                Console.WriteLine(Json.Serialize(new { ok = true, status = "created_and_reopened", projectPath = projectPath, projectCreated = true, saved = true, evidenceDirectory = evidence,
                    artifacts = verified, verificationMode = "independent_project_reopen_requested_values", nativeDefaultsAllowed = true, startupScreenConfigured = false, runtimeReady = false, runtimeTested = false, downloaded = false }));
            } catch (Exception ex) {
                Console.WriteLine(Json.Serialize(new { ok = false, status = "project_creation_failed", stage = stage, error = ex.GetBaseException().Message,
                    projectPath = projectPath, outputDirectory = destination, evidenceDirectory = evidence, partialOutputRetained = Directory.Exists(destination), downloaded = false }));
            }
        }
        try { File.Delete(lockPath); }
        catch (Exception) { Console.Error.WriteLine("Build lock cleanup failed; inspect the output parent before another creation attempt."); }
    }
}
