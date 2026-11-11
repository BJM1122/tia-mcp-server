using System;
using Siemens.Engineering;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;

// Public API differences between TIA Portal versions that the live core meets.
// Each TIA_API_* symbol is defined by tools/Build-TiaNative.ps1 when the version
// row lists the feature in apiFeatures; without it the core compiles the
// fallback below and reports the feature as unavailable instead of failing.
// With every symbol defined (V20) each member is the original direct call.
internal static class LiveCoreApi
{
    private static NotSupportedException Missing(string member)
    {
        return new NotSupportedException(member + " is not available in the TIA Portal " + TiaNativeTarget.PortalVersion + " public API.");
    }

#if TIA_API_SOFTWARE_NAMESPACES
    public static string NamespaceOrNull(PlcBlock block) { return block.Namespace; }
    public static string NamespaceOrNull(PlcType plcType) { return plcType.Namespace; }
    public static string RequireNamespace(PlcBlock block) { return block.Namespace; }
    public static string RequireNamespace(PlcType plcType) { return plcType.Namespace; }
#else
    // Without software namespaces every object is in the default namespace.
    public static string NamespaceOrNull(PlcBlock block) { return null; }
    public static string NamespaceOrNull(PlcType plcType) { return null; }
    public static string RequireNamespace(PlcBlock block) { throw Missing("PlcBlock.Namespace"); }
    public static string RequireNamespace(PlcType plcType) { throw Missing("PlcType.Namespace"); }
#endif

#if TIA_API_SAFETY_TAGS
    public static bool IsSafety(PlcTag tag) { return tag.IsSafety; }
#else
    public static bool IsSafety(PlcTag tag) { throw Missing("PlcTag.IsSafety"); }
#endif

#if TIA_API_LOCAL_SESSIONS
    public static int LocalSessionCount(TiaPortal portal) { return portal.LocalSessions.Count; }
#else
    public static int LocalSessionCount(TiaPortal portal) { throw Missing("TiaPortal.LocalSessions"); }
#endif

#if TIA_API_OBJECT_IDENTIFIER
    public static ObjectIdentifierProvider IdentifierProvider(Project project) { return project.GetService<ObjectIdentifierProvider>(); }
#else
    // Callers already treat a missing provider as "service_unavailable".
    public static ObjectIdentifierProvider IdentifierProvider(Project project) { return null; }
#endif

    // Cross references and the DataBlock.Interface read are guarded with #if in
    // TiaLiveReadCore.cs itself: their bodies use types that do not exist without them.
}

#if !TIA_API_OBJECT_IDENTIFIER
// Stands in for the V16+ service so the core's identifier fields compile.
// Never constructed: LiveCoreApi.IdentifierProvider returns null.
internal sealed class ObjectIdentifierProvider
{
    private ObjectIdentifierProvider() { }
    public string GetIdentifier(object value) { throw new NotSupportedException("ObjectIdentifierProvider is not available in this TIA Portal version."); }
}
#endif
