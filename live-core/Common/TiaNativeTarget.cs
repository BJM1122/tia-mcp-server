using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;

// Version identity shared by every native companion. The constants live in
// TiaBuildTarget, which tools/Build-TiaNative.ps1 generates from
// portal-versions.json for the version being built; nothing here names a
// specific TIA Portal version. A binary built for one version rejects any other.
internal static class TiaNativeTarget
{
    public static string PortalVersion { get { return TiaBuildTarget.PortalVersion; } }
    public static string ProjectExtension { get { return TiaBuildTarget.ProjectExtension; } }

    // "ap20" for ".ap20": keeps existing self-test check names stable.
    public static string ExtensionTag { get { return TiaBuildTarget.ProjectExtension.TrimStart('.'); } }

    public static bool MatchesApi(AssemblyName identity)
    {
        return identity != null && identity.Version != null &&
            String.Equals(identity.Name, "Siemens.Engineering", StringComparison.Ordinal) &&
            identity.Version.Major == TiaBuildTarget.ApiMajor && identity.Version.Minor == TiaBuildTarget.ApiMinor;
    }

    public static void RequireApi(AssemblyName identity, string message)
    {
        if (!MatchesApi(identity)) throw new InvalidOperationException(message);
    }

    public static string ApiRequirement
    {
        get { return "the Siemens.Engineering " + TiaBuildTarget.PortalVersion + " public API assembly"; }
    }

    // "20.0": the API major.minor this binary was built against.
    public static string ApiAssembly
    {
        get
        {
            return TiaBuildTarget.ApiMajor.ToString(CultureInfo.InvariantCulture) + "." +
                TiaBuildTarget.ApiMinor.ToString(CultureInfo.InvariantCulture);
        }
    }

    // Reported by every self-test as "target", next to the capabilities the
    // companion implements. The server enables a capability for a version only
    // when a companion built for that version reports it here.
    public static Dictionary<string, object> Target()
    {
        Dictionary<string, object> target = new Dictionary<string, object>();
        target.Add("portalVersion", TiaBuildTarget.PortalVersion);
        target.Add("apiAssembly", ApiAssembly);
        target.Add("projectExtension", TiaBuildTarget.ProjectExtension);
        target.Add("apiFeatures", TiaBuildTarget.ApiFeatures);
        return target;
    }

    public static bool IsProjectPath(string path)
    {
        return String.Equals(Path.GetExtension(path), TiaBuildTarget.ProjectExtension, StringComparison.OrdinalIgnoreCase);
    }

    // An extension guaranteed not to be this target's, for negative self-tests.
    public static string ForeignExtension
    {
        get { return String.Equals(TiaBuildTarget.ProjectExtension, ".ap19", StringComparison.OrdinalIgnoreCase) ? ".ap20" : ".ap19"; }
    }
}
