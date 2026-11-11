using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml;
using System.Xml.Linq;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;

[assembly: AssemblyTitle("TiaOpennessImportBlock")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("0.27.0.0")]
[assembly: AssemblyInformationalVersion("0.27.0")]

// Invoked by the plan-gated MCP wrapper. Attaches to an existing project only.
// Never opens/closes a project, goes online, downloads, or accesses PLC values.
internal static class TiaOpennessImportBlock
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
    private static string apiPath;

    private sealed class Candidate
    {
        public XDocument Document;
        public XElement Block;
        public string Name, Number, Kind, Sha256;
        public byte[] Bytes;
        public string ExpectedBaseline;
    }

    private sealed class Target
    {
        public PlcSoftware Software;
        public PlcBlockComposition Blocks;
        public PlcBlock Block;
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Utf8;
        try
        {
            Dictionary<string, string> options = Parse(args);
            if (options.ContainsKey("signature-only")) return RunOfflineSignatures(options);
            apiPath = Path.GetFullPath(Required(options, "api"));
            AssemblyName identity = AssemblyName.GetAssemblyName(apiPath);
            TiaNativeTarget.RequireApi(identity, "The Siemens.Engineering " + TiaNativeTarget.PortalVersion + " public API is required.");
            AppDomain.CurrentDomain.AssemblyResolve += ResolveApi;
            Assembly api = Assembly.LoadFrom(apiPath);
            if (options.ContainsKey("self-test")) return SelfTest(api);
            if (options.ContainsKey("changeset"))
            {
                List<Candidate> items = ReadChangeset(Required(options, "changeset"), Required(options, "changeset-sha256"), options.ContainsKey("baseline-only"));
                if (options.ContainsKey("baseline-only") || options.ContainsKey("verify-only")) return RunChangesetVerification(options, items);
                return RunChangeset(options, items);
            }
            if (options.ContainsKey("baseline-only")) throw new ArgumentException("Baseline capture requires a target list.");
            Candidate candidate = ReadCandidate(File.ReadAllBytes(Required(options, "xml")));
            MatchCandidate(candidate, options);
            if (options.ContainsKey("validate-only"))
            {
                WriteJson(new { ok = true, status = "candidate_validated", candidate.Sha256,
                    candidate.Name, candidate.Number, candidate.Kind, projectModified = false, plcAccessed = false });
                return 0;
            }
            if (!String.Equals(candidate.Sha256, Required(options, "xml-sha256"), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Candidate differs from the approved XML SHA-256.");
            if (options.ContainsKey("verify-only")) return RunVerification(options, candidate);
            candidate.ExpectedBaseline = Required(options, "baseline-sha256");
            return RunImport(options, candidate);
        }
        catch (Exception ex)
        {
            WriteJson(new { ok = false, status = "failed", error = ex.Message, errorType = ex.GetType().Name, download = false });
            return 1;
        }
    }

    private static Assembly ResolveApi(object sender, ResolveEventArgs args)
    {
        AssemblyName name = new AssemblyName(args.Name);
        if (name.Name != "Siemens.Engineering" && name.Name != "Siemens.Engineering.Contract") return null;
        string path = name.Name == "Siemens.Engineering" ? apiPath : Path.Combine(Path.GetDirectoryName(apiPath), name.Name + ".dll");
        return File.Exists(path) ? Assembly.LoadFrom(path) : null;
    }

    private static Dictionary<string, string> Parse(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var flags = new HashSet<string> { "self-test", "validate-only", "verify-only", "baseline-only", "signature-only", "no-save" };
        var values = new HashSet<string> { "api", "project", "xml", "target-name", "target-number", "target-kind", "process-id", "process-start-time-utc", "xml-sha256", "compile-scope", "out", "timeout-ms", "changeset", "changeset-sha256", "baseline-sha256", "files" };
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) throw new ArgumentException("Expected a named option.");
            string key = args[i].Substring(2);
            if (result.ContainsKey(key)) throw new ArgumentException("Duplicate option: " + key);
            if (flags.Contains(key)) result.Add(key, "true");
            else if (values.Contains(key) && i + 1 < args.Length) result.Add(key, args[++i]);
            else throw new ArgumentException("Unknown or incomplete option: " + key);
        }
        if (result.ContainsKey("self-test") && result.Keys.Any(k => k != "self-test" && k != "api"))
            throw new ArgumentException("Self-test cannot be combined with project operations.");
        if (result.ContainsKey("validate-only") && result.Keys.Any(k => !new[] { "validate-only", "api", "xml", "target-name", "target-number", "target-kind" }.Contains(k)))
            throw new ArgumentException("Candidate validation cannot be combined with project operations.");
        if (result.ContainsKey("changeset") && result.Keys.Any(k => new[] { "xml", "xml-sha256", "target-name", "target-number", "target-kind", "validate-only" }.Contains(k)))
            throw new ArgumentException("A changeset names its blocks in the changeset file only.");
        if (result.ContainsKey("changeset") && result.ContainsKey("compile-scope") && result["compile-scope"] != "software")
            throw new ArgumentException("A changeset always compiles the whole PLC software.");
        if (result.ContainsKey("signature-only") && result.Keys.Any(k => k != "signature-only" && k != "files"))
            throw new ArgumentException("Offline signatures only accept --files (a JSON array of XML paths).");
        return result;
    }

    private static Dictionary<string, object> OfflineSignature(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        Candidate candidate = ReadCandidate(bytes);
        return new Dictionary<string, object> {
            { "path", Path.GetFullPath(path) }, { "sha256", candidate.Sha256 },
            { "kind", candidate.Kind }, { "name", candidate.Name }, { "number", candidate.Number },
            { "targetSignature", TargetSignature(candidate) }, { "programSignature", ProgramSignature(candidate) }
        };
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunOfflineSignatures(Dictionary<string, string> options)
    {
        string[] files = Json.Deserialize<string[]>(Required(options, "files"));
        if (files == null || files.Length < 1 || files.Length > 200) throw new ArgumentException("Expected 1 to 200 XML files.");
        WriteJson(new { ok = true, status = "offline_signatures", items = files.Select(OfflineSignature).ToArray() });
        return 0;
    }

    private static string Required(Dictionary<string, string> options, string key)
    {
        string value;
        if (!options.TryGetValue(key, out value) || String.IsNullOrWhiteSpace(value)) throw new ArgumentException("Missing option: " + key);
        return value;
    }

    private static Candidate ReadCandidate(byte[] bytes)
    {
        if (bytes.Length == 0 || bytes.Length > 32 * 1024 * 1024) throw new InvalidDataException("Candidate size is outside the supported range.");
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 32 * 1024 * 1024 };
        XDocument document;
        using (var stream = new MemoryStream(bytes))
        using (var reader = XmlReader.Create(stream, settings)) document = XDocument.Load(reader);
        XElement root = document.Root;
        if (root == null || root.Name != "Document") throw new InvalidDataException("Expected a Simatic ML Document.");
        var supported = new HashSet<string> { "SW.Blocks.FC", "SW.Blocks.FB", "SW.Blocks.OB", "SW.Blocks.GlobalDB", "SW.Blocks.InstanceDB" };
        XElement[] blocks = root.Elements().Where(e => supported.Contains(e.Name.LocalName)).ToArray();
        if (blocks.Length != 1 || root.Elements().Any(e => e.Name.LocalName != "Engineering" && e.Name.LocalName != "DocumentInfo" && !supported.Contains(e.Name.LocalName)))
            throw new InvalidDataException("Exactly one supported PLC block is required; additional engineering objects are prohibited.");
        XElement block = blocks[0];
        if (block.Descendants().Any(e => supported.Contains(e.Name.LocalName))) throw new InvalidDataException("Nested PLC blocks are prohibited.");
        XElement attributes = block.Element("AttributeList");
        if (attributes == null) throw new InvalidDataException("Block attributes are missing.");
        string name = (string)attributes.Element("Name");
        int number;
        if (String.IsNullOrWhiteSpace(name) || !Int32.TryParse((string)attributes.Element("Number"), out number) || number < 1)
            throw new InvalidDataException("A named, numbered block is required.");
        var ids = document.Descendants().Attributes("ID").Select(a => a.Value).ToArray();
        if (ids.Length != ids.Distinct(StringComparer.Ordinal).Count()) throw new InvalidDataException("Duplicate document IDs.");
        string kind = block.Name.LocalName.Substring("SW.Blocks.".Length);
        return new Candidate { Document = document, Block = block, Name = name, Number = number.ToString(CultureInfo.InvariantCulture), Kind = kind, Bytes = bytes, Sha256 = Hash(bytes) };
    }

    private static void MatchCandidate(Candidate candidate, Dictionary<string, string> options)
    {
        if (candidate.Name != Required(options, "target-name") || candidate.Number != Required(options, "target-number") || candidate.Kind != Required(options, "target-kind"))
            throw new InvalidDataException("Candidate block identity does not match the requested target.");
    }

    // Compare program content, not export timestamps, generated IDs or compiler status.
    // Scoped UId references are normalized consistently, preserving wiring topology.
    private static XElement StableAttributes(Candidate candidate)
    {
        XElement attributes = new XElement(candidate.Block.Element("AttributeList"));
        foreach (XElement node in attributes.Elements().Where(e => new[] { "CompileDate", "CodeModifiedDate", "InterfaceModifiedDate", "IsConsistent", "ModifiedDate", "MemorySize", "LoadMemorySize", "WorkMemorySize" }.Contains(e.Name.LocalName)).ToArray()) node.Remove();
        return attributes;
    }

    // Bind the complete exported block, including any version-specific sections
    // outside ObjectList. The document header contains a new timestamp on each export.
    private static string TargetSignature(Candidate candidate)
    {
        var block = new XElement(candidate.Block);
        block.Element("AttributeList").ReplaceWith(StableAttributes(candidate));
        var text = new StringBuilder();
        Canonical(block, text, new Dictionary<string, string>(), false);
        return Hash(Utf8.GetBytes(text.ToString()));
    }

    private static string ProgramSignature(Candidate candidate)
    {
        XElement attributes = StableAttributes(candidate);
        var text = new StringBuilder();
        Canonical(attributes, text, new Dictionary<string, string>());
        XElement objects = candidate.Block.Element("ObjectList");
        if (objects != null)
            foreach (XElement item in objects.Elements()) Canonical(item, text, new Dictionary<string, string>());
        return Hash(Utf8.GetBytes(text.ToString()));
    }

    private static void Canonical(XElement element, StringBuilder text, Dictionary<string, string> ids, bool normalizeMemberComments = true)
    {
        text.Append('<').Append(element.Name.ToString());
        foreach (XAttribute attribute in element.Attributes().Where(a => !a.IsNamespaceDeclaration && a.Name.LocalName != "ID").OrderBy(a => a.Name.ToString(), StringComparer.Ordinal))
        {
            string value = attribute.Value;
            if (attribute.Name.LocalName == "UId")
            {
                string mapped;
                if (!ids.TryGetValue(value, out mapped)) { mapped = ids.Count.ToString(CultureInfo.InvariantCulture); ids.Add(value, mapped); }
                value = mapped;
            }
            text.Append('|').Append(attribute.Name).Append('=').Append(value.Length).Append(':').Append(value);
        }
        text.Append('>');
        foreach (XNode node in element.Nodes())
        {
            XElement child = node as XElement;
            if (child != null) Canonical(child, text, ids, normalizeMemberComments);
            else
            {
                XText value = node as XText;
                if (value != null && (!String.IsNullOrWhiteSpace(value.Value) || !element.HasElements))
                {
                    string content = value.Value;
                    // V20 removes trailing spaces/tabs in DB member comments on import.
                    // Do not normalize executable tokens, string values or other text.
                    if (normalizeMemberComments && element.Name.LocalName == "MultiLanguageText" && element.Parent != null &&
                        element.Parent.Name.LocalName == "Comment" && element.Parent.Parent != null &&
                        element.Parent.Parent.Name.LocalName == "Member") content = content.Trim(' ', '\t'); // TIA strips both ends on import
                    text.Append(content.Length).Append(':').Append(content);
                }
            }
        }
        text.Append("</").Append(element.Name.ToString()).Append('>');
    }

    private static int SelfTest(Assembly api)
    {
        if (api.GetType("Siemens.Engineering.SW.Blocks.PlcBlockComposition", true).GetMethods().All(m => m.Name != "Import")) throw new InvalidOperationException("Import API is unavailable.");
        string sample = "<Document><SW.Blocks.FC ID='0'><AttributeList><Name>Test</Name><Number>1</Number><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList><SW.Blocks.CompileUnit ID='1'><AttributeList><NetworkSource><FlgNet><Parts><Access UId='21'/><Part UId='22'/></Parts><Wires><Wire UId='23'><IdentCon UId='21'/><NameCon UId='22' Name='in'/></Wire></Wires></FlgNet></NetworkSource></AttributeList></SW.Blocks.CompileUnit></ObjectList></SW.Blocks.FC></Document>";
        Candidate original = ReadCandidate(Utf8.GetBytes(sample));
        Candidate renumbered = ReadCandidate(Utf8.GetBytes(sample.Replace("ID='0'", "ID='A'").Replace("ID='1'", "ID='B'").Replace("UId='21'", "UId='101'").Replace("UId='22'", "UId='102'").Replace("UId='23'", "UId='103'")));
        Candidate changed = ReadCandidate(Utf8.GetBytes(sample.Replace("Name='in'", "Name='out'")));
        if (ProgramSignature(original) != ProgramSignature(renumbered) || ProgramSignature(original) == ProgramSignature(changed)) throw new InvalidOperationException("Program comparison self-test failed.");
        string dbSample = "<Document><SW.Blocks.GlobalDB><AttributeList><Name>TestDB</Name><Number>1</Number><Interface><Sections><Section Name='Static'><Member Name='Value' Datatype='String'><StartValue>'text '</StartValue><Comment><MultiLanguageText Lang='en-US'>Label </MultiLanguageText></Comment></Member></Section></Sections></Interface></AttributeList></SW.Blocks.GlobalDB></Document>";
        string dbSignature = ProgramSignature(ReadCandidate(Utf8.GetBytes(dbSample)));
        if (dbSignature != ProgramSignature(ReadCandidate(Utf8.GetBytes(dbSample.Replace("Label </", "Label</")))) ||
            dbSignature != ProgramSignature(ReadCandidate(Utf8.GetBytes(dbSample.Replace(">Label </", ">  Label</")))) ||
            dbSignature == ProgramSignature(ReadCandidate(Utf8.GetBytes(dbSample.Replace("Label </", "La bel</")))) ||
            dbSignature == ProgramSignature(ReadCandidate(Utf8.GetBytes(dbSample.Replace("Label </", "Different</")))) ||
            dbSignature == ProgramSignature(ReadCandidate(Utf8.GetBytes(dbSample.Replace("'text '", "'text'")))))
            throw new InvalidOperationException("DB comment whitespace comparison self-test failed.");
        bool rejected = false;
        try { ReadCandidate(Utf8.GetBytes("<!DOCTYPE Document [<!ENTITY x 'bad'>]>" + sample)); } catch (XmlException) { rejected = true; }
        if (!rejected) throw new InvalidOperationException("DTD rejection self-test failed.");
        Candidate fc = ReadCandidate(Utf8.GetBytes(sample));
        Candidate db = ReadCandidate(Utf8.GetBytes(dbSample));
        List<Candidate> ordered = OrderChangeset(new List<Candidate> { fc, db });
        bool duplicateRejected = false;
        try { OrderChangeset(new List<Candidate> { fc, ReadCandidate(Utf8.GetBytes(sample)) }); } catch (InvalidDataException) { duplicateRejected = true; }
        Candidate idb = ReadCandidate(Utf8.GetBytes(dbSample.Replace("SW.Blocks.GlobalDB", "SW.Blocks.InstanceDB").Replace("TestDB", "TestIDB").Replace("<Number>1</Number>", "<Number>2</Number>")));
        List<Candidate> withInstance = OrderChangeset(new List<Candidate> { idb, fc, db });
        if (ordered[0] != db || ordered[1] != fc || !duplicateRejected ||
            withInstance[0] != db || withInstance[1] != fc || withInstance[2] != idb)
            throw new InvalidOperationException("Changeset ordering self-test failed.");
        if (TargetSignature(original) != TargetSignature(renumbered) ||
            TargetSignature(original) == TargetSignature(changed) ||
            TargetSignature(db) == TargetSignature(ReadCandidate(Utf8.GetBytes(dbSample.Replace("Label </", "Label</")))))
            throw new InvalidOperationException("Target signature normalization failed.");
        fc.ExpectedBaseline = TargetSignature(fc);
        db.ExpectedBaseline = TargetSignature(db);
        CheckApprovedBaselines(new[] { fc, db }, new[] { fc, db });
        bool refusedSecond = false;
        try { CheckApprovedBaselines(new[] { fc, db }, new[] { fc, ReadCandidate(Utf8.GetBytes(dbSample.Replace("'text '", "'other'"))) }); }
        catch (BaselineChanged ex) { refusedSecond = ex.Blocks.SequenceEqual(new[] { db.Kind + db.Number + " " + db.Name }); }
        if (!refusedSecond) throw new InvalidOperationException("A changed second target must refuse the batch.");
        string signatureFile = Path.GetTempFileName();
        try {
            File.WriteAllBytes(signatureFile, original.Bytes);
            Dictionary<string, object> offline = OfflineSignature(signatureFile);
            if ((string)offline["targetSignature"] != TargetSignature(original) ||
                (string)offline["programSignature"] != ProgramSignature(original))
                throw new InvalidOperationException("Offline signature parity failed.");
        } finally { File.Delete(signatureFile); }
        WriteJson(new { ok = true, status = "self_test_passed", protocolVersion = 1, apiPath = apiPath,
            apiAssemblyVersion = api.GetName().Version.ToString(), checks = new[] { "api_identity", "xml_validation", "program_comparison", "dtd_rejection", "changeset_ordering", "target_baseline", "offline_signature", "software_compile_fallback" },
            target = TiaNativeTarget.Target(), capabilities = new[] { "block_import" },
            safety = new { selfTestOnly = true, projectOpened = false, projectModified = false, plcAccessed = false, import = false, download = false } });
        return 0;
    }

    // Runs in a fresh process after import, or before planning to inspect the
    // exact current block. This branch never imports, compiles or saves.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunVerification(Dictionary<string, string> options, Candidate candidate)
    {
        string projectPath = Path.GetFullPath(Required(options, "project"));
        if (!TiaNativeTarget.IsProjectPath(projectPath) || !File.Exists(projectPath)) throw new ArgumentException("Existing target-version project required.");
        int pid = Int32.Parse(Required(options, "process-id"), CultureInfo.InvariantCulture);
        long ticks = DateTimeOffset.Parse(Required(options, "process-start-time-utc"), CultureInfo.InvariantCulture, DateTimeStyles.None).UtcDateTime.Ticks;
        int timeout = Int32.Parse(Required(options, "timeout-ms"), CultureInfo.InvariantCulture);
        CheckBounds(pid, timeout);
        string output = Path.GetFullPath(Required(options, "out"));
        if (Directory.Exists(output) || File.Exists(output)) throw new IOException("Verification output already exists.");
        CheckProcess(pid, ticks);
        using (var watchdog = new Timer(delegate { Console.Error.WriteLine("Verification deadline exceeded."); Environment.Exit(124); }, null, timeout, Timeout.Infinite))
        {
            TiaPortalProcess descriptor = TiaPortal.GetProcess(pid, Math.Min(timeout, 10000));
            if (descriptor == null || descriptor.ProjectPath == null || !SamePath(descriptor.ProjectPath.FullName, projectPath)) throw new InvalidOperationException("Verification process/project mismatch.");
            using (TiaPortal portal = descriptor.Attach())
            {
                CheckProcess(pid, ticks);
                Project[] projects = portal.Projects.Where(p => p.Path != null && SamePath(p.Path.FullName, projectPath)).ToArray();
                if (projects.Length != 1) throw new InvalidOperationException("Exactly one verification project required.");
                Target target = FindTarget(projects[0], candidate);
                Directory.CreateDirectory(output);
                string export = Path.Combine(output, "verification.xml");
                target.Block.Export(new FileInfo(export), ExportOptions.WithDefaults);
                Candidate observed = ReadCandidate(File.ReadAllBytes(export));
                MatchCandidate(observed, options);
                CheckProcess(pid, ticks);
                bool matches = ProgramSignature(candidate) == ProgramSignature(observed);
                WriteJson(new { ok = matches, status = matches ? "independent_readback_verified" : "independent_readback_mismatch",
                    processId = pid, processStartTimeUtc = new DateTime(ticks, DateTimeKind.Utc).ToString("o"), projectPath = projectPath,
                    verificationExport = export, verificationSha256 = observed.Sha256, programContentMatches = matches,
                    verificationMode = "independent-session", projectModified = false, plcAccessed = false, download = false });
                return matches ? 0 : 1;
            }
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunImport(Dictionary<string, string> options, Candidate candidate)
    {
        string projectPath = Path.GetFullPath(Required(options, "project"));
        if (!TiaNativeTarget.IsProjectPath(projectPath) || !File.Exists(projectPath)) throw new ArgumentException("An existing " + TiaNativeTarget.ProjectExtension + " project is required.");
        int pid = Int32.Parse(Required(options, "process-id"), CultureInfo.InvariantCulture);
        int timeout = Int32.Parse(Required(options, "timeout-ms"), CultureInfo.InvariantCulture);
        string scope = Required(options, "compile-scope");
        if (scope != "block" && scope != "software") throw new ArgumentException("Unsupported compile scope '" + scope + "'; expected block or software.");
        CheckBounds(pid, timeout);
        string output = Path.GetFullPath(Required(options, "out"));
        if (Directory.Exists(output) || File.Exists(output)) throw new IOException("Output directory already exists.");
        Directory.CreateDirectory(output);
        string staged = Path.Combine(output, "candidate.xml");
        File.WriteAllBytes(staged, candidate.Bytes);
        var errors = new List<string>();
        var summary = new Dictionary<string, object> {
            { "status", "preflight" }, { "projectPath", projectPath }, { "processId", pid },
            { "targetName", candidate.Name }, { "targetNumber", candidate.Number }, { "candidateSha256", candidate.Sha256 }, { "sourceImportStarted", false },
            { "projectSaved", false }, { "projectModified", false }, { "plcAccessed", false }, { "download", false },
            { "rollbackAttempted", false }, { "rollbackSucceeded", false }, { "errors", errors },
            { "compileScope", scope }, { "compileScopeUsed", null }, { "softwareCompileFallback", false }
        };
        Stopwatch elapsed = Stopwatch.StartNew();
        string refusedBeforeImport = null;
        string summaryPath = Path.Combine(output, "import-block.json");
        SaveSummary(summaryPath, summary);
        using (var watchdog = new Timer(delegate { Console.Error.WriteLine("Import deadline exceeded; project state may be indeterminate. Inspect the journal before retrying."); Environment.Exit(124); }, null, timeout, Timeout.Infinite))
        {
            try
            {
                // Bind the native attach to the process observed and approved by the MCP plan.
                long startTicks = DateTimeOffset.Parse(Required(options, "process-start-time-utc"), CultureInfo.InvariantCulture, DateTimeStyles.None).UtcDateTime.Ticks;
                CheckProcess(pid, startTicks);
                TiaPortalProcess descriptor = TiaPortal.GetProcess(pid, Math.Min(timeout, 10000));
                if (descriptor == null || descriptor.ProjectPath == null || !SamePath(descriptor.ProjectPath.FullName, projectPath)) throw new InvalidOperationException("Exact process descriptor/project mismatch.");
                using (TiaPortal portal = descriptor.Attach())
                {
                    CheckProcess(pid, startTicks);
                    Project[] projects = portal.Projects.Where(p => p.Path != null && SamePath(p.Path.FullName, projectPath)).ToArray();
                    if (projects.Length != 1) throw new InvalidOperationException("Exactly one matching attached project is required.");
                    Project project = projects[0];
                    using (ExclusiveAccess access = portal.ExclusiveAccess("Import one reviewed PLC block for offline inspection"))
                    {
                        Stopwatch baselineTimer = Stopwatch.StartNew();
                        Target target = FindTarget(project, candidate);
                        string baseline = Path.Combine(output, "baseline.xml");
                        target.Block.Export(new FileInfo(baseline), ExportOptions.WithDefaults);
                        Candidate original = ReadCandidate(File.ReadAllBytes(baseline));
                        try { CheckApprovedBaselines(new[] { candidate }, new[] { original }); }
                        finally { summary["baselineCheckMs"] = baselineTimer.ElapsedMilliseconds; }
                        summary["baselineExport"] = baseline;
                        summary["baselineSha256"] = original.Sha256;
                        summary["processStartTimeUtc"] = new DateTime(startTicks, DateTimeKind.Utc).ToString("o");
                        summary["status"] = "baseline_exported";
                        SaveSummary(summaryPath, summary);
                        long softwareCompileMs = -1;
                        if (scope == "software")
                        {
                            // Prove the PLC software compiles before the import, so a later error belongs to
                            // the import and a rollback compile can prove the restore.
                            if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access was cancelled before baseline compilation.");
                            summary["status"] = "baseline_compile_started";
                            summary["projectModified"] = true;
                            SaveSummary(summaryPath, summary);
                            long compileStarted = elapsed.ElapsedMilliseconds;
                            CompilerResult baselineCompile = target.Software.GetService<ICompilable>().Compile();
                            softwareCompileMs = elapsed.ElapsedMilliseconds - compileStarted;
                            summary["baselineCompile"] = CompileReport(baselineCompile);
                            summary["baselineCompileMs"] = softwareCompileMs;
                            if (Failed(baselineCompile))
                            {
                                refusedBeforeImport = "refused_baseline_compile_errors";
                                throw new InvalidOperationException("The PLC software has compile errors before the import; nothing was imported.");
                            }
                            // After the import come a software compile and, on failure, a re-import and another compile.
                            if (elapsed.ElapsedMilliseconds + 2 * softwareCompileMs + RollbackMarginMs > timeout)
                            {
                                refusedBeforeImport = "refused_time_budget";
                                throw new TimeoutException("The time budget cannot hold the import compile and a rollback compile (" + softwareCompileMs + " ms each); nothing was imported. Raise timeoutMs.");
                            }
                        }
                        if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access was cancelled before import.");
                        CheckProcess(pid, startTicks);
                        if (Hash(File.ReadAllBytes(staged)) != candidate.Sha256) throw new InvalidDataException("Staged candidate changed.");
                        // Kept from before the import: the rollback must not depend on finding a target the import may have broken.
                        PlcBlockComposition group = target.Blocks;
                        PlcSoftware software = target.Software;
                        bool mutationAttempted = false;
                        try
                        {
                            summary["status"] = "import_started";
                            summary["sourceImportStarted"] = true;
                            summary["projectModified"] = true;
                            SaveSummary(summaryPath, summary);
                            mutationAttempted = true;
                            group.Import(new FileInfo(staged), ImportOptions.Override);
                            target = FindTarget(project, candidate);
                            CompilerResult result;
                            if (scope == "software")
                            {
                                result = software.GetService<ICompilable>().Compile();
                                summary["compile"] = CompileReport(result);
                                summary["compileScopeUsed"] = "software";
                            }
                            else
                            {
                                result = target.Block.GetService<ICompilable>().Compile();
                                summary["compile"] = CompileReport(result);
                                summary["compileScopeUsed"] = "block";
                                // A block-only compile cannot update the instance DBs, multi-instances and callers that
                                // depend on the re-imported interface, so it can fail on unchanged content. A software
                                // compile settles them and is the arbiter: its errors still roll the import back.
                                // Fall back only while two thirds of the budget remain for it and a rollback compile.
                                if (Failed(result) && elapsed.ElapsedMilliseconds <= timeout / 3)
                                {
                                    if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access was cancelled before the software compile fallback.");
                                    CheckProcess(pid, startTicks);
                                    summary["softwareCompileFallback"] = true;
                                    summary["status"] = "software_compile_fallback_started";
                                    SaveSummary(summaryPath, summary);
                                    result = software.GetService<ICompilable>().Compile();
                                    summary["fallbackCompile"] = CompileReport(result);
                                    summary["compileScopeUsed"] = "software";
                                }
                            }
                            if (Failed(result)) throw new InvalidOperationException("Imported block compilation failed (" + summary["compileScopeUsed"] + " scope).");
                            string verification = Path.Combine(output, "verification.xml");
                            target.Block.Export(new FileInfo(verification), ExportOptions.WithDefaults);
                            Candidate readback = ReadCandidate(File.ReadAllBytes(verification));
                            MatchCandidate(readback, options);
                            summary["verificationExport"] = verification;
                            summary["verificationSha256"] = readback.Sha256;
                            summary["programContentMatches"] = ProgramSignature(candidate) == ProgramSignature(readback);
                            if (!(bool)summary["programContentMatches"]) throw new InvalidOperationException("Re-exported program content differs from the reviewed candidate.");
                            CheckProcess(pid, startTicks);
                            if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access was cancelled.");
                            summary["status"] = "verified_unsaved";
                            SaveSummary(summaryPath, summary);
                        }
                        catch
                        {
                            if (mutationAttempted)
                            {
                                summary["rollbackAttempted"] = true;
                                summary["status"] = "rollback_started";
                                SaveSummary(summaryPath, summary);
                                // Restore, then compile the whole PLC software: a block-only compile cannot make the
                                // dependent instance DBs and callers consistent again. Each step reports on its own.
                                bool restoredOk = true;
                                try
                                {
                                    CheckProcess(pid, startTicks);
                                    if (Hash(File.ReadAllBytes(baseline)) != original.Sha256) throw new InvalidDataException("Baseline changed; refusing an unverified rollback.");
                                    group.Import(new FileInfo(baseline), ImportOptions.Override);
                                }
                                catch (Exception rollbackError) { restoredOk = false; errors.Add("Rollback: " + rollbackError.Message); }
                                if (restoredOk)
                                {
                                    // Software scope knows its compile time; block scope keeps a third of the budget for it.
                                    // Software scope proved a clean compile before the import, so errors now are the
                                    // rollback's. Block scope did not, so errors may be older and elsewhere: the
                                    // restored block's own export and content decide, and the errors are reported.
                                    long needed = softwareCompileMs >= 0 ? softwareCompileMs + RollbackMarginMs : timeout / 3;
                                    restoredOk = RollbackCompile(software, summary, errors, timeout - elapsed.ElapsedMilliseconds, needed, scope == "software");
                                    try
                                    {
                                        Target restored = FindTarget(project, original);
                                        string restoredPath = Path.Combine(output, "restored.xml");
                                        restored.Block.Export(new FileInfo(restoredPath), ExportOptions.WithDefaults);
                                        summary["rollbackExport"] = restoredPath;
                                        bool same = ProgramSignature(original) == ProgramSignature(ReadCandidate(File.ReadAllBytes(restoredPath)));
                                        summary["rollbackContentMatches"] = same;
                                        restoredOk = restoredOk && same;
                                    }
                                    catch (Exception verifyError) { restoredOk = false; errors.Add("Rollback check: " + verifyError.Message); }
                                }
                                summary["rollbackSucceeded"] = restoredOk;
                            }
                            throw;
                        }
                        // Saving is outside rollback: an uncertain Save result must not be silently rewritten.
                        if (!options.ContainsKey("no-save"))
                        {
                            summary["status"] = "save_started";
                            SaveSummary(summaryPath, summary);
                            project.Save();
                            summary["projectSaved"] = true;
                        }
                        summary["status"] = options.ContainsKey("no-save") ? "verified_unsaved" : "verified_saved";
                    }
                }
            }
            catch (BaselineChanged ex)
            {
                errors.Add(ex.Message); summary["status"] = "refused_target_changed";
                summary["sourceImportStarted"] = false; summary["changedTargets"] = ex.Blocks;
            }
            catch (Exception ex) { errors.Add(ex.Message); summary["status"] = refusedBeforeImport ?? ((bool)summary["rollbackSucceeded"] ? "failed_rolled_back" : "failed_or_indeterminate"); }
            SaveSummary(summaryPath, summary);
            WriteJson(summary);
            return errors.Count == 0 ? 0 : 1;
        }
    }

    private sealed class BaselineChanged : Exception
    {
        public readonly string[] Blocks;
        public BaselineChanged(string[] blocks) : base("Target content changed since plan: " + String.Join(", ", blocks)) { Blocks = blocks; }
    }

    private static void CheckApprovedBaselines(IList<Candidate> planned, IList<Candidate> observed)
    {
        var changed = new List<string>();
        for (int i = 0; i < planned.Count; i++)
        {
            Candidate item = planned[i];
            if (!String.Equals(item.ExpectedBaseline, TargetSignature(observed[i]), StringComparison.Ordinal))
                changed.Add(item.Kind + item.Number + " " + item.Name);
        }
        if (changed.Count > 0) throw new BaselineChanged(changed.ToArray());
    }

    // ---- Changeset: several reviewed blocks in one attach, one software compile, one rollback unit ----

    // The changeset file is written by the MCP wrapper next to the output directory and bound by SHA-256.
    // Every item is bound again by its own XML SHA-256 from the plan.
    private static List<Candidate> ReadChangeset(string path, string expectedSha256, bool captureBaseline)
    {
        byte[] bytes = File.ReadAllBytes(path);
        if (!String.Equals(Hash(bytes), expectedSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The changeset file differs from the approved SHA-256.");
        var document = Json.DeserializeObject(Utf8.GetString(bytes)) as Dictionary<string, object>;
        var raw = document == null || !document.ContainsKey("items") ? null : document["items"] as object[];
        if (raw == null || raw.Length < (captureBaseline ? 1 : 2) || raw.Length > 20) throw new InvalidDataException("Invalid target count for this operation.");
        var items = new List<Candidate>();
        foreach (object value in raw)
        {
            var item = value as Dictionary<string, object>;
            if (item == null) throw new InvalidDataException("Changeset item must be an object.");
            Candidate candidate = ReadCandidate(File.ReadAllBytes((string)item["xml"]));
            if (!String.Equals(candidate.Sha256, (string)item["sha256"], StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Changeset item differs from its approved XML SHA-256: " + candidate.Name);
            if (candidate.Name != (string)item["name"] || candidate.Number != (string)item["number"] || candidate.Kind != (string)item["kind"])
                throw new InvalidDataException("Changeset item identity does not match its target: " + candidate.Name);
            if (!captureBaseline) candidate.ExpectedBaseline = (string)item["targetContentSha256"];
            items.Add(candidate);
        }
        return OrderChangeset(items);
    }

    // Global DBs, then FC/FB, then instance DBs (after the FB whose interface they follow), then OBs;
    // the reviewed order is kept within each group. One block may appear once.
    private static int ChangesetRank(string kind)
    {
        if (kind == "InstanceDB") return 2;
        if (kind.EndsWith("DB", StringComparison.Ordinal)) return 0;
        if (kind == "OB") return 3;
        return 1;
    }

    private static List<Candidate> OrderChangeset(List<Candidate> items)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Candidate item in items)
            if (!seen.Add(item.Kind + "\0" + item.Name) || !seen.Add("#" + (item.Kind.EndsWith("DB", StringComparison.Ordinal) ? "DB" : item.Kind) + item.Number))
                throw new InvalidDataException("A block appears twice in the changeset: " + item.Name);
        return items.OrderBy(i => ChangesetRank(i.Kind)).ToList();
    }

    private static string ItemDirectory(string output, int index, Candidate item)
    {
        string directory = Path.Combine(output, (index + 1).ToString("D2", CultureInfo.InvariantCulture) + "-" + item.Kind + item.Number);
        Directory.CreateDirectory(directory);
        return directory;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunChangesetVerification(Dictionary<string, string> options, List<Candidate> items)
    {
        string projectPath = Path.GetFullPath(Required(options, "project"));
        if (!TiaNativeTarget.IsProjectPath(projectPath) || !File.Exists(projectPath)) throw new ArgumentException("Existing target-version project required.");
        int pid = Int32.Parse(Required(options, "process-id"), CultureInfo.InvariantCulture);
        long ticks = DateTimeOffset.Parse(Required(options, "process-start-time-utc"), CultureInfo.InvariantCulture, DateTimeStyles.None).UtcDateTime.Ticks;
        int timeout = Int32.Parse(Required(options, "timeout-ms"), CultureInfo.InvariantCulture);
        CheckBounds(pid, timeout);
        string output = Path.GetFullPath(Required(options, "out"));
        if (Directory.Exists(output) || File.Exists(output)) throw new IOException("Verification output already exists.");
        CheckProcess(pid, ticks);
        using (var watchdog = new Timer(delegate { Console.Error.WriteLine("Verification deadline exceeded."); Environment.Exit(124); }, null, timeout, Timeout.Infinite))
        {
            TiaPortalProcess descriptor = TiaPortal.GetProcess(pid, Math.Min(timeout, 10000));
            if (descriptor == null || descriptor.ProjectPath == null || !SamePath(descriptor.ProjectPath.FullName, projectPath)) throw new InvalidOperationException("Verification process/project mismatch.");
            using (TiaPortal portal = descriptor.Attach())
            {
                CheckProcess(pid, ticks);
                Project[] projects = portal.Projects.Where(p => p.Path != null && SamePath(p.Path.FullName, projectPath)).ToArray();
                if (projects.Length != 1) throw new InvalidOperationException("Exactly one verification project required.");
                Directory.CreateDirectory(output);
                var results = new List<object>();
                Target[] targets = FindTargets(projects[0], items);
                bool capture = options.ContainsKey("baseline-only");
                bool all = true;
                for (int i = 0; i < items.Count; i++)
                {
                    string export = Path.Combine(ItemDirectory(output, i, items[i]), "verification.xml");
                    targets[i].Block.Export(new FileInfo(export), ExportOptions.WithDefaults);
                    Candidate observed = ReadCandidate(File.ReadAllBytes(export));
                    string signature = capture ? TargetSignature(observed) : null;
                    bool matches = capture || ProgramSignature(items[i]) == ProgramSignature(observed);
                    all = all && matches;
                    results.Add(new { name = items[i].Name, number = items[i].Number, kind = items[i].Kind, verificationExport = export, targetContentSha256 = signature, programContentMatches = !capture && matches });
                }
                CheckProcess(pid, ticks);
                WriteJson(new { ok = all, status = capture ? "baseline_captured" : all ? "independent_readback_verified" : "independent_readback_mismatch",
                    processId = pid, processStartTimeUtc = new DateTime(ticks, DateTimeKind.Utc).ToString("o"), projectPath = projectPath,
                    items = results, programContentMatches = !capture && all, verificationMode = "independent-session",
                    projectModified = false, plcAccessed = false, download = false });
                return all ? 0 : 1;
            }
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int RunChangeset(Dictionary<string, string> options, List<Candidate> items)
    {
        string projectPath = Path.GetFullPath(Required(options, "project"));
        if (!TiaNativeTarget.IsProjectPath(projectPath) || !File.Exists(projectPath)) throw new ArgumentException("An existing " + TiaNativeTarget.ProjectExtension + " project is required.");
        int pid = Int32.Parse(Required(options, "process-id"), CultureInfo.InvariantCulture);
        int timeout = Int32.Parse(Required(options, "timeout-ms"), CultureInfo.InvariantCulture);
        CheckBounds(pid, timeout);
        string output = Path.GetFullPath(Required(options, "out"));
        if (Directory.Exists(output) || File.Exists(output)) throw new IOException("Output directory already exists.");
        Directory.CreateDirectory(output);
        var errors = new List<string>();
        var itemReports = new List<Dictionary<string, object>>();
        var staged = new string[items.Count];
        var baselines = new string[items.Count];
        var originals = new Candidate[items.Count];
        // Each block's group composition, kept from the backup phase: a rollback must not depend on
        // finding a target that a failed import may have removed.
        var groups = new PlcBlockComposition[items.Count];
        Stopwatch elapsed = Stopwatch.StartNew();
        long compileMs = 0;
        string refusedBeforeImport = null;
        for (int i = 0; i < items.Count; i++)
        {
            staged[i] = Path.Combine(ItemDirectory(output, i, items[i]), "candidate.xml");
            File.WriteAllBytes(staged[i], items[i].Bytes);
            itemReports.Add(new Dictionary<string, object> {
                { "name", items[i].Name }, { "number", items[i].Number }, { "kind", items[i].Kind },
                { "candidateSha256", items[i].Sha256 }, { "imported", false }, { "programContentMatches", false } });
        }
        var summary = new Dictionary<string, object> {
            { "status", "preflight" }, { "mode", "changeset" }, { "importStarted", false }, { "projectPath", projectPath }, { "processId", pid },
            { "items", itemReports }, { "projectSaved", false }, { "projectModified", false }, { "plcAccessed", false },
            { "download", false }, { "rollbackAttempted", false }, { "rollbackSucceeded", false }, { "errors", errors }
        };
        string summaryPath = Path.Combine(output, "import-changeset.json");
        SaveSummary(summaryPath, summary);
        using (var watchdog = new Timer(delegate { Console.Error.WriteLine("Changeset deadline exceeded; project state may be indeterminate. Inspect the journal before retrying."); Environment.Exit(124); }, null, timeout, Timeout.Infinite))
        {
            try
            {
                long startTicks = DateTimeOffset.Parse(Required(options, "process-start-time-utc"), CultureInfo.InvariantCulture, DateTimeStyles.None).UtcDateTime.Ticks;
                CheckProcess(pid, startTicks);
                TiaPortalProcess descriptor = TiaPortal.GetProcess(pid, Math.Min(timeout, 10000));
                if (descriptor == null || descriptor.ProjectPath == null || !SamePath(descriptor.ProjectPath.FullName, projectPath)) throw new InvalidOperationException("Exact process descriptor/project mismatch.");
                summary["processStartTimeUtc"] = new DateTime(startTicks, DateTimeKind.Utc).ToString("o");
                using (TiaPortal portal = descriptor.Attach())
                {
                    CheckProcess(pid, startTicks);
                    Project[] projects = portal.Projects.Where(p => p.Path != null && SamePath(p.Path.FullName, projectPath)).ToArray();
                    if (projects.Length != 1) throw new InvalidOperationException("Exactly one matching attached project is required.");
                    Project project = projects[0];
                    using (ExclusiveAccess access = portal.ExclusiveAccess("Import a reviewed set of PLC blocks for offline inspection"))
                    {
                        Stopwatch baselineTimer = Stopwatch.StartNew();
                        Target[] targets = FindTargets(project, items);
                        // All targets must live in one PLC software.
                        PlcSoftware software = null;
                        for (int i = 0; i < items.Count; i++)
                        {
                            Target target = targets[i];
                            groups[i] = target.Blocks;
                            baselines[i] = Path.Combine(ItemDirectory(output, i, items[i]), "baseline.xml");
                            target.Block.Export(new FileInfo(baselines[i]), ExportOptions.WithDefaults);
                            originals[i] = ReadCandidate(File.ReadAllBytes(baselines[i]));
                            itemReports[i]["baselineExport"] = baselines[i];
                            itemReports[i]["baselineSha256"] = originals[i].Sha256;
                            if (software == null) software = target.Software;
                            else if (!ReferenceEquals(software, target.Software) && !Equals(software, target.Software))
                                throw new InvalidOperationException("All changeset blocks must belong to one PLC software.");
                        }
                        try { CheckApprovedBaselines(items, originals); }
                        finally { summary["baselineCheckMs"] = baselineTimer.ElapsedMilliseconds; }
                        // The software must compile cleanly before anything is imported, so a failure after the
                        // import belongs to the changeset and a rollback compile can prove the restore.
                        if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access was cancelled before baseline compilation.");
                        summary["status"] = "baseline_compile_started";
                        summary["projectModified"] = true;
                        SaveSummary(summaryPath, summary);
                        long compileStarted = elapsed.ElapsedMilliseconds;
                        CompilerResult baselineCompile = software.GetService<ICompilable>().Compile();
                        compileMs = elapsed.ElapsedMilliseconds - compileStarted;
                        summary["baselineCompile"] = CompileReport(baselineCompile);
                        summary["baselineCompileMs"] = compileMs;
                        if (baselineCompile.ErrorCount != 0 || baselineCompile.State.ToString() == "Error")
                        {
                            refusedBeforeImport = "refused_baseline_compile_errors";
                            throw new InvalidOperationException("The PLC software has compile errors before the changeset; nothing was imported.");
                        }
                        // After the imports come a compile and, on failure, re-imports and another compile.
                        if (elapsed.ElapsedMilliseconds + 2 * compileMs + RollbackMarginMs > timeout)
                        {
                            refusedBeforeImport = "refused_time_budget";
                            throw new TimeoutException("The time budget cannot hold the changeset compile and a rollback compile (" + compileMs + " ms each); nothing was imported. Raise timeoutMs.");
                        }
                        if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access was cancelled before import.");
                        CheckProcess(pid, startTicks);
                        for (int i = 0; i < items.Count; i++)
                            if (Hash(File.ReadAllBytes(staged[i])) != items[i].Sha256) throw new InvalidDataException("Staged candidate changed: " + items[i].Name);
                        int imported = 0;
                        try
                        {
                            summary["status"] = "import_started";
                            summary["importStarted"] = true;
                            summary["projectModified"] = true;
                            SaveSummary(summaryPath, summary);
                            for (int i = 0; i < items.Count; i++)
                            {
                                // Keep enough time for the changeset compile and a rollback compile.
                                if (elapsed.ElapsedMilliseconds + 2 * compileMs + RollbackMarginMs > timeout)
                                    throw new TimeoutException("Stopped before importing " + items[i].Name + ": the rest of the time budget is needed for compile and rollback.");
                                if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access was cancelled during the changeset.");
                                CheckProcess(pid, startTicks);
                                imported = i + 1;
                                groups[i].Import(new FileInfo(staged[i]), ImportOptions.Override);
                                itemReports[i]["imported"] = true;
                                SaveSummary(summaryPath, summary);
                            }
                            // One software compile: re-imported DBs are recreated, so every user must be recompiled.
                            CompilerResult result = software.GetService<ICompilable>().Compile();
                            summary["compile"] = CompileReport(result);
                            if (result.ErrorCount != 0 || result.State.ToString() == "Error") throw new InvalidOperationException("The changeset does not compile.");
                            bool all = true;
                            // Imported blocks are new objects: resolve the whole batch in one inventory walk.
                            Target[] importedTargets = FindTargets(project, items);
                            for (int i = 0; i < items.Count; i++)
                            {
                                string verification = Path.Combine(ItemDirectory(output, i, items[i]), "verification.xml");
                                importedTargets[i].Block.Export(new FileInfo(verification), ExportOptions.WithDefaults);
                                Candidate readback = ReadCandidate(File.ReadAllBytes(verification));
                                bool matches = readback.Name == items[i].Name && readback.Number == items[i].Number && readback.Kind == items[i].Kind &&
                                    ProgramSignature(items[i]) == ProgramSignature(readback);
                                itemReports[i]["verificationExport"] = verification;
                                itemReports[i]["verificationSha256"] = readback.Sha256;
                                itemReports[i]["programContentMatches"] = matches;
                                all = all && matches;
                            }
                            summary["programContentMatches"] = all;
                            if (!all) throw new InvalidOperationException("Re-exported program content differs from a reviewed candidate.");
                            CheckProcess(pid, startTicks);
                            if (access.IsCancellationRequested) throw new OperationCanceledException("Exclusive access was cancelled.");
                            summary["status"] = "verified_unsaved";
                            SaveSummary(summaryPath, summary);
                        }
                        catch
                        {
                            if (imported > 0)
                            {
                                // Restore every imported block from its own baseline, newest first, then compile once.
                                summary["rollbackAttempted"] = true;
                                summary["status"] = "rollback_started";
                                SaveSummary(summaryPath, summary);
                                // Every block is restored on its own: one failure must not leave the others imported.
                                bool restoredAll = true;
                                for (int i = imported - 1; i >= 0; i--)
                                {
                                    try
                                    {
                                        if (Hash(File.ReadAllBytes(baselines[i])) != originals[i].Sha256) throw new InvalidDataException("Baseline changed; refusing an unverified rollback.");
                                        groups[i].Import(new FileInfo(baselines[i]), ImportOptions.Override);
                                    }
                                    catch (Exception rollbackError)
                                    {
                                        restoredAll = false;
                                        itemReports[i]["rollbackError"] = rollbackError.Message;
                                        errors.Add("Rollback " + items[i].Name + ": " + rollbackError.Message);
                                    }
                                }
                                // The changeset proved a clean software compile before importing, so errors now are the rollback's.
                                bool compiled = RollbackCompile(software, summary, errors, timeout - elapsed.ElapsedMilliseconds, compileMs + RollbackMarginMs, true);
                                restoredAll = restoredAll && compiled;
                                // One inventory walk for the whole rollback; if any block cannot be resolved,
                                // fall back to a per-block lookup so each one still gets its own verdict.
                                Target[] restoredTargets = null;
                                try { restoredTargets = FindTargets(project, originals.Take(imported).ToList()); }
                                catch (InvalidOperationException) { restoredTargets = null; }
                                for (int i = 0; i < imported; i++)
                                {
                                    try
                                    {
                                        string restoredPath = Path.Combine(ItemDirectory(output, i, items[i]), "restored.xml");
                                        Target restoredTarget = restoredTargets != null ? restoredTargets[i] : FindTarget(project, originals[i]);
                                        restoredTarget.Block.Export(new FileInfo(restoredPath), ExportOptions.WithDefaults);
                                        bool same = ProgramSignature(originals[i]) == ProgramSignature(ReadCandidate(File.ReadAllBytes(restoredPath)));
                                        itemReports[i]["rollbackExport"] = restoredPath;
                                        itemReports[i]["restored"] = same;
                                        restoredAll = restoredAll && same;
                                    }
                                    catch (Exception verifyError)
                                    {
                                        restoredAll = false;
                                        itemReports[i]["restored"] = false;
                                        errors.Add("Rollback check " + items[i].Name + ": " + verifyError.Message);
                                    }
                                }
                                summary["rollbackSucceeded"] = restoredAll;
                            }
                            throw;
                        }
                        if (!options.ContainsKey("no-save"))
                        {
                            summary["status"] = "save_started";
                            SaveSummary(summaryPath, summary);
                            project.Save();
                            summary["projectSaved"] = true;
                        }
                        summary["status"] = options.ContainsKey("no-save") ? "verified_unsaved" : "verified_saved";
                    }
                }
            }
            catch (BaselineChanged ex)
            {
                errors.Add(ex.Message); summary["status"] = "refused_target_changed";
                summary["changedTargets"] = ex.Blocks;
            }
            catch (Exception ex)
            {
                errors.Add(ex.Message);
                summary["status"] = refusedBeforeImport ?? ((bool)summary["rollbackSucceeded"] ? "failed_rolled_back" : "failed_or_indeterminate");
            }
            SaveSummary(summaryPath, summary);
            WriteJson(summary);
            return errors.Count == 0 ? 0 : 1;
        }
    }

    // Slack for exports, re-imports and verification around the two compiles.
    private const long RollbackMarginMs = 60000;

    // Mirrored by IMPORTER_MAX_TIMEOUT_MS in src/core/importer-output.ts;
    // scripts/importer-contract.test.mjs fails if the two differ.
    private const int MaxTimeoutMs = 600000;

    // One bounds check for every mode, so the limit cannot drift between them.
    private static void CheckBounds(int pid, int timeout)
    {
        if (pid < 1) throw new ArgumentException("Invalid process id " + pid + ".");
        if (timeout < 1000 || timeout > MaxTimeoutMs) throw new ArgumentException("timeout-ms must be between 1000 and " + MaxTimeoutMs + " (got " + timeout + ").");
    }

    // The rollback compile, shared by the single-block and changeset paths. The whole PLC software is
    // compiled: a block-only compile cannot make dependent instance DBs and callers consistent again.
    // With less than 'needed' ms of the budget left it is skipped and recorded, so the watchdog never
    // ends the process inside the compile without a record. Returns true only when the compile ran
    // and either had no errors or its errors are advisory (errorsAreFatal = false).
    private static bool RollbackCompile(PlcSoftware software, Dictionary<string, object> summary, List<string> errors,
        long remaining, long needed, bool errorsAreFatal)
    {
        if (remaining < needed)
        {
            summary["rollbackCompile"] = "skipped_time_budget";
            errors.Add("Rollback compile skipped: " + remaining + " ms left of the budget. The baselines were re-imported; compile the PLC software in TIA Portal and check the blocks.");
            return false;
        }
        try
        {
            CompilerResult restoredCompile = software.GetService<ICompilable>().Compile();
            summary["rollbackCompile"] = CompileReport(restoredCompile);
            summary["rollbackCompileScope"] = "software";
            if (!Failed(restoredCompile)) return true;
            if (errorsAreFatal)
            {
                errors.Add("Rollback compile: the PLC software has compile errors after the restore.");
                return false;
            }
            summary["rollbackCompileErrorsAdvisory"] = "The PLC software has compile errors after the restore; no clean compile was proven before the import, so they may be older. Check them in TIA Portal.";
            return true;
        }
        catch (Exception compileError)
        {
            errors.Add("Rollback compile: " + compileError.Message);
            return false;
        }
    }

    private static bool Failed(CompilerResult result) { return result.ErrorCount != 0 || result.State.ToString() == "Error"; }

    private static Target FindTarget(Project project, Candidate candidate)
    {
        return FindTargets(project, new[] { candidate })[0];
    }

    // Resolve the entire planned batch in one inventory walk. Names may repeat
    // across PLCs, so collect every match and enforce uniqueness afterwards.
    private static Target[] FindTargets(Project project, IList<Candidate> candidates)
    {
        var software = new HashSet<PlcSoftware>();
        foreach (Device device in project.Devices) CollectDevice(device, software);
        foreach (Device device in project.UngroupedDevicesGroup.Devices) CollectDevice(device, software);
        foreach (DeviceUserGroup group in project.DeviceGroups) CollectGroup(group, software, 0);
        var names = candidates.ToLookup(c => c.Name, StringComparer.Ordinal);
        var found = candidates.ToDictionary(c => c, c => new List<Target>());
        foreach (PlcSoftware plc in software) CollectBlocks(plc.BlockGroup, plc, names, found, 0);
        foreach (Candidate candidate in candidates)
            if (found[candidate].Count != 1) throw new InvalidOperationException(
                "Target block is absent or ambiguous across PLCs/groups: " + candidate.Kind + candidate.Number + " " + candidate.Name);
        return candidates.Select(c => found[c][0]).ToArray();
    }

    private static void CollectGroup(DeviceUserGroup group, HashSet<PlcSoftware> software, int depth)
    {
        if (depth > 40) throw new InvalidOperationException("Device group depth exceeds limit.");
        foreach (Device device in group.Devices) CollectDevice(device, software);
        foreach (DeviceUserGroup child in group.Groups) CollectGroup(child, software, depth + 1);
    }

    private static void CollectDevice(Device device, HashSet<PlcSoftware> software)
    {
        foreach (DeviceItem item in device.DeviceItems) CollectItem(item, software, 0);
    }

    private static void CollectItem(DeviceItem item, HashSet<PlcSoftware> software, int depth)
    {
        if (depth > 40) throw new InvalidOperationException("Device item depth exceeds limit.");
        SoftwareContainer container = item.GetService<SoftwareContainer>();
        PlcSoftware plc = container == null ? null : container.Software as PlcSoftware;
        if (plc != null) software.Add(plc);
        foreach (DeviceItem child in item.DeviceItems) CollectItem(child, software, depth + 1);
    }

    private static void CollectBlocks(PlcBlockGroup group, PlcSoftware software, ILookup<string, Candidate> names, Dictionary<Candidate, List<Target>> found, int depth)
    {
        if (depth > 40) throw new InvalidOperationException("Block group depth exceeds limit.");
        foreach (PlcBlock block in group.Blocks)
        {
            foreach (Candidate candidate in names[block.Name])
                if (block.GetType().Name == candidate.Kind && block.Number.ToString(CultureInfo.InvariantCulture) == candidate.Number)
                    found[candidate].Add(new Target { Software = software, Blocks = group.Blocks, Block = block });
        }
        foreach (PlcBlockUserGroup child in group.Groups) CollectBlocks(child, software, names, found, depth + 1);
    }

    private static object CompileReport(CompilerResult result)
    {
        var messages = new List<object>();
        CollectMessages(result.Messages, messages, 0);
        return new { state = result.State.ToString(), errors = result.ErrorCount, warnings = result.WarningCount, messages };
    }

    private static void CollectMessages(CompilerResultMessageComposition source, List<object> messages, int depth)
    {
        if (depth > 40 || messages.Count >= 2000) return;
        foreach (CompilerResultMessage message in source)
        {
            if (messages.Count >= 2000) return;
            messages.Add(new { description = message.Description, path = message.Path, state = message.State.ToString(), errors = message.ErrorCount, warnings = message.WarningCount });
            CollectMessages(message.Messages, messages, depth + 1);
        }
    }

    private static long ProcessStart(int pid) { using (Process process = Process.GetProcessById(pid)) return process.StartTime.ToUniversalTime().Ticks; }
    private static void CheckProcess(int pid, long ticks) { if (ProcessStart(pid) != ticks) throw new InvalidOperationException("TIA process identity changed."); }
    private static bool SamePath(string left, string right) { return String.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase); }
    private static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    private static void WriteJson(object value) { Console.WriteLine(Json.Serialize(value)); }
    private static void SaveSummary(string path, object value) { File.WriteAllText(path, Json.Serialize(value), Utf8); }
}
