using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Web.Script.Serialization;
using Siemens.Engineering;

namespace Siemens.Engineering {
    [Flags] public enum EngineeringAttributeAccessMode { Read = 1 }
    public class EngineeringAttributeInfo { public string Name; public EngineeringAttributeAccessMode AccessMode; }
    public class EngineeringCompositionInfo { public string Name; }
    public interface IEngineeringObject {
        IEnumerable<EngineeringAttributeInfo> GetAttributeInfos();
        object GetAttribute(string name);
        IEnumerable<EngineeringCompositionInfo> GetCompositionInfos();
        object GetComposition(string name);
    }
    public class FakeObject : IEngineeringObject {
        public string Name { get; set; }
        public virtual IEnumerable<EngineeringAttributeInfo> GetAttributeInfos() { Counters.Metadata++; throw new Exception("ConfirmationType not found: metadata must not be queried"); }
        public virtual object GetAttribute(string name) { Counters.Metadata++; throw new Exception("Generic attribute read is forbidden"); }
        public virtual IEnumerable<EngineeringCompositionInfo> GetCompositionInfos() { Counters.Metadata++; throw new Exception("Generic composition discovery is forbidden"); }
        public object GetComposition(string name) { Counters.Metadata++; throw new Exception("Generic composition read is forbidden"); }
        public string ConfirmationType { get { Counters.Forbidden++; throw new Exception("Portal-fatal getter"); } }
        public string Password { get { Counters.Forbidden++; throw new Exception("Sensitive getter"); } }
        public string UnexpectedScalar { get { Counters.Forbidden++; throw new Exception("Unlisted getter"); } }
    }
    public class Project : FakeObject { }
    public class DeviceItem : FakeObject { public T GetService<T>() where T : class { return null; } }
    public class NetworkInterface : FakeObject { }
    public class SoftwareContainer { public IEngineeringObject Software; }
    public class ObjectIdentifierProvider {
        public string GetIdentifier(IEngineeringObject value) { Counters.Identifiers++; throw new Exception("No discovery-based IDs for Unified"); }
    }
    public class SharedText : FakeObject { public string Text { get { return "Caption"; } } }
    public class ClassicObject : FakeObject {
        public override IEnumerable<EngineeringAttributeInfo> GetAttributeInfos() { Counters.Metadata++; return new[] { new EngineeringAttributeInfo { Name = "Name", AccessMode = EngineeringAttributeAccessMode.Read } }; }
        public override object GetAttribute(string name) { return Name; }
        public override IEnumerable<EngineeringCompositionInfo> GetCompositionInfos() { return new EngineeringCompositionInfo[0]; }
    }
}
namespace Siemens.Engineering.HmiUnified {
    public class HmiSoftware : FakeObject {
        public List<HmiScreen> ScreenValues = new List<HmiScreen>();
        public List<HmiScreen> Screens { get { Counters.Screens++; return ScreenValues; } }
        public List<FakeObject> Tags { get { return new List<FakeObject>(); } }
        public List<FakeObject> DiscreteAlarms { get { throw new Exception("Unavailable alarm collection"); } }
    }
    public class HmiScreen : FakeObject {
        public int Width { get { return 1280; } }
        public int Height { get { return 800; } }
        public List<FakeObject> ScreenItems { get; set; }
    }
    public class HmiButton : FakeObject {
        public int Left { get { return 20; } }
        public SharedText Text { get { return new SharedText { Name = "caption" }; } }
        public List<FakeObject> EventHandlers { get; set; }
    }
    public class BrokenControl : FakeObject { public int Left { get { throw new Exception("Unreadable geometry"); } } }
    public class HmiEventHandler : FakeObject { public HmiScript Script { get; set; } }
    public class HmiScript : FakeObject { public string ScriptCode { get { return "export function Click() {}"; } } }
}
static class Counters {
    public static int Metadata, Forbidden, Identifiers, Screens;
    public static void Reset() { Metadata = Forbidden = Identifiers = Screens = 0; }
}
class Harness {
    private sealed class ReferenceComparer : IEqualityComparer<IEngineeringObject> {
        internal static readonly ReferenceComparer Instance = new ReferenceComparer();
        public bool Equals(IEngineeringObject a, IEngineeringObject b) { return Object.ReferenceEquals(a, b); }
        public int GetHashCode(IEngineeringObject obj) { return RuntimeHelpers.GetHashCode(obj); }
    }
    static Dictionary<string, object> Map(params object[] entries) {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < entries.Length; i += 2) result.Add((string)entries[i], entries[i + 1]);
        return result;
    }
    static string SafeError(Exception error) { return error.Message; }
    /* ENGINEERING_READER */
    static Siemens.Engineering.HmiUnified.HmiSoftware Target() {
        var script = new Siemens.Engineering.HmiUnified.HmiScript { Name = "Click" };
        var handler = new Siemens.Engineering.HmiUnified.HmiEventHandler { Name = "ClickHandler", Script = script };
        var button = new Siemens.Engineering.HmiUnified.HmiButton { Name = "Start", EventHandlers = new List<FakeObject> { handler } };
        var screen = new Siemens.Engineering.HmiUnified.HmiScreen { Name = "Main", ScreenItems = new List<FakeObject> { button, new Siemens.Engineering.HmiUnified.BrokenControl { Name = "Broken" }, new FakeObject { Name = "Sibling" } } };
        return new Siemens.Engineering.HmiUnified.HmiSoftware { Name = "HMI", ScreenValues = new List<Siemens.Engineering.HmiUnified.HmiScreen> { screen } };
    }
    static object Result(EngineeringReader reader, bool hmiCoverage = true) {
        return Map("records", reader.Records, "issues", reader.Issues, "coverage", hmiCoverage ? reader.HmiCoverage() : null, "truncated", reader.Truncated,
            "metadataCalls", Counters.Metadata, "forbiddenGetterCalls", Counters.Forbidden, "identifierCalls", Counters.Identifiers, "screenGetterCalls", Counters.Screens);
    }
    static void Main() {
        var results = new Dictionary<string, object>();
        Counters.Reset();
        var reader = new EngineeringReader(100, true, new ObjectIdentifierProvider(), new HashSet<string>(new[] { "screens", "alarms", "tags" }));
        reader.Visit(Target(), null, "HmiSoftware", 0);
        results["unified"] = Result(reader);
        Counters.Reset();
        reader = new EngineeringReader(3, true, null, new HashSet<string>(new[] { "screens" }));
        reader.Visit(Target(), null, "HmiSoftware", 0);
        results["bounded"] = Result(reader);
        Counters.Reset();
        reader = new EngineeringReader(100, true, null, new HashSet<string>(new[] { "tags" }));
        reader.Visit(Target(), null, "HmiSoftware", 0);
        results["tagsOnly"] = Result(reader);
        Counters.Reset();
        reader = new EngineeringReader(100, false, null);
        reader.Visit(Target(), null, "HmiSoftware", 0);
        results["noScreens"] = Result(reader, false);
        Counters.Reset();
        reader = new EngineeringReader(100, true, null);
        reader.Visit(new ClassicObject { Name = "Classic" }, null, "Object", 0);
        results["classic"] = Result(reader, false);
        Console.WriteLine(new JavaScriptSerializer().Serialize(results));
    }
}
