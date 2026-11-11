// Isolated test API. It cannot contact Siemens, a PLC, or the user's projects.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyVersion("15.1.0.0")]
internal static class ProjectLocker {
    private static void Main(string[] args) {
        using (FileStream stream = new FileStream(args[0], FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
            Console.WriteLine("LOCKED");
            Console.ReadLine();
        }
    }
}
namespace Siemens.Engineering {
    public enum ExportOptions { WithDefaults }
    public interface IEngineeringServiceProvider { T GetService<T>(); }
    public static class Fixture {
        public static int Exports;
        public static string Behavior { get { return Environment.GetEnvironmentVariable("TIA_FIXTURE_BEHAVIOR") ?? ""; } }
        public static string ProjectPath { get { return Environment.GetEnvironmentVariable("TIA_FIXTURE_PROJECT"); } }
        public static object[] Empty { get { return new object[0]; } }
    }
    public sealed class TiaPortal : IDisposable {
        public static object[] GetProcesses() { return new object[] { new Descriptor() }; }
        public object[] Projects { get { return new object[] { new Project() }; } }
        public void Dispose() { }
    }
    public sealed class Descriptor {
        public int Id { get { return Int32.Parse(Environment.GetEnvironmentVariable("TIA_FIXTURE_PID")); } }
        public FileInfo ProjectPath { get { return new FileInfo(Fixture.ProjectPath + (Fixture.Behavior == "wrong-project" ? ".wrong" : "")); } }
        public TiaPortal Attach() { return new TiaPortal(); }
    }
    public sealed class Project {
        public FileInfo Path { get { return new FileInfo(Fixture.ProjectPath); } }
        public string Name { get { return "FixturePress"; } }
        public bool IsModified { get { if (Fixture.Behavior == "unreadable-state") throw new IOException("state unavailable"); return Fixture.Exports > 0 && Fixture.Behavior == "changed-state"; } }
        public object[] DeviceGroups { get { return Fixture.Empty; } }
        public object[] Devices { get { return new object[] { new HW.Device() }; } }
    }
}
namespace Siemens.Engineering.HW {
    public sealed class Device {
        public string Name { get { return "Station"; } }
        public object[] DeviceItems { get { return new object[] { new DeviceItem() }; } }
    }
    public sealed class DeviceItem : Siemens.Engineering.IEngineeringServiceProvider {
        public string Name { get { return "CPU"; } }
        public object[] DeviceItems { get { return Siemens.Engineering.Fixture.Empty; } }
        public T GetService<T>() {
            if (Siemens.Engineering.Fixture.Behavior == "service-failed") throw new IOException("service read failed");
            return (T)(object)new Features.SoftwareContainer();
        }
    }
}
namespace Siemens.Engineering.HW.Features {
    public sealed class SoftwareContainer { public SW.PlcSoftware Software { get { return new SW.PlcSoftware(); } } }
}
namespace Siemens.Engineering.SW {
    public sealed class PlcSoftware {
        public string Name { get { return "PLC"; } }
        public Group BlockGroup { get { return new Group("block", false); } }
        public Group TypeGroup { get { return new Group("type", false); } }
        public Group TagTableGroup { get { return new Group("tag", false); } }
    }
    public sealed class Group {
        private readonly string Kind;
        private readonly bool System;
        public Group(string kind, bool system) { Kind = kind; System = system; }
        public string Name { get { return Kind + (System ? "-system" : "-user"); } }
        public object[] Groups { get { return Siemens.Engineering.Fixture.Empty; } }
        public object[] SystemBlockGroups { get { return new object[] { new Group("block", true) }; } }
        public object[] SystemTypeGroups { get { return new object[] { new Group("type", true) }; } }
        public object[] Blocks { get { return new object[] { new Blocks.FC(System ? 2 : 1) }; } }
        public object[] Types { get { return new object[] { new Types.PlcType(System ? "SysType" : "UserType") }; } }
        public object[] TagTables { get { return new object[] { new Tags.PlcTagTable() }; } }
    }
    public abstract class Exportable {
        public string Name { get; protected set; }
        public DateTime ModifiedDate { get { return new DateTime(2026, 1, 1); } }
        public DateTime CodeModifiedDate { get { return ModifiedDate; } }
        public DateTime InterfaceModifiedDate { get { return ModifiedDate; } }
        public DateTime ModifiedTimeStamp { get { return ModifiedDate; } }
        public bool IsConsistent { get { return Siemens.Engineering.Fixture.Behavior != "inconsistent"; } }
        public bool IsKnowHowProtected { get { return false; } }
        public void Export(FileInfo destination, Siemens.Engineering.ExportOptions options) {
            if (Siemens.Engineering.Fixture.Behavior == "export-failed") throw new IOException("fixture export failed");
            if (!IsConsistent) throw new IOException("inconsistent fixture block");
            Siemens.Engineering.Fixture.Exports++;
            File.WriteAllText(destination.FullName, "<Document><SW.Blocks.FC><AttributeList><Name>" + Name + "</Name><Number>1</Number><ProgrammingLanguage>SCL</ProgrammingLanguage></AttributeList></SW.Blocks.FC></Document>");
        }
    }
}
namespace Siemens.Engineering.SW.Blocks {
    public sealed class FC : Siemens.Engineering.SW.Exportable {
        public FC(int number) { Number = number; Name = "Block" + number; }
        public int Number { get; private set; }
        public string ProgrammingLanguage { get { return "SCL"; } }
    }
}
namespace Siemens.Engineering.SW.Types {
    public sealed class PlcType : Siemens.Engineering.SW.Exportable { public PlcType(string name) { Name = name; } }
}
namespace Siemens.Engineering.SW.Tags {
    public sealed class PlcTagTable : Siemens.Engineering.SW.Exportable { public PlcTagTable() { Name = "Tags"; } }
}
